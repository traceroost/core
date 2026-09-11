/**
 * Drives `drainQueue` on a timer (AL 04).
 *
 * "Send on a timer, not on session close, even though the trigger is session close" — closing a
 * session is a moment the developer is watching, and a network call attached to it is one they
 * notice when it is slow.
 *
 * No timer runs on an unlinked install. `syncToLinkState()` starts the interval when a
 * credential appears and stops it when one is removed, so linking/leaving takes effect without
 * a restart and an install that is never linked never starts a forwarding thread.
 */

import { drainQueue, type DrainDeps } from './sender'
import { loadCredentials } from '../team/credentials'

export interface ForwardScheduler {
  /** Re-evaluate whether the timer should be running (call after link / leave). */
  syncToLinkState(): void
  /** Drain now, ignoring the interval (call after a session close enqueues something). */
  drainSoon(): void
  dispose(): void
}

export function startForwardScheduler(opts: {
  intervalMs?: number
  notify?: DrainDeps['notify']
  log?: (msg: string) => void
} = {}): ForwardScheduler {
  const intervalMs = opts.intervalMs ?? 5 * 60_000
  let timer: ReturnType<typeof setInterval> | undefined
  let draining = false
  let soonTimer: ReturnType<typeof setTimeout> | undefined

  const run = async () => {
    if (draining) return
    if (!loadCredentials()) { stop(); return }
    draining = true
    try {
      const res = await drainQueue({ notify: opts.notify })
      if (res.sent > 0 || res.droppedInvalid > 0) {
        opts.log?.(`[AgentLens] forwarding: sent ${res.sent}, dropped ${res.droppedInvalid} invalid, ${res.remaining} queued`)
      }
      if (res.stopped === 'membership-revoked') stop()
    } catch (err) {
      opts.log?.(`[AgentLens] forwarding drain error: ${(err as Error).message}`)
    } finally {
      draining = false
    }
  }

  const start = () => {
    if (timer) return
    timer = setInterval(() => { void run() }, intervalMs)
    timer.unref?.()
    void run()
  }

  const stop = () => {
    if (timer) { clearInterval(timer); timer = undefined }
  }

  // Initial evaluation.
  if (loadCredentials()) start()

  const scheduler: ForwardScheduler = {
    syncToLinkState() {
      if (loadCredentials()) start()
      else stop()
    },
    drainSoon() {
      if (!loadCredentials()) return
      if (soonTimer) clearTimeout(soonTimer)
      soonTimer = setTimeout(() => { void run() }, 3_000)
      soonTimer.unref?.()
    },
    dispose() {
      stop()
      if (soonTimer) clearTimeout(soonTimer)
      if (activeScheduler === scheduler) activeScheduler = undefined
    },
  }
  activeScheduler = scheduler
  return scheduler
}

// A process-wide handle so surfaces that aren't wired to the host (the webview panel controller,
// the standalone `/api/team` route) can nudge the scheduler after a link/leave without threading
// it through every constructor.
let activeScheduler: ForwardScheduler | undefined

export function syncForwardSchedulerToLinkState(): void {
  activeScheduler?.syncToLinkState()
}
export function drainForwardQueueSoon(): void {
  activeScheduler?.drainSoon()
}
