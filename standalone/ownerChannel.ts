/**
 * The owner channel: how a process that spawned the collector (the desktop app) asks it to shut
 * down cleanly, on every OS.
 *
 * Why not just signals: on Windows there is no SIGTERM. `child.kill()` there is TerminateProcess,
 * which runs no handler, so a collector stopped that way loses every span it had not flushed yet.
 * An app-owned collector needs a request it can *honour* — save spans.json and the outcomes cache,
 * release the data-dir lock, exit 0 — exactly what its SIGTERM handler does on POSIX.
 *
 * The request travels over Node's IPC channel (`stdio: [..., 'ipc']` at spawn), not HTTP:
 *
 *  - **No network surface.** The channel is a pipe the parent creates and the child inherits at
 *    spawn (a socketpair on POSIX; on Windows, a single-instance named pipe that libuv connects
 *    before the child starts). Nothing else can open it: not a web page in any browser, not another
 *    local user, not another process of the same user. An HTTP endpoint would have needed a token,
 *    Host/Origin checks and a guarantee the token never reaches the dashboard page; a pipe needs
 *    none of that because there is nothing to connect to.
 *  - **Opt-in.** Installed only when the parent says it wants it (`TRACEROOST_OWNER_CHANNEL=ipc`)
 *    *and* the process really has an IPC channel (`process.send`). The variable alone grants
 *    nothing: without a channel there is no one to receive a message from. `npx traceroost`, the
 *    background services and Docker have neither, and behave exactly as before.
 *  - **Exact messages only.** `{ type: 'traceroost:shutdown' }` and nothing else; every other
 *    message is ignored.
 *
 * The channel closing (`'disconnect'`) is treated as the same request: it means the owner is gone —
 * crashed, or killed by Task Manager or an installer — and an owned collector outliving its owner
 * would keep the data dir locked and the app's files in use, with nobody left to stop it. Flushing
 * and exiting then is the cooperative version of what the owner would have asked for.
 *
 * POSIX signals keep working as before: SIGTERM/SIGINT still run the same shutdown.
 */

/** The one message that asks the collector to shut down. */
export const SHUTDOWN_REQUEST = { type: 'traceroost:shutdown' } as const

/** Set by the owner in the child's environment to ask for the channel. */
export const OWNER_CHANNEL_ENV = 'TRACEROOST_OWNER_CHANNEL'
export const OWNER_CHANNEL_IPC = 'ipc'

export function isShutdownRequest(message: unknown): boolean {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false
  const keys = Object.keys(message)
  return keys.length === 1 && keys[0] === 'type' && (message as { type?: unknown }).type === SHUTDOWN_REQUEST.type
}

/** The slice of `process` this needs — a fake in tests. */
export interface OwnerChannelProcess {
  send?: unknown
  env: Record<string, string | undefined>
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
}

export type ShutdownReason = 'requested' | 'owner-gone'

/**
 * Wires the channel to `shutdown` when it applies. Returns whether it did. `shutdown` is called at
 * most once from here, whichever of the request and the disconnect comes first.
 */
export function installOwnerChannel(proc: OwnerChannelProcess, shutdown: (reason: ShutdownReason) => void): boolean {
  if (proc.env[OWNER_CHANNEL_ENV] !== OWNER_CHANNEL_IPC) return false
  if (typeof proc.send !== 'function') return false
  let done = false
  const once = (reason: ShutdownReason) => {
    if (done) return
    done = true
    shutdown(reason)
  }
  proc.on('message', message => { if (isShutdownRequest(message)) once('requested') })
  proc.on('disconnect', () => once('owner-gone'))
  return true
}
