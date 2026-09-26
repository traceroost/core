/**
 * Forwards a session whenever its built rollup content actually changed (staged feature 10's
 * generalization beyond outcome-only re-forwarding) -- the live-update counterpart to
 * `enqueueSession.ts`'s ledger-gated `maybeEnqueueSession`, used only on paths that see a session
 * repeatedly while it's still being written to (extension.ts's `store.onUpdate`,
 * standalone/server.ts's `runLogScan`), not on one-time historical/restart-rediscovery loads --
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

import { ForwardQueue } from '../cloud/forward/queue'
import { assertValidRollupPayload } from '../cloud/forward/validate'
import { buildPayloadForCard, type PayloadBuildCache } from '../cloud/org/payloadPreview'
import { loadCredentials } from '../cloud/org/credentials'
import type { EnqueueResult } from '../cloud/org/enqueueSession'
import type { ReconciliationService } from './reconciliationService'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

export async function maybeForwardOnContentChange(
  reconciliation: ReconciliationService,
  card: SessionSummaryCard,
  log?: (m: string) => void,
  cache?: PayloadBuildCache,
): Promise<EnqueueResult> {
  if (!loadCredentials()) return { enqueued: false, reason: 'not-linked' }

  try {
    const built = await buildPayloadForCard(card, cache)
    if (!built.payload.session) return { enqueued: false, reason: 'error' }

    const { revision, changed } = reconciliation.recordContentChange(built.payload.session.session_id, built.payload.session)
    if (!changed) return { enqueued: false, reason: 'duplicate' }

    built.payload.session.revision = revision
    assertValidRollupPayload(built.payload)
    const added = new ForwardQueue(undefined, undefined, log).enqueue(built.payload)
    return added ? { enqueued: true } : { enqueued: false, reason: 'duplicate' }
  } catch (err) {
    log?.(`[TraceRoost] could not forward session on content change: ${(err as Error).message}`)
    return { enqueued: false, reason: 'error' }
  }
}
