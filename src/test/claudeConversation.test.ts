import * as assert from 'assert'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'
import { conversationKey, mergeCardsByKey } from '../claudeConversation'
import { traceKey, toUuid, traceKeysInWindow, localHorizonOf } from '../traceIdentity'

function card(overrides: Partial<SessionSummaryCard>): SessionSummaryCard {
  return {
    sessionId: 'x', traceId: 'x', source: 'claude_code', dataSource: 'otel', workspace: '/repo',
    userRequest: 'p', model: 'claude-sonnet-4-6', turns: 1, inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 60_000,
    startTime: '2026-01-01T00:02:00.000Z', filesRead: [], filesSearched: [], filesChanged: [],
    filesWritten: [], filesChangedNote: undefined, toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1,
    errors: 0, outcome: 'unknown', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  } as SessionSummaryCard
}

// The same Claude turn seen through OTEL and through its transcript share one canonical key.
const KEY = traceKey('claude', 'prompt-0001')
const otel = (o: Partial<SessionSummaryCard> = {}) => card({ sessionId: KEY, traceId: 't-1', dataSource: 'otel', claudeSessionId: 'conv-uuid', sourceRank: 3, ...o })
const log = (o: Partial<SessionSummaryCard> = {}) => card({ sessionId: KEY, traceId: KEY, dataSource: 'log', claudeSessionId: 'conv-uuid', conversationId: 'conv-uuid', sourceRank: 2, ...o })

suite('claudeConversation — merging a turn\'s OTEL and log cards by key', () => {
  test('conversation key: the card\'s conversationId, else a Claude card\'s session id', () => {
    assert.strictEqual(conversationKey(log()), 'conv-uuid')
    assert.strictEqual(conversationKey(otel()), 'conv-uuid')
    assert.strictEqual(conversationKey(otel({ claudeSessionId: undefined })), null)
    assert.strictEqual(conversationKey(card({ source: 'codex', claudeSessionId: 'conv-uuid' })), null)
  })

  test('same key: one card, the higher source rank wins, and what only the loser knew is kept', () => {
    const o = otel()
    const merged = mergeCardsByKey([o], [log({ subagentCount: 2 })])
    assert.strictEqual(merged.length, 1)
    assert.strictEqual(merged[0].dataSource, 'otel')
    assert.strictEqual(merged[0].conversationId, 'conv-uuid')
    assert.strictEqual(merged[0].subagentCount, 2)
    assert.strictEqual(o.conversationId, undefined, 'never mutates its input')
  })

  test('a partial OTEL card (no usage yet) gives way to the full transcript', () => {
    const l = log()
    const merged = mergeCardsByKey([otel({ sourceRank: 1 })], [l])
    assert.deepStrictEqual(merged, [l])
  })

  test('different keys are never merged — e.g. a derived OTEL key and a transcript turn', () => {
    const merged = mergeCardsByKey([otel({ sessionId: 'derived-key', derived: true })], [log()])
    assert.strictEqual(merged.length, 2)
  })
})

suite('traceIdentity — manifest hooks over in-memory cards', () => {
  test('traceKeysInWindow: wire keys of settled, non-legacy traces started in the window; localHorizonOf: the oldest', () => {
    const cards = [
      card({ sessionId: KEY, startTime: '2026-01-01T00:00:00.000Z' }),
      card({ sessionId: 'copilot-span-1', startTime: '2026-01-02T00:00:00.000Z' }),
      card({ sessionId: 'old-file#1', startTime: '2025-12-01T00:00:00.000Z', legacy: true }),
      card({ sessionId: 'span-pending', startTime: '2026-01-03T00:00:00.000Z', keyPending: true }),
    ]
    assert.deepStrictEqual(traceKeysInWindow(cards, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-05T00:00:00Z')), [KEY, toUuid('copilot-span-1')])
    assert.deepStrictEqual(traceKeysInWindow(cards, Date.parse('2026-01-02T00:00:00Z'), Date.parse('2026-01-05T00:00:00Z')), [toUuid('copilot-span-1')])
    assert.strictEqual(localHorizonOf(cards), Date.parse('2026-01-01T00:00:00Z'))
  })
})
