import * as assert from 'assert'
import './domShim'
import { niceMax, summarize, type TrendBin } from '../../../media/src/tabs/outcomeTrend'

function bin(start: string, merged: number, committed: number, abandoned: number): TrendBin {
  const m = (tokens: number) => ({ sessions: tokens > 0 ? 1 : 0, tokens })
  const byOutcome = { merged: m(merged), committed: m(committed), abandoned: m(abandoned), ambiguous: m(0) }
  const tokens = merged + committed + abandoned
  return { start, end: start, byOutcome, total: { sessions: [merged, committed, abandoned].filter(t => t > 0).length, tokens } }
}

suite('media — Outcome & token spend summary', () => {
  test('summarize adds bins per outcome and splits landed vs uncommitted tokens', () => {
    const s = summarize([bin('2026-01-01', 600, 200, 0), bin('2026-01-02', 0, 0, 200)])
    assert.deepStrictEqual(s.byOutcome.merged, { sessions: 1, tokens: 600 })
    assert.deepStrictEqual(s.byOutcome.committed, { sessions: 1, tokens: 200 })
    assert.deepStrictEqual(s.byOutcome.abandoned, { sessions: 1, tokens: 200 })
    assert.deepStrictEqual(s.total, { sessions: 3, tokens: 1000 })
    // Landed = merged + committed.
    assert.strictEqual(s.landedShare, 0.8)
    assert.strictEqual(s.uncommittedShare, 0.2)
  })

  test('summarize of no tokens reports 0% shares, not NaN', () => {
    const s = summarize([])
    assert.deepStrictEqual(s.total, { sessions: 0, tokens: 0 })
    assert.strictEqual(s.landedShare, 0)
    assert.strictEqual(s.uncommittedShare, 0)
  })

  test('niceMax rounds the axis up to a 1/2/2.5/5 × 10^n step', () => {
    assert.deepStrictEqual(niceMax(0), { max: 1, step: 1 })
    assert.deepStrictEqual(niceMax(-5), { max: 1, step: 1 })
    assert.deepStrictEqual(niceMax(4), { max: 4, step: 1 })
    assert.deepStrictEqual(niceMax(7), { max: 8, step: 2 })
    assert.deepStrictEqual(niceMax(9), { max: 10, step: 2.5 })
    assert.deepStrictEqual(niceMax(1234), { max: 1500, step: 500 })
    assert.deepStrictEqual(niceMax(30, 3), { max: 30, step: 10 })
  })
})
