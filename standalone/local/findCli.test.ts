import * as assert from 'assert'
import { classify, findDeepLink } from './findCli'
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

const REPO_HASH = 'a'.repeat(64)

suite('classify', () => {
  test('a hash matching a recorded session id is a trace', () => {
    const sessions = [makeCard({ sessionId: 'sess-1' })]
    assert.strictEqual(classify('sess-1', sessions), 'trace')
  })

  test('a hash matching a recorded trace id is a trace', () => {
    const sessions = [makeCard({ sessionId: 'sess-1', traceId: 'trace-1' })]
    assert.strictEqual(classify('trace-1', sessions), 'trace')
  })

  test('a 64-char repo hash with no matching session is a repo', () => {
    assert.strictEqual(classify(REPO_HASH, []), 'repo')
  })

  test('an unrecognized value falls back to repo (patternsCli reports "not found")', () => {
    assert.strictEqual(classify('nothing-matches-this', []), 'repo')
  })
})

suite('findDeepLink', () => {
  test('encodes the hash under the id extension.ts is actually registered under', () => {
    assert.strictEqual(
      findDeepLink('sess-1'),
      'vscode://agentlens.agentlens-dashboard/find?hash=sess-1',
    )
  })

  test('includes reporter when given', () => {
    assert.strictEqual(
      findDeepLink('sess-1', 'a.dev@example.com'),
      'vscode://agentlens.agentlens-dashboard/find?hash=sess-1&reporter=a.dev%40example.com',
    )
  })

  test('omits reporter entirely when not given, rather than an empty param', () => {
    assert.ok(!findDeepLink('sess-1').includes('reporter'))
  })
})
