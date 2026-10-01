import * as assert from 'assert'
import { computeBaseline, computeEffectiveness, computePostMetrics } from '../instructionEffectiveness'
import { calcSessionCostUsd } from '../pricing'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'
import type { LoopSignal } from '../types'

const APPLIED_AT = Date.parse('2026-03-01T00:00:00.000Z')
const HOUR = 3_600_000
const LOOP: LoopSignal = { type: 'exact_tool_repeat', severity: 'warning', evidence: 'x', count: 3, examples: [], patternName: 'x', action: 'x' }

function card(i: number, offsetHours: number, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: `s${i}`, traceId: `t${i}`, source: 'claude_code', dataSource: 'otel', workspace: '/ws',
    userRequest: 'task', model: 'claude-sonnet-4-5', turns: 1,
    inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0,
    durationMs: 1000, startTime: new Date(APPLIED_AT + offsetHours * HOUR).toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [], toolCounts: {},
    totalToolCalls: 0, totalLlmCalls: 10, errors: 0, outcome: 'text_response', timeline: [],
    backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

/** n sessions before the apply time (hours -1, -2, …). */
function before(n: number, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard[] {
  return Array.from({ length: n }, (_, i) => card(100 + i, -(i + 1), overrides))
}

/** n sessions at or after the apply time (hours 0, 1, …). */
function after(n: number, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard[] {
  return Array.from({ length: n }, (_, i) => card(200 + i, i, overrides))
}

suite('instructionEffectiveness', () => {
  test('baseline under five prior sessions is flagged insufficient with zeroed metrics', () => {
    const b = computeBaseline([...before(4), ...after(10)], APPLIED_AT)
    assert.deepStrictEqual(b, { sessionCount: 4, costAvg: 0, turnsAvg: 0, errorRate: 0, loopRate: 0, insufficient: true })
  })

  test('baseline averages only the most recent window of prior sessions, ignoring undated ones', () => {
    const recent = before(3, { totalLlmCalls: 4, errors: 1 })
    const loopy = [card(1, -4, { totalLlmCalls: 4, errors: 1, loopSignals: [LOOP] }), card(2, -5, { totalLlmCalls: 4, errors: 1, loopSignals: [LOOP] })]
    const old = Array.from({ length: 5 }, (_, i) => card(300 + i, -(100 + i), { totalLlmCalls: 100, errors: 9 }))
    const undated = card(999, 0, { startTime: '' })
    const b = computeBaseline([...recent, ...loopy, ...old, undated], APPLIED_AT, 5)
    assert.strictEqual(b.sessionCount, 5)
    assert.strictEqual(b.insufficient, false)
    assert.strictEqual(b.turnsAvg, 4, 'the five newest prior sessions, not the 100-turn old ones')
    assert.strictEqual(b.errorRate, 1)
    assert.strictEqual(b.loopRate, 2 / 5)
    assert.strictEqual(b.costAvg, calcSessionCostUsd(recent[0]))
  })

  test('post metrics need at least three sessions at or after the apply time', () => {
    assert.strictEqual(computePostMetrics([...before(10), ...after(2)], APPLIED_AT), null)
    const post = computePostMetrics([...before(10), ...after(3, { totalLlmCalls: 6, errors: 2 })], APPLIED_AT)
    assert.deepStrictEqual(post && { n: post.sessionCount, turns: post.turnsAvg, errors: post.errorRate, loops: post.loopRate },
      { n: 3, turns: 6, errors: 2, loops: 0 })
  })

  test('change percentages compare post against baseline', () => {
    const r = computeEffectiveness([
      ...before(10, { totalLlmCalls: 10, errors: 2 }),
      ...after(4, { totalLlmCalls: 5, errors: 1, inputTokens: 500, outputTokens: 50 }),
    ], APPLIED_AT)
    assert.strictEqual(r.confidence, 'low')
    assert.strictEqual(r.turnsChangePct, -50)
    assert.strictEqual(r.errorChangePct, -50)
    // Cost goes through the shared pricing table; assert against it rather than hard-coding rates.
    const b = calcSessionCostUsd(before(1)[0])
    const a = calcSessionCostUsd(after(1, { inputTokens: 500, outputTokens: 50 })[0])
    assert.ok(b > 0, 'the fixture model is priced')
    assert.ok(Math.abs((r.costChangePct ?? NaN) - ((a - b) / b) * 100) < 1e-9)
  })

  test('a zero baseline yields null change rather than Infinity', () => {
    const r = computeEffectiveness([...before(6, { errors: 0 }), ...after(3, { errors: 2 })], APPLIED_AT)
    assert.strictEqual(r.errorChangePct, null)
    assert.strictEqual(r.turnsChangePct, 0)
  })

  test('no change percentages when the baseline is insufficient or post data is missing', () => {
    const thinBaseline = computeEffectiveness([...before(2), ...after(5)], APPLIED_AT)
    assert.ok(thinBaseline.post)
    assert.strictEqual(thinBaseline.costChangePct, null)
    assert.strictEqual(thinBaseline.turnsChangePct, null)
    assert.strictEqual(thinBaseline.errorChangePct, null)

    const noPost = computeEffectiveness(before(10), APPLIED_AT)
    assert.strictEqual(noPost.post, null)
    assert.strictEqual(noPost.confidence, 'none')
    assert.strictEqual(noPost.turnsChangePct, null)
  })

  test('confidence grows with the number of post-apply sessions', () => {
    const conf = (n: number) => computeEffectiveness([...before(5), ...after(n)], APPLIED_AT).confidence
    assert.strictEqual(conf(3), 'low')
    assert.strictEqual(conf(7), 'low')
    assert.strictEqual(conf(8), 'medium')
    assert.strictEqual(conf(14), 'medium')
    assert.strictEqual(conf(15), 'high')
  })
})
