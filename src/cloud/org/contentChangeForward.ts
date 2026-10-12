/**
 * Forwards a session whenever its built rollup content actually changed (live reconciliation's
 * generalization beyond outcome-only re-forwarding) -- the live-update counterpart to
 * `enqueueSession.ts`'s ledger-gated `maybeEnqueueSession`, used only on paths that see a session
 * repeatedly while it's still being written to (extension.ts's `store.onUpdate` and periodic log
 * scan, via sessionForwarder.ts; standalone/server.ts's `runLogScan`), not on one-time
 * historical/restart-rediscovery loads --
 * those keep the cheap ledger short-circuit, since replaying a machine's whole history through
 * this function on every restart would rebuild (real `git` subprocesses) and diff every session
 * every time.
 *
 * Unlike `maybeEnqueueSession`, there is no delivery-ledger check here at all: the content hash
 * itself is the gate. A session with no prior recorded hash is, by definition, a change (first
 * send); a session whose hash matches its last recorded one is not (skipped, no network/queue
 * write); anything else re-forwards under a freshly allocated revision, same as a detected
 * outcome change already does.
 */

import { ForwardQueue } from '../forward/queue'
import { assertValidRollupPayload } from '../forward/validate'
import { buildPayloadForCard, type PayloadBuildCache } from './payloadPreview'
import { loadCredentials } from './credentials'
import type { EnqueueResult } from './enqueueSession'
import type { ReconciliationService } from '../../reconcile/reconciliationService'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'
import { hasSettledKey, sourceRankOf } from '../../traceIdentity'

/** One forward in flight per key, in call order. The payload build awaits `git`, so two calls for
 *  the same trace used to interleave: the older snapshot could finish building last, take the
 *  newer revision and overwrite the newer content in the cloud. A call now waits for the previous
 *  one for its key, and a call that a newer one for the same key has already superseded while it
 *  waited is dropped (`superseded` — the newer one carries the current card). */
const inFlight = new Map<string, { tail: Promise<unknown>; latest: number }>()
let callSeq = 0

export async function maybeForwardOnContentChange(
  reconciliation: ReconciliationService,
  card: SessionSummaryCard,
  log?: (m: string) => void,
  cache?: PayloadBuildCache,
): Promise<EnqueueResult> {
  if (!loadCredentials()) return { enqueued: false, reason: 'not-linked' }
  // Never under a provisional or synthesized id — see enqueueSession.ts.
  if (!hasSettledKey(card)) return { enqueued: false, reason: 'unkeyed' }

  const key = card.sessionId
  const seq = ++callSeq
  const slot = inFlight.get(key) ?? { tail: Promise.resolve(), latest: 0 }
  slot.latest = seq
  const run = slot.tail.then(async (): Promise<EnqueueResult> => {
    if (slot.latest !== seq) return { enqueued: false, reason: 'duplicate' }
    return forwardNow(reconciliation, card, log, cache)
  })
  slot.tail = run.catch(() => undefined)
  inFlight.set(key, slot)
  try {
    return await run
  } finally {
    if (inFlight.get(key) === slot && slot.latest === seq) inFlight.delete(key)
  }
}

async function forwardNow(
  reconciliation: ReconciliationService,
  card: SessionSummaryCard,
  log?: (m: string) => void,
  cache?: PayloadBuildCache,
): Promise<EnqueueResult> {
  try {
    const built = await buildPayloadForCard(card, cache)
    if (!built.payload.session) return { enqueued: false, reason: 'error' }

    // Source precedence (src/traceIdentity.ts): a turn's log and OTEL cards share one key, so a
    // transcript re-scan after the OTEL card was sent must not go out as a newer revision.
    // The content is recorded as sent only once it is actually queued (`commit`): a failed enqueue
    // leaves it a change, so the next pass tries again.
    const plan = reconciliation.planContentChange(built.payload.session.session_id, built.payload.session, sourceRankOf(card))
    if (plan.downgrade) return { enqueued: false, reason: 'lower-rank' }
    if (!plan.changed) return { enqueued: false, reason: 'duplicate' }

    built.payload.session.revision = plan.revision
    assertValidRollupPayload(built.payload)
    const added = new ForwardQueue(undefined, undefined, log).enqueue(built.payload)
    if (!added) return { enqueued: false, reason: 'duplicate' }
    plan.commit()
    return { enqueued: true }
  } catch (err) {
    log?.(`[TraceRoost] Could not forward session on content change: ${(err as Error).message}`)
    return { enqueued: false, reason: 'error' }
  }
}
