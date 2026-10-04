/**
 * Forwards one session's current rollup to TraceRoost Cloud after its content changed — a hard
 * no-op unless an org is linked (both cloud calls below check). Shared by every path where the
 * extension learns a session changed: a live OTLP update and the periodic log scan. The standalone
 * server does the same in its own `runLogScan`/live paths.
 *
 * With reconciliation available, the content-hash gate (staged feature 10) re-forwards the session
 * under a fresh revision whenever its rollup content actually changed — not just on its first send
 * — debounced per session so a burst of updates coalesces into one check (each check rebuilds the
 * payload with `git` subprocesses; see keyedDebouncer.ts). Without reconciliation (no SQLite
 * database) it falls back to the first-send-only enqueue.
 */

import type { SessionSummaryCard } from './summarizers/summarizerTypes'
import type { ReconciliationService } from './reconcile/reconciliationService'
import type { EnqueueResult } from './cloudBridge'

export interface SessionForwarderDeps {
  cloud: {
    enqueueSession(card: SessionSummaryCard, log?: (m: string) => void): Promise<EnqueueResult>
    forwardOnContentChange(
      reconciliation: ReconciliationService,
      card: SessionSummaryCard,
      log?: (m: string) => void,
    ): Promise<EnqueueResult>
  }
  /** Read on every call: the service is created after the first live sessions can arrive. */
  reconciliation: () => ReconciliationService | undefined
  debouncer: { schedule(key: string, run: () => void): void }
  /** Asks the forward scheduler to drain soon, once something was enqueued. */
  drainSoon: () => void
  log?: (m: string) => void
}

export function createSessionForwarder(deps: SessionForwarderDeps): (card: SessionSummaryCard) => void {
  return (card) => {
    const svc = deps.reconciliation()
    const onResult = (r: EnqueueResult) => { if (r.enqueued) deps.drainSoon() }
    if (svc) {
      deps.debouncer.schedule(card.sessionId, () => {
        void deps.cloud.forwardOnContentChange(svc, card, deps.log).then(onResult, () => { /* best-effort, as every forward path */ })
      })
    } else {
      void deps.cloud.enqueueSession(card, deps.log).then(onResult, () => { /* best-effort, as every forward path */ })
    }
  }
}
