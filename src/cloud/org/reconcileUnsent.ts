/**
 * "Queue everything this install hasn't delivered yet" — shared by the Org panel (right after a
 * link, and its "Check for unsent traces" button) and linkWatcher.ts (a link made outside this
 * process, e.g. `traceroost org link` or another server). Cheap to call: `maybeEnqueueSession`
 * checks the delivery ledger before building anything, so an already-delivered session costs one
 * lookup, not a rebuilt payload or a re-send.
 */

import { maybeEnqueueSession } from './enqueueSession'
import { createPayloadBuildCache } from './payloadPreview'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

// How many sessions' `maybeEnqueueSession` calls run at once. Matches the shape of
// `gitOutcome.ts`'s `MAX_CONCURRENT_SESSION_CLASSIFICATIONS` — bounded so total concurrent `git`
// subprocess load stays predictable, not unbounded fan-out over a large backlog.
const RECONCILE_CONCURRENCY = 6

/** Runs `worker` over `sessions` with up to `RECONCILE_CONCURRENCY` in flight at once, rather than
 *  one at a time. Progress (when `onProgress` is given) is reported after each *completion*, in
 *  whichever order they land — no longer tied to array order the way the old serial loop was. */
async function runReconcilePool(
  sessions: SessionSummaryCard[],
  worker: (session: SessionSummaryCard) => Promise<{ enqueued: boolean }>,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const total = sessions.length
  let nextIndex = 0
  let done = 0
  let queued = 0

  async function runOne(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= total) return
      const res = await worker(sessions[i])
      if (res.enqueued) queued++
      done++
      if (onProgress) {
        onProgress(done, total)
        // Without this, a progress update can sit unsent: when `worker` short-circuits on an
        // already-delivered session, it resolves via microtasks only (no real async I/O), so a
        // burst of already-delivered sessions completing back-to-back never actually returns
        // control to the event loop — and posting to the webview is IPC, which needs that to
        // flush. `setImmediate` forces one real event-loop tick per completion so the webview
        // sees progress as it happens instead of one burst at the end.
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
  }

  const workerCount = Math.min(RECONCILE_CONCURRENCY, total)
  await Promise.all(Array.from({ length: workerCount }, runOne))
  return queued
}

/** Queues every one of `sessions` not yet confirmed delivered to the currently linked install, and
 *  returns how many were queued. Shared by the panel (link, "Check for unsent traces") and
 *  linkWatcher.ts (a link made outside this process). Does not nudge the scheduler. */
export async function queueUnsentSessions(
  sessions: SessionSummaryCard[],
  log?: (m: string) => void,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  if (sessions.length === 0) return 0
  // Scoped to this one reconcile pass — memoizes the per-workspace git work (repo key, branch,
  // outcome classification) that would otherwise be recomputed once per session instead of once
  // per distinct repo a developer's sessions cluster in. See payloadPreview.ts's
  // createPayloadBuildCache and .staged-issues/reconcile-gap-and-latency.md.
  const cache = createPayloadBuildCache()
  const queued = await runReconcilePool(sessions, (session) => maybeEnqueueSession(session, log, cache), onProgress)
  if (queued > 0) {
    log?.(`[TraceRoost] Reconcile: queued ${queued} local session(s) not yet confirmed delivered`)
  }
  return queued
}
