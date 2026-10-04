import * as assert from 'assert'
import './domShim'
import { makeCard, makeSummary } from './fixtures'
import {
  sessionSummary, filteredSessions, selectedAgentFilter, languageFilter, dataSourceFilter, workspaceFilter,
  outcomeFilter, gitOutcomes, timeRange, rangedSearchResults, sessionSortKey, sessionSortDir,
} from '../../../media/src/state'
import { buildCodeChangeBins, hasLineData } from '../../../media/src/tabs/codeChanges'
import { buildTrendBins, WEEKLY_AFTER_DAYS } from '../../../media/src/tabs/outcomeTrend'

// Analytics → Code changes over time (media/src/tabs/codeChanges.ts): agent-authored lines and
// files per day/week, from the same filtered set as the neighbouring charts.

const day = (d: string, h = 10) => `${d}T${String(h).padStart(2, '0')}:00:00.000Z`

suite('media — Code changes over time', () => {
  setup(() => {
    sessionSummary.value = makeSummary([])
    selectedAgentFilter.value = 'all'
    languageFilter.value = 'all'
    dataSourceFilter.value = 'all'
    workspaceFilter.value = ''
    outcomeFilter.value = 'all'
    gitOutcomes.value = {}
    timeRange.value = { preset: 'all' }
    rangedSearchResults.value = null
    sessionSortKey.value = 'start_time'
    sessionSortDir.value = 'desc'
  })
  teardown(() => {
    selectedAgentFilter.value = 'all'
    languageFilter.value = 'all'
    dataSourceFilter.value = 'all'
    workspaceFilter.value = ''
    outcomeFilter.value = 'all'
    gitOutcomes.value = {}
  })

  test('sums lines and files per UTC day, gap-free, with totals', () => {
    const t = buildCodeChangeBins([
      makeCard({ sessionId: 'a', startTime: day('2026-05-01', 9), filesChangedCount: 2, linesAdded: 10, linesRemoved: 3 }),
      makeCard({ sessionId: 'b', startTime: day('2026-05-01', 23), filesChangedCount: 1, linesAdded: 5, linesRemoved: 0 }),
      makeCard({ sessionId: 'c', startTime: day('2026-05-03'), filesChangedCount: 4, linesAdded: 0, linesRemoved: 40 }),
    ])
    assert.strictEqual(t.unit, 'day')
    assert.deepStrictEqual(t.bins.map(b => [b.start, b.added, b.removed, b.files, b.traces]), [
      ['2026-05-01', 15, 3, 3, 2],
      ['2026-05-02', 0, 0, 0, 0],
      ['2026-05-03', 0, 40, 4, 1],
    ])
    assert.deepStrictEqual(t.total, { added: 15, removed: 43, files: 7, traces: 3 })
    assert.strictEqual(t.excluded, 0)
  })

  test('traces without line data are excluded and counted, never summed as 0', () => {
    const t = buildCodeChangeBins([
      makeCard({ sessionId: 'known', startTime: day('2026-05-01'), filesChangedCount: 1, linesAdded: 7, linesRemoved: 2 }),
      // Agent records no edit contents: files known, lines "?".
      makeCard({ sessionId: 'unknown-lines', startTime: day('2026-05-01'), filesChangedCount: 9 }),
      // Stored before change-size tracking: nothing recorded.
      makeCard({ sessionId: 'old', startTime: day('2026-05-02') }),
    ])
    assert.deepStrictEqual(t.bins.map(b => [b.start, b.added, b.removed, b.files, b.traces]), [['2026-05-01', 7, 2, 1, 1]])
    assert.strictEqual(t.excluded, 2)
    assert.strictEqual(hasLineData(makeCard({ filesChangedCount: 0, linesAdded: 0, linesRemoved: 0 })), true)
    assert.strictEqual(hasLineData(makeCard({ linesAdded: 1 })), false)
  })

  test('a trace that changed nothing counts as a real 0 / 0', () => {
    const t = buildCodeChangeBins([makeCard({ startTime: day('2026-05-01'), filesChangedCount: 0, linesAdded: 0, linesRemoved: 0 })])
    assert.deepStrictEqual(t.total, { added: 0, removed: 0, files: 0, traces: 1 })
    assert.strictEqual(t.bins.length, 1)
  })

  test('empty when nothing has data; undatable traces are left off the axis', () => {
    assert.deepStrictEqual(buildCodeChangeBins([]), { bins: [], unit: 'day', total: { added: 0, removed: 0, files: 0, traces: 0 }, excluded: 0 })
    const none = buildCodeChangeBins([makeCard({ sessionId: 'x' }), makeCard({ sessionId: 'y', filesChangedCount: 3 })])
    assert.strictEqual(none.bins.length, 0)
    assert.strictEqual(none.excluded, 2)
    const bad = buildCodeChangeBins([
      makeCard({ sessionId: 'ok', startTime: day('2026-05-01'), filesChangedCount: 1, linesAdded: 1, linesRemoved: 0 }),
      makeCard({ sessionId: 'bad', startTime: 'garbage', filesChangedCount: 1, linesAdded: 99, linesRemoved: 0 }),
    ])
    assert.deepStrictEqual(bad.bins.map(b => [b.start, b.added]), [['2026-05-01', 1]])
  })

  test('switches to Monday-start weeks past WEEKLY_AFTER_DAYS — the same bins as Outcome & token spend', () => {
    const first = '2026-01-07' // a Wednesday
    const lastMs = Date.parse(day(first)) + WEEKLY_AFTER_DAYS * 86_400_000
    const last = new Date(lastMs).toISOString().slice(0, 10)
    const cards = [
      makeCard({ sessionId: 'f', startTime: day(first), filesChangedCount: 1, linesAdded: 1, linesRemoved: 1 }),
      makeCard({ sessionId: 'l', startTime: day(last), filesChangedCount: 1, linesAdded: 2, linesRemoved: 0 }),
    ]
    const t = buildCodeChangeBins(cards)
    assert.strictEqual(t.unit, 'week')
    assert.strictEqual(t.bins[0].start, '2026-01-05')
    assert.strictEqual(t.bins[t.bins.length - 1].end, last)
    assert.strictEqual(t.bins.reduce((n, b) => n + b.traces, 0), 2)
    const outcome = { overall: 'committed' as const, files: {}, reason: '' }
    const trend = buildTrendBins(cards, { f: outcome, l: outcome })
    assert.deepStrictEqual(t.bins.map(b => [b.start, b.end]), trend.bins.map(b => [b.start, b.end]))
  })

  test('fed from filteredSessions, it follows agent, language, source, repo and outcome filters', () => {
    const card = (sessionId: string, o: Parameters<typeof makeCard>[0]) =>
      makeCard({ sessionId, startTime: day('2026-05-01'), filesChangedCount: 1, linesAdded: 10, linesRemoved: 1, ...o })
    sessionSummary.value = makeSummary([
      card('claude-ts', { source: 'claude_code', language: 'typescript', workspace: '/repo/a', dataSource: 'otel' }),
      card('codex-py', { source: 'codex', language: 'python', workspace: '/repo/b', dataSource: 'log', linesAdded: 100 }),
      card('codex-unknown', { source: 'codex', language: 'python', workspace: '/repo/b', dataSource: 'log', linesAdded: undefined, linesRemoved: undefined }),
    ])
    const added = () => buildCodeChangeBins(filteredSessions.value).total.added
    const excluded = () => buildCodeChangeBins(filteredSessions.value).excluded
    assert.strictEqual(added(), 110)
    assert.strictEqual(excluded(), 1)

    selectedAgentFilter.value = 'claude_code'
    assert.strictEqual(added(), 10)
    assert.strictEqual(excluded(), 0)
    selectedAgentFilter.value = 'all'

    languageFilter.value = 'python'
    assert.strictEqual(added(), 100)
    assert.strictEqual(excluded(), 1)
    languageFilter.value = 'all'

    dataSourceFilter.value = 'otel'
    assert.strictEqual(added(), 10)
    dataSourceFilter.value = 'all'

    workspaceFilter.value = '/repo/b'
    assert.strictEqual(added(), 100)
    workspaceFilter.value = ''

    gitOutcomes.value = { 'claude-ts': { overall: 'committed', files: {}, reason: '' }, 'codex-py': null, 'codex-unknown': null }
    outcomeFilter.value = 'committed'
    assert.strictEqual(added(), 10)
  })
})
