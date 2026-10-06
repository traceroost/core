/**
 * One turn of an agent conversation can arrive two ways: live OTEL and the agent's on-disk log.
 * With stable trace identity (traceIdentity.ts) both copies carry the same
 * canonical key, so "counting it once" is no longer an overlap guess: it is the same key, and
 * source precedence decides which copy the row shows — a lower-rank card never replaces a
 * higher-rank one, within a rank the newer wins. The VS Code extension applies that in the
 * database writer (database/writer.ts); the standalone server applies it when it merges its OTEL
 * and log-sourced cards (mergeCardsByKey below) — same rule, so both surfaces agree.
 */
import type { SessionSummaryCard } from './summarizers/summarizerTypes'
import { sourceRankOf } from './traceIdentity'

/** The conversation a card belongs to — what the conversation marker groups by: the log
 *  parser's conversationId, else (a Claude OTEL card) Claude Code's own session id. */
export function conversationKey(card: SessionSummaryCard): string | null {
  if (card.conversationId) return card.conversationId
  return card.source === 'claude_code' && card.claudeSessionId ? card.claudeSessionId : null
}

/**
 * The cards to list for `otelCards` + `logCards`: one per key. When both sources have a card for
 * a key, the higher source rank wins (a tie goes to the OTEL card, which is rebuilt live); what
 * only the losing card knows — its conversation, its folded subagent count — is carried over.
 * Never mutates the input cards.
 */
export function mergeCardsByKey(otelCards: SessionSummaryCard[], logCards: Iterable<SessionSummaryCard>): SessionSummaryCard[] {
  const byKey = new Map<string, SessionSummaryCard>()
  for (const c of otelCards) byKey.set(c.sessionId, c)
  const merged: SessionSummaryCard[] = []
  for (const log of logCards) {
    const otel = byKey.get(log.sessionId)
    if (!otel) { merged.push(log); continue }
    const winner = sourceRankOf(log) > sourceRankOf(otel) ? log : otel
    const loser = winner === log ? otel : log
    const extra: Partial<SessionSummaryCard> = {}
    if (!winner.conversationId && loser.conversationId) extra.conversationId = loser.conversationId
    if (winner.subagentCount === undefined && loser.subagentCount !== undefined) extra.subagentCount = loser.subagentCount
    byKey.set(log.sessionId, Object.keys(extra).length > 0 ? { ...winner, ...extra } : winner)
  }
  return [...byKey.values(), ...merged]
}
