import * as assert from 'assert'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'
import { claudeConversationKey, claudeOtelCoversLog, logCardsNotCoveredByOtel, CLAUDE_OVERLAP_SLACK_MS } from '../claudeConversation'

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

// The same Claude conversation seen through OTEL (per interaction) and its transcript.
const otel = (o: Partial<SessionSummaryCard> = {}) => card({ sessionId: 'span-1', traceId: 't-1', dataSource: 'otel', claudeSessionId: 'conv-uuid', ...o })
const log = (o: Partial<SessionSummaryCard> = {}) => card({ sessionId: 'conv-uuid', traceId: 'conv-uuid', dataSource: 'log', claudeSessionId: 'conv-uuid', startTime: '2026-01-01T00:00:00.000Z', durationMs: 10 * 60_000, ...o })

suite('claudeConversation — Claude OTEL/transcript dedupe', () => {
  test('conversation key: claudeSessionId, else a log card\'s transcript id (segment suffix stripped)', () => {
    assert.strictEqual(claudeConversationKey(otel()), 'conv-uuid')
    assert.strictEqual(claudeConversationKey(log({ claudeSessionId: undefined, sessionId: 'abc#2' })), 'abc')
    assert.strictEqual(claudeConversationKey(otel({ claudeSessionId: undefined })), null)
    assert.strictEqual(claudeConversationKey(card({ source: 'codex', claudeSessionId: 'conv-uuid' })), null)
  })

  test('an OTEL interaction covers the transcript of the same conversation when times overlap', () => {
    assert.strictEqual(claudeOtelCoversLog(otel(), log()), true)
    assert.strictEqual(claudeOtelCoversLog(otel({ claudeSessionId: 'other' }), log()), false, 'different conversation')
    assert.strictEqual(claudeOtelCoversLog(otel({ startTime: '2026-01-01T02:00:00.000Z' }), log()), false, 'no time overlap')
    // Within the slack: the interaction span starts a beat before the transcript's first line.
    const justBefore = new Date(Date.parse('2026-01-01T00:00:00.000Z') - 60_000 - CLAUDE_OVERLAP_SLACK_MS + 1000).toISOString()
    assert.strictEqual(claudeOtelCoversLog(otel({ startTime: justBefore }), log()), true)
    assert.strictEqual(claudeOtelCoversLog(log(), otel()), false, 'direction matters: otel covers log')
  })

  test('logCardsNotCoveredByOtel drops the covered transcript, keeps everything else', () => {
    const unrelatedLog = log({ sessionId: 'other-conv', traceId: 'other-conv', claudeSessionId: 'other-conv' })
    const codexLog = card({ sessionId: 'codex-1', source: 'codex', dataSource: 'log' })
    const kept = logCardsNotCoveredByOtel([otel()], [log(), unrelatedLog, codexLog])
    assert.deepStrictEqual(kept.map(k => k.sessionId), ['other-conv', 'codex-1'])
  })

  test('gap-split transcript segments are dropped only where OTEL overlaps them', () => {
    const seg1 = log({ sessionId: 'conv-uuid', durationMs: 5 * 60_000 })
    const seg2 = log({ sessionId: 'conv-uuid#2', startTime: '2026-01-01T05:00:00.000Z', durationMs: 5 * 60_000 })
    const kept = logCardsNotCoveredByOtel([otel()], [seg1, seg2])
    assert.deepStrictEqual(kept.map(k => k.sessionId), ['conv-uuid#2'])
  })

  test('an id collision still drops the log card, and conversationId is backfilled onto OTEL', () => {
    const o = otel({ sessionId: 'same-id', claudeSessionId: undefined })
    const kept = logCardsNotCoveredByOtel([o], [log({ sessionId: 'same-id', conversationId: 'conv-link' })])
    assert.deepStrictEqual(kept, [])
    assert.strictEqual(o.conversationId, 'conv-link')
    const o2 = otel({ conversationId: 'mine' })
    logCardsNotCoveredByOtel([o2], [log({ conversationId: 'theirs' })])
    assert.strictEqual(o2.conversationId, 'mine', 'an existing conversationId is kept')
  })

  test('without OTEL, every transcript is kept', () => {
    assert.strictEqual(logCardsNotCoveredByOtel([], [log(), log({ sessionId: 'b' })]).length, 2)
  })
})
