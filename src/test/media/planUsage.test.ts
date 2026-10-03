import * as assert from 'assert'
import './domShim'
import { makeCard } from './fixtures'
import {
  chart1Views, chart2Rollups, defaultChart1View, fiveHourLines, forAgentFilter, hasPlanData, limitUsedLabel, planLimitWindows,
  showLimitColumn, weeklyPointsFor, windowlessPlans, type PlanUsageSnapshot, type LimitHit, type WindowRollup,
} from '../../../media/src/planUsage'
import { getCostSavingActions } from '../../../media/src/costSavingActions'

const T0 = Date.parse('2026-09-28T00:00:00.000Z')
const HOUR = 3_600_000

function empty(): PlanUsageSnapshot {
  return {
    generatedAt: T0, meters: [], sessions: {}, series: { weekly: [], fiveHour: [] }, hits: [],
    weeklyRollups: [], historyStartsAt: {}, weeklyPtsPerDollar: {},
  }
}

function hit(provider: 'claude' | 'codex', windowKind: 'five_hour' | 'weekly', t: number): LimitHit {
  return { provider, sessionId: 's', windowKind, hitAt: t, resetsAt: t + HOUR }
}

function rollup(provider: 'claude' | 'codex', end: number, peak: number): WindowRollup {
  return { provider, accountHash: '', windowKind: 'weekly', windowEnd: end, peakPct: peak, hit: false, coverage: 'full' }
}

const codexOnly = (): PlanUsageSnapshot => ({
  ...empty(),
  meters: [{ provider: 'codex', planType: 'plus', observedAt: T0, approximate: false, windows: [
    { windowKind: 'five_hour', usedPct: 23, resetsAt: T0 + HOUR, observedAt: T0, resetSinceReading: false },
    { windowKind: 'weekly', usedPct: 38, resetsAt: T0 + 50 * HOUR, observedAt: T0, resetSinceReading: false },
  ] }],
  series: {
    weekly: [{ provider: 'codex', windowKind: 'weekly', approximate: false, points: [{ t: T0 - HOUR, pct: 30 }, { t: T0, pct: 38 }] }],
    fiveHour: [{ provider: 'codex', windowKind: 'five_hour', approximate: false, points: [{ t: T0 - HOUR, pct: 10 }, { t: T0, pct: 23 }] }],
  },
  sessions: { 'codex-1': { fiveHourPct: 12.4, weeklyPct: 0.4, approximate: false } },
})

suite('planUsage — no data, no UI', () => {
  test('nothing renders without a snapshot or with an empty one', () => {
    assert.strictEqual(hasPlanData(null), false)
    assert.strictEqual(hasPlanData(empty()), false)
    assert.deepStrictEqual(chart1Views(empty()), [])
    assert.strictEqual(defaultChart1View(empty()), null)
    assert.deepStrictEqual(chart2Rollups(empty()), [])
    assert.strictEqual(showLimitColumn([makeCard({ sessionId: 'x' })], empty()), false)
  })

  test('the Limit used label is blank without a value, ≈ when approximate, <1% for tiny shares', () => {
    assert.strictEqual(limitUsedLabel(undefined), null)
    assert.strictEqual(limitUsedLabel({ approximate: false }), null)
    assert.strictEqual(limitUsedLabel({ fiveHourPct: 12.4, weeklyPct: 0.4, approximate: false }), '5h 12%')
    assert.strictEqual(limitUsedLabel({ weeklyPct: 3, approximate: true }), '≈ wk 3%')
    assert.strictEqual(limitUsedLabel({ weeklyPct: 0, approximate: true }), '≈ wk 0%')
    // The cell shows one window; the detail lists both.
    assert.deepStrictEqual(planLimitWindows({ fiveHourPct: 12.4, weeklyPct: 0.4, approximate: false }), [
      { label: '5-hour', pct: '12%' }, { label: 'Weekly', pct: '<1%' },
    ])
    assert.deepStrictEqual(planLimitWindows(undefined), [])
  })

  test('the column shows only when a session in view has a value or a hit', () => {
    const s = codexOnly()
    assert.strictEqual(showLimitColumn([makeCard({ sessionId: 'codex-1' })], s), true)
    assert.strictEqual(showLimitColumn([makeCard({ sessionId: 'other' })], s), false)
    s.sessions['hit-only'] = { approximate: false, hits: [hit('claude', 'five_hour', T0)] }
    assert.strictEqual(showLimitColumn([makeCard({ sessionId: 'hit-only' })], s), true)
  })

  test("Claude never gets a 5-hour line, but its hits still make the view available", () => {
    const s = empty()
    s.series.fiveHour = [{ provider: 'claude', windowKind: 'five_hour', approximate: true, points: [{ t: T0, pct: 40 }] }]
    s.series.weekly = [{ provider: 'claude', windowKind: 'weekly', approximate: true, points: [{ t: T0, pct: 31 }] }]
    assert.deepStrictEqual(fiveHourLines(s), [])
    assert.deepStrictEqual(chart1Views(s), ['weekly'])
    s.hits = [hit('claude', 'five_hour', T0)]
    assert.deepStrictEqual(chart1Views(s), ['weekly', 'five_hour'])
  })

  test('the 5-hour view is the default only for users who keep hitting it', () => {
    const s = codexOnly()
    assert.deepStrictEqual(chart1Views(s), ['weekly', 'five_hour'])
    assert.strictEqual(defaultChart1View(s), 'weekly')
    s.hits = [hit('codex', 'five_hour', T0 - 48 * HOUR)]
    assert.strictEqual(defaultChart1View(s), 'weekly')
    s.hits.push(hit('codex', 'five_hour', T0 - 2 * HOUR))
    assert.strictEqual(defaultChart1View(s), 'five_hour')
  })

  test('a view with only weekly data offers no toggle', () => {
    const s = codexOnly()
    s.series.fiveHour = []
    assert.deepStrictEqual(chart1Views(s), ['weekly'])
  })

  test('the week-over-week chart needs two completed windows for some agent', () => {
    const s = empty()
    s.weeklyRollups = [rollup('codex', T0, 40)]
    assert.deepStrictEqual(chart2Rollups(s), [])
    s.weeklyRollups.push(rollup('codex', T0 + 168 * HOUR, 30), rollup('claude', T0, 50))
    assert.deepStrictEqual(chart2Rollups(s).map(r => r.provider), ['codex', 'codex'])
  })

  test('a plan that reports no windows still shows the section, as its own card', () => {
    const business: PlanUsageSnapshot = { ...empty(), planStatus: [
      { provider: 'codex', planType: 'business', observedAt: T0, noWindows: true, hasCredits: true, limitReached: false },
    ] }
    assert.strictEqual(hasPlanData(business), true)
    assert.deepStrictEqual(windowlessPlans(business).map(s => s.planType), ['business'])
    assert.strictEqual(hasPlanData(forAgentFilter(business, 'claude_code')), false)
    // A provider with a meter shows its plan there, not as a second card.
    const withMeter: PlanUsageSnapshot = { ...codexOnly(), planStatus: business.planStatus }
    assert.deepStrictEqual(windowlessPlans(withMeter), [])
    // A plan that does report windows never gets the card.
    assert.strictEqual(hasPlanData({ ...empty(), planStatus: [{ ...business.planStatus![0], noWindows: false }] }), false)
  })

  test('the agent filter narrows to that agent, and hides everything for agents without plan data', () => {
    const s = codexOnly()
    assert.strictEqual(forAgentFilter(s, 'all'), s)
    assert.strictEqual(forAgentFilter(s, 'copilot'), null)
    assert.strictEqual(hasPlanData(forAgentFilter(s, 'claude_code')), false)
    assert.deepStrictEqual(forAgentFilter(s, 'codex')!.meters.map(m => m.provider), ['codex'])
  })
})

suite('Cost-saving actions in plan-limit points', () => {
  const reread = (wasteUsd: number) => ({
    type: 'file_reread' as const, severity: 'warning' as const, evidence: 'e', count: 3, examples: [],
    patternName: 'File Re-read Loop', action: 'Add it to CLAUDE.md', wasteUsd,
  })

  test('points appear only for subscription sessions and only with enough history', () => {
    const sessions = [makeCard({ sessionId: 'codex-1', source: 'codex', loopSignals: [reread(2)] })]
    const noHistory = getCostSavingActions(sessions, '', codexOnly())
    const action = noHistory.find(a => a.id === 'loop_signal:file_reread')!
    assert.strictEqual(action.estimatedUsd, 2)
    assert.strictEqual(action.limitPts, undefined)

    const withHistory = { ...codexOnly(), weeklyPtsPerDollar: { codex: 1.5 } }
    assert.strictEqual(getCostSavingActions(sessions, '', withHistory).find(a => a.id === 'loop_signal:file_reread')!.limitPts, 3)
    assert.strictEqual(weeklyPointsFor(withHistory, 'claude', 2), undefined)

    const apiSession = [makeCard({ sessionId: 'not-on-plan', source: 'codex', loopSignals: [reread(2)] })]
    assert.strictEqual(getCostSavingActions(apiSession, '', withHistory).find(a => a.id === 'loop_signal:file_reread')!.limitPts, undefined)
  })

  test('actions measured in points lead, largest first', () => {
    const cacheMiss = { ...reread(1), type: 'cache_miss' as const, patternName: 'Avoidable Cache Miss' }
    const sessions = [
      makeCard({ sessionId: 'codex-1', source: 'codex', loopSignals: [reread(1), cacheMiss] }),
      makeCard({ sessionId: 'codex-2', source: 'codex', loopSignals: [{ ...cacheMiss, wasteUsd: 4 }] }),
    ]
    const snap = { ...codexOnly(), weeklyPtsPerDollar: { codex: 1 } }
    snap.sessions['codex-2'] = { weeklyPct: 5, approximate: false }
    const ids = getCostSavingActions(sessions, '', snap).map(a => a.id)
    assert.deepStrictEqual(ids.slice(0, 2), ['loop_signal:cache_miss', 'loop_signal:file_reread'])
  })
})
