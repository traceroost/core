import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { lookupRates, calcAggregateCostWithRates as calcTokenCost, calcSessionCostUsd, RATES, normalizeCostKey } from '../../../media/src/pricing'
import { lookupRates as hostLookupRates, calcSessionCostUsd as hostCalcSessionCostUsd } from '../../pricing'

// media/src/pricing.ts is a hand-copied mirror of src/pricing.ts (see its own comments on
// normalizeCostKey/lookupRates: "Kept in sync with src/pricing.ts") — the extension-host twin
// has a dedicated test file (src/test/pricing.test.ts) covering the exact same normalization and
// no-prefix-match logic, including a regression test for a previously-shipped bug where an
// unrecognized newer model silently inherited an unrelated older model's rate. This file pins the
// same behavior here since nothing else does, and the whole point of "kept in sync by hand" is
// that the two copies can silently drift without a comment noticing.
//
// The cost math itself (tieredCost through calcSessionCostUsd) is a byte-for-byte copy of
// src/pricing.ts's — the suite at the bottom of this file fails if the two drift, or if the
// long-context tier fields for any model differ between the two RATES tables.

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

suite('media/pricing — parity with src/pricing.ts', () => {
  const repoRoot = path.resolve(__dirname, '../../../../..')
  const costBlock = (file: string, endMarker: string | null): string => {
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    const start = text.indexOf('// Applies two-tier pricing')
    const end = endMarker === null ? text.length : text.indexOf(endMarker)
    assert.ok(start !== -1 && end > start, `cost block not found in ${file}`)
    return text.slice(start, end).trim()
  }

  test('the cost-math block is byte-identical in both files', () => {
    assert.strictEqual(
      costBlock('media/src/pricing.ts', null),
      costBlock('src/pricing.ts', "/** Prices ONE API call's tokens"),
    )
  })

  test('every model has the same rates and long-context tier on host and webview', () => {
    const fields = [
      'inputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok', 'outputPerMTok',
      'longContextThresholdTokens', 'inputAboveThresholdPerMTok', 'outputAboveThresholdPerMTok',
      'cacheReadAboveThresholdPerMTok', 'cacheWriteAboveThresholdPerMTok',
    ] as const
    for (const key of Object.keys(RATES)) {
      const host = hostLookupRates(key)
      assert.ok(host, `${key} missing from src/pricing.ts`)
      for (const f of fields) {
        assert.strictEqual(RATES[key][f], host![f], `${key}.${f} differs between media and host`)
      }
    }
  })

  test('host and webview compute the same session cost (tiered per call, flat on totals)', () => {
    const timeline = [
      { type: 'llm', inputTokens: 300_000, cacheReadTokens: 250_000, cacheCreateTokens: 0, outputTokens: 2_000 },
      { type: 'llm', inputTokens: 120_000, cacheReadTokens: 100_000, cacheCreateTokens: 10_000, outputTokens: 1_000 },
    ]
    for (const model of ['gpt-5.4', 'gpt-5.6-luna', 'claude-sonnet-4', 'claude-opus-4-8']) {
      for (const tl of [timeline, []]) {
        const session = { model, inputTokens: 420_000, cacheReadTokens: 350_000, cacheCreateTokens: 10_000, outputTokens: 3_000, timeline: tl }
        const a = calcSessionCostUsd(session)
        const b = hostCalcSessionCostUsd(session)
        assert.ok(a > 0 && Math.abs(a - b) < 1e-12, `${model}: media ${a} vs host ${b}`)
      }
    }
  })
})
