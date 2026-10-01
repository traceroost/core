/**
 * One Claude Code conversation is ingested two ways: live OTEL (one card per interaction,
 * sessionId = the interaction span id, carrying Claude Code's `session.id` as `claudeSessionId`)
 * and its on-disk transcript (one card per transcript or gap-split segment `<id>#<n>`, whose lines
 * carry the same id). Without a shared rule both get counted. The VS Code extension applies this
 * rule in the database writer (database/writer.ts); the standalone server applies it when it
 * merges its OTEL and log-sourced cards (mergeOtelAndLogSessions below) — same key, same overlap
 * test, so both surfaces count a Claude session once, with OTEL winning.
 */
import type { SessionSummaryCard } from './summarizers/summarizerTypes'

/** Slack when matching a Claude log card's [start, end] against OTEL interactions' ranges: the
 *  interaction span starts a beat before the transcript's first line is written. */
export const CLAUDE_OVERLAP_SLACK_MS = 60_000

/** The Claude Code session a card belongs to — the key shared by its OTEL and log cards. */
export function claudeConversationKey(card: SessionSummaryCard): string | null {
  if (card.source !== 'claude_code') return null
  if (card.claudeSessionId) return card.claudeSessionId
  return card.dataSource === 'log' ? card.sessionId.replace(/#\d+$/, '') : null
}

/** True when `otel` (an OTEL Claude interaction) belongs to the same conversation as `log` (a
 *  transcript card) and their time ranges overlap — the writer's _claudeOtelCovers test. */
export function claudeOtelCoversLog(otel: SessionSummaryCard, log: SessionSummaryCard): boolean {
  if (otel.dataSource !== 'otel' || log.dataSource !== 'log') return false
  const key = claudeConversationKey(log)
  if (!key || claudeConversationKey(otel) !== key) return false
  const logStart = Date.parse(log.startTime)
  const otelStart = Date.parse(otel.startTime)
  if (!logStart || !otelStart) return false
  const logEnd = logStart + (log.durationMs || 0)
  const otelEnd = otelStart + (otel.durationMs || 0)
  return otelStart <= logEnd + CLAUDE_OVERLAP_SLACK_MS && otelEnd >= logStart - CLAUDE_OVERLAP_SLACK_MS
}

/**
 * The log-sourced cards that should still be listed next to `otelCards`: a log card is dropped
 * when an OTEL card has the same sessionId (the existing id-collision rule) or covers the same
 * Claude conversation (claudeOtelCoversLog). A dropped card's `conversationId` is backfilled onto
 * the OTEL card that replaced it when that card has none — the log parser links multi-segment
 * conversations; the live OTEL path never does. Mutates `otelCards` for that backfill only.
 */
export function logCardsNotCoveredByOtel(otelCards: SessionSummaryCard[], logCards: Iterable<SessionSummaryCard>): SessionSummaryCard[] {
  const otelById = new Map(otelCards.map(s => [s.sessionId, s]))
  const otelClaudeByKey = new Map<string, SessionSummaryCard[]>()
  for (const s of otelCards) {
    const key = s.dataSource === 'otel' ? claudeConversationKey(s) : null
    if (!key) continue
    const list = otelClaudeByKey.get(key)
    if (list) list.push(s)
    else otelClaudeByKey.set(key, [s])
  }
  const kept: SessionSummaryCard[] = []
  for (const log of logCards) {
    const key = claudeConversationKey(log)
    const replacement = otelById.get(log.sessionId)
      ?? (key ? otelClaudeByKey.get(key)?.find(o => claudeOtelCoversLog(o, log)) : undefined)
    if (!replacement) { kept.push(log); continue }
    if (!replacement.conversationId && log.conversationId) replacement.conversationId = log.conversationId
  }
  return kept
}
