import * as assert from 'assert'
import { lookupRates, calcTokenCostUsd, stripDateSuffix, normalizeCostKey, setCloudRateOverrides } from '../pricing'

suite('pricing', () => {
  test('lookupRates returns rates for known model', () => {
    const rates = lookupRates('claude-sonnet-4-6')
    assert.ok(rates !== null, 'Should find rates for claude-sonnet-4-6')
    assert.ok(rates!.inputPerMTok > 0)
    assert.ok(rates!.outputPerMTok > 0)
  })

  test('lookupRates returns null for unknown model', () => {
    const rates = lookupRates('totally-unknown-model-xyz')
    assert.strictEqual(rates, null)
  })

  test('lookupRates strips date suffix', () => {
    const rates = lookupRates('claude-sonnet-4-6-20260101')
    assert.ok(rates !== null, 'Should match after stripping date suffix')
  })

  test('lookupRates does not prefix-match an unknown newer model onto an older one', () => {
    // claude-opus-4-9 doesn't exist in RATES, but claude-opus-4 does (deprecated,
    // $15/$75). A substring-prefix fallback would previously match this incorrectly —
    // must fall through to null (shown as ~$? in the UI) instead of a wrong rate.
    const rates = lookupRates('claude-opus-4-9')
    assert.strictEqual(rates, null, 'Should not silently inherit claude-opus-4\'s rate')
  })

  test('lookupRates does not prefix-match a differently-suffixed known model', () => {
    // gpt-4.1 exists; gpt-4.1-turbo does not. Must not match gpt-4.1's rate.
    const rates = lookupRates('gpt-4.1-turbo')
    assert.strictEqual(rates, null)
  })

  test('stripDateSuffix removes a trailing YYYY-MM-DD date', () => {
    assert.strictEqual(stripDateSuffix('claude-opus-4-7-2026-03-15'), 'claude-opus-4-7')
  })

  test('stripDateSuffix removes a trailing YYYYMMDD date', () => {
    assert.strictEqual(stripDateSuffix('claude-opus-4-7-20260315'), 'claude-opus-4-7')
  })

  test('stripDateSuffix leaves an undated model ID unchanged', () => {
    assert.strictEqual(stripDateSuffix('claude-opus-4-7'), 'claude-opus-4-7')
  })

  test('lookupRates resolves a fast-mode model ID built from a date-stripped base (logReader.ts pattern)', () => {
    // Regression test for the fast-mode + date-suffix ordering bug: logReader.ts
    // builds the fast-mode model ID as `${stripDateSuffix(primaryBase)}-fast`, not
    // `${primaryBase}-fast`. Simulate that construction directly.
    const rawDatedModel = 'claude-opus-4-7-20260315'
    const effectiveModel = `${stripDateSuffix(rawDatedModel)}-fast`
    assert.strictEqual(effectiveModel, 'claude-opus-4-7-fast')
    const rates = lookupRates(effectiveModel)
    assert.ok(rates !== null, 'Should resolve to the fast-mode rate')
    assert.strictEqual(rates!.inputPerMTok, 30.00, 'Should be the fast-mode rate ($30), not the standard rate ($5)')
  })

  test('calcTokenCostUsd returns 0 for unknown model', () => {
    const cost = calcTokenCostUsd(10000, 0, 0, 2000, 'nonexistent-model')
    assert.strictEqual(cost, 0)
  })

  test('calcTokenCostUsd computes correct value for claude-sonnet-4-6', () => {
    // inputPerMTok: 3.00, outputPerMTok: 15.00
    // 1M input = $3.00, 1M output = $15.00
    const cost = calcTokenCostUsd(1_000_000, 0, 0, 1_000_000, 'claude-sonnet-4-6')
    assert.ok(Math.abs(cost - 18.00) < 0.001, `Expected ~$18, got $${cost}`)
  })

  test('calcTokenCostUsd includes cache read tokens', () => {
    // cacheReadPerMTok: 0.30 for claude-sonnet-4-6
    const costNoCache = calcTokenCostUsd(1_000_000, 0, 0, 0, 'claude-sonnet-4-6')
    const costWithCache = calcTokenCostUsd(1_000_000, 1_000_000, 0, 0, 'claude-sonnet-4-6')
    assert.ok(costWithCache > costNoCache, 'Cache read tokens should add to cost')
    assert.ok(Math.abs(costWithCache - (3.00 + 0.30)) < 0.001)
  })

  test('calcTokenCostUsd returns 0 for included (free) model', () => {
    // big-pickle is free during its OpenCode Zen evaluation period — all-zero rates
    const cost = calcTokenCostUsd(100_000, 0, 0, 10_000, 'big-pickle')
    assert.strictEqual(cost, 0)
  })

  test('calcTokenCostUsd resolves the free Zen models added 2026-09-01', () => {
    for (const m of ['ling-3.0-flash-fin-free', 'muse-spark-1.2-contributor-free']) {
      assert.notStrictEqual(lookupRates(m), null, `${m} should be in RATES`)
      assert.strictEqual(calcTokenCostUsd(500_000, 0, 0, 100_000, m), 0, `${m} should be free`)
    }
  })

  test('calcTokenCostUsd resolves the free Zen model added 2026-09-15', () => {
    assert.notStrictEqual(lookupRates('muse-spark-1.3-contributor-free'), null)
    assert.strictEqual(calcTokenCostUsd(500_000, 0, 0, 100_000, 'muse-spark-1.3-contributor-free'), 0)
  })

  test('calcTokenCostUsd resolves gemini-3.8-flash at the same promotional rate as 3.6/3.7', () => {
    const rates38 = lookupRates('gemini-3.8-flash')
    assert.notStrictEqual(rates38, null)
    assert.deepStrictEqual(rates38, lookupRates('gemini-3.7-flash'))
  })

  test('calcTokenCostUsd uses flat rate for gpt-6-astra under its 272K threshold', () => {
    const cost = calcTokenCostUsd(200_000, 0, 0, 100_000, 'gpt-6-astra')
    const expected = (200_000 / 1_000_000) * 10.00 + (100_000 / 1_000_000) * 50.00
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd applies the surcharge for gpt-6-astra above its 272K threshold', () => {
    // 372K input: first 272K at $10, next 100K at $20 (2x)
    const cost = calcTokenCostUsd(372_000, 0, 0, 0, 'gpt-6-astra')
    const expected = (272_000 / 1_000_000) * 10.00 + (100_000 / 1_000_000) * 20.00
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd prices claude-fable-5-1 with the 0.025x cache-read rate', () => {
    // Fable 5.1 matches Fable 5 on input/output/cache-write but reads cache at $0.25/MTok (0.025x),
    // not $1.00/MTok (0.1x). A dotted telemetry ID must normalize to the hyphenated key.
    const rates = lookupRates('claude-fable-5.1')
    assert.notStrictEqual(rates, null, 'claude-fable-5.1 should normalize to claude-fable-5-1')
    assert.strictEqual(rates!.cacheReadPerMTok, 0.25)
    assert.strictEqual(rates!.inputPerMTok, 10.00)
    // 1M input + 1M cache-read + 1M output = 10.00 + 0.25 + 50.00
    const cost = calcTokenCostUsd(1_000_000, 1_000_000, 0, 1_000_000, 'claude-fable-5-1')
    assert.ok(Math.abs(cost - 60.25) < 0.001, `Expected ~$60.25, got $${cost}`)
  })

  test('calcTokenCostUsd uses flat rate for claude-sonnet-4 under threshold', () => {
    // 100K input + 50K output — all below 200K, so same as flat rate
    const cost = calcTokenCostUsd(100_000, 0, 0, 50_000, 'claude-sonnet-4')
    const expected = (100_000 / 1_000_000) * 3.00 + (50_000 / 1_000_000) * 15.00
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd applies tiered rate for claude-sonnet-4 above 200K input', () => {
    // 300K input, 0 output: first 200K at $3, next 100K at $6
    const cost = calcTokenCostUsd(300_000, 0, 0, 0, 'claude-sonnet-4')
    const expected = (200_000 / 1_000_000) * 3.00 + (100_000 / 1_000_000) * 6.00
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd tiered output for claude-sonnet-4', () => {
    // 0 input, 250K output: first 200K at $15, next 50K at $22.50
    const cost = calcTokenCostUsd(0, 0, 0, 250_000, 'claude-sonnet-4')
    const expected = (200_000 / 1_000_000) * 15.00 + (50_000 / 1_000_000) * 22.50
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd flat rate for claude-sonnet-4-5 (no tiered rates)', () => {
    // claude-sonnet-4-5 has no above-200K rates; 300K input uses flat $3/MTok
    const cost = calcTokenCostUsd(300_000, 0, 0, 0, 'claude-sonnet-4-5')
    const expected = (300_000 / 1_000_000) * 3.00
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd uses flat rate for gpt-5.4 under its 272K threshold', () => {
    const cost = calcTokenCostUsd(200_000, 0, 0, 100_000, 'gpt-5.4')
    const expected = (200_000 / 1_000_000) * 2.50 + (100_000 / 1_000_000) * 15.00
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd applies the surcharge for gpt-5.4 above its 272K threshold', () => {
    // 372K input: first 272K at $2.50, next 100K at $5.00 (2x)
    const cost = calcTokenCostUsd(372_000, 0, 0, 0, 'gpt-5.4')
    const expected = (272_000 / 1_000_000) * 2.50 + (100_000 / 1_000_000) * 5.00
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd uses flat rate for gpt-5.6-luna under its 200K threshold', () => {
    const cost = calcTokenCostUsd(150_000, 0, 0, 0, 'gpt-5.6-luna')
    const expected = (150_000 / 1_000_000) * 0.20
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd applies the surcharge for gpt-5.6-luna above its 200K threshold (lower than the rest of the 5.6 family)', () => {
    // 250K input: first 200K at $0.20, next 50K at $0.40 (2x)
    const cost = calcTokenCostUsd(250_000, 0, 0, 0, 'gpt-5.6-luna')
    const expected = (200_000 / 1_000_000) * 0.20 + (50_000 / 1_000_000) * 0.40
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd applies the surcharge to cache-read tokens for grok-4.5', () => {
    // grok-4.5 has no cache-write pricing (0), so this also exercises the cacheWrite fallback path.
    // 300K cache-read: first 200K at $0.50, next 100K at $1.00 (2x)
    const cost = calcTokenCostUsd(0, 300_000, 50_000, 0, 'grok-4.5')
    const expectedCacheRead = (200_000 / 1_000_000) * 0.50 + (100_000 / 1_000_000) * 1.00
    assert.ok(Math.abs(cost - expectedCacheRead) < 0.0001, `Expected $${expectedCacheRead}, got $${cost}`)
  })

  // ── dot-vs-hyphen model IDs (GH #231) ──────────────────────────────────────

  test('lookupRates resolves a dotted Claude model ID onto its hyphenated rate key', () => {
    // Copilot VS Code imports these with dotted minor versions; RATES keys them with hyphens.
    for (const dotted of ['claude-opus-4.8', 'claude-opus-4.6', 'claude-sonnet-4.6']) {
      const rates = lookupRates(dotted)
      assert.ok(rates !== null, `${dotted} should resolve`)
      assert.strictEqual(rates, lookupRates(dotted.replace(/\./g, '-')), `${dotted} should match its hyphenated key`)
    }
  })

  test('calcTokenCostUsd returns a non-zero cost for a dotted Claude model ID with real tokens', () => {
    // The exact #231 symptom: non-zero output tokens on a known model, but cost_usd = 0.
    const cost = calcTokenCostUsd(0, 0, 0, 1_000_000, 'claude-opus-4.8')
    assert.ok(cost > 0, `Expected non-zero cost, got $${cost}`)
    assert.strictEqual(cost, calcTokenCostUsd(0, 0, 0, 1_000_000, 'claude-opus-4-8'))
  })

  test('lookupRates resolves a hyphenated GPT model ID onto its dotted rate key', () => {
    // The reverse direction: RATES keys GPT models with dots, so a hyphenated telemetry ID must
    // still resolve (and a naive input-only `.`→`-` replace would have broken this).
    assert.strictEqual(lookupRates('gpt-5-4'), lookupRates('gpt-5.4'))
    assert.ok(lookupRates('gpt-5-4') !== null)
  })

  test('lookupRates resolves a dotted ID that is also date-suffixed', () => {
    assert.strictEqual(lookupRates('claude-opus-4.8-20260101'), lookupRates('claude-opus-4-8'))
    assert.strictEqual(lookupRates('claude-opus-4.8-2026-01-01'), lookupRates('claude-opus-4-8'))
  })

  test('lookupRates resolves a dotted fast-mode ID (logReader base + "-fast" pattern)', () => {
    const rates = lookupRates('claude-opus-4.8-fast')
    assert.ok(rates !== null)
    assert.strictEqual(rates, lookupRates('claude-opus-4-8-fast'))
  })

  test('lookupRates resolves the retired "gpt-5 mini" space-variant onto gpt-5-mini', () => {
    assert.strictEqual(lookupRates('gpt-5 mini'), lookupRates('gpt-5-mini'))
    assert.ok(lookupRates('gpt-5 mini') !== null)
  })

  test('normalization does not resurrect prefix-matching: unknown newer/aliased models stay null', () => {
    assert.strictEqual(lookupRates('claude-opus-4-9'), null)
    assert.strictEqual(lookupRates('claude-opus-4.9'), null)
    assert.strictEqual(lookupRates('gpt-4.1-turbo'), null)
  })

  test('normalizeCostKey collapses dots, spaces, and underscores to hyphens after date-stripping', () => {
    assert.strictEqual(normalizeCostKey('Claude-Opus-4.8'), 'claude-opus-4-8')
    assert.strictEqual(normalizeCostKey('gpt-5.4'), 'gpt-5-4')
    assert.strictEqual(normalizeCostKey('gpt-5 mini'), 'gpt-5-mini')
    assert.strictEqual(normalizeCostKey('gpt_5_mini'), 'gpt-5-mini')
    assert.strictEqual(normalizeCostKey('claude-opus-4.8-20260101'), 'claude-opus-4-8')
  })

  test('the RATES cost-key index builds without a collision (guard in pricing.ts did not throw on import)', () => {
    // If two RATES keys collapsed to one cost key with different rates, importing ../pricing above
    // would already have thrown. This asserts the observable consequence: every known model still
    // resolves to a rate, and a couple of near-miss pairs resolve independently.
    assert.ok(lookupRates('gpt-5.4') !== null && lookupRates('gpt-5.4-mini') !== null)
    assert.notStrictEqual(lookupRates('gpt-5.4'), lookupRates('gpt-5.4-mini'))
    assert.ok(lookupRates('mai-code-1-flash') !== null && lookupRates('mai-code-1.1-flash') !== null)
    assert.notStrictEqual(lookupRates('mai-code-1-flash'), lookupRates('mai-code-1.1-flash'))
  })
})

// setCloudRateOverrides mutates module-level state read by every other test in this file (via
// lookupRates), so each test here resets it to empty afterward rather than relying on suite order
// — same reason none of the suite above ever calls it.
suite('pricing — cloud rate overrides', () => {
  teardown(() => { setCloudRateOverrides({}) })

  test('an override takes priority over the local RATES entry for the same model', () => {
    const local = lookupRates('claude-sonnet-5')
    assert.ok(local && local.inputPerMTok > 0)
    setCloudRateOverrides({ 'claude-sonnet-5': { inputPerMTok: 1, cacheReadPerMTok: 2, cacheWritePerMTok: 3, outputPerMTok: 4 } })
    assert.deepStrictEqual(lookupRates('claude-sonnet-5'), {
      inputPerMTok: 1, cacheReadPerMTok: 2, cacheWritePerMTok: 3, outputPerMTok: 4, contextWindowTokens: 0,
    })
  })

  test('an override for an unrecognized model makes it resolve where it previously returned null', () => {
    assert.strictEqual(lookupRates('some-orgs-fine-tune'), null)
    setCloudRateOverrides({ 'some-orgs-fine-tune': { inputPerMTok: 1, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 5 } })
    assert.ok(lookupRates('some-orgs-fine-tune') !== null)
  })

  test('override keys are normalized the same way local RATES keys are', () => {
    setCloudRateOverrides({ 'Claude-Sonnet-5': { inputPerMTok: 1, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 1 } })
    assert.strictEqual(lookupRates('claude sonnet 5')?.inputPerMTok, 1)
  })

  test('a model absent from the override map still falls back to local RATES', () => {
    setCloudRateOverrides({ 'some-other-model': { inputPerMTok: 9, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 9 } })
    const local = lookupRates('claude-sonnet-5')
    assert.ok(local && local.inputPerMTok !== 9)
  })

  test('clearing overrides (empty map) restores local RATES', () => {
    setCloudRateOverrides({ 'claude-sonnet-5': { inputPerMTok: 1, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 1 } })
    setCloudRateOverrides({})
    assert.notStrictEqual(lookupRates('claude-sonnet-5')?.inputPerMTok, 1)
  })
})
