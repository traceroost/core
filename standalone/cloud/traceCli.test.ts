import * as assert from 'assert'
import { findSessionById } from './traceCli'
import type { SessionSummaryCard } from '../../src/summarizers/summarizerTypes'

function makeCard(overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-1',
    traceId: 'trace-1',
    source: 'claude_code',
    dataSource: 'otel',
    workspace: '/repo',
    userRequest: 'do a thing',
    model: 'claude-3',
    turns: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    cacheHitRate: 0,
    durationMs: 1000,
    startTime: '2024-01-01T00:00:00.000Z',
    filesRead: [],
    filesSearched: [],
    filesChanged: [],
    filesWritten: [],
    toolCounts: {},
    totalToolCalls: 0,
    totalLlmCalls: 0,
    errors: 0,
    outcome: 'tool_calls',
    timeline: [],
    backgroundSpans: [],
    loopSignals: [],
    ...overrides,
  }
}

suite('findSessionById', () => {
  test('matches by sessionId', () => {
    const sessions = [makeCard({ sessionId: 'a' }), makeCard({ sessionId: 'b' })]
    assert.strictEqual(findSessionById(sessions, 'b')?.sessionId, 'b')
  })

  test('matches by traceId when sessionId differs', () => {
    const sessions = [makeCard({ sessionId: 'a', traceId: 'trace-a' })]
    assert.strictEqual(findSessionById(sessions, 'trace-a')?.sessionId, 'a')
  })

  test('returns undefined when nothing matches', () => {
    const sessions = [makeCard({ sessionId: 'a' })]
    assert.strictEqual(findSessionById(sessions, 'nope'), undefined)
  })

  test('does not partial-match — an id that is only a substring of a real one does not match', () => {
    const sessions = [makeCard({ sessionId: 'abcdef' })]
    assert.strictEqual(findSessionById(sessions, 'abc'), undefined)
  })
})
