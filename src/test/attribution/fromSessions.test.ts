import * as assert from 'assert'
import { toAttributionSessions } from '../../attribution/fromSessions'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

function card(id: string, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: id, traceId: 't-' + id, source: 'claude_code', dataSource: 'otel', workspace: '/repo',
    userRequest: 'secret prompt', model: 'm', turns: 1, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 5000,
    startTime: '2026-01-01T00:00:00.000Z', filesRead: [], filesSearched: [], filesChanged: ['src/a.ts'],
    filesWritten: [], toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

suite('attribution/fromSessions', () => {
  test('maps the time span and changed files — and nothing else', () => {
    const [s] = toAttributionSessions([card('s1')])
    const start = Date.parse('2026-01-01T00:00:00.000Z')
    assert.deepStrictEqual(s, { sessionId: 's1', workspace: '/repo', startMs: start, endMs: start + 5000, filesChanged: ['src/a.ts'] })
  })

  test('a missing or negative duration collapses to a zero-length span', () => {
    const [neg, none] = toAttributionSessions([
      card('neg', { durationMs: -10 }),
      card('none', { durationMs: undefined as unknown as number }),
    ])
    assert.strictEqual(neg.endMs, neg.startMs)
    assert.strictEqual(none.endMs, none.startMs)
  })

  test('skips sessions that cannot be joined to commits', () => {
    const out = toAttributionSessions([
      card('no-ws', { workspace: '' }),
      card('no-start', { startTime: '' }),
      card('bad-start', { startTime: 'not a date' }),
      card('no-files', { filesChanged: [] }),
      card('null-files', { filesChanged: undefined as unknown as string[] }),
      card('ok'),
    ])
    assert.deepStrictEqual(out.map(s => s.sessionId), ['ok'])
  })
})
