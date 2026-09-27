import * as assert from 'assert'
import { topTouchedFiles, groupedSignals } from './patternsCli'
import type { SessionSummaryCard, TimelineEntry } from '../../src/summarizers/summarizerTypes'

// detectLoopSignals's own detection accuracy is covered by src/test/loopDetector.test.ts — this
// file is only about the aggregation on top of it (topTouchedFiles/groupedSignals), the part
// patternsCli.ts actually adds.

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

function errorEntry(message: string): TimelineEntry {
  return {
    type: 'tool', spanId: 'sp', label: 'Bash', durationMs: 10,
    isError: true, errorMessage: message, timestamp: '2024-01-01T00:00:01.000Z',
  }
}

suite('topTouchedFiles', () => {
  test('counts a file once per read/changed/written occurrence, across sessions', () => {
    const sessions = [
      makeCard({ sessionId: 'a', filesRead: ['x.ts'], filesChanged: ['x.ts'] }),
      makeCard({ sessionId: 'b', filesRead: ['x.ts'], filesWritten: ['y.ts'] }),
    ]
    const files = topTouchedFiles(sessions)
    assert.deepStrictEqual(files, [
      { path: 'x.ts', count: 3 },
      { path: 'y.ts', count: 1 },
    ])
  })

  test('returns an empty list when no session touched any files', () => {
    assert.deepStrictEqual(topTouchedFiles([makeCard()]), [])
  })

  test('ties break alphabetically for a deterministic order', () => {
    const sessions = [
      makeCard({ sessionId: 'a', filesChanged: ['z.ts', 'a.ts'] }),
    ]
    assert.deepStrictEqual(topTouchedFiles(sessions).map(f => f.path), ['a.ts', 'z.ts'])
  })

  test('respects the limit parameter', () => {
    const sessions = [makeCard({ filesChanged: ['a.ts', 'b.ts', 'c.ts'] })]
    assert.strictEqual(topTouchedFiles(sessions, 2).length, 2)
  })
})

suite('groupedSignals', () => {
  test('empty for sessions with no error/loop behavior', () => {
    assert.deepStrictEqual(groupedSignals([makeCard()]), [])
  })

  test('groups a recurring error by type, across sessions, counting distinct sessions affected', () => {
    const sessions = [
      makeCard({ sessionId: 'a', timeline: [errorEntry('boom'), errorEntry('boom'), errorEntry('boom')] }),
      makeCard({ sessionId: 'b', timeline: [errorEntry('boom'), errorEntry('boom'), errorEntry('boom')] }),
    ]
    const groups = groupedSignals(sessions)
    const errorGroup = groups.find(g => g.type === 'error_recurrence')
    assert.ok(errorGroup, 'expected an error_recurrence group')
    assert.strictEqual(errorGroup!.sessions, 2)
  })

  test('counts distinct sessions affected, not raw occurrences, when several sessions trip the same type', () => {
    const sessions = [
      makeCard({ sessionId: 'one', timeline: [errorEntry('a'), errorEntry('a'), errorEntry('a')] }),
      makeCard({ sessionId: 'two', timeline: [errorEntry('b'), errorEntry('b'), errorEntry('b'), errorEntry('b')] }),
      makeCard({ sessionId: 'three', timeline: [] }), // no error behavior — must not inflate the count
    ]
    const groups = groupedSignals(sessions)
    assert.strictEqual(groups.length, 1)
    assert.strictEqual(groups[0].type, 'error_recurrence')
    assert.strictEqual(groups[0].sessions, 2) // 'one' and 'two', not 'three'
  })
})
