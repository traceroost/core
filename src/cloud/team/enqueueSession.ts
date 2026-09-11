/**
 * The one place a closed session becomes a queued rollup (AL 04).
 *
 * A hard no-op on an unlinked install — it reads the credential and returns before touching the
 * queue, so an install that is never linked never writes a forward-queue file.
 */

import { ForwardQueue } from '../forward/queue'
import { loadCredentials } from './credentials'
import { buildPayloadForCard } from './payloadPreview'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

export interface EnqueueResult {
  enqueued: boolean
  reason?: 'not-linked' | 'duplicate' | 'not-a-repo' | 'shallow-clone' | 'no-root-commit' | 'error'
}

/** Builds the rollup for `card` and appends it to the forwarding queue, if a team is linked. */
export async function maybeEnqueueSession(card: SessionSummaryCard, log?: (m: string) => void): Promise<EnqueueResult> {
  if (!loadCredentials()) return { enqueued: false, reason: 'not-linked' }
  try {
    const built = await buildPayloadForCard(card)
    if (!built.ok) return { enqueued: false, reason: built.reason }
    const added = new ForwardQueue().enqueue(built.payload)
    return added ? { enqueued: true } : { enqueued: false, reason: 'duplicate' }
  } catch (err) {
    log?.(`[AgentLens] could not enqueue session for forwarding: ${(err as Error).message}`)
    return { enqueued: false, reason: 'error' }
  }
}
