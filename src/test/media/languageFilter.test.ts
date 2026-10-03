import * as assert from 'assert'
import './domShim'
import { makeCard, makeSummary } from './fixtures'
import {
  sessionSummary, filteredSessions, selectedAgentFilter, languageFilter, timeRange, rangedSearchResults,
  sessionSortKey, sessionSortDir, makeTimeRange, matchesLanguageFilter,
} from '../../../media/src/state'
import { buildLanguageBreakdown } from '../../../media/src/tabs/languageBreakdown'

function ids(cards: { sessionId: string }[]): string[] {
  return cards.map(c => c.sessionId).sort()
}

suite('media — Language filter and breakdown', () => {
  setup(() => {
    sessionSummary.value = makeSummary([])
    selectedAgentFilter.value = 'all'
    languageFilter.value = 'all'
    timeRange.value = { preset: 'all' }
    rangedSearchResults.value = null
    sessionSortKey.value = 'start_time'
    sessionSortDir.value = 'desc'
  })
  teardown(() => { languageFilter.value = 'all' })

  const cards = () => [
    makeCard({ sessionId: 'py', language: 'python', languageSecondary: null }),
    makeCard({ sessionId: 'ts-py', language: 'typescript', languageSecondary: 'python' }),
    makeCard({ sessionId: 'go', language: 'go', languageSecondary: null, source: 'codex' }),
    makeCard({ sessionId: 'docs', language: 'none', languageSecondary: null }),
    makeCard({ sessionId: 'old' }),
  ]

  test('matches primary or secondary; unrecorded rows only match All', () => {
    sessionSummary.value = makeSummary(cards())
    assert.strictEqual(filteredSessions.value.length, 5)
    languageFilter.value = 'python'
    assert.deepStrictEqual(ids(filteredSessions.value), ['py', 'ts-py'])
    languageFilter.value = 'none'
    assert.deepStrictEqual(ids(filteredSessions.value), ['docs'])
    languageFilter.value = 'rust'
    assert.deepStrictEqual(ids(filteredSessions.value), [])
    assert.strictEqual(matchesLanguageFilter({}, 'all'), true)
    assert.strictEqual(matchesLanguageFilter({}, 'python'), false)
  })

  test('combines with the agent filter', () => {
    sessionSummary.value = makeSummary(cards())
    languageFilter.value = 'go'
    selectedAgentFilter.value = 'claude_code'
    assert.deepStrictEqual(ids(filteredSessions.value), [])
    selectedAgentFilter.value = 'codex'
    assert.deepStrictEqual(ids(filteredSessions.value), ['go'])
  })

  test('applies to DB results merged for a bounded time range too', () => {
    const now = Date.now()
    timeRange.value = makeTimeRange('24h')
    rangedSearchResults.value = {
      sessions: [
        makeCard({ sessionId: 'db-rust', language: 'rust', startTime: new Date(now - 60_000).toISOString() }),
        makeCard({ sessionId: 'db-java', language: 'java', startTime: new Date(now - 90_000).toISOString() }),
      ],
      totalCount: 2,
      offset: 0,
    }
    languageFilter.value = 'rust'
    assert.deepStrictEqual(ids(filteredSessions.value), ['db-rust'])
  })

  test('sorting by language and by lines changed', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'b', language: 'python', linesAdded: 1, linesRemoved: 1 }),
      makeCard({ sessionId: 'a', language: 'go', linesAdded: 50, linesRemoved: 0 }),
      makeCard({ sessionId: 'z' }),
    ])
    sessionSortKey.value = 'language'
    assert.deepStrictEqual(filteredSessions.value.map(s => s.sessionId), ['a', 'b', 'z'])
    sessionSortKey.value = 'lines'
    assert.deepStrictEqual(filteredSessions.value.map(s => s.sessionId), ['a', 'b', 'z'])
  })

  test('buildLanguageBreakdown groups by primary language with counts and change size', () => {
    const rows = buildLanguageBreakdown([
      makeCard({ sessionId: '1', language: 'python', inputTokens: 10, outputTokens: 5, filesChangedCount: 2, linesAdded: 7, linesRemoved: 1 }),
      makeCard({ sessionId: '2', language: 'python', languageSecondary: 'go', inputTokens: 1, outputTokens: 1, loopSignals: [{ type: 'file_reread', severity: 'warning', description: '', evidence: [] } as never] }),
      makeCard({ sessionId: '3', language: 'go' }),
      makeCard({ sessionId: '4' }),
    ])
    assert.deepStrictEqual(rows.map(r => [r.language, r.sessions]), [['python', 2], ['go', 1], ['unrecorded', 1]])
    const py = rows[0]
    assert.strictEqual(py.tokens, 17)
    assert.strictEqual(py.withSignals, 1)
    assert.deepStrictEqual([py.filesChanged, py.linesAdded, py.linesRemoved], [2, 7, 1])
  })
})
