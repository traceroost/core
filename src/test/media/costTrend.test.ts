import * as assert from 'assert'
import './domShim'
import { buildDayBins, describeChange, costHeadline, periodLabel, previousLabel } from '../../../media/src/costTrend'
import type { SessionSummaryCard } from '../../../media/src/types'

const fmt = (v: number) => `$${v.toFixed(2)}`

function trace(i: number, iso: string, source = 'claude_code', model = 'claude-sonnet-4-5'): SessionSummaryCard {
  return {
    sessionId: `s${i}`, traceId: `t${i}`, source, workspace: '/r', model,
    inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0,
    startTime: iso, totalLlmCalls: 3, errors: 0, loopSignals: [],
  } as unknown as SessionSummaryCard
}

suite('media — Cost & limits: cost and tokens per day', () => {
  test('bins are dense UTC days: an empty day in the middle is a bin with nothing in it', () => {
    const { bins, unit } = buildDayBins([trace(1, '2026-11-01T10:00:00Z'), trace(2, '2026-11-03T10:00:00Z', 'codex', 'gpt-5')])
    assert.strictEqual(unit, 'day')
    assert.deepStrictEqual(bins.map(b => b.start), ['2026-11-01', '2026-11-02', '2026-11-03'])
    assert.strictEqual(bins[1].traces, 0)
    assert.strictEqual(bins[1].cost, 0)
    assert.ok((bins[0].costBySource.claude_code ?? 0) > 0)
    assert.ok((bins[2].costBySource.codex ?? 0) > 0)
    assert.strictEqual(bins[0].tokensIn, 1000)
    assert.strictEqual(bins[0].tokensOut, 100)
  })

  test('past 56 days the bins are whole Monday-start weeks', () => {
    const { unit, bins } = buildDayBins([trace(1, '2026-08-01T10:00:00Z'), trace(2, '2026-11-01T10:00:00Z')])
    assert.strictEqual(unit, 'week')
    assert.strictEqual(new Date(bins[0].start + 'T00:00:00Z').getUTCDay(), 1)
  })

  test('an unrecognised model counts toward tokens and traces, not cost', () => {
    const { bins } = buildDayBins([trace(1, '2026-11-01T10:00:00Z', 'claude_code', 'no-such-model-xyz')])
    assert.strictEqual(bins[0].traces, 1)
    assert.strictEqual(bins[0].pricedTraces, 0)
    assert.strictEqual(bins[0].cost, 0)
  })

  test('change: under 5% is about the same; nothing to compare against gives null', () => {
    assert.strictEqual(describeChange(118, 100), 'up 18%')
    assert.strictEqual(describeChange(96, 100), 'about the same')
    assert.strictEqual(describeChange(80, 100), 'down 20%')
    assert.strictEqual(describeChange(50, 0), null)
  })

  test('headline: all time has no comparison; a bounded range compares with the period before', () => {
    assert.strictEqual(costHeadline({ preset: 'all' }, { cost: 10, pricedTraces: 4 }, null, fmt), '$10.00 across all traces. $2.50 per trace.')
    const since = Date.UTC(2026, 10, 17)
    assert.strictEqual(
      costHeadline({ preset: '7d', since }, { cost: 118, pricedTraces: 50 }, { cost: 100, pricedTraces: 40 }, fmt),
      '$118.00 over the last 7 days; up 18% from the 7 days before ($100.00). $2.36 per trace, down 6%.',
    )
    // No previous data (not loaded, or nothing priced): the comparison is left out, not printed as a wrong %.
    assert.strictEqual(costHeadline({ preset: '7d', since }, { cost: 5, pricedTraces: 2 }, null, fmt), '$5.00 over the last 7 days. $2.50 per trace.')
    assert.strictEqual(costHeadline({ preset: '7d', since }, { cost: 5, pricedTraces: 2 }, { cost: 0, pricedTraces: 0 }, fmt), '$5.00 over the last 7 days. $2.50 per trace.')
  })

  test('custom ranges name their dates and their length', () => {
    const since = new Date(2026, 10, 1).getTime()
    const until = new Date(2026, 10, 15).getTime()
    assert.strictEqual(periodLabel({ preset: 'custom', since, until }), 'Nov 1 to Nov 15')
    assert.strictEqual(previousLabel({ preset: 'custom', since, until }), 'the 14 days before')
  })
})
