/**
 * The one place a closed session becomes a queued rollup (AL 04).
 *
 * A hard no-op on an unlinked install — it reads the credential and returns before touching the
 * queue, so an install that is never linked never writes a forward-queue file.
 */

import { ForwardQueue } from '../forward/queue'
import { DeliveryLedger, scopedKey } from '../forward/deliveryLedger'
import { toUuid } from '../forward/buildSessionRollup'
import { loadCredentials } from './credentials'
import { buildPayloadForCard } from './payloadPreview'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

export interface EnqueueResult {
  enqueued: boolean
  reason?: 'not-linked' | 'duplicate' | 'already-delivered' | 'error'
}

/** Builds the rollup for `card` and appends it to the forwarding queue, if a team is linked. A
 *  session whose repository can't be keyed (not a git repo, a shallow clone, no root commit) is
 *  still enqueued — just without repo grouping, never dropped and never keyed with a fake hash.
 *
 *  Checks the delivery ledger *before* building the payload — every log-file rediscovery on
 *  process restart, and every on-demand reconciliation, calls this once per local session
 *  regardless of whether it was already sent; without this check that would mean rebuilding
 *  (a git-subprocess-driven) payload and re-transmitting a machine's entire history on every
 *  restart. Scoped to the *currently linked* org (see `scopedKey`) — a session delivered to a
 *  previous team is not "already delivered" to this one. See `deliveryLedger.ts`. */
export async function maybeEnqueueSession(card: SessionSummaryCard, log?: (m: string) => void): Promise<EnqueueResult> {
  const creds = loadCredentials()
  if (!creds) return { enqueued: false, reason: 'not-linked' }
  // Matches the key a built session payload would get — see buildSessionRollup.ts's session_id
  // field and queue.ts's itemKey — without paying for the git-subprocess work just to discard it.
  if (new DeliveryLedger().isDelivered(scopedKey(creds.orgId, `session:${toUuid(card.sessionId)}`))) {
    return { enqueued: false, reason: 'already-delivered' }
  }
  try {
    const built = await buildPayloadForCard(card)
    if (built.ungroupedReason) {
      log?.(`[TraceRoost] session forwarded without repo grouping (${built.ungroupedReason}): ${card.workspace || card.projectPath || 'unknown workspace'}`)
    }
    const added = new ForwardQueue().enqueue(built.payload)
    return added ? { enqueued: true } : { enqueued: false, reason: 'duplicate' }
  } catch (err) {
    log?.(`[TraceRoost] could not enqueue session for forwarding: ${(err as Error).message}`)
    return { enqueued: false, reason: 'error' }
  }
}
