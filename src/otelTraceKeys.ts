/**
 * Gives every OTEL-built card its canonical key (see traceIdentity.ts), so
 * an OTEL card and the log card of the same turn are one row:
 *
 *   - Claude: joined to its transcript turn (claudeTurnJoin.ts) → traceKey('claude', promptId);
 *     not joinable → a derived key; join still on hold → `keyPending` (provisional id, shown but
 *     not persisted). A synthesized interaction (its root span hasn't arrived) keeps its
 *     `synth-` id: it is never persisted, and its real start time isn't known yet.
 *   - Codex: the turn id its spans carry (traceId `codex:<thread>:<turn>`) → traceKey('codex',
 *     turn) — the key the rollout's turn gets. A trace keyed `prompt-<n>` (Codex 0.17x sends its
 *     prompt event, which names no turn, before any span that does) takes the one turn id its
 *     spans name (`codexTurnId`). With none yet, it is held (`keyPending`) for up to
 *     CODEX_TURN_KEY_HOLD_MS after it starts, so it is not stored under a key the turn's spans
 *     then replace; past that it keeps its own OTEL key. Turn-id equality between the rollout and
 *     OTEL holds on Codex 0.172 (E2E real agents).
 *   - Copilot: keeps its own exact OTEL key (the invoke_agent span id) — the log ↔ OTEL id
 *     equality is unverified, so no cross-source merge by key.
 */

import type { SessionSummaryCard } from './summarizers/summarizerTypes'
import { getClaudeTurnJoiner } from './claudeTurnJoin'
import { traceKey, claudeInteractionKey, SOURCE_RANK_OTEL, SOURCE_RANK_PARTIAL } from './traceIdentity'

export interface OtelKeyHints {
  /** Interaction span id → OTEL `user_prompt_length` (a join tie-breaker). */
  promptLengths?: Map<string, number>
}

const CODEX_TURN_RE = /^codex:[^:]+:(.+)$/
/** How long a Codex prompt trace waits for a span that names its turn. Codex exports a batch every
 *  few seconds; the prompt event leads the turn's first spans by about that much. */
export const CODEX_TURN_KEY_HOLD_MS = 30_000

export function assignOtelTraceKeys(cards: SessionSummaryCard[], hints: OtelKeyHints = {}, nowMs = Date.now()): void {
  const joiner = getClaudeTurnJoiner()
  for (const card of cards) {
    if (card.dataSource !== 'otel') continue
    const hasUsage = card.totalLlmCalls > 0 && (card.inputTokens > 0 || card.outputTokens > 0)
    card.sourceRank = hasUsage ? SOURCE_RANK_OTEL : SOURCE_RANK_PARTIAL
    if (card.sessionId.startsWith('synth-')) continue

    if (card.source === 'claude_code') {
      const sid = card.claudeSessionId
      const startMs = Date.parse(card.startTime)
      if (!sid || !(startMs > 0)) continue
      const spanId = card.sessionId
      const result = joiner
        ? joiner.resolve({ interactionId: spanId, claudeSessionId: sid, startMs, promptLength: hints.promptLengths?.get(spanId) })
        : { status: 'derived' as const, key: claudeInteractionKey(sid, startMs) }
      if (result.status === 'pending') { card.keyPending = true; continue }
      card.sessionId = result.key
      if (result.status === 'derived' || result.derived) card.derived = true
      // Every turn of a transcript carries its file id as conversationId; so does its OTEL card.
      if (!card.conversationId) card.conversationId = sid
      continue
    }

    if (card.source === 'codex') {
      const m = CODEX_TURN_RE.exec(card.traceId)
      if (!m) continue
      const turn = m[1].startsWith('prompt-') ? card.codexTurnId : m[1]
      if (turn) { card.sessionId = traceKey('codex', turn); continue }
      const startMs = Date.parse(card.startTime)
      if (startMs > 0 && nowMs - startMs < CODEX_TURN_KEY_HOLD_MS) card.keyPending = true
    }
  }
}
