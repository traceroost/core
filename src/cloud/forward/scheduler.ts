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
import { DEFAULT_MAX_ITEMS } from './queue'
import { loadCredentials } from '../team/credentials'

// The most batches a single drain run could ever need to fully empty a queue at the hard item
// cap, at the default per-batch limit (`drainQueue`'s own `batchLimit ?? 200`) — a sanity
// backstop against an unbounded loop, not a limit expected to bite in practice.
const MAX_DRAIN_ITERATIONS_PER_RUN = Math.ceil(DEFAULT_MAX_ITEMS / 200)

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
  /** Called after every real drain attempt (sent something, failed, or nothing was eligible) —
   *  never after a tick skipped outright (already draining, or no credential) — and also, mid-drain,
   *  right after each individual item leaves the queue (see `drainQueue`'s `onItemDone`), so a
   *  large backlog's count visibly ticks down as it sends instead of sitting frozen at its
   *  pre-drain total for however long the whole batch takes. The queue depth and connectivity
   *  indicator shown in the Team panel only change as a result of these, so this is the one place
   *  a host needs to hook to keep that panel live instead of stale until the next time it's
   *  reopened. */
  onDrainComplete?: () => void
  /** Forwarded to every `drainQueue` call's `DrainDeps.recordSent` — see there. */
  recordSent?: DrainDeps['recordSent']
  /** Test-only — every other piece of `cloud/forward` already threads this through instead of
   *  always touching the real `~/.traceroost`; kept optional so no real caller needs to pass it. */
  baseHome?: string
  /** Test-only — lets a test exercise the multi-batch keep-draining loop below without needing a
   *  real backlog past `drainQueue`'s default 200-item `batchLimit`. No real caller needs to
   *  override this. */
  batchLimit?: number
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
      let res = await drainQueue({ notify: opts.notify, baseHome: opts.baseHome, batchLimit: opts.batchLimit, onItemDone: opts.onDrainComplete, recordSent: opts.recordSent })
      if (res.sent > 0 || res.droppedInvalid > 0) {
        opts.log?.(`[TraceRoost] forwarding: sent ${res.sent}, dropped ${res.droppedInvalid} invalid, ${res.remaining} queued`)
      }
      // A single drain caps itself at `batchLimit` (200) items so one tick never blocks the timer
      // — but left alone, a backlog bigger than that (right after "Check for unsent traces" on a
      // large history, say) would only shrink by 200 once every 5 minutes. Keep going immediately
      // while a batch is genuinely making progress with nothing stopping it (`stopped: null`
      // means the batch completed with no auth/rate-limit/offline condition hit); any other
      // `stopped` reason means retrying right now would just fail the same way, so defer to the
      // normal timer/backoff instead. Capped at `DEFAULT_MAX_ITEMS / batchLimit` iterations — the
      // most batches a single drain could ever need to empty a full queue — as a sanity backstop,
      // not a real limit expected to bite.
      let iterations = 1
      while (res.stopped === null && res.remaining > 0 && iterations < MAX_DRAIN_ITERATIONS_PER_RUN) {
        res = await drainQueue({ notify: opts.notify, baseHome: opts.baseHome, batchLimit: opts.batchLimit, onItemDone: opts.onDrainComplete, recordSent: opts.recordSent })
        iterations++
        if (res.sent > 0 || res.droppedInvalid > 0) {
          opts.log?.(`[TraceRoost] forwarding: sent ${res.sent}, dropped ${res.droppedInvalid} invalid, ${res.remaining} queued`)
        }
      }
      if (res.remaining > 0 && iterations >= MAX_DRAIN_ITERATIONS_PER_RUN) {
        opts.log?.(`[TraceRoost] forwarding: paused after ${iterations} batches this run with ${res.remaining} still queued — resuming on the next tick`)
      }
      if (res.stopped === 'membership-revoked') stop()
    } catch (err) {
      opts.log?.(`[TraceRoost] forwarding drain error: ${(err as Error).message}`)
    } finally {
      draining = false
      opts.onDrainComplete?.()
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
