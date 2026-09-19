// Pricing data for extension-host cost computation (cost_usd stored in sessions table).
// Rate table is kept in sync with media/src/pricing.ts — update both when rates change.
// PRICING_LAST_UPDATED: 2026-09-15

export interface ModelRates {
  inputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
  outputPerMTok: number
  contextWindowTokens: number   // max context window for Projection estimates; 0 = unknown
  // Optional tiered "long context" surcharge, applied per API call above longContextThresholdTokens.
  // When absent, flat rates apply regardless of call size. Threshold is per-model (confirmed values
  // vary — 200K for some models, 272K for others — see PRICING_SOURCES.md); defaults to 200K if the
  // above-threshold rates are set but the threshold itself isn't (kept for claude-sonnet-4 parity).
  longContextThresholdTokens?: number
  inputAboveThresholdPerMTok?: number
  outputAboveThresholdPerMTok?: number
  cacheReadAboveThresholdPerMTok?: number
  cacheWriteAboveThresholdPerMTok?: number
}

const RATES: Record<string, ModelRates> = {
  // ── OpenAI ─────────────────────────────────────────────────────────────────
  // gpt-4.1: re-listed on the API pricing page as of 2026-08-07 at real rates (previously assumed delisted/$0 —
  // that turned out to be wrong or stale; correcting to the live page value).
  'gpt-4.1':            { inputPerMTok: 2.00,  cacheReadPerMTok: 0.50,   cacheWritePerMTok: 0, outputPerMTok: 8.00,  contextWindowTokens: 1_000_000 },
  // gpt-4.1-mini: added 2026-08-12 — confirmed on OpenAI's general API pricing page.
  'gpt-4.1-mini':       { inputPerMTok: 0.40,  cacheReadPerMTok: 0.10,   cacheWritePerMTok: 0, outputPerMTok: 1.60,  contextWindowTokens: 0 },
  // gpt-5-mini: no longer an included/$0 model as of the 2026-07-19 pricing page — now billed at standard rates.
  // (The old `'gpt-5 mini'` space-variant alias key is gone — normalizeCostKey collapses the space to a hyphen.)
  'gpt-5-mini':         { inputPerMTok: 0.25,  cacheReadPerMTok: 0.025,  cacheWritePerMTok: 0, outputPerMTok: 2.00,  contextWindowTokens: 200_000 },
  'gpt-4o':             { inputPerMTok: 2.50,  cacheReadPerMTok: 1.25,   cacheWritePerMTok: 0, outputPerMTok: 10.00, contextWindowTokens: 128_000 },
  'gpt-4o-mini':        { inputPerMTok: 0.15,  cacheReadPerMTok: 0.075,  cacheWritePerMTok: 0, outputPerMTok: 0.60,  contextWindowTokens: 128_000 },
  // gpt-5.1: corrected 2026-08-07 — was $1.75/$14.00, live API pricing page now shows $1.25/$10.00 (older-gen
  // model repriced down below gpt-5.2). gpt-5.1-codex/-mini/-max not independently re-confirmed this round
  // (absent from the general pricing page); left unchanged — see PRICING_SOURCES.md Known gaps.
  'gpt-5.1':            { inputPerMTok: 1.25,  cacheReadPerMTok: 0.125,  cacheWritePerMTok: 0, outputPerMTok: 10.00, contextWindowTokens: 256_000 },
  'gpt-5.1-codex':      { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00, contextWindowTokens: 256_000 },
  'gpt-5.1-codex-mini': { inputPerMTok: 0.75,  cacheReadPerMTok: 0.075,  cacheWritePerMTok: 0, outputPerMTok: 4.50,  contextWindowTokens: 256_000 },
  'gpt-5.1-codex-max':  { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00, contextWindowTokens: 256_000 },
  'gpt-5.2':            { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00, contextWindowTokens: 256_000 },
  'gpt-5.2-codex':      { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00, contextWindowTokens: 256_000 },
  'gpt-5.3-codex':      { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00, contextWindowTokens: 256_000 },
  // gpt-5.4: long-context surcharge above 272K tokens/call confirmed 2026-08-12 (2x input/cache-read, 1.5x output).
  'gpt-5.4':            { inputPerMTok: 2.50,  cacheReadPerMTok: 0.25,   cacheWritePerMTok: 0, outputPerMTok: 15.00, contextWindowTokens: 272_000,
                          longContextThresholdTokens: 272_000,
                          inputAboveThresholdPerMTok: 5.00, cacheReadAboveThresholdPerMTok: 0.50, outputAboveThresholdPerMTok: 22.50 },
  'gpt-5.4-mini':       { inputPerMTok: 0.75,  cacheReadPerMTok: 0.075,  cacheWritePerMTok: 0, outputPerMTok: 4.50,  contextWindowTokens: 200_000 },
  'gpt-5.4-nano':       { inputPerMTok: 0.20,  cacheReadPerMTok: 0.02,   cacheWritePerMTok: 0, outputPerMTok: 1.25,  contextWindowTokens: 128_000 },
  // gpt-5.5: long-context surcharge above 272K tokens/call confirmed 2026-08-12 (2x input/cache-read, 1.5x output).
  'gpt-5.5':            { inputPerMTok: 5.00,  cacheReadPerMTok: 0.50,   cacheWritePerMTok: 0, outputPerMTok: 30.00, contextWindowTokens: 256_000,
                          longContextThresholdTokens: 272_000,
                          inputAboveThresholdPerMTok: 10.00, cacheReadAboveThresholdPerMTok: 1.00, outputAboveThresholdPerMTok: 45.00 },
  // gpt-5.6 family: Luna (small/fast), Terra (mid), Sol (flagship). Corrected 2026-08-07 — Luna and Terra were
  // repriced down (Luna $1.00→$0.20 input, Terra $2.50→$2.00 input), and the whole family gained real cache-write
  // pricing (1.25x input, confirmed across the Copilot docs, OpenAI's pricing page, and the Codex credits page).
  // Long-context surcharge tiers confirmed 2026-08-12 (2x input/cache-read/cache-write, 1.5x output) — Luna's
  // threshold (200K) is lower than Sol/Terra's (272K), per Copilot's pricing page default-tier labels.
  'gpt-5.6-luna':       { inputPerMTok: 0.20,  cacheReadPerMTok: 0.02,   cacheWritePerMTok: 0.25, outputPerMTok: 1.20,  contextWindowTokens: 256_000,
                          longContextThresholdTokens: 200_000,
                          inputAboveThresholdPerMTok: 0.40, cacheReadAboveThresholdPerMTok: 0.04, cacheWriteAboveThresholdPerMTok: 0.50, outputAboveThresholdPerMTok: 1.80 },
  'gpt-5.6-terra':      { inputPerMTok: 2.00,  cacheReadPerMTok: 0.20,   cacheWritePerMTok: 2.50, outputPerMTok: 12.00, contextWindowTokens: 256_000,
                          longContextThresholdTokens: 272_000,
                          inputAboveThresholdPerMTok: 4.00, cacheReadAboveThresholdPerMTok: 0.40, cacheWriteAboveThresholdPerMTok: 5.00, outputAboveThresholdPerMTok: 18.00 },
  // gpt-5.6-sol: corrected 2026-08-26 — OpenAI's own API page dropped this from $5.00/$0.50/$6.25/$30.00 to
  // $4.00/$0.40/$5.00/$20.00 (long-context tier $10.00/$1.00/$12.50/$45.00 → $8.00/$0.80/$10.00/$30.00), noted on
  // the source page as "promotional pricing... at least through November 21, 2026" (still live as of 2026-09-15 —
  // re-check sooner than usual). Copilot's own separate extra-50%-off layer on top of this rate, previously
  // through Sept 3, 2026, is gone from Copilot's pricing page as of this refresh — it ended as scheduled, so this
  // rate is now correct for Copilot-sourced sessions too (previously overstated ~2x while that discount was live).
  'gpt-5.6-sol':        { inputPerMTok: 4.00,  cacheReadPerMTok: 0.40,   cacheWritePerMTok: 5.00, outputPerMTok: 20.00, contextWindowTokens: 256_000,
                          longContextThresholdTokens: 272_000,
                          inputAboveThresholdPerMTok: 8.00, cacheReadAboveThresholdPerMTok: 0.80, cacheWriteAboveThresholdPerMTok: 10.00, outputAboveThresholdPerMTok: 30.00 },
  // gpt-5.6-cyber: added 2026-08-26 — new on OpenAI's API pricing page. Short-context only; no long-context tier
  // listed on the source page (unlike the rest of the 5.6 family).
  'gpt-5.6-cyber':      { inputPerMTok: 12.50, cacheReadPerMTok: 1.25,   cacheWritePerMTok: 15.625, outputPerMTok: 75.00, contextWindowTokens: 0 },
  // gpt-6-astra: added 2026-09-15 — new flagship, confirmed on Copilot's model pricing page, OpenAI's own API
  // pricing page, and the Codex CLI credits page (250/25/1250 credits ÷25 = $10.00/$1.00/$50.00). Same tiered
  // shape as the 5.6 family: cache-write at 1.25x input, long-context surcharge above 272K (2x input/cache/
  // cache-write, 1.5x output). OpenAI's API page also lists a fast-mode rate ($20.00/$2.00/$100.00 short-context)
  // — not modeled, consistent with not modeling GPT-5.6 fast mode either.
  'gpt-6-astra':        { inputPerMTok: 10.00, cacheReadPerMTok: 1.00,   cacheWritePerMTok: 12.50, outputPerMTok: 50.00, contextWindowTokens: 256_000,
                          longContextThresholdTokens: 272_000,
                          inputAboveThresholdPerMTok: 20.00, cacheReadAboveThresholdPerMTok: 2.00, cacheWriteAboveThresholdPerMTok: 25.00, outputAboveThresholdPerMTok: 75.00 },
  // gpt-4.1-nano, gpt-5-nano, gpt-5 (base): added 2026-08-26 — confirmed on OpenAI's general API pricing page, but
  // not independently confirmed as reachable through Copilot or Codex CLI specifically (neither's own docs
  // mentioned them this pass). Added on this file's existing philosophy that a model which never appears in
  // telemetry costs nothing to have listed, while one that does and isn't listed silently shows ~$?.
  'gpt-4.1-nano':       { inputPerMTok: 0.10,  cacheReadPerMTok: 0.025,  cacheWritePerMTok: 0, outputPerMTok: 0.40,  contextWindowTokens: 1_000_000 },
  'gpt-5-nano':         { inputPerMTok: 0.05,  cacheReadPerMTok: 0.005,  cacheWritePerMTok: 0, outputPerMTok: 0.40,  contextWindowTokens: 0 },
  'gpt-5':              { inputPerMTok: 1.25,  cacheReadPerMTok: 0.125,  cacheWritePerMTok: 0, outputPerMTok: 10.00, contextWindowTokens: 0 },
  // ── Copilot marketplace third-party models ──────────────────────────────────
  // These four were already present in media/src/pricing.ts (browser-side) but missing here — a real sync gap
  // that made cost_usd store as 0 (not ~$?) for any Copilot session using them, silently under-reporting rather
  // than flagging as unknown. Added 2026-08-12 to restore parity; rates confirmed against the Copilot pricing page.
  // grok-4.5: long-context surcharge above 200K tokens/call confirmed 2026-08-12 (2x input/cache-read, 1.5x output).
  'grok-4.5':           { inputPerMTok: 2.00,  cacheReadPerMTok: 0.50,   cacheWritePerMTok: 0, outputPerMTok: 6.00,  contextWindowTokens: 0,
                          longContextThresholdTokens: 200_000,
                          inputAboveThresholdPerMTok: 4.00, cacheReadAboveThresholdPerMTok: 1.00, outputAboveThresholdPerMTok: 12.00 },
  // grok-4.6: added 2026-08-26 — new on the Copilot pricing page, same rate structure as grok-4.5.
  'grok-4.6':           { inputPerMTok: 2.00,  cacheReadPerMTok: 0.50,   cacheWritePerMTok: 0, outputPerMTok: 6.00,  contextWindowTokens: 0,
                          longContextThresholdTokens: 200_000,
                          inputAboveThresholdPerMTok: 4.00, cacheReadAboveThresholdPerMTok: 1.00, outputAboveThresholdPerMTok: 12.00 },
  'kimi-k3':            { inputPerMTok: 3.00,  cacheReadPerMTok: 0.30,   cacheWritePerMTok: 0, outputPerMTok: 15.00, contextWindowTokens: 0 },
  'kimi-k2.7-code':     { inputPerMTok: 0.95,  cacheReadPerMTok: 0.19,   cacheWritePerMTok: 0, outputPerMTok: 4.00,  contextWindowTokens: 0 },
  'mai-code-1-flash':   { inputPerMTok: 0.75,  cacheReadPerMTok: 0.075,  cacheWritePerMTok: 0, outputPerMTok: 4.50,  contextWindowTokens: 0 },
  // mai-code-1.1-flash: added 2026-08-12 — new on the Copilot pricing page this refresh.
  'mai-code-1.1-flash': { inputPerMTok: 0.20,  cacheReadPerMTok: 0.02,   cacheWritePerMTok: 0, outputPerMTok: 1.20,  contextWindowTokens: 0 },
  // ── Codex-only ─────────────────────────────────────────────────────────────
  // codex-mini-latest: deprecated per OpenAI docs; kept for historical sessions.
  'codex-mini-latest':  { inputPerMTok: 1.50,  cacheReadPerMTok: 0.375,  cacheWritePerMTok: 0, outputPerMTok: 6.00,  contextWindowTokens: 200_000 },
  // ── Anthropic ──────────────────────────────────────────────────────────────
  'claude-opus-4':      { inputPerMTok: 15.00, cacheReadPerMTok: 1.50,  cacheWritePerMTok: 18.75, outputPerMTok: 75.00, contextWindowTokens: 200_000 },
  'claude-opus-4-1':    { inputPerMTok: 15.00, cacheReadPerMTok: 1.50,  cacheWritePerMTok: 18.75, outputPerMTok: 75.00, contextWindowTokens: 200_000 },
  'claude-haiku-3-5':   { inputPerMTok:  0.80, cacheReadPerMTok: 0.08,  cacheWritePerMTok:  1.00, outputPerMTok:  4.00, contextWindowTokens: 200_000 },
  'claude-haiku-4-5':   { inputPerMTok:  1.00, cacheReadPerMTok: 0.10,  cacheWritePerMTok:  1.25, outputPerMTok:  5.00, contextWindowTokens: 200_000 },
  'claude-sonnet-4':    { inputPerMTok:  3.00, cacheReadPerMTok: 0.30,  cacheWritePerMTok:  3.75, outputPerMTok: 15.00, contextWindowTokens: 1_000_000,
                          longContextThresholdTokens: 200_000,
                          inputAboveThresholdPerMTok: 6.00, outputAboveThresholdPerMTok: 22.50, cacheReadAboveThresholdPerMTok: 0.60, cacheWriteAboveThresholdPerMTok: 7.50 },
  'claude-sonnet-4-5':  { inputPerMTok:  3.00, cacheReadPerMTok: 0.30,  cacheWritePerMTok:  3.75, outputPerMTok: 15.00, contextWindowTokens: 1_000_000 },
  'claude-sonnet-4-6':  { inputPerMTok:  3.00, cacheReadPerMTok: 0.30,  cacheWritePerMTok:  3.75, outputPerMTok: 15.00, contextWindowTokens: 1_000_000 },
  // claude-sonnet-5: launched at introductory pricing ($2/$0.20/$2.50/$10) with a scheduled increase to
  // $3/$0.30/$3.75/$15 on 2026-09-01 — confirmed 2026-08-12 that increase has been cancelled and this rate is
  // now the permanent standard price. No date-driven change needed.
  'claude-sonnet-5':    { inputPerMTok:  2.00, cacheReadPerMTok: 0.20,  cacheWritePerMTok:  2.50, outputPerMTok: 10.00, contextWindowTokens: 1_000_000 },
  'claude-opus-4-5':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000 },
  'claude-opus-4-6':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000 },
  'claude-opus-4-7':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000 },
  'claude-opus-4-8':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000 },
  // claude-opus-5: added 2026-08-07, now GA per Anthropic's pricing page — same rate as Opus 4.8.
  'claude-opus-5':      { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000 },
  // fast mode for Opus 4.6 was removed 2026-06-29 — requests now run at standard speed/rates despite the -fast suffix.
  'claude-opus-4-6-fast':{ inputPerMTok:  5.00, cacheReadPerMTok: 0.50, cacheWritePerMTok:  6.25, outputPerMTok:  25.00, contextWindowTokens: 1_000_000 },
  // fast mode for Opus 4.7 is confirmed removed as of this refresh (2026-08-07) — Anthropic's docs now state
  // requests with speed:"fast" return an error. Entry frozen for historical sessions only.
  'claude-opus-4-7-fast':{ inputPerMTok: 30.00, cacheReadPerMTok: 3.00, cacheWritePerMTok: 37.50, outputPerMTok: 150.00, contextWindowTokens: 1_000_000 },
  'claude-opus-4-8-fast':{ inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000 },
  // claude-opus-5-fast: added 2026-08-07 — Anthropic's fast-mode table lists Opus 5 and Opus 4.8 together at the same rate.
  'claude-opus-5-fast':  { inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000 },
  'claude-fable-5':      { inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000 },
  // claude-mythos-5: limited-availability preview (anthropic.com/glasswing), same rates as Fable 5.
  'claude-mythos-5':     { inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000 },
  // claude-fable-5-1 / claude-mythos-5-1: added 2026-09-01 — new on Anthropic's pricing page. Same input/output
  // and cache-write rates as Fable 5, but cache reads are 0.025x base input ($0.25/MTok) instead of the usual
  // 0.1x ($1.00/MTok) — the one rate that differs between the .0 and .1 releases. Slug follows the file's
  // hyphenated-minor convention (claude-opus-4-8); normalizeCostKey resolves a dotted telemetry ID to it.
  'claude-fable-5-1':   { inputPerMTok: 10.00, cacheReadPerMTok: 0.25, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000 },
  'claude-mythos-5-1':  { inputPerMTok: 10.00, cacheReadPerMTok: 0.25, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000 },
  // ── Google ─────────────────────────────────────────────────────────────────
  'gemini-2.5-pro':  { inputPerMTok: 1.25, cacheReadPerMTok: 0.125, cacheWritePerMTok: 0, outputPerMTok: 10.00, contextWindowTokens: 1_000_000 },
  'gemini-3-flash':  { inputPerMTok: 0.50, cacheReadPerMTok: 0.05,  cacheWritePerMTok: 0, outputPerMTok:  3.00, contextWindowTokens: 1_000_000 },
  'gemini-3-pro':    { inputPerMTok: 2.00, cacheReadPerMTok: 0.20,  cacheWritePerMTok: 0, outputPerMTok: 12.00, contextWindowTokens: 1_000_000 },
  // gemini-3.1-pro: long-context surcharge above 200K tokens/call confirmed 2026-08-12 (2x input/cache-read, 1.5x output).
  'gemini-3.1-pro':  { inputPerMTok: 2.00, cacheReadPerMTok: 0.20,  cacheWritePerMTok: 0, outputPerMTok: 12.00, contextWindowTokens: 1_000_000,
                       longContextThresholdTokens: 200_000,
                       inputAboveThresholdPerMTok: 4.00, cacheReadAboveThresholdPerMTok: 0.40, outputAboveThresholdPerMTok: 18.00 },
  'gemini-3.5-flash':{ inputPerMTok: 1.50, cacheReadPerMTok: 0.15,  cacheWritePerMTok: 0, outputPerMTok:  9.00, contextWindowTokens: 1_000_000 },
  // gemini-3.6-flash: corrected 2026-08-26 — was $1.50/$0.15/$7.50, Copilot's pricing page now shows
  // $0.75/$0.075/$3.75, labeled "promotional pricing through Dec 31, 2026."
  'gemini-3.6-flash':{ inputPerMTok: 0.75, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0, outputPerMTok:  3.75, contextWindowTokens: 1_000_000 },
  // gemini-3.7-flash: added 2026-08-26 — new on the Copilot pricing page, same promotional rate as 3.6-flash above.
  'gemini-3.7-flash':{ inputPerMTok: 0.75, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0, outputPerMTok:  3.75, contextWindowTokens: 1_000_000 },
  // gemini-3.8-flash: added 2026-09-15 — new on the Copilot pricing page, same promotional rate and end date
  // (Dec 31, 2026) as 3.6/3.7-flash above.
  'gemini-3.8-flash':{ inputPerMTok: 0.75, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0, outputPerMTok:  3.75, contextWindowTokens: 1_000_000 },
  // ── Fine-tuned ─────────────────────────────────────────────────────────────
  // raptor-mini: no longer an included/$0 model as of the 2026-07-19 Copilot pricing page — now billed at standard rates.
  'raptor-mini': { inputPerMTok: 0.25, cacheReadPerMTok: 0.025, cacheWritePerMTok: 0, outputPerMTok:  2.00,  contextWindowTokens: 0 },
  'goldeneye':   { inputPerMTok: 1.25, cacheReadPerMTok: 0.125, cacheWritePerMTok: 0, outputPerMTok: 10.00, contextWindowTokens: 0 },
  // ── OpenCode Zen  https://opencode.ai/docs/zen/ ────────────────────────────
  // big-pickle: OpenCode's stealth model, free during limited evaluation period.
  'big-pickle':  { inputPerMTok: 0,    cacheReadPerMTok: 0,     cacheWritePerMTok: 0, outputPerMTok:  0,     contextWindowTokens: 200_000 },
  // Free Zen-exclusive models, added 2026-08-12 — model ID slugs confirmed from the Zen docs (previously withheld
  // pending confirmation; see PRICING_SOURCES.md). All free during their "limited time" evaluation period, same
  // caveat as big-pickle.
  'deepseek-v4-flash-free':      { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0, contextWindowTokens: 0 },
  'mimo-v2.5-free':               { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0, contextWindowTokens: 0 },
  'hy3-free':                     { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0, contextWindowTokens: 0 },
  'laguna-s-2.1-free':            { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0, contextWindowTokens: 0 },
  'ling-3.0-tiny-free':           { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0, contextWindowTokens: 0 },
  'nemotron-3-ultra-free':        { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0, contextWindowTokens: 0 },
  'nemotron-3.5-lightning-free':  { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0, contextWindowTokens: 0 },
  // Added 2026-09-01 from the Zen docs. muse-spark-1.2-contributor-free's slug was flagged unconfirmed last
  // refresh and is now confirmed. ling-3.0-flash-fin-free is new this pass; ling-3.0-tiny-free (kept below) is
  // no longer on the page — likely renamed to it, but left in place since it's $0 either way (see PRICING_SOURCES.md).
  'ling-3.0-flash-fin-free':      { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0, contextWindowTokens: 0 },
  'muse-spark-1.2-contributor-free': { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0, contextWindowTokens: 0 },
  // muse-spark-1.3-contributor-free: added 2026-09-15 — 1.2 is gone from the Zen docs, replaced by this; both
  // keys kept (see ling-3.0-tiny-free/-flash-fin-free above for the same pattern) since it's $0 either way.
  'muse-spark-1.3-contributor-free': { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0, contextWindowTokens: 0 },
}

// Exported so callers that build a model ID by appending their own suffix (e.g.
// logReader.ts's fast-mode `-fast` marker) can strip a trailing date first — a raw
// model string can be date-suffixed (e.g. claude-opus-4-7-20260315), and appending
// another suffix afterward moves the date off the end, out of reach of the
// date-stripping regex normalizeCostKey() applies below.
export function stripDateSuffix(modelId: string): string {
  return modelId
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')  // strip date suffix e.g. -2025-04-14
    .replace(/-\d{8}$/, '')               // strip YYYYMMDD suffix e.g. -20260501
}

// Normalizes a model ID to the key used for rate lookup. Vendors and telemetry sources disagree on
// whether a minor version is punctuated with a dot or a hyphen: Copilot VS Code emits
// `claude-opus-4.8` while this table keys that model `claude-opus-4-8`; OpenAI IDs like `gpt-5.4`
// run the other way. Collapsing `.`, whitespace, and `_` to `-` — applied to BOTH the incoming ID
// and every RATES key (see RATES_BY_COST_KEY) — makes the two representations meet. Lookup only;
// the raw model ID is still what gets stored and displayed. See GH #231.
export function normalizeCostKey(modelId: string): string {
  return stripDateSuffix(modelId.toLowerCase())
    .trim()
    .replace(/[.\s_]+/g, '-')
}

// RATES re-keyed by normalizeCostKey, built once at module load. If two distinct RATES keys
// collapse to the same cost key with *different* rates, that's a table-authoring mistake that would
// otherwise let one silently shadow the other — fail loudly instead.
const RATES_BY_COST_KEY: Map<string, ModelRates> = (() => {
  const map = new Map<string, ModelRates>()
  for (const [modelId, rates] of Object.entries(RATES)) {
    const key = normalizeCostKey(modelId)
    const existing = map.get(key)
    if (existing && JSON.stringify(existing) !== JSON.stringify(rates)) {
      throw new Error(
        `pricing: RATES key "${modelId}" collapses to cost key "${key}", which another key ` +
        `already maps to with different rates — rename one so they don't collide under normalizeCostKey`,
      )
    }
    map.set(key, rates)
  }
  return map
})()

// Optional override, populated only by a linked install's src/cloud/team/pricingSync.ts —
// unset (empty) for every unlinked install, which is the overwhelming majority of usage. Checked
// first in lookupRates below, falling back to the local RATES_BY_COST_KEY exactly as before when
// empty or when a model isn't in it. This is the one and only seam cloud-sourced pricing enters
// through: the calculation itself (calcTokenCostUsd's formula, tiered pricing, normalizeCostKey)
// is completely unaffected — only where a rate's *numbers* come from can change.
//
// Cloud's effective-rates endpoint only knows 4 flat per-MTok rates (no tiered/long-context
// surcharge fields, no contextWindowTokens — the cloud pricing table doesn't model either). An
// override entry always gets contextWindowTokens: 0 ("unknown"), same as any other model this
// file has no context-window data for; cost math is unaffected, only the Projection tab's
// context-fill estimate loses precision for an overridden model specifically.
let cloudRateOverrides: Map<string, ModelRates> = new Map()

export function setCloudRateOverrides(rates: Record<string, Omit<ModelRates, 'contextWindowTokens'>>): void {
  const map = new Map<string, ModelRates>()
  for (const [modelId, r] of Object.entries(rates)) {
    map.set(normalizeCostKey(modelId), { ...r, contextWindowTokens: 0 })
  }
  cloudRateOverrides = map
}

/** Snapshot of whichever cloud rate overrides are currently active, keyed by normalizeCostKey —
 *  for surfacing "local vs remote" in the Pricing tab. Empty on an unlinked install or before the
 *  first successful sync (see pricingSync.ts). Read-only local-memory access, no network call. */
export function getCloudRateOverrides(): Record<string, ModelRates> {
  return Object.fromEntries(cloudRateOverrides)
}

// Exact match only, after normalization — no prefix-matching fallback. A previous
// version fell back to substring-prefix matching ("versioned or aliased model IDs"),
// but that let an unrecognized *newer* model silently inherit an unrelated *older*
// model's rate whenever the new ID happened to start with an existing key (e.g. a
// hypothetical claude-opus-4-9 would have matched the deprecated claude-opus-4 entry
// and been priced at its stale rate instead of showing as unknown). Showing ~$? for
// a genuinely unrecognized model and prompting a RATES addition is the intended
// failure mode elsewhere in this file — a confidently wrong number is worse than a
// visible gap.
export function lookupRates(modelId: string): ModelRates | null {
  if (!modelId) return null
  const cloudRate = cloudRateOverrides.get(normalizeCostKey(modelId))
  if (cloudRate) return cloudRate
  return RATES_BY_COST_KEY.get(normalizeCostKey(modelId)) ?? null
}

// Applies two-tier pricing: tokens up to the threshold at baseRate, remainder at aboveRate.
function tieredCost(tokens: number, threshold: number, baseRatePerMTok: number, aboveRatePerMTok: number): number {
  if (tokens <= threshold) return (tokens / 1_000_000) * baseRatePerMTok
  return (threshold / 1_000_000) * baseRatePerMTok
       + ((tokens - threshold) / 1_000_000) * aboveRatePerMTok
}

export function calcTokenCostUsd(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
  modelId: string,
): number {
  const rates = lookupRates(modelId)
  if (!rates) return 0
  if (rates.inputAboveThresholdPerMTok !== undefined) {
    // Threshold defaults to 200K if above-threshold rates are set without an explicit threshold
    // (kept for claude-sonnet-4 parity — every model added since has set this explicitly).
    // Missing per-category above-threshold rates (e.g. cache write on a model with no cache-write
    // pricing at all) fall back to that category's flat rate, i.e. no surcharge for that category.
    const threshold = rates.longContextThresholdTokens ?? 200_000
    return tieredCost(inputTokens,     threshold, rates.inputPerMTok,      rates.inputAboveThresholdPerMTok)
         + tieredCost(cacheReadTokens,  threshold, rates.cacheReadPerMTok,  rates.cacheReadAboveThresholdPerMTok ?? rates.cacheReadPerMTok)
         + tieredCost(cacheWriteTokens, threshold, rates.cacheWritePerMTok, rates.cacheWriteAboveThresholdPerMTok ?? rates.cacheWritePerMTok)
         + tieredCost(outputTokens,     threshold, rates.outputPerMTok,     rates.outputAboveThresholdPerMTok ?? rates.outputPerMTok)
  }
  return (inputTokens     / 1_000_000) * rates.inputPerMTok
       + (cacheReadTokens / 1_000_000) * rates.cacheReadPerMTok
       + (cacheWriteTokens/ 1_000_000) * rates.cacheWritePerMTok
       + (outputTokens    / 1_000_000) * rates.outputPerMTok
}
