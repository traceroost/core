/**
 * Gives every OTEL-built card its canonical key (staged feature 11 — see traceIdentity.ts), so
 * an OTEL card and the log card of the same turn are one row:
 *
 *   - Claude: joined to its transcript turn (claudeTurnJoin.ts) → traceKey('claude', promptId);
 *     not joinable → a derived key; join still on hold → `keyPending` (provisional id, shown but
 *     not persisted). A synthesized interaction (its root span hasn't arrived) keeps its
 *     `synth-` id: it is never persisted, and its real start time isn't known yet.
 *   - Codex: the turn id its spans carry (traceId `codex:<thread>:<turn>`) → traceKey('codex',
 *     turn) — the key the rollout's turn gets. A turn with no id (`prompt-<n>`) keeps its own
 *     OTEL key. Verify at scale: rollout ↔ OTEL turn_id equality rests on one sample.
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

export function assignOtelTraceKeys(cards: SessionSummaryCard[], hints: OtelKeyHints = {}): void {
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
      if (!m || m[1].startsWith('prompt-')) continue
      card.sessionId = traceKey('codex', m[1])
    }
  }
}
