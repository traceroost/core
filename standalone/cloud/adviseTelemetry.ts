/**
 * The cloud step of `traceroost advise --apply` (standalone/local/adviseCli.ts's `afterApply`):
 * record the apply in the CLI's suggestion ledger (`~/.traceroost/instruction-ledger.json`) and —
 * only when an org is linked — queue the repo's updated instruction-file state (AL 08). Suggestion
 * events are no longer sent (org/instructionTelemetry.ts); the ledger stays local.
 */

import { recordApplied, readLedger } from '../../src/cloud/org/suggestionLedgerStore'
import { maybeEnqueueInstructionTelemetry } from '../../src/cloud/org/instructionTelemetry'
import { drainForwardQueueSoon } from '../../src/cloud/forward/scheduler'
import type { AfterApplyHook } from '../local/adviseCli'

export const recordAppliedAndEmit: AfterApplyHook = async (workspace, card, sessions) => {
  recordApplied(workspace, card.id, { id: card.id, category: card.category, priority: card.priority, targetAgents: card.targetAgents })
  const enqueued = await maybeEnqueueInstructionTelemetry(workspace, sessions, readLedger(workspace))
  if (enqueued) {
    drainForwardQueueSoon()
    console.log('  The updated instruction-file state (hashed, no text) was queued for your org.')
  }
}
