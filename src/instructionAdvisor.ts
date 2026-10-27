/**
 * Instruction Advisor — pure analysis over SessionSummaryCard[].
 * All inputs are workspace-pre-filtered; no I/O here.
 *
 * The rules themselves (IDs, thresholds, text) live in ./suggestionRules.ts, a byte-identical copy
 * of the webview's media/src/suggestionRules.ts — so the MCP server, instruction telemetry and
 * `traceroost advise` surface exactly the suggestions the Instructions tab shows, under the same
 * IDs the tab applies/dismisses them by. This module only binds the host's session cost.
 */

import type { SessionSummaryCard } from './summarizers/summarizerTypes'
import { calcSessionCostUsd } from './pricing'
import { generateSuggestions as generateSuggestionsWithCost, type SuggestionCard, type TargetAgent } from './suggestionRules'

export type { SuggestionCard, SuggestionCategory, TargetAgent } from './suggestionRules'

export function generateSuggestions(
  sessions: SessionSummaryCard[],
  existingInstructionText: string,
): SuggestionCard[] {
  return generateSuggestionsWithCost(sessions, existingInstructionText, calcSessionCostUsd)
}

/**
 * A card's target agents narrowed to the ones with traces in `sessions` (the repo's agents in use),
 * so a Claude-only repo isn't told about Copilot, Codex, OpenCode and Cursor. All of them when none
 * is in use: the hot-file card leaves Copilot out, and a Copilot-only repo still gets it.
 */
export function targetAgentsInUse(card: SuggestionCard, sessions: SessionSummaryCard[]): TargetAgent[] {
  const inUse = new Set<string>(sessions.map(s => s.source))
  const narrowed = card.targetAgents.filter(a => inUse.has(a))
  return narrowed.length > 0 ? narrowed : card.targetAgents
}
