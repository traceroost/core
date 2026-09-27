/**
 * The cloud step of `traceroost advise --apply` (standalone/local/adviseCli.ts's `afterApply`):
 * record the apply in the CLI's suggestion ledger (`~/.traceroost/instruction-ledger.json`) and —
 * only when an org is linked — queue a `SuggestionEvent` for it (AL 08). The ledger's only reader
 * is that instruction telemetry, so both halves live here, beside the rest of the linking code.
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
    console.log('  A suggestion event (id hashed, no prose) was queued for your org.')
  }
}
