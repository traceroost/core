import * as assert from 'assert'
import './domShim'
import {
  changeWindows, windowStats, measureChange, changeVerdict, changeHeadline, verdictSummary, describeMeasure,
  MIN_SIDE_TRACES, BEFORE_DAYS,
} from '../../../media/src/changeMeasures'
import type { SessionSummaryCard } from '../../../media/src/types'

const DAY = 86_400_000
const AT = Date.UTC(2026, 10, 1)

function trace(i: number, startMs: number, over: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: `s${i}`, traceId: `t${i}`, source: 'claude_code', workspace: '/r', model: 'claude-sonnet-5-5',
    inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheCreateTokens: 0, cacheHitRate: 0.5,
    startTime: new Date(startMs).toISOString(), totalLlmCalls: 10, errors: 0, loopSignals: [],
    ...over,
  } as unknown as SessionSummaryCard
}

const side = (n: number, from: number, step: number, over: Partial<SessionSummaryCard> = {}) =>
  Array.from({ length: n }, (_, i) => trace(from + i, AT + step * (i + 1), over))

suite('media — measuring an applied suggestion (cloud parity)', () => {
  test('windows: 60 days before (newest first), everything from the change on', () => {
    const old = trace(0, AT - (BEFORE_DAYS + 1) * DAY)
    const before = trace(1, AT - DAY)
    const after = trace(2, AT + DAY)
    const w = changeWindows([old, after, before], AT)
    assert.deepStrictEqual(w.before.map(s => s.sessionId), ['s1'])
    assert.deepStrictEqual(w.after.map(s => s.sessionId), ['s2'])
  })

  test('under 10 traces a side is "measuring", with no measures and a count of what is missing', () => {
    const c = measureChange(windowStats(side(4, 0, -DAY), () => null), windowStats(side(12, 100, DAY), () => null))
    assert.strictEqual(c.confidence, 'insufficient')
    assert.deepStrictEqual(c.measures, [])
    assert.strictEqual(changeVerdict(c), 'measuring')
    assert.match(changeHeadline(c), new RegExp(`needs ${MIN_SIDE_TRACES} traces on each side \\(4 before, 12 after`))
  })

  test('fewer turns per trace reads as better, per trace not in total', () => {
    // Twice as many traces after, each with half the turns: total turns flat, per trace −50%.
    const before = windowStats(side(10, 0, -DAY, { totalLlmCalls: 20 }), () => null)
    const after = windowStats(side(20, 100, DAY, { totalLlmCalls: 10 }), () => null)
    const c = measureChange(before, after)
    assert.strictEqual(c.confidence, 'medium')
    const turns = c.measures.find(m => m.id === 'turns')!
    assert.strictEqual(turns.before, 20)
    assert.strictEqual(turns.after, 10)
    assert.strictEqual(describeMeasure(turns), 'turns per trace −50%')
    assert.strictEqual(changeVerdict(c), 'better')
    assert.match(changeHeadline(c), /^Since then, turns per trace −50%/)
  })

  test('moves under 5% are "about the same", and landed uses git outcomes', () => {
    const outcomes: Record<string, 'merged' | 'abandoned'> = {}
    const before = side(10, 0, -DAY, { totalLlmCalls: 100 })
    const after = side(40, 100, DAY, { totalLlmCalls: 102 })
    before.forEach((s, i) => { outcomes[s.sessionId] = i < 5 ? 'merged' : 'abandoned' })
    after.forEach((s, i) => { outcomes[s.sessionId] = i < 30 ? 'merged' : 'abandoned' })
    const c = measureChange(windowStats(before, s => outcomes[s.sessionId]), windowStats(after, s => outcomes[s.sessionId]))
    assert.strictEqual(c.confidence, 'high')
    assert.strictEqual(c.measures.find(m => m.id === 'turns')!.flat, true)
    const landed = c.measures.find(m => m.id === 'landed')!
    assert.strictEqual(landed.before, 0.5)
    assert.strictEqual(landed.after, 0.75)
    assert.strictEqual(describeMeasure(landed), 'landed +25 pts')
  })

  test('a model-mix shift of 20 points or more is flagged', () => {
    const c = measureChange(
      windowStats(side(10, 0, -DAY, { model: 'a' }), () => null),
      windowStats(side(10, 100, DAY, { model: 'b' }), () => null),
    )
    assert.ok(c.modelShift)
  })

  test('the summary counts verdicts', () => {
    assert.strictEqual(verdictSummary(['better', 'better', 'flat', 'measuring']), '3 changes measured: 2 better, 1 about the same; 1 still measuring.')
    assert.strictEqual(verdictSummary(['measuring']), 'No change has enough traces to measure yet.')
    assert.strictEqual(verdictSummary([]), null)
  })
})
