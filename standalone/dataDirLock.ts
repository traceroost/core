/**
 * Single writer per data directory. Two standalone servers on one data dir (say the background
 * service on :3000 and a `pnpm run local` on :3001) each load `spans.json` at startup and rewrite
 * the whole file on every save, so whichever saves last silently discards the other's spans --
 * and both drain the same forward queue. So a server takes an exclusive lock on its data dir
 * (`<dataDir>/server.lock`) before it reads or writes anything there, and a second one is refused.
 *
 * The lock file is created atomically (`wx`, i.e. O_CREAT|O_EXCL) and holds who owns it -- pid,
 * hostname, ports, start time -- so the refusal can name the running instance. A crashed holder's
 * lock is taken over on the next start: on this host when its pid is no longer alive, and for a
 * holder on another host (a data dir on a shared or network filesystem, or a re-created container
 * with a new hostname) once its heartbeat -- the holder touches the file every
 * `HEARTBEAT_INTERVAL_MS` -- is older than `REMOTE_STALE_MS`; a remote pid can't be probed.
 *
 * Only the standalone server takes this lock. The VS Code extension keeps its spans in its own
 * SQLite store under VS Code's global storage, not here, and the per-machine files both hosts do
 * share (forward queue, delivery ledger, credential) are already guarded per write by
 * src/cloud/forward/fileLock.ts.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'

export const LOCK_FILENAME = 'server.lock'
export const HEARTBEAT_INTERVAL_MS = 30_000
/** A lock written from another host with no heartbeat for this long is presumed abandoned. */
export const REMOTE_STALE_MS = 3 * HEARTBEAT_INTERVAL_MS
/** An empty or unparseable lock this young is presumed mid-write by a starting holder. */
const UNREADABLE_GRACE_MS = 10_000

export interface DataDirLockInfo {
  pid: number
  hostname: string
  /** ISO time the holder started. */
  startedAt: string
  /** True when the holder runs as the background service (`TRACEROOST_SERVICE=1`). */
  service: boolean
  /** Ports actually bound -- absent until the holder has bound all three. */
  uiPort?: number
  otlpPort?: number
  mcpPort?: number
  /** Random per-acquisition id, so a holder can tell its own lock from a successor's. */
  token: string
}

/** Who is asking, and how to probe -- injectable so tests can simulate other hosts and pids. */
export interface LockEnv {
  pid: number
  hostname: string
  now: () => number
  isPidAlive: (pid: number) => boolean
  platform: NodeJS.Platform
}

export function defaultLockEnv(): LockEnv {
  return { pid: process.pid, hostname: os.hostname(), now: Date.now, isPidAlive, platform: process.platform }
}

/** `kill(pid, 0)` probes without signalling (Windows included): ESRCH means gone, EPERM means
 *  alive but someone else's. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type AcquireResult =
  | { ok: true; lock: DataDirLock }
  /** `holder` is null when the lock file exists but is still being written. */
  | { ok: false; holder: DataDirLockInfo | null }

/**
 * One attempt to become the data dir's writer: creates the lock, or takes over a stale one, or
 * reports who holds it. Never waits. Creates `dataDir` if it doesn't exist yet.
 */
export function tryAcquireDataDirLock(dataDir: string, opts: { service?: boolean } = {}, env: LockEnv = defaultLockEnv()): AcquireResult {
  fs.mkdirSync(dataDir, { recursive: true })
  const lockPath = path.join(dataDir, LOCK_FILENAME)
  const info: DataDirLockInfo = {
    pid: env.pid, hostname: env.hostname, startedAt: new Date(env.now()).toISOString(),
    service: opts.service === true, token: crypto.randomBytes(8).toString('hex'),
  }
  // Bounded: each pass either creates the lock, reports a live holder, or removes one stale lock.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try { fs.writeSync(fd, JSON.stringify(info)) } finally { fs.closeSync(fd) }
      return { ok: true, lock: new DataDirLock(lockPath, info, env) }
    } catch (err) {
      if (!isCreateContention((err as NodeJS.ErrnoException).code, env.platform)) throw err
    }
    const current = readLockFile(lockPath)
    if (!current) continue // vanished between the failed create and the read -- retry the create
    if (!isStale(current, env)) return { ok: false, holder: current.info }
    removeStaleLock(lockPath, current.raw)
  }
  return { ok: false, holder: readLockFile(lockPath)?.info ?? null }
}

/** The held lock: refresh it with the bound ports, keep its heartbeat going, release it on exit. */
export class DataDirLock {
  private timer: NodeJS.Timeout | undefined
  private released = false

  constructor(readonly lockPath: string, private info: DataDirLockInfo, private readonly env: LockEnv) {}

  get holder(): DataDirLockInfo { return this.info }

  /** Records the ports actually bound, so a refused second server can point at this one. */
  setPorts(ports: { ui: number; otlp: number; mcp: number }): void {
    this.info = { ...this.info, uiPort: ports.ui, otlpPort: ports.otlp, mcpPort: ports.mcp }
    if (this.isOurs()) {
      try { fs.writeFileSync(this.lockPath, JSON.stringify(this.info)) } catch { /* the heartbeat re-checks */ }
    }
  }

  /** True while the lock file on disk is still this acquisition's. */
  isOurs(): boolean {
    return readLockFile(this.lockPath)?.info?.token === this.info.token
  }

  /**
   * One heartbeat: bumps the lock's mtime (the liveness signal other hosts read) and confirms it is
   * still ours. A lock deleted out from under us is re-created; one replaced by another server
   * (which judged ours stale -- e.g. this process was suspended past `REMOTE_STALE_MS` while the
   * data dir was opened from another host) returns false: this process is no longer the writer.
   */
  beat(): boolean {
    if (this.released) return false
    const current = readLockFile(this.lockPath)
    if (current?.info?.token === this.info.token) {
      const now = new Date(this.env.now())
      try { fs.utimesSync(this.lockPath, now, now) } catch { /* next beat retries */ }
      return true
    }
    if (current) return false
    try {
      const fd = fs.openSync(this.lockPath, 'wx')
      try { fs.writeSync(fd, JSON.stringify(this.info)) } finally { fs.closeSync(fd) }
      return true
    } catch {
      return false
    }
  }

  /** Starts the periodic heartbeat; `onLost` runs once if the lock stops being ours. */
  startHeartbeat(onLost: (holder: DataDirLockInfo | null) => void, intervalMs = HEARTBEAT_INTERVAL_MS): void {
    this.timer = setInterval(() => {
      if (this.beat()) return
      this.stopHeartbeat()
      onLost(readLockFile(this.lockPath)?.info ?? null)
    }, intervalMs)
    this.timer.unref()
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Removes the lock if it is still ours. Idempotent and synchronous, so safe in an 'exit' handler. */
  release(): void {
    if (this.released) return
    this.released = true
    this.stopHeartbeat()
    if (!this.isOurs()) return
    try { fs.rmSync(this.lockPath, { force: true }) } catch { /* the next start treats it as stale */ }
  }
}

function readLockFile(lockPath: string): { raw: string; info: DataDirLockInfo | null; mtimeMs: number } | null {
  let raw: string
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs
    raw = fs.readFileSync(lockPath, 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DataDirLockInfo>
    const valid = typeof parsed.pid === 'number' && typeof parsed.hostname === 'string' && typeof parsed.token === 'string'
    return { raw, info: valid ? parsed as DataDirLockInfo : null, mtimeMs }
  } catch {
    return { raw, info: null, mtimeMs }
  }
}

function isStale(lock: { info: DataDirLockInfo | null; mtimeMs: number }, env: LockEnv): boolean {
  const age = env.now() - lock.mtimeMs
  if (!lock.info) return age > UNREADABLE_GRACE_MS
  if (lock.info.hostname.toLowerCase() === env.hostname.toLowerCase()) {
    // Our own pid can only be a previous process's record (a container restarted as pid 1, say).
    return lock.info.pid === env.pid || !env.isPidAlive(lock.info.pid)
  }
  return age > REMOTE_STALE_MS
}

/**
 * Removes a stale lock without clobbering a fresh one a concurrent starter may have just written:
 * renames it aside first, and only deletes what was renamed if it is the lock judged stale --
 * otherwise (someone else won the takeover first) puts that one back.
 */
function removeStaleLock(lockPath: string, staleRaw: string): void {
  const aside = `${lockPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`
  try { fs.renameSync(lockPath, aside) } catch { return }
  let movedRaw: string | null = null
  try { movedRaw = fs.readFileSync(aside, 'utf-8') } catch { /* fall through and drop it */ }
  if (movedRaw !== null && movedRaw !== staleRaw) {
    // linkSync fails if a lock exists again, so it can never replace a newer one.
    try { fs.linkSync(aside, lockPath) } catch { /* a newer lock is already in place */ }
  }
  try { fs.rmSync(aside, { force: true }) } catch { /* harmless leftover */ }
}

/** Same contention test as fileLock.ts's isLockContention: EEXIST, plus what Windows reports for a
 *  lock file another process has open or has just deleted ("delete pending"). */
function isCreateContention(code: string | undefined, platform: NodeJS.Platform): boolean {
  if (code === 'EEXIST') return true
  return platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
}

/** The refusal printed by a second server, naming the running one and the ways out. */
export function describeLockHolder(dataDir: string, holder: DataDirLockInfo | null, env: Pick<LockEnv, 'hostname' | 'platform'> = defaultLockEnv()): string {
  const lockPath = path.join(dataDir, LOCK_FILENAME)
  const lines = [`[TraceRoost] Refusing to start: another TraceRoost server is already using the data directory ${dataDir}.`]
  if (!holder) {
    lines.push(`  It is starting up right now (${lockPath} is still being written). Wait a moment and open its dashboard, or try again.`)
  } else {
    const local = holder.hostname.toLowerCase() === env.hostname.toLowerCase()
    const where = local ? 'on this machine' : `on host ${holder.hostname} (the data directory is shared between machines)`
    const ports = holder.uiPort !== undefined
      ? `dashboard http://localhost:${holder.uiPort}, OTLP port ${holder.otlpPort}, MCP port ${holder.mcpPort}`
      : 'still binding its ports'
    lines.push(`  Running instance: pid ${holder.pid} ${where}${holder.service ? ', the background service' : ''} — ${ports}, started ${holder.startedAt}.`)
    lines.push('  Two servers on one data directory overwrite each other\'s spans.json and race the cloud forward queue, so only one may run.')
    if (holder.uiPort !== undefined && local) lines.push(`  - Use the running one: open http://localhost:${holder.uiPort}`)
    if (holder.service) {
      lines.push(`  - Or stop it: \`traceroost service stop\`${local ? '' : ` on ${holder.hostname}`}.`)
    } else if (local) {
      const kill = env.platform === 'win32' ? `taskkill /PID ${holder.pid}` : `kill ${holder.pid}`
      lines.push(`  - Or stop it: Ctrl+C in the terminal it runs in, or \`${kill}\`.`)
    } else {
      lines.push(`  - Or stop it on ${holder.hostname}. If nothing runs there any more, its lock is taken over automatically ${REMOTE_STALE_MS / 1000}s after its last heartbeat.`)
    }
  }
  lines.push('  - Or run this one against its own data directory and ports, e.g. DATA_DIR=~/traceroost-2 UI_PORT=3001 OTLP_PORT=4319 MCP_PORT=4317 (or `traceroost service install --data-dir <dir>`).')
  lines.push(`  The lock (${lockPath}) is removed when that server exits; a crashed server's lock is taken over on the next start.`)
  return lines.join('\n')
}
