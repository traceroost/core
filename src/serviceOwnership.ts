/**
 * "The background service always wins": who may write the coding agents' settings when the VS Code
 * extension and a standalone TraceRoost server (the OS background service, a `traceroost` in a
 * terminal, the desktop app's collector) both run on this machine.
 *
 * Two hosts setting agents up would fight over one endpoint — each start pointing the agents at its
 * own port. The standalone server keeps collecting with VS Code closed, so it wins: while one is
 * running, the extension writes no agent settings at all, on activation or otherwise, and its
 * Set Up Agents / Remove Agent Setup commands ask the server to do it (POST /action on its
 * dashboard, the same requests its Settings panel sends). If the server starts after the extension
 * already set agents up, its own start points them at itself, which is fine.
 *
 * A standalone server is taken to be running when either
 *   - the extension's own collector lost its port to one (the existing collectorConflict check:
 *     EADDRINUSE, then `GET /traceroost/standalone` on that port — detectPortOwner), or
 *   - it holds the data-dir lock (`<dataDir>/server.lock`, standalone/dataDirLock.ts) on this host
 *     with a live pid, and its recorded OTLP port answers that same identity probe. This catches a
 *     server that fell back to another port, which the extension's own bind would never notice.
 *     The lock is looked for in config.json's dataDir and in the one the last server to start
 *     recorded in ports.json, which covers a server started with a DATA_DIR override.
 * Either way only a server whose identity reply says `managesAgentSetup: true` takes over. A
 * Docker container publishing 4318 answers the probe too, but the agent settings it can reach are
 * the container's own: it says false, and the extension keeps setting up this machine's agents
 * (pointed at that port, where the container receives them) as it did before. So does a server
 * run with TRACEROOST_NO_AUTOCONFIG=1, which refuses every agent-setup request.
 */

import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { readResolvedPorts, serviceDashboardUrl, standaloneIdentity } from './portResolver'
import { readServiceConfig } from './serviceConfig'

/** The data-dir lock's file name — standalone/dataDirLock.ts re-exports it as LOCK_FILENAME. */
export const SERVER_LOCK_FILENAME = 'server.lock'

/** The part of a data-dir lock (standalone/dataDirLock.ts's DataDirLockInfo) read here. */
export interface ServerLockSnapshot {
  pid: number
  hostname: string
  service?: boolean
  uiPort?: number
  otlpPort?: number
}

/** The lock in `dataDir`, or undefined when there is none or it can't be read. */
export function readServerLock(dataDir: string): ServerLockSnapshot | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, SERVER_LOCK_FILENAME), 'utf-8')) as Partial<ServerLockSnapshot>
    if (typeof parsed.pid !== 'number' || typeof parsed.hostname !== 'string') return undefined
    return parsed as ServerLockSnapshot
  } catch {
    return undefined
  }
}

/** `kill(pid, 0)`: ESRCH means gone, EPERM alive but someone else's (as in dataDirLock.ts). */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export type AgentSetupOwner =
  | { owner: 'extension' }
  /** A standalone server runs; `otlpPort` is the port it receives on. */
  | { owner: 'service'; otlpPort: number }

export interface AgentSetupOwnerInput {
  /** The extension's configured OTLP port. */
  extensionPort: number
  /** Who holds that port when the extension's own collector couldn't bind it (collectorConflict). */
  portOwner?: 'plugin' | 'standalone' | 'foreign'
  /** Whether that standalone server says it manages agent setup (serviceManagesAgentSetup). */
  portOwnerManagesSetup: boolean
  /** The data dir's lock, if any. */
  lock?: ServerLockSnapshot
  /** Whether `lock.otlpPort` answered the standalone identity probe saying it manages agent setup. */
  lockPortManagesSetup: boolean
  hostname: string
  isPidAlive: (pid: number) => boolean
}

/** Pure: which host sets agents up. See the file comment for the rules. */
export function decideAgentSetupOwner(input: AgentSetupOwnerInput): AgentSetupOwner {
  if (input.portOwner === 'standalone' && input.portOwnerManagesSetup) return { owner: 'service', otlpPort: input.extensionPort }
  const lock = input.lock
  if (lock && lock.hostname.toLowerCase() === input.hostname.toLowerCase() && input.isPidAlive(lock.pid)
    && typeof lock.otlpPort === 'number' && input.lockPortManagesSetup) {
    return { owner: 'service', otlpPort: lock.otlpPort }
  }
  return { owner: 'extension' }
}

/** True when a standalone server answers on `port` and says it sets this machine's agents up. */
export async function serviceManagesAgentSetup(port: number): Promise<boolean> {
  const identity = await standaloneIdentity(port)
  return identity?.kind === 'standalone' && identity.managesAgentSetup === true
}

/** The data dirs whose lock may name a running server: config.json's, and the one recorded in
 *  ports.json by the last server to start (a DATA_DIR override). */
export function candidateDataDirs(baseHome?: string): string[] {
  const configured = path.resolve(readServiceConfig(baseHome).dataDir)
  const recorded = readResolvedPorts(baseHome)?.dataDir
  return typeof recorded === 'string' && recorded && path.resolve(recorded) !== configured
    ? [configured, path.resolve(recorded)]
    : [configured]
}

/** Reads the locks and probes their ports, then decides (decideAgentSetupOwner). Cheap when no
 *  server runs: no lock, no probe. */
export async function detectAgentSetupOwner(extensionPort: number, portOwner?: 'plugin' | 'standalone' | 'foreign', baseHome?: string): Promise<AgentSetupOwner> {
  const hostname = os.hostname()
  const portOwnerManagesSetup = portOwner === 'standalone' && await serviceManagesAgentSetup(extensionPort)
  if (portOwnerManagesSetup) return decideAgentSetupOwner({ extensionPort, portOwner, portOwnerManagesSetup, lockPortManagesSetup: false, hostname, isPidAlive })
  for (const dataDir of candidateDataDirs(baseHome)) {
    const lock = readServerLock(dataDir)
    const live = !!lock && lock.hostname.toLowerCase() === hostname.toLowerCase() && isPidAlive(lock.pid) && typeof lock.otlpPort === 'number'
    const lockPortManagesSetup = live && await serviceManagesAgentSetup(lock!.otlpPort!)
    const decided = decideAgentSetupOwner({ extensionPort, portOwner, portOwnerManagesSetup, lock, lockPortManagesSetup, hostname, isPidAlive })
    if (decided.owner === 'service') return decided
  }
  return { owner: 'extension' }
}

/**
 * Sends one of the standalone dashboard's agent-setup actions (`reconfigureOtel`,
 * `removeAgentSetup`, `agentSetup`) to the server receiving OTLP on `otlpPort`, and returns its
 * JSON reply — or undefined when no dashboard answers, or it doesn't know the action (an older
 * server replies with an empty body). Loopback binds need no token; a server bound beyond
 * loopback gets the access token from config.json, as its dashboard link does.
 */
export async function postServiceAction(otlpPort: number, body: Record<string, unknown>, baseHome?: string, timeoutMs = 15_000): Promise<Record<string, unknown> | undefined> {
  const dashboard = await serviceDashboardUrl(otlpPort, baseHome)
  if (!dashboard) return undefined
  const url = new URL(dashboard)
  const token = url.searchParams.get('token')
  // `localhost` may resolve to ::1 first while the server listens on 127.0.0.1.
  const host = url.hostname === 'localhost' ? (readServiceConfig(baseHome).bindHost === '::1' ? '::1' : '127.0.0.1') : url.hostname.replace(/^\[|\]$/g, '')
  const data = JSON.stringify(body)
  return new Promise(resolve => {
    const req = http.request({
      host, port: Number(url.port), path: '/action', method: 'POST', timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(undefined); return }
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined)
        } catch {
          resolve(undefined)
        }
      })
    })
    req.on('error', () => resolve(undefined))
    req.on('timeout', () => { req.destroy(); resolve(undefined) })
    req.end(data)
  })
}
