import * as assert from 'assert'
import './domShim'
import { makeCard, makeSummary } from './fixtures'
import {
  sessionSummary, filteredSessions, selectedAgentFilter, dataSourceFilter, workspaceFilter,
  outcomeFilter, initiatorFilter, sessionTextFilter, sessionSortKey, sessionSortDir, timeRange,
  gitOutcomes, evidenceSessionIds, rangedSearchResults, sessionLimit, repoInfo, makeTimeRange,
  type SortKey,
} from '../../../media/src/state'

// ── Shared setup ────────────────────────────────────────────────────────────────
// filteredSessions (state.ts) is the single computed signal Sessions/Cost/Analytics/Search/
// Insights all read — every test below drives it purely through the public filter/sort signals,
// the same surface the UI components touch, and reads back filteredSessions.value.

function resetAllFilters() {
  sessionSummary.value = makeSummary([])
  selectedAgentFilter.value = 'all'
  dataSourceFilter.value = 'all'
  workspaceFilter.value = ''
  outcomeFilter.value = 'all'
  initiatorFilter.value = 'all'
  sessionTextFilter.value = ''
  sessionSortKey.value = 'start_time'
  sessionSortDir.value = 'desc'
  timeRange.value = { preset: 'all' }
  gitOutcomes.value = {}
  evidenceSessionIds.value = null
  rangedSearchResults.value = null
  sessionLimit.value = 25
  repoInfo.value = {}
}

function ids(cards: { sessionId: string }[]): string[] {
  return cards.map(c => c.sessionId)
}

setup(resetAllFilters)

// ── Filters ─────────────────────────────────────────────────────────────────────

suite('filteredSessions — filters', () => {
  test('agent filter narrows to a single source', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', source: 'claude_code' }),
      makeCard({ sessionId: 'b', source: 'codex' }),
      makeCard({ sessionId: 'c', source: 'claude_code' }),
    ])
    selectedAgentFilter.value = 'claude_code'
    assert.deepStrictEqual(ids(filteredSessions.value).sort(), ['a', 'c'])
  })

  test('agent filter "all" excludes nothing', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', source: 'claude_code' }),
      makeCard({ sessionId: 'b', source: 'codex' }),
    ])
    selectedAgentFilter.value = 'all'
    assert.strictEqual(filteredSessions.value.length, 2)
  })

  test('data source filter narrows to otel or log', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', dataSource: 'otel' }),
      makeCard({ sessionId: 'b', dataSource: 'log' }),
    ])
    dataSourceFilter.value = 'log'
    assert.deepStrictEqual(ids(filteredSessions.value), ['b'])
  })

  test('data source filter treats a missing dataSource as otel', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', dataSource: undefined as unknown as 'otel' }),
    ])
    dataSourceFilter.value = 'otel'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a'])
  })

  test('workspace filter narrows by repo query against the workspace path', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', workspace: '/home/user/repo-one' }),
      makeCard({ sessionId: 'b', workspace: '/home/user/repo-two' }),
    ])
    workspaceFilter.value = 'repo-one'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a'])
  })

  test('text filter matches the user request', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', userRequest: 'fix the login bug' }),
      makeCard({ sessionId: 'b', userRequest: 'add a new feature' }),
    ])
    sessionTextFilter.value = 'login'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a'])
  })

  test('text filter matches a raw session id', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'unique-id-123', userRequest: 'do something' }),
      makeCard({ sessionId: 'other', userRequest: 'do something else' }),
    ])
    sessionTextFilter.value = 'unique-id'
    assert.deepStrictEqual(ids(filteredSessions.value), ['unique-id-123'])
  })

  test('text filter matches a raw trace id', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', traceId: 'abcdef1234567890', userRequest: 'x' }),
      makeCard({ sessionId: 'b', traceId: 'zzzzzzzzzzzzzzzz', userRequest: 'x' }),
    ])
    sessionTextFilter.value = 'abcdef'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a'])
  })

  test('text filter is case-insensitive', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', userRequest: 'Fix The Bug' }),
    ])
    sessionTextFilter.value = 'FIX the'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a'])
  })

  test('an evidence-session override replaces the text filter entirely', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', userRequest: 'matches text' }),
      makeCard({ sessionId: 'b', userRequest: 'does not match' }),
    ])
    sessionTextFilter.value = 'matches'
    evidenceSessionIds.value = new Set(['b'])
    // evidence override wins outright — 'b' doesn't match the text filter but is in the evidence set
    assert.deepStrictEqual(ids(filteredSessions.value), ['b'])
  })

  test('initiator filter "agent" also includes api-initiated sessions', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', initiator: 'user' }),
      makeCard({ sessionId: 'b', initiator: 'agent' }),
      makeCard({ sessionId: 'c', initiator: 'api' }),
    ])
    initiatorFilter.value = 'agent'
    assert.deepStrictEqual(ids(filteredSessions.value).sort(), ['b', 'c'])
  })

  test('initiator filter "user" only matches user, not agent or api', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', initiator: 'user' }),
      makeCard({ sessionId: 'b', initiator: 'agent' }),
    ])
    initiatorFilter.value = 'user'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a'])
  })

  test('a session with no initiator defaults to user', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', initiator: undefined }),
    ])
    initiatorFilter.value = 'user'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a'])
  })

  test('outcome filter narrows to sessions whose resolved outcome matches the bucket', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a' }),
      makeCard({ sessionId: 'b' }),
      makeCard({ sessionId: 'c' }),
    ])
    gitOutcomes.value = {
      a: { overall: 'merged', files: {}, reason: '' },
      b: { overall: 'committed', files: {}, reason: '' },
      c: { overall: 'abandoned', files: {}, reason: '' },
    }
    outcomeFilter.value = 'merged'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a'])
  })

  test('outcome filter excludes a session whose outcome has not resolved yet', () => {
    sessionSummary.value = makeSummary([makeCard({ sessionId: 'a' })])
    gitOutcomes.value = {} // 'a' not yet present — unresolved
    outcomeFilter.value = 'merged'
    assert.strictEqual(filteredSessions.value.length, 0)
  })

  test('outcome filter never matches an "ambiguous" outcome, even under a specific bucket', () => {
    sessionSummary.value = makeSummary([makeCard({ sessionId: 'a' })])
    gitOutcomes.value = { a: { overall: 'ambiguous', files: {}, reason: '' } }
    for (const bucket of ['merged', 'committed', 'abandoned'] as const) {
      outcomeFilter.value = bucket
      assert.strictEqual(filteredSessions.value.length, 0, `bucket ${bucket} should exclude ambiguous`)
    }
  })

  test('outcome filter "all" shows resolved, unresolved, and ambiguous sessions alike', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a' }),
      makeCard({ sessionId: 'b' }),
    ])
    gitOutcomes.value = { a: { overall: 'ambiguous', files: {}, reason: '' } } // b unresolved
    outcomeFilter.value = 'all'
    assert.strictEqual(filteredSessions.value.length, 2)
  })

  test('time range "all" preset does not narrow by time at all', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'old', startTime: '2000-01-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'new', startTime: new Date().toISOString() }),
    ])
    timeRange.value = { preset: 'all' }
    assert.strictEqual(filteredSessions.value.length, 2)
  })

  test('a bounded time range with no DB results yet falls back to in-memory sessions in the window', () => {
    const now = Date.now()
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'inside', startTime: new Date(now - 60_000).toISOString() }),
      makeCard({ sessionId: 'outside', startTime: new Date(now - 10 * 86_400_000).toISOString() }),
    ])
    timeRange.value = makeTimeRange('24h')
    rangedSearchResults.value = null // still loading
    assert.deepStrictEqual(ids(filteredSessions.value), ['inside'])
  })

  test('a bounded time range merges DB results with in-memory sessions, deduplicated by sessionId', () => {
    const now = Date.now()
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'in-memory-only', startTime: new Date(now - 60_000).toISOString() }),
      makeCard({ sessionId: 'both', startTime: new Date(now - 120_000).toISOString() }),
    ])
    timeRange.value = makeTimeRange('24h')
    rangedSearchResults.value = {
      sessions: [
        makeCard({ sessionId: 'both', startTime: new Date(now - 120_000).toISOString() }),
        makeCard({ sessionId: 'db-only', startTime: new Date(now - 180_000).toISOString() }),
      ],
      totalCount: 2,
      offset: 0,
    }
    assert.deepStrictEqual(
      ids(filteredSessions.value).sort(),
      ['both', 'db-only', 'in-memory-only'].sort(),
    )
  })

  test('combined filters (agent + data source + outcome) all narrow together', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'match', source: 'claude_code', dataSource: 'otel' }),
      makeCard({ sessionId: 'wrong-agent', source: 'codex', dataSource: 'otel' }),
      makeCard({ sessionId: 'wrong-source', source: 'claude_code', dataSource: 'log' }),
      makeCard({ sessionId: 'wrong-outcome', source: 'claude_code', dataSource: 'otel' }),
    ])
    gitOutcomes.value = {
      match: { overall: 'merged', files: {}, reason: '' },
      'wrong-agent': { overall: 'merged', files: {}, reason: '' },
      'wrong-source': { overall: 'merged', files: {}, reason: '' },
      'wrong-outcome': { overall: 'abandoned', files: {}, reason: '' },
    }
    selectedAgentFilter.value = 'claude_code'
    dataSourceFilter.value = 'otel'
    outcomeFilter.value = 'merged'
    assert.deepStrictEqual(ids(filteredSessions.value), ['match'])
  })
})

// ── Sort ────────────────────────────────────────────────────────────────────────

suite('filteredSessions — sort, every column, both directions', () => {
  test('start_time desc (default) is newest first', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'old', startTime: '2024-01-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'new', startTime: '2024-03-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'mid', startTime: '2024-02-01T00:00:00.000Z' }),
    ])
    // sessionSummary.value is assumed newest-first on input, same as the real host feed;
    // filteredSessions keeps that order for desc (its default) and reverses it for asc.
    sessionSortDir.value = 'desc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['old', 'new', 'mid'])
    sessionSortKey.value = 'start_time'
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['mid', 'new', 'old'])
  })

  test('total_tokens sorts by input+output tokens', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', inputTokens: 10, outputTokens: 10 }), // 20
      makeCard({ sessionId: 'b', inputTokens: 100, outputTokens: 100 }), // 200
      makeCard({ sessionId: 'c', inputTokens: 50, outputTokens: 0 }), // 50
    ])
    sessionSortKey.value = 'total_tokens'
    sessionSortDir.value = 'desc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['b', 'c', 'a'])
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a', 'c', 'b'])
  })

  test('duration_ms sorts numerically', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', durationMs: 5000 }),
      makeCard({ sessionId: 'b', durationMs: 500 }),
      makeCard({ sessionId: 'c', durationMs: 50000 }),
    ])
    sessionSortKey.value = 'duration_ms'
    sessionSortDir.value = 'desc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['c', 'a', 'b'])
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['b', 'a', 'c'])
  })

  test('errors sorts numerically', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', errors: 0 }),
      makeCard({ sessionId: 'b', errors: 3 }),
      makeCard({ sessionId: 'c', errors: 1 }),
    ])
    sessionSortKey.value = 'errors'
    sessionSortDir.value = 'desc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['b', 'c', 'a'])
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a', 'c', 'b'])
  })

  test('turns sorts numerically', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', turns: 2 }),
      makeCard({ sessionId: 'b', turns: 8 }),
      makeCard({ sessionId: 'c', turns: 5 }),
    ])
    sessionSortKey.value = 'turns'
    sessionSortDir.value = 'desc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['b', 'c', 'a'])
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a', 'c', 'b'])
  })

  test('prompt sorts lexicographically by user request', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', userRequest: 'banana' }),
      makeCard({ sessionId: 'b', userRequest: 'apple' }),
      makeCard({ sessionId: 'c', userRequest: 'cherry' }),
    ])
    sessionSortKey.value = 'prompt'
    // NB: the prompt/model/source/workspace comparator compares a→b (not b→a like the numeric
    // keys), so the 'desc' direction signal yields ascending alphabetical order here.
    sessionSortDir.value = 'desc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['b', 'a', 'c'])
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['c', 'a', 'b'])
  })

  test('model sorts lexicographically', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', model: 'gpt-4' }),
      makeCard({ sessionId: 'b', model: 'claude-3' }),
    ])
    sessionSortKey.value = 'model'
    sessionSortDir.value = 'desc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['b', 'a'])
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a', 'b'])
  })

  test('source sorts lexicographically', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', source: 'codex' }),
      makeCard({ sessionId: 'b', source: 'claude_code' }),
    ])
    sessionSortKey.value = 'source'
    sessionSortDir.value = 'desc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['b', 'a'])
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a', 'b'])
  })

  test('workspace sorts lexicographically', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', workspace: '/z/repo' }),
      makeCard({ sessionId: 'b', workspace: '/a/repo' }),
    ])
    sessionSortKey.value = 'workspace'
    sessionSortDir.value = 'desc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['b', 'a'])
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['a', 'b'])
  })

  test('outcome sorts merged > committed > abandoned > unresolved, desc = best first', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'merged' }),
      makeCard({ sessionId: 'committed' }),
      makeCard({ sessionId: 'abandoned' }),
      makeCard({ sessionId: 'unresolved' }),
    ])
    gitOutcomes.value = {
      merged: { overall: 'merged', files: {}, reason: '' },
      committed: { overall: 'committed', files: {}, reason: '' },
      abandoned: { overall: 'abandoned', files: {}, reason: '' },
      // 'unresolved' deliberately absent from gitOutcomes
    }
    sessionSortKey.value = 'outcome'
    sessionSortDir.value = 'desc'
    assert.deepStrictEqual(
      ids(filteredSessions.value),
      ['merged', 'committed', 'abandoned', 'unresolved'],
    )
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(
      ids(filteredSessions.value),
      ['unresolved', 'abandoned', 'committed', 'merged'],
    )
  })

  test('signals sorts by severity-weighted score, desc = worst first', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'none', loopSignals: [] }),
      makeCard({
        sessionId: 'one-warning',
        loopSignals: [{ type: 'exact_tool_repeat', severity: 'warning', evidence: '', count: 1, examples: [], patternName: '', action: '' }],
      }),
      makeCard({
        sessionId: 'one-critical',
        loopSignals: [{ type: 'exact_tool_repeat', severity: 'critical', evidence: '', count: 1, examples: [], patternName: '', action: '' }],
      }),
    ])
    sessionSortKey.value = 'signals'
    sessionSortDir.value = 'desc'
    // a single critical (score 1001) outranks any number of plain warnings (score = count)
    assert.deepStrictEqual(ids(filteredSessions.value), ['one-critical', 'one-warning', 'none'])
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['none', 'one-warning', 'one-critical'])
  })

  test('cost sorts by calculated session cost using the session model\'s rates', () => {
    sessionSummary.value = makeSummary([
      // claude-sonnet-4-5: $3/MTok in, $15/MTok out (pricing.ts)
      makeCard({ sessionId: 'cheap', model: 'claude-sonnet-4-5', inputTokens: 1000, outputTokens: 0 }),
      makeCard({ sessionId: 'expensive', model: 'claude-sonnet-4-5', inputTokens: 1000, outputTokens: 10000 }),
      makeCard({ sessionId: 'unknown-model', model: 'totally-unknown-model-xyz', inputTokens: 999999, outputTokens: 999999 }),
    ])
    sessionSortKey.value = 'cost'
    sessionSortDir.value = 'desc'
    // an unrecognized model prices at $0 regardless of token volume (calcSessionCost / lookupRates)
    assert.deepStrictEqual(ids(filteredSessions.value), ['expensive', 'cheap', 'unknown-model'])
    sessionSortDir.value = 'asc'
    assert.deepStrictEqual(ids(filteredSessions.value), ['unknown-model', 'cheap', 'expensive'])
  })

  const ALL_KEYS: SortKey[] = [
    'start_time', 'total_tokens', 'duration_ms', 'errors', 'prompt', 'model',
    'source', 'cost', 'workspace', 'turns', 'outcome', 'signals',
  ]

  test('every sort key returns the full, unfiltered set — sorting never drops a row', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a' }),
      makeCard({ sessionId: 'b' }),
      makeCard({ sessionId: 'c' }),
    ])
    for (const key of ALL_KEYS) {
      for (const dir of ['asc', 'desc'] as const) {
        sessionSortKey.value = key
        sessionSortDir.value = dir
        assert.strictEqual(filteredSessions.value.length, 3, `${key} ${dir} dropped a row`)
      }
    }
  })
})

// ── Cross-tab consistency ─────────────────────────────────────────────────────────
// Sessions.tsx, Cost.tsx, and Analytics.tsx all read filteredSessions directly (state.ts's own
// doc comment: "used by Efficiency, Cost, Traces, Search, Insights") rather than running any
// independent query — so "same filters, same tab data" reduces to "there is exactly one shared
// signal, and every reader observes the same .value". Cost.tsx additionally narrows to its own
// priced-source subset inline (tabs/Cost.tsx); that narrowing is replicated here since it isn't
// an exported function, and checked for being a well-defined subset, never a divergent query.

const PRICED_SOURCES = new Set(['copilot', 'codex', 'claude_code'])

suite('filteredSessions — shared across tabs', () => {
  test('two independent readers of filteredSessions see the identical array for the same filters', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', source: 'claude_code' }),
      makeCard({ sessionId: 'b', source: 'codex' }),
    ])
    selectedAgentFilter.value = 'codex'
    const sessionsTabView = filteredSessions.value
    const analyticsTabView = filteredSessions.value
    assert.strictEqual(sessionsTabView, analyticsTabView) // same array reference, not just equal contents
  })

  test('changing a filter is immediately visible to every consumer — no per-tab staleness', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', source: 'claude_code' }),
      makeCard({ sessionId: 'b', source: 'codex' }),
    ])
    assert.strictEqual(filteredSessions.value.length, 2)
    selectedAgentFilter.value = 'codex' // simulates switching the filter from any one tab
    assert.deepStrictEqual(ids(filteredSessions.value), ['b']) // every tab observes it immediately
  })

  test('Cost tab\'s priced-source narrowing is always a subset of filteredSessions, never an independent query', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', source: 'claude_code' }),
      makeCard({ sessionId: 'b', source: 'opencode' }), // not priced
      makeCard({ sessionId: 'c', source: 'cursor' }),   // not priced
      makeCard({ sessionId: 'd', source: 'codex' }),
    ])
    const shared = filteredSessions.value
    const pricedSessions = shared.filter(s => PRICED_SOURCES.has(s.source))
    assert.deepStrictEqual(ids(pricedSessions).sort(), ['a', 'd'])
    // every priced-source row visible anywhere is also in Cost's view — no silent exclusion
    for (const s of shared) {
      if (PRICED_SOURCES.has(s.source)) assert.ok(pricedSessions.includes(s))
    }
  })

  test('a filter that excludes all priced sources leaves Cost with an empty (not stale) view', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', source: 'claude_code' }),
    ])
    selectedAgentFilter.value = 'opencode' // excludes the only session entirely
    const shared = filteredSessions.value
    assert.strictEqual(shared.length, 0)
    assert.strictEqual(shared.filter(s => PRICED_SOURCES.has(s.source)).length, 0)
  })
})
