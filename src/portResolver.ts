/**
 * Shared port-conflict handling for the background-service path (`standalone/server.ts`,
 * `src/mcpServer.ts`) and, for `detectPortOwner`, the VS Code extension's own collector too.
 *
 * The trap this exists to avoid: auto-picking a free port is easy, but nothing upstream of this
 * separated "the port that was requested" from "the port that was actually bound" — a fallback
 * that isn't read back by every consumer (auto-configure, the printed dashboard URL, `service
 * status`, the MCP endpoint string) would silently point agents at a dead port. `ResolvedPorts` is
 * the one record every consumer reads instead of re-deriving "the port" from an env var.
 * See .staged-issues/auto-pick-free-port.md for the full design this implements.
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { defaultDataDir } from './serviceConfig'

export interface ResolvedPorts {
  ui: number
  otlp: number
  mcp: number
  /** ISO timestamp of the process start that resolved these ports. */
  resolvedAt: string
  /** PID of the process that resolved these ports — stale once that process exits, but harmless
   *  to read stale: `service status` only uses this record to decide what to print/probe, never
   *  to decide liveness on its own. */
  pid: number
}

/** How far past the requested port to scan before giving up. Matches the doc's "+1 through +20". */
export const DEFAULT_SCAN_CAP = 20

export function resolvedPortsPath(baseHome?: string): string {
  return path.join(defaultDataDir(baseHome), 'ports.json')
}

export function readResolvedPorts(baseHome?: string): ResolvedPorts | undefined {
  try {
    const raw = fs.readFileSync(resolvedPortsPath(baseHome), 'utf-8')
    return JSON.parse(raw) as ResolvedPorts
  } catch {
    return undefined
  }
}

export function writeResolvedPorts(ports: ResolvedPorts, baseHome?: string): void {
  const configPath = resolvedPortsPath(baseHome)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(ports, null, 2) + '\n', 'utf-8')
}

export class PortScanExhaustedError extends Error {
  constructor(public readonly requestedPort: number, public readonly cap: number) {
    super(
      `Port ${requestedPort} (and the next ${cap} ports after it) are all in use — ` +
      `stop one of those processes or set a different port to use.`
    )
    this.name = 'PortScanExhaustedError'
  }
}

/**
 * Binds `server` starting at `preferredPort`. On `EADDRINUSE`, scans upward
 * (`preferredPort + 1`, `+2`, … up to `+cap`) until a free port binds. Never sticky across calls —
 * each call starts back at `preferredPort`, so a restart after the conflict clears returns to the
 * configured port rather than drifting further from it.
 *
 * Resolves with the port actually bound. Throws `PortScanExhaustedError` if every candidate in the
 * scan range is taken, rather than hanging or scanning indefinitely.
 */
export async function listenWithFallback(
  server: http.Server,
  preferredPort: number,
  host: string,
  opts: { cap?: number; onFallback?: (requested: number, bound: number) => void } = {},
): Promise<number> {
  const cap = opts.cap ?? DEFAULT_SCAN_CAP
  for (let offset = 0; offset <= cap; offset++) {
    const candidate = preferredPort + offset
    const outcome = await new Promise<'bound' | 'retry'>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening)
        if (err.code === 'EADDRINUSE') { resolve('retry'); return }
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve('bound')
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(candidate, host)
    })
    if (outcome === 'bound') {
      // Read the actual bound port off the socket rather than trusting `candidate` — the two
      // differ when `preferredPort` was 0 (OS-assigned ephemeral port), which real callers here
      // never pass but tests exercising this function directly do.
      const actual = (server.address() as { port: number }).port
      if (actual !== preferredPort) { opts.onFallback?.(preferredPort, actual) }
      return actual
    }
  }
  throw new PortScanExhaustedError(preferredPort, cap)
}

// ── Port ownership detection ─────────────────────────────────────────────────
//
// Distinguishes "another TraceRoost instance" from "some unrelated app" for the log line either
// way — used both when the VS Code extension's own collector loses a bind race (extension.ts) and
// when the standalone/service path falls back to a different port (standalone/server.ts).

function probePort(port: number, probePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}${probePath}`, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
          resolve(json.traceroost === true)
        } catch {
          resolve(false)
        }
      })
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => { req.destroy(); resolve(false) })
  })
}

export async function detectPortOwner(port: number): Promise<'plugin' | 'standalone' | 'foreign'> {
  const [isPlugin, isStandalone] = await Promise.all([
    probePort(port, '/traceroost/plugin'),
    probePort(port, '/traceroost/standalone'),
  ])
  if (isPlugin) return 'plugin'
  if (isStandalone) return 'standalone'
  return 'foreign'
}
