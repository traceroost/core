import * as assert from 'assert'
import { lookupRates, calcTokenCost, normalizeCostKey } from '../../../media/src/pricing'

// media/src/pricing.ts is a hand-copied mirror of src/pricing.ts (see its own comments on
// normalizeCostKey/lookupRates: "Kept in sync with src/pricing.ts") — the extension-host twin
// has a dedicated test file (src/test/pricing.test.ts) covering the exact same normalization and
// no-prefix-match logic, including a regression test for a previously-shipped bug where an
// unrecognized newer model silently inherited an unrelated older model's rate. This file pins the
// same behavior here since nothing else does, and the whole point of "kept in sync by hand" is
// that the two copies can silently drift without a comment noticing.
//
// media's calcTokenCost is deliberately simpler than the host's calcTokenCostUsd — no >200K
// tiered-surcharge branching, since it operates on already-known session/entry totals and "can't
// reconstruct per-turn call sizes" (ModelRates' own doc comment) — so only the flat multiplication
// is tested here, not tiering.

suite('media/pricing', () => {
  test('lookupRates returns rates for a known model', () => {
    const rates = lookupRates('claude-sonnet-4-6')
    assert.ok(rates !== null)
    assert.ok(rates!.inputPerMTok > 0)
    assert.ok(rates!.outputPerMTok > 0)
  })

  test('lookupRates returns null for an unknown model', () => {
    assert.strictEqual(lookupRates('totally-unknown-model-xyz'), null)
  })

  test('lookupRates does not prefix-match an unknown newer model onto an older one', () => {
    // claude-opus-4-9 doesn't exist; claude-opus-4 does (deprecated, $15/$75). A substring-prefix
    // fallback would incorrectly match this — must fall through to null instead.
    assert.strictEqual(lookupRates('claude-opus-4-9'), null)
  })

  test('lookupRates resolves a dotted Claude model ID onto its hyphenated rate key', () => {
    for (const dotted of ['claude-opus-4.8', 'claude-sonnet-4.6']) {
      const rates = lookupRates(dotted)
      assert.ok(rates !== null, `${dotted} should resolve`)
      assert.strictEqual(rates, lookupRates(dotted.replace(/\./g, '-')))
    }
  })

  test('lookupRates resolves a hyphenated GPT model ID onto its dotted rate key', () => {
    assert.strictEqual(lookupRates('gpt-5-4'), lookupRates('gpt-5.4'))
    assert.ok(lookupRates('gpt-5-4') !== null)
  })

  test('lookupRates strips a trailing date suffix', () => {
    assert.notStrictEqual(lookupRates('claude-sonnet-4-6-20260101'), null)
    assert.strictEqual(lookupRates('claude-sonnet-4-6-20260101'), lookupRates('claude-sonnet-4-6'))
  })

  test('normalizeCostKey collapses dots, spaces, and underscores to hyphens after date-stripping', () => {
    assert.strictEqual(normalizeCostKey('Claude-Opus-4.8'), 'claude-opus-4-8')
    assert.strictEqual(normalizeCostKey('gpt_5_mini'), 'gpt-5-mini')
    assert.strictEqual(normalizeCostKey('claude-opus-4.8-20260101'), 'claude-opus-4-8')
  })

  test('calcTokenCost computes the flat per-MTok sum across all four token kinds', () => {
    const rates = lookupRates('claude-sonnet-4-6')!
    const cost = calcTokenCost(1_000_000, 0, 0, 1_000_000, rates)
    // inputPerMTok 3.00 + outputPerMTok 15.00
    assert.ok(Math.abs(cost - 18.00) < 0.001, `Expected ~$18, got $${cost}`)
  })

  test('calcTokenCost includes cache read and cache write tokens', () => {
    const rates = lookupRates('claude-sonnet-4-6')!
    const withoutCache = calcTokenCost(1_000_000, 0, 0, 0, rates)
    const withCache = calcTokenCost(1_000_000, 1_000_000, 1_000_000, 0, rates)
    assert.ok(withCache > withoutCache)
    assert.ok(Math.abs(withCache - (3.00 + 0.30 + 3.75)) < 0.001)
  })

  test('calcTokenCost returns 0 for a free (all-zero-rate) model', () => {
    const rates = lookupRates('big-pickle')!
    assert.strictEqual(calcTokenCost(100_000, 0, 0, 10_000, rates), 0)
  })
})
