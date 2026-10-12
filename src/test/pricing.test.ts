import * as assert from 'assert'
import { lookupRates, calcTokenCostUsd, calcAggregateTokenCostUsd, calcSessionCostUsd, stripDateSuffix, normalizeCostKey, setCloudRateOverrides, getCloudRateOverrides } from '../pricing'

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

  test('calcTokenCostUsd bills a gpt-6-astra call over 272K entirely at the long-context rate', () => {
    // 372K input + 10K output: every token at the long rate ($20 input, $75 output), not just the
    // 100K past the threshold.  0.372 × 20 + 0.01 × 75 = 7.44 + 0.75 = 8.19
    const cost = calcTokenCostUsd(372_000, 0, 0, 10_000, 'gpt-6-astra')
    assert.ok(Math.abs(cost - 8.19) < 1e-9, `Expected $8.19, got $${cost}`)
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
    // 100K input + 50K output — prompt under 200K, so flat rates
    const cost = calcTokenCostUsd(100_000, 0, 0, 50_000, 'claude-sonnet-4')
    const expected = (100_000 / 1_000_000) * 3.00 + (50_000 / 1_000_000) * 15.00
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('claude-sonnet-4: a prompt over 200K counting cache reads and writes bills the whole call, output included, at the premium', () => {
    // 20K uncached + 150K cache read + 40K cache write = 210K prompt > 200K. No category is over
    // 200K on its own (the old per-category rule billed this flat), but Anthropic counts the whole
    // prompt: 0.02 × $6 + 0.15 × $0.60 + 0.04 × $7.50 + 0.008 × $22.50 = 0.12 + 0.09 + 0.30 + 0.18 = 0.69
    const cost = calcTokenCostUsd(20_000, 150_000, 40_000, 8_000, 'claude-sonnet-4')
    assert.ok(Math.abs(cost - 0.69) < 1e-9, `Expected $0.69, got $${cost}`)
  })

  test('claude-sonnet-4: exactly 200K is not over the threshold; output never counts toward it', () => {
    // 200K prompt + 250K output: flat.  0.2 × 3 + 0.25 × 15 = 0.60 + 3.75
    assert.ok(Math.abs(calcTokenCostUsd(200_000, 0, 0, 250_000, 'claude-sonnet-4') - 4.35) < 1e-9)
    // One more prompt token: everything at the premium.  0.200001 × 6 + 0.25 × 22.5
    assert.ok(Math.abs(calcTokenCostUsd(200_001, 0, 0, 250_000, 'claude-sonnet-4') - (1.200006 + 5.625)) < 1e-9)
  })

  test('claude-haiku-5-5: priced by prompt length over 100K, cache hits included', () => {
    // 5K uncached + 90K cache read = 95K: base rates.  0.005 × 0.10 + 0.09 × 0.01 + 0.002 × 0.50
    assert.ok(Math.abs(calcTokenCostUsd(5_000, 90_000, 0, 2_000, 'claude-haiku-5-5') - (0.0005 + 0.0009 + 0.001)) < 1e-12)
    // 5K uncached + 96K cache read = 101K: the whole call at the >100K row.
    // 0.005 × 0.50 + 0.096 × 0.05 + 0.002 × 2.50 = 0.0025 + 0.0048 + 0.005 = 0.0123
    assert.ok(Math.abs(calcTokenCostUsd(5_000, 96_000, 0, 2_000, 'claude-haiku-5-5') - 0.0123) < 1e-12)
  })

  test('claude-sonnet-5-5 reads cache at 0.05x base input', () => {
    assert.strictEqual(lookupRates('claude-sonnet-5.5')!.cacheReadPerMTok, 0.10)
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

  test('gpt-5.4: input + cached input over 272K bills input, cached input and output at 2x/2x/1.5x', () => {
    // 72K uncached + 250K cached = 322K prompt > 272K; 4K output.
    // 0.072 × $5 + 0.25 × $0.50 + 0.004 × $22.50 = 0.36 + 0.125 + 0.09 = 0.575
    // (The old per-category rule billed all of this flat: 0.18 + 0.0625 + 0.06 = 0.3025.)
    const cost = calcTokenCostUsd(72_000, 250_000, 0, 4_000, 'gpt-5.4')
    assert.ok(Math.abs(cost - 0.575) < 1e-9, `Expected $0.575, got $${cost}`)
  })

  test('gpt-5.4: exactly 272K is still the short-context rate', () => {
    const cost = calcTokenCostUsd(272_000, 0, 0, 0, 'gpt-5.4')
    assert.ok(Math.abs(cost - 0.68) < 1e-9, `Expected $0.68, got $${cost}`)
  })

  test('calcTokenCostUsd uses flat rate for gpt-5.6-luna under its 200K threshold', () => {
    const cost = calcTokenCostUsd(150_000, 0, 0, 0, 'gpt-5.6-luna')
    const expected = (150_000 / 1_000_000) * 0.20
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('gpt-5.6-luna: over its 200K threshold (lower than the rest of the 5.6 family) every category, cache write included, is at the long rate', () => {
    // 100K uncached + 80K cache read + 30K cache write = 210K > 200K; 10K output.
    // 0.1 × 0.40 + 0.08 × 0.04 + 0.03 × 0.50 + 0.01 × 1.80 = 0.04 + 0.0032 + 0.015 + 0.018 = 0.0762
    const cost = calcTokenCostUsd(100_000, 80_000, 30_000, 10_000, 'gpt-5.6-luna')
    assert.ok(Math.abs(cost - 0.0762) < 1e-12, `Expected $0.0762, got $${cost}`)
  })

  test('grok-4.5: a missing above-threshold rate keeps the flat rate for that category', () => {
    // grok-4.5 has no cache-write pricing (0, no above-threshold rate), so the cache write stays $0.
    // 300K cache read + 50K cache write = 350K > 200K: 0.3 × $1.00 + 0.05 × $0 = 0.30
    const cost = calcTokenCostUsd(0, 300_000, 50_000, 0, 'grok-4.5')
    assert.ok(Math.abs(cost - 0.30) < 1e-9, `Expected $0.30, got $${cost}`)
  })

  test('gemini-3.1-pro: a prompt over 200K bills input, cache reads and output at the >200K row', () => {
    // 150K uncached + 60K cache read = 210K; 5K output.  0.15 × 4 + 0.06 × 0.40 + 0.005 × 18
    const cost = calcTokenCostUsd(150_000, 60_000, 0, 5_000, 'gemini-3.1-pro')
    assert.ok(Math.abs(cost - (0.60 + 0.024 + 0.09)) < 1e-9, `got $${cost}`)
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
      inputPerMTok: 1, cacheReadPerMTok: 2, cacheWritePerMTok: 3, outputPerMTok: 4, contextWindowTokens: local.contextWindowTokens,
    })
  })

  test('an override keeps the local context window and long-context tier fields', () => {
    const local = lookupRates('gpt-5.4')!
    assert.ok(local.contextWindowTokens > 0 && local.longContextThresholdTokens)
    setCloudRateOverrides({ 'gpt-5.4': { inputPerMTok: 3, cacheReadPerMTok: 0.3, cacheWritePerMTok: 0, outputPerMTok: 16 } })
    assert.deepStrictEqual(lookupRates('gpt-5.4'), {
      ...local, inputPerMTok: 3, cacheReadPerMTok: 0.3, cacheWritePerMTok: 0, outputPerMTok: 16,
    })
  })

  test('an override for a model unknown locally is a bare entry with an unknown context window', () => {
    setCloudRateOverrides({ 'some-orgs-fine-tune': { inputPerMTok: 1, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 5 } })
    assert.deepStrictEqual(lookupRates('some-orgs-fine-tune'), {
      inputPerMTok: 1, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 5, contextWindowTokens: 0,
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

  test('getCloudRateOverrides reflects the current override map, keyed by normalizeCostKey', () => {
    assert.deepStrictEqual(getCloudRateOverrides(), {})
    setCloudRateOverrides({ 'Claude-Sonnet-5': { inputPerMTok: 1, cacheReadPerMTok: 2, cacheWritePerMTok: 3, outputPerMTok: 4 } })
    assert.deepStrictEqual(getCloudRateOverrides(), {
      'claude-sonnet-5': { inputPerMTok: 1, cacheReadPerMTok: 2, cacheWritePerMTok: 3, outputPerMTok: 4, contextWindowTokens: 1_000_000 },
    })
  })
})

// H21: the long-context tier is a per-call surcharge. A session's cumulative cache reads cross
// 272K long before any single call does, so it must never be applied to session totals.
suite('pricing — session cost (per-call long-context tier)', () => {
  const call = (input: number, cacheRead: number, output: number) =>
    ({ type: 'llm', inputTokens: input + cacheRead, cacheReadTokens: cacheRead, cacheCreateTokens: 0, outputTokens: output })

  test('ten 100K-cache-read calls on gpt-5.4 are priced at base rates, not the >272K tier', () => {
    const timeline = Array.from({ length: 10 }, () => call(5_000, 100_000, 1_000))
    const session = {
      model: 'gpt-5.4', inputTokens: 1_050_000, cacheReadTokens: 1_000_000, cacheCreateTokens: 0, outputTokens: 10_000, timeline,
    }
    // 50K input × $2.50 + 1M cache read × $0.25 + 10K output × $15 = 0.125 + 0.25 + 0.15
    const expected = 0.525
    assert.ok(Math.abs(calcSessionCostUsd(session) - expected) < 1e-9, `got ${calcSessionCostUsd(session)}`)
    // The old behavior (tier applied to the aggregate) overbilled:
    assert.ok(calcTokenCostUsd(50_000, 1_000_000, 0, 10_000, 'gpt-5.4') > expected + 0.1)
  })

  test('a single call above the threshold still gets the tier, on all of its tokens', () => {
    const session = {
      model: 'gpt-5.4', inputTokens: 300_000, cacheReadTokens: 0, cacheCreateTokens: 0, outputTokens: 0,
      timeline: [call(300_000, 0, 0)],
    }
    // 300K × $5.00 — the whole call, not just the 28K past 272K
    assert.ok(Math.abs(calcSessionCostUsd(session) - 1.50) < 1e-9)
  })

  test('a timeline with one call over and one under prices each by its own prompt', () => {
    const session = {
      model: 'gpt-5.4', inputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, outputTokens: 0,
      // 22K uncached + 260K cached = 282K (long); 10K uncached + 200K cached = 210K (short)
      timeline: [call(22_000, 260_000, 2_000), call(10_000, 200_000, 2_000)],
    }
    // long:  0.022 × 5 + 0.26 × 0.50 + 0.002 × 22.5 = 0.11 + 0.13 + 0.045 = 0.285
    // short: 0.01 × 2.5 + 0.2 × 0.25 + 0.002 × 15    = 0.025 + 0.05 + 0.03 = 0.105
    assert.ok(Math.abs(calcSessionCostUsd(session) - 0.39) < 1e-9, `got ${calcSessionCostUsd(session)}`)
  })

  test('without per-call token data it falls back to flat aggregate pricing (no tier)', () => {
    const session = { model: 'gpt-5.4', inputTokens: 1_050_000, cacheReadTokens: 1_000_000, cacheCreateTokens: 0, outputTokens: 10_000, timeline: [] }
    assert.ok(Math.abs(calcSessionCostUsd(session) - 0.525) < 1e-9)
    assert.strictEqual(calcSessionCostUsd(session), calcAggregateTokenCostUsd(50_000, 1_000_000, 0, 10_000, 'gpt-5.4'))
  })

  test('multi-model timelines price each call at its own model', () => {
    const session = {
      model: 'claude-opus-4-8', inputTokens: 2_000_000, cacheReadTokens: 0, cacheCreateTokens: 0, outputTokens: 0,
      timeline: [
        { type: 'llm', model: 'claude-opus-4-8', inputTokens: 1_000_000 },
        { type: 'llm', model: 'claude-haiku-4-5', inputTokens: 1_000_000 },
        { type: 'tool', inputTokens: 999_999_999 },
      ],
    }
    assert.ok(Math.abs(calcSessionCostUsd(session) - (5.00 + 1.00)) < 1e-9)
  })

  test('unknown model with no per-call data costs 0', () => {
    assert.strictEqual(calcSessionCostUsd({ model: 'nope-model', inputTokens: 1000, cacheReadTokens: 0, outputTokens: 10 }), 0)
  })
})
