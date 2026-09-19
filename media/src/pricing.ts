// Pricing data for Copilot cost estimation.
// Token rates: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
export const PRICING_LAST_UPDATED = '2026-09-15'

export interface ModelRates {
  inputPerMTok: number              // USD per 1M input tokens
  cacheReadPerMTok: number          // USD per 1M cache-read tokens (0 if n/a)
  cacheWritePerMTok: number         // USD per 1M cache-write tokens (0 if n/a)
  outputPerMTok: number             // USD per 1M output tokens
  // Optional tiered rates for >200K tokens-per-call surcharge. Not applied in session-level calcTokenCost
  // (which operates on session totals and can't reconstruct per-turn call sizes).
  inputAbove200kPerMTok?: number
  outputAbove200kPerMTok?: number
  cacheReadAbove200kPerMTok?: number
  cacheWriteAbove200kPerMTok?: number
  // Set when a source explicitly labels this rate as temporary/promotional rather than the vendor's
  // standard price. Free-text, vendor's own wording — deliberately NOT a machine-checked expiration
  // date. Vendors don't reliably honor their own stated end dates (see claude-sonnet-5's cancelled
  // Sept 1 2026 increase below), so computing "is this still active" would assert a certainty the
  // refresh process can't back up. Displayed as-is on the in-app Pricing page; re-verify promotional
  // rates at the next refresh regardless of whether their stated window has technically passed.
  promoNote?: string
}

// Keyed by normalized model ID (lowercase, no date suffix).
export const RATES: Record<string, ModelRates> = {
  // ── OpenAI ─────────────────────────────────────────────────────────────────────────────────────
  // gpt-4.1: re-listed on the pricing page as of 2026-08-07 at real rates (previously assumed delisted/$0 —
  // that turned out to be wrong or stale; correcting to the live page value).
  'gpt-4.1':             { inputPerMTok: 2.00,  cacheReadPerMTok: 0.50,   cacheWritePerMTok: 0, outputPerMTok: 8.00 },
  // gpt-4.1-mini: added 2026-08-12 — confirmed on OpenAI's general API pricing page. Not seen on Copilot's own
  // model list yet.
  'gpt-4.1-mini':        { inputPerMTok: 0.40,  cacheReadPerMTok: 0.10,   cacheWritePerMTok: 0, outputPerMTok: 1.60 },
  // gpt-5-mini: no longer included/$0 as of 2026-07-19 — now billed at standard token rates.
  // (The old `'gpt-5 mini'` space-variant alias key is gone — normalizeCostKey collapses the space to a hyphen.)
  'gpt-5-mini':          { inputPerMTok: 0.25,  cacheReadPerMTok: 0.025,  cacheWritePerMTok: 0, outputPerMTok: 2.00 },
  // older included models kept for historical sessions
  'gpt-4o':              { inputPerMTok: 2.50,  cacheReadPerMTok: 1.25,   cacheWritePerMTok: 0, outputPerMTok: 10.00 },
  'gpt-4o-mini':         { inputPerMTok: 0.15,  cacheReadPerMTok: 0.075,  cacheWritePerMTok: 0, outputPerMTok: 0.60 },
  // gpt-5.1 corrected 2026-08-07 — was $1.75/$14.00, live pricing page now shows $1.25/$10.00 (older-gen model
  // repriced down below gpt-5.2). gpt-5.1-codex/-mini/-max not independently re-confirmed this round — left
  // unchanged, see PRICING_SOURCES.md Known gaps.
  'gpt-5.1':             { inputPerMTok: 1.25,  cacheReadPerMTok: 0.125,  cacheWritePerMTok: 0, outputPerMTok: 10.00 },
  'gpt-5.1-codex':       { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00 },
  'gpt-5.1-codex-mini':  { inputPerMTok: 0.75,  cacheReadPerMTok: 0.075,  cacheWritePerMTok: 0, outputPerMTok: 4.50 },
  'gpt-5.1-codex-max':   { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00 },
  // premium models
  'gpt-5.2':             { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00 },
  'gpt-5.2-codex':       { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00 },
  'gpt-5.3-codex':       { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00 },
  'gpt-5.4':             { inputPerMTok: 2.50,  cacheReadPerMTok: 0.25,   cacheWritePerMTok: 0, outputPerMTok: 15.00 },  // long-context surcharge (>272K tokens) not implemented
  'gpt-5.4-mini':        { inputPerMTok: 0.75,  cacheReadPerMTok: 0.075,  cacheWritePerMTok: 0, outputPerMTok: 4.50 },
  'gpt-5.4-nano':        { inputPerMTok: 0.20,  cacheReadPerMTok: 0.02,   cacheWritePerMTok: 0, outputPerMTok: 1.25 },
  'gpt-5.5':             { inputPerMTok: 5.00,  cacheReadPerMTok: 0.50,   cacheWritePerMTok: 0, outputPerMTok: 30.00 },  // long-context surcharge (>unknown threshold) not implemented
  // gpt-5.6 family: Luna (small/fast), Terra (mid), Sol (flagship). Corrected 2026-08-07 — Luna and Terra were
  // repriced down (Luna $1.00→$0.20 input, Terra $2.50→$2.00 input), and the whole family gained real cache-write
  // pricing (1.25x input, confirmed across the Copilot docs, OpenAI's pricing page, and the Codex credits page).
  // A "long context" surcharge tier also exists above an unconfirmed token threshold (~2x input/cache, ~1.5x
  // output per Copilot's docs) — not implemented; see PRICING_SOURCES.md Known gaps.
  'gpt-5.6-luna':        { inputPerMTok: 0.20,  cacheReadPerMTok: 0.02,   cacheWritePerMTok: 0.25, outputPerMTok: 1.20 },
  'gpt-5.6-terra':       { inputPerMTok: 2.00,  cacheReadPerMTok: 0.20,   cacheWritePerMTok: 2.50, outputPerMTok: 12.00 },
  // gpt-5.6-sol: corrected 2026-08-26 — OpenAI's own API page dropped this from $5.00/$0.50/$6.25/$30.00 to
  // $4.00/$0.40/$5.00/$20.00, noted on the source page as "promotional pricing... at least through November 21,
  // 2026." Copilot additionally layers its own extra 50% promotional discount on top of this for Copilot-sourced
  // sessions specifically ($2.00/$0.20/$2.50/$10.00) — not modeled here (one shared rate per model regardless of
  // source agent, same as everywhere else in this file); see PRICING_SOURCES.md Known gaps.
  // Copilot's own separate extra-50%-off layer on top of this rate, previously through Sept 3, 2026, is gone
  // from Copilot's pricing page as of the 2026-09-15 refresh — it ended as scheduled, so this rate is now
  // correct for Copilot-sourced sessions too (previously overstated ~2x while that discount was live).
  'gpt-5.6-sol':         { inputPerMTok: 4.00,  cacheReadPerMTok: 0.40,   cacheWritePerMTok: 5.00, outputPerMTok: 20.00,
                           promoNote: 'OpenAI: promotional pricing, at least through Nov 21, 2026' },
  // gpt-5.6-cyber: added 2026-08-26 — new on OpenAI's API pricing page.
  'gpt-5.6-cyber':       { inputPerMTok: 12.50, cacheReadPerMTok: 1.25,   cacheWritePerMTok: 15.625, outputPerMTok: 75.00 },
  // gpt-6-astra: added 2026-09-15 — new flagship, confirmed on Copilot's pricing page, OpenAI's own API pricing
  // page, and the Codex CLI credits page. Long-context surcharge (>272K tokens) not implemented here, same as the 5.6 family.
  'gpt-6-astra':         { inputPerMTok: 10.00, cacheReadPerMTok: 1.00,   cacheWritePerMTok: 12.50, outputPerMTok: 50.00 },
  // gpt-4.1-nano, gpt-5-nano, gpt-5 (base): added 2026-08-26 — confirmed on OpenAI's general API pricing page, not
  // independently confirmed as reachable through Copilot specifically this pass.
  'gpt-4.1-nano':        { inputPerMTok: 0.10,  cacheReadPerMTok: 0.025,  cacheWritePerMTok: 0, outputPerMTok: 0.40 },
  'gpt-5-nano':          { inputPerMTok: 0.05,  cacheReadPerMTok: 0.005,  cacheWritePerMTok: 0, outputPerMTok: 0.40 },
  // gpt-5 (base): rate not independently re-confirmed this round; re-check next pass if it turns up in real telemetry.
  'gpt-5':               { inputPerMTok: 1.25,  cacheReadPerMTok: 0.125,  cacheWritePerMTok: 0, outputPerMTok: 10.00 },
  // ── Codex-only models ──────────────────────────────────────────────────────────────────────────
  // codex-mini-latest: fine-tuned o4-mini; 75% cache discount (not the usual 90%); deprecated
  'codex-mini-latest':   { inputPerMTok: 1.50,  cacheReadPerMTok: 0.375,  cacheWritePerMTok: 0, outputPerMTok: 6.00 },
  // ── Anthropic ──────────────────────────────────────────────────────────────────────────────────
  // deprecated — for historical Claude Code sessions
  'claude-opus-4':         { inputPerMTok: 15.00, cacheReadPerMTok: 1.50, cacheWritePerMTok: 18.75, outputPerMTok: 75.00 },
  'claude-opus-4-1':       { inputPerMTok: 15.00, cacheReadPerMTok: 1.50, cacheWritePerMTok: 18.75, outputPerMTok: 75.00 },
  'claude-haiku-3-5':      { inputPerMTok:  0.80, cacheReadPerMTok: 0.08, cacheWritePerMTok:  1.00, outputPerMTok:  4.00 },
  // current
  'claude-haiku-4-5':      { inputPerMTok:  1.00, cacheReadPerMTok: 0.10, cacheWritePerMTok:  1.25, outputPerMTok:  5.00 },
  'claude-sonnet-4':       { inputPerMTok:  3.00, cacheReadPerMTok: 0.30, cacheWritePerMTok:  3.75, outputPerMTok: 15.00,
                             inputAbove200kPerMTok: 6.00, outputAbove200kPerMTok: 22.50, cacheReadAbove200kPerMTok: 0.60, cacheWriteAbove200kPerMTok: 7.50 },
  'claude-sonnet-4-5':     { inputPerMTok:  3.00, cacheReadPerMTok: 0.30, cacheWritePerMTok:  3.75, outputPerMTok: 15.00 },
  'claude-sonnet-4-6':     { inputPerMTok:  3.00, cacheReadPerMTok: 0.30, cacheWritePerMTok:  3.75, outputPerMTok: 15.00 },
  // claude-sonnet-5: launched at introductory pricing ($2/$0.20/$2.50/$10) with a scheduled increase to
  // $3/$0.30/$3.75/$15 on 2026-09-01 — confirmed 2026-08-12 that increase has been cancelled and this rate is
  // now the permanent standard price. No date-driven change needed.
  'claude-sonnet-5':       { inputPerMTok:  2.00, cacheReadPerMTok: 0.20, cacheWritePerMTok:  2.50, outputPerMTok: 10.00 },
  'claude-opus-4-5':       { inputPerMTok:  5.00, cacheReadPerMTok: 0.50, cacheWritePerMTok:  6.25, outputPerMTok: 25.00 },
  'claude-opus-4-6':       { inputPerMTok:  5.00, cacheReadPerMTok: 0.50, cacheWritePerMTok:  6.25, outputPerMTok: 25.00 },
  'claude-opus-4-7':       { inputPerMTok:  5.00, cacheReadPerMTok: 0.50, cacheWritePerMTok:  6.25, outputPerMTok: 25.00 },
  'claude-opus-4-8':       { inputPerMTok:  5.00, cacheReadPerMTok: 0.50, cacheWritePerMTok:  6.25, outputPerMTok: 25.00 },
  // claude-opus-5: added 2026-08-07, now GA per both Anthropic's and Copilot's pricing pages — same rate as Opus 4.8.
  'claude-opus-5':         { inputPerMTok:  5.00, cacheReadPerMTok: 0.50, cacheWritePerMTok:  6.25, outputPerMTok: 25.00 },
  // fast mode (/fast toggle in Claude Code) — model ID appended with -fast by logReader when usage.speed === 'fast'.
  // Opus 4.6 fast mode was removed 2026-06-29: requests run at standard speed/rates despite the -fast suffix.
  'claude-opus-4-6-fast':  { inputPerMTok:  5.00, cacheReadPerMTok: 0.50, cacheWritePerMTok:  6.25, outputPerMTok:  25.00 },
  // Opus 4.7 fast mode is confirmed removed as of this refresh (2026-08-07) — Anthropic's docs now state requests
  // with speed:"fast" return an error. Copilot's own pricing docs never listed a fast-mode row for it either.
  // Entry frozen for historical sessions only.
  'claude-opus-4-7-fast':  { inputPerMTok: 30.00, cacheReadPerMTok: 3.00, cacheWritePerMTok: 37.50, outputPerMTok: 150.00 },
  'claude-opus-4-8-fast':  { inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00 },
  // claude-opus-5-fast: added 2026-08-07 — Anthropic's fast-mode table lists Opus 5 and Opus 4.8 together at the
  // same rate; Copilot's own docs don't yet list a distinct fast-mode row for it, so the rate is carried over
  // from Opus 4.8's fast-mode entry as a best estimate.
  'claude-opus-5-fast':    { inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00 },
  'claude-fable-5':        { inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00 },  // not yet listed in Copilot billing docs
  'claude-mythos-5':       { inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00 },  // limited availability preview; not yet listed in Copilot billing docs
  // claude-fable-5-1 / claude-mythos-5-1: added 2026-09-01 — new on Anthropic's pricing page. Same as Fable 5
  // except cache reads are 0.025x base input ($0.25/MTok) instead of 0.1x ($1.00/MTok). Not in Copilot billing docs.
  'claude-fable-5-1':      { inputPerMTok: 10.00, cacheReadPerMTok: 0.25, cacheWritePerMTok: 12.50, outputPerMTok:  50.00 },
  'claude-mythos-5-1':     { inputPerMTok: 10.00, cacheReadPerMTok: 0.25, cacheWritePerMTok: 12.50, outputPerMTok:  50.00 },
  // ── Google ─────────────────────────────────────────────────────────────────────────────────────
  'gemini-2.5-pro':   { inputPerMTok: 1.25, cacheReadPerMTok: 0.125, cacheWritePerMTok: 0, outputPerMTok: 10.00 },  // long-context surcharge (>200K tokens) not implemented
  'gemini-3-flash':   { inputPerMTok: 0.50, cacheReadPerMTok: 0.05,  cacheWritePerMTok: 0, outputPerMTok: 3.00 },
  'gemini-3-pro':     { inputPerMTok: 2.00, cacheReadPerMTok: 0.20,  cacheWritePerMTok: 0, outputPerMTok: 12.00 },
  'gemini-3.1-pro':   { inputPerMTok: 2.00, cacheReadPerMTok: 0.20,  cacheWritePerMTok: 0, outputPerMTok: 12.00 },  // long-context surcharge (>200K tokens) not implemented
  'gemini-3.5-flash': { inputPerMTok: 1.50, cacheReadPerMTok: 0.15,  cacheWritePerMTok: 0, outputPerMTok: 9.00 },
  // gemini-3.6-flash: corrected 2026-08-26 — was $1.50/$0.15/$7.50, Copilot's pricing page now shows
  // $0.75/$0.075/$3.75, labeled "promotional pricing through Dec 31, 2026."
  'gemini-3.6-flash': { inputPerMTok: 0.75, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0, outputPerMTok: 3.75,
                        promoNote: 'Copilot: promotional pricing through Dec 31, 2026' },
  // gemini-3.7-flash: added 2026-08-26 — new on the Copilot pricing page, same promotional rate as 3.6-flash above.
  'gemini-3.7-flash': { inputPerMTok: 0.75, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0, outputPerMTok: 3.75,
                        promoNote: 'Copilot: promotional pricing through Dec 31, 2026' },
  // gemini-3.8-flash: added 2026-09-15 — new on the Copilot pricing page, same promotional rate and end date as
  // 3.6/3.7-flash above.
  'gemini-3.8-flash': { inputPerMTok: 0.75, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0, outputPerMTok: 3.75,
                        promoNote: 'Copilot: promotional pricing through Dec 31, 2026' },
  // ── Fine-tuned ─────────────────────────────────────────────────────────────────────────────────
  // raptor-mini: no longer included/$0 as of 2026-07-19 — now billed at the same standard rate as gpt-5-mini.
  'raptor-mini': { inputPerMTok: 0.25, cacheReadPerMTok: 0.025, cacheWritePerMTok: 0, outputPerMTok: 2.00 },
  'goldeneye':   { inputPerMTok: 1.25, cacheReadPerMTok: 0.125, cacheWritePerMTok: 0, outputPerMTok: 10.00 },
  // ── Other third-party (new to Copilot marketplace as of 2026-07-19) ───────────────────────────────
  'mai-code-1-flash': { inputPerMTok: 0.75, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0, outputPerMTok: 4.50 },
  // mai-code-1.1-flash: added 2026-08-12 — new on the Copilot pricing page this refresh.
  'mai-code-1.1-flash': { inputPerMTok: 0.20, cacheReadPerMTok: 0.02,  cacheWritePerMTok: 0, outputPerMTok: 1.20 },
  'kimi-k2.7-code':   { inputPerMTok: 0.95, cacheReadPerMTok: 0.19,  cacheWritePerMTok: 0, outputPerMTok: 4.00 },
  // ── Other third-party (new to Copilot marketplace as of 2026-08-07) ───────────────────────────────
  // Exact telemetry model-ID slug unconfirmed (guessed from
  // the Copilot docs display name, matching the existing naming convention) — a wrong guess fails safe (falls
  // back to ~$? rather than mis-pricing), same risk tolerance as the OpenCode Zen free-model gaps below.
  'grok-4.5':         { inputPerMTok: 2.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok: 0, outputPerMTok: 6.00 },
  // grok-4.6: added 2026-08-26 — new on the Copilot pricing page, same rate as grok-4.5.
  'grok-4.6':         { inputPerMTok: 2.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok: 0, outputPerMTok: 6.00 },
  'kimi-k3':          { inputPerMTok: 3.00, cacheReadPerMTok: 0.30,  cacheWritePerMTok: 0, outputPerMTok: 15.00 },
  // ── OpenCode Zen  https://opencode.ai/docs/zen/ ────────────────────────────
  // big-pickle: OpenCode's stealth model, free during limited evaluation period.
  'big-pickle':  { inputPerMTok: 0,    cacheReadPerMTok: 0,     cacheWritePerMTok: 0, outputPerMTok: 0 },
  // Free Zen-exclusive models, added 2026-08-12 — model ID slugs confirmed from the Zen docs (previously withheld
  // pending confirmation; see PRICING_SOURCES.md). All free during their "limited time" evaluation period, same
  // caveat as big-pickle.
  'deepseek-v4-flash-free':     { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 },
  'mimo-v2.5-free':              { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 },
  'hy3-free':                    { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 },
  'laguna-s-2.1-free':           { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 },
  'ling-3.0-tiny-free':          { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 },
  'nemotron-3-ultra-free':       { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 },
  'nemotron-3.5-lightning-free': { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 },
  // Added 2026-09-01 from the Zen docs. muse-spark-1.2-contributor-free's slug (flagged unconfirmed last refresh)
  // is now confirmed. ling-3.0-flash-fin-free is new; ling-3.0-tiny-free (kept) is no longer on the page — likely
  // renamed to it, left in place since it's $0 either way (see PRICING_SOURCES.md).
  'ling-3.0-flash-fin-free':     { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 },
  'muse-spark-1.2-contributor-free': { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 },
  // muse-spark-1.3-contributor-free: added 2026-09-15 — 1.2 is gone from the Zen docs, replaced by this; both
  // keys kept (same pattern as ling-3.0-tiny-free/-flash-fin-free above) since it's $0 either way.
  'muse-spark-1.3-contributor-free': { inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 },
}

// ── UI display grouping ──────────────────────────────────────────────────────────
// Purely presentational metadata for the Pricing page (tabs/Pricing.tsx) — groups
// RATES entries by vendor (mirroring the section comments above), with the sources
// each group was last checked against. Doesn't affect cost calculation at all;
// PRICING_SOURCES.md's refresh runbook covers keeping this in sync alongside RATES.
export interface PricingSection {
  label: string
  verified: string  // YYYY-MM-DD
  sources: { label: string; url: string }[]
  modelKeys: string[]
}

export const PRICING_SECTIONS: PricingSection[] = [
  {
    label: 'OpenAI (GPT / Codex family)',
    verified: '2026-09-15',
    sources: [
      { label: 'Copilot model pricing', url: 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing' },
      { label: 'OpenAI API pricing', url: 'https://developers.openai.com/api/docs/pricing' },
      { label: 'Codex CLI pricing', url: 'https://learn.chatgpt.com/docs/pricing' },
    ],
    modelKeys: [
      'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-5', 'gpt-5-nano', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini',
      'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1-codex-max',
      'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
      'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-cyber', 'gpt-6-astra', 'codex-mini-latest',
    ],
  },
  {
    label: 'Anthropic (Claude)',
    verified: '2026-09-15',
    sources: [
      { label: 'Anthropic API pricing', url: 'https://platform.claude.com/docs/en/about-claude/pricing' },
      { label: 'Copilot model pricing', url: 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing' },
    ],
    modelKeys: [
      'claude-opus-4', 'claude-opus-4-1', 'claude-haiku-3-5', 'claude-haiku-4-5',
      'claude-sonnet-4', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5',
      'claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5',
      'claude-opus-4-6-fast', 'claude-opus-4-7-fast', 'claude-opus-4-8-fast', 'claude-opus-5-fast',
      'claude-fable-5', 'claude-mythos-5', 'claude-fable-5-1', 'claude-mythos-5-1',
    ],
  },
  {
    label: 'Google (Gemini)',
    verified: '2026-09-15',
    sources: [
      { label: 'Copilot model pricing', url: 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing' },
    ],
    modelKeys: ['gemini-2.5-pro', 'gemini-3-flash', 'gemini-3-pro', 'gemini-3.1-pro', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash'],
  },
  {
    label: 'Fine-tuned & other Copilot-marketplace models',
    verified: '2026-09-15',
    sources: [
      { label: 'Copilot model pricing', url: 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing' },
    ],
    modelKeys: ['raptor-mini', 'goldeneye', 'mai-code-1-flash', 'mai-code-1.1-flash', 'kimi-k2.7-code', 'grok-4.5', 'grok-4.6', 'kimi-k3'],
  },
  {
    label: 'OpenCode Zen (free evaluation models)',
    verified: '2026-09-15',
    sources: [
      { label: 'OpenCode Zen docs', url: 'https://opencode.ai/docs/zen/' },
    ],
    modelKeys: [
      'big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free', 'hy3-free',
      'laguna-s-2.1-free', 'ling-3.0-tiny-free', 'ling-3.0-flash-fin-free', 'nemotron-3-ultra-free',
      'nemotron-3.5-lightning-free', 'muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free',
    ],
  },
]

// Normalizes a model ID to the key used for rate lookup. Vendors and telemetry sources disagree on
// whether a minor version is punctuated with a dot or a hyphen: Copilot VS Code emits
// `claude-opus-4.8` while this table keys that model `claude-opus-4-8`; OpenAI IDs like `gpt-5.4`
// run the other way. Collapsing `.`, whitespace, and `_` to `-` — applied to BOTH the incoming ID
// and every RATES key (see RATES_BY_COST_KEY) — makes the two representations meet. Lookup only;
// the raw model ID is still what gets stored and displayed. Kept in sync with src/pricing.ts. See GH #231.
export function normalizeCostKey(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')  // strip date suffix e.g. -2025-04-14
    .replace(/-\d{8}$/, '')               // strip YYYYMMDD suffix e.g. -20260501
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

// Exact match only, after normalization — no prefix-matching fallback. A previous
// version fell back to substring-prefix matching ("versioned or aliased model IDs"),
// but that let an unrecognized *newer* model silently inherit an unrelated *older*
// model's rate whenever the new ID happened to start with an existing key (e.g. a
// hypothetical claude-opus-4-9 would have matched the deprecated claude-opus-4 entry
// and been priced at its stale rate instead of showing as unknown). Showing ~$? for
// a genuinely unrecognized model and prompting a RATES addition is the intended
// failure mode elsewhere in this file — a confidently wrong number is worse than a
// visible gap. Kept in sync with the same fix in src/pricing.ts.
export function lookupRates(modelId: string): ModelRates | null {
  if (!modelId) return null
  return RATES_BY_COST_KEY.get(normalizeCostKey(modelId)) ?? null
}

// Token-based cost: the new Copilot AI Credits model (Jun 2026+).
// inputTokens here should be the raw (non-cached) input count.
export function calcTokenCost(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
  rates: ModelRates,
): number {
  return (inputTokens      / 1_000_000) * rates.inputPerMTok
       + (cacheReadTokens  / 1_000_000) * rates.cacheReadPerMTok
       + (cacheWriteTokens / 1_000_000) * rates.cacheWritePerMTok
       + (outputTokens     / 1_000_000) * rates.outputPerMTok
}
