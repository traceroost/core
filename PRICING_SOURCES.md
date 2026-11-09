# Pricing Sources

This file records exactly where each agent's billing data is retrieved from, and the current
best-known rates for each model. It's a reference + refresh runbook, not a changelog. Pricing
corrections that change displayed cost belong in `CHANGELOG.md` at release time, not here.

## How to refresh this file

Do this on its own branch, with its own PR, scoped to pricing changes only. Don't bundle a
pricing refresh into a PR that also does something else. This keeps `git blame` on the rate tables
meaningful (every pricing PR is a pricing PR, nothing more) and makes each refresh easy to review
and revert independently if a source turns out to have been misread.

1. Fetch each source URL below and compare against the rate tables here.
2. Update `RATES` in both `src/pricing.ts` and `media/src/pricing.ts` to match. See
   "Notes for maintainers" at the bottom for lookup/normalization details.
3. If you added, removed, or renamed a model key in `RATES`, update `PRICING_SECTIONS` in
   `media/src/pricing.ts` to match; it's the vendor grouping + source citations the in-app Pricing
   page (`$` icon in the header, `media/src/tabs/Pricing.tsx`) renders. A model left out doesn't go
   missing (the page has an "Uncategorized" fallback for exactly this), but it should still land in
   the right vendor group rather than sit there as a nudge to finish the job. If a source URL in a
   section changed, update `PRICING_SECTIONS[].sources` too.
4. Bump every date that records when pricing was last verified. There's more than one, and it's
   easy to miss one:
   - `PRICING_LAST_UPDATED` in `media/src/pricing.ts`
   - The `PRICING_LAST_UPDATED: <date>` comment at the top of `src/pricing.ts`
   - Every per-section "verified `<date>`" source line below, for whichever sections you actually
     re-checked
   - The matching `PRICING_SECTIONS[].verified` date(s) in `media/src/pricing.ts`; these mirror the
     sections below and drive the "verified `<date>`" text shown on the in-app Pricing page itself
5. If a source explicitly labels a rate as promotional/temporary (its own wording, not your
   inference), set `promoNote` on that model's entry in `media/src/pricing.ts`: free text, quote
   or closely paraphrase the source's own wording including any stated end date (e.g. `'OpenAI:
   promotional pricing, at least through Nov 21, 2026'`). This surfaces as a hover-note `‡` marker
   next to the model name on the in-app Pricing page. Deliberately not a computed
   expiration/start-stop date. Vendors don't reliably honor their own stated windows, so don't
   build logic that treats the note as expired once its date passes; just re-verify the rate (and
   the note) at the next refresh like any other rate, regardless of whether the stated window has
   technically ended. Clear `promoNote` only once a source confirms the rate is no longer
   promotional (folded into the standard rate, or reverted).
6. Run `tsc --noEmit` (both configs), `eslint src media/src`, and `mocha` to confirm nothing broke.
7. If a rate or model can't be confirmed from a source, add it to that section's "Known gaps"
   instead of guessing.

---

## Copilot

Copilot uses token-based AI Credits billing only.

### Billing model: Token-based AI Credits (from Jun 1, 2026)

**Who it applies to:** All Copilot plans.

**Source:** <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing> (verified 2026-11-09: every token rate on this page re-checked and unchanged; no models added or removed on the OpenAI, Google, xAI, Moonshot or Microsoft rows. The Anthropic rows now also show **Claude Fable 5, Fable 5.1, Haiku 4.5, Sonnet 4 and Sonnet 4.6**: each matching `RATES` and Anthropic's page exactly: but not Fable 5.2, Mythos 5.x or Opus 4.5–4.7. Gemini 4 Argon's promo is worded "until December 1, 2026", agreeing with Google's own schedule. A "GPT Image 2.5 Flare" image-generation row is new and not modeled (image tokens, billed separately from the session model). Prior pass (2026-11-08: every existing token rate on this page re-checked and unchanged. New this pass: **GPT-6.1 Terra** (half of GPT-6.1 Sol across the board, three-way confirmed: see the Codex section) and **Gemini 4 Argon** ($2.00/$0.10/$10.00, the same figure OpenCode Zen publishes while calling it 50% off through Nov 30, 2026). Also noticed: this page's Google rows are now **Gemini 3.8 Flash and Gemini 4 Argon only**: `gemini-3.7-flash` has dropped off too, joining the other Gemini keys already absent since 2026-10-11; and the only Claude fast-mode row here is now **Opus 4.8 (fast mode) (preview)**. Nothing removed from `RATES` on that basis: see Known gaps. Prior pass (2026-10-11: existing token rates re-checked; **Claude Sonnet 5.5's cache-read rate corrected** to $0.10 (was $0.20): Anthropic's and this page both list $0.10. New this pass: **GPT-6.1 Sol**, **Claude Haiku 5.5** (priced by prompt length: see the Claude section) and **Grok 4.7**. Prior pass (2026-09-28): all existing token rates re-checked and unchanged; new then: **GPT-6 Sol** and **GPT-6 Luna**: the rest of the GPT-6 family alongside GPT-6 Astra (added last pass), confirmed independently on this page, OpenAI's own API pricing page, and the Codex CLI credits page (Sol: 50/5/250 credits ÷25; Luna: 2.5/0.25/12.5 credits ÷25: both match the USD rates in `RATES` exactly). Also new: **Claude Opus 5.5** and **Claude Sonnet 5.5**, confirmed both here and on Anthropic's own pricing page (see the Claude section below): Opus 5.5 is priced *below* Opus 5 despite the higher version number, and Sonnet 5.5 shares Sonnet 5's exact rate. Also noticed: **Claude Mythos 5 and 5.1 are no longer listed on this page** (they were as of 2026-09-15): Anthropic's own pricing page still lists both unchanged, so this reads as a Copilot-specific model-availability change, not a rate change; same situation as Claude Opus 4.6 (still absent as of this pass too) and `gpt-4.1` previously.)))

**What this page provides:**

- Per-model token rates: `inputPerMTok`, `cacheReadPerMTok`, `cacheWritePerMTok`, `outputPerMTok` (USD per 1M tokens)
- List of included models (effectively $0; look for models with no token rate listed)
- Per-model "long context" surcharge tiers for some models: 2x input/cache-read/cache-write, 1.5x
  output for a call whose prompt is over a per-model threshold (272K for GPT-5.4/5.5/5.6-Sol/5.6-Terra/6-Astra/
  6-Sol/**6-Luna**, 200K for GPT-5.6-Luna/Gemini 3.1 Pro/Grok 4.5). **GPT-6 Luna's threshold (272K) is
  higher than its GPT-5.6-Luna predecessor's (200K)**, confirmed by asking about each model
  individually rather than assuming the "Luna tier is always 200K" pattern carried over; don't
  assume it without re-checking on a future refresh either. Modeled in `RATES` via `longContextThresholdTokens` +
  the `*AboveThresholdPerMTok` fields, identically in `src/pricing.ts` and `media/src/pricing.ts`.
  **The whole call is billed at the higher rates** (input, cache reads, cache writes and output)
  once its prompt (uncached input + cache reads + cache writes; output never counts) is over the
  threshold, not just the tokens past it. That is every vendor's published rule: OpenAI ("prompts
  with >272K input tokens are priced at 2x input and 1.5x output for the full session",
  developers.openai.com/api/docs/models/gpt-5.5), Google (the Gemini Pro "prompts > 200k tokens"
  rows, ai.google.dev/gemini-api/docs/pricing), Anthropic (below). Before 2026-10-11 the code billed
  only each category's excess over the threshold, at the higher rate, and nothing for a call whose
  categories were each under it however large the prompt.
  The tier is only ever applied to a single API call's tokens: a session's cost is the sum of its
  LLM calls priced one by one (`calcSessionCostUsd`, shared by the extension host and the webview)
  whenever the timeline has per-call token counts. Only a session with no per-call data falls back
  to pricing its aggregate totals, and then at flat rates with no tier: a session's cumulative
  cache reads cross 200K/272K long before any single call does, so tiering a total overbills.

**Formula:**

```text
cost = (inputTokens / 1_000_000 × inputRate)
     + (cacheReadTokens / 1_000_000 × cacheReadRate)
     + (cacheWriteTokens / 1_000_000 × cacheWriteRate)
     + (outputTokens / 1_000_000 × outputRate)
aiCredits = cost / 0.01
```

**Known gaps:**

- `gpt-4o`, `gpt-4o-mini` are no longer listed on the current AI Credits pricing page at all (paid
  or included). Kept in `RATES` at their legacy rate for historical/legacy sessions; treat as
  deprecated. `gpt-4.1` is **not** listed on Copilot's own model pricing page as of 2026-08-12
  (confirmed absent, re-checked twice this refresh), but it's still live on OpenAI's general API
  pricing page at the same rate ($2.00/$0.50/$8.00) that Codex CLI uses directly (see the Codex
  section below), so `RATES` is left unchanged. Copilot apparently just doesn't currently offer it
  as a selectable model; that's a different thing from the rate being wrong.
- `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5.1-codex-max`: not independently re-confirmed in the
  2026-08-07 refresh: absent from the general API pricing page (only base `gpt-5.1` was listed,
  and it turned out to have been repriced down to $1.25/$10.00 from $1.75/$14.00). Left unchanged
  at their prior values on the assumption they didn't move, but that's unverified. Re-check next
  refresh.
- **New third-party marketplace models** (`grok-4.5`, `kimi-k3`, `gemini-3.6-flash`): added
  2026-08-07 from the Copilot pricing page. Exact telemetry model-ID slugs are unconfirmed (guessed
  from the docs display name, following the existing naming convention); verify against real
  telemetry when encountered. `mai-code-1.1-flash` added 2026-08-12 on the same basis (new on the
  pricing page this refresh, slug guessed from display name). Separately: `grok-4.5`, `kimi-k3`,
  `kimi-k2.7-code`, and `mai-code-1-flash` existed in `media/src/pricing.ts` (browser) but had never
  been added to `src/pricing.ts` (extension host): a real sync gap, not a rate error, that made
  `cost_usd` store as `0` rather than the correct amount for any Copilot session using them. Fixed
  2026-08-12; both files now match. `grok-4.6` and `gemini-3.7-flash` added 2026-08-26, same basis
  (new on the Copilot pricing page this refresh, slug guessed from display name), added to both
  files together this time, no sync gap introduced. `gemini-3.6-flash` was corrected the same pass:
  its price dropped from $1.50/$0.15/$7.50 to $0.75/$0.075/$3.75, labeled on Copilot's page as
  "promotional pricing through Dec 31, 2026", the same promotional rate the new 3.7-flash launched
  at. `gpt-5.6-cyber` also added 2026-08-26, confirmed on OpenAI's own API pricing page rather than
  Copilot's (not yet independently confirmed as reachable through Copilot specifically).
- **`gpt-6-astra`**: added 2026-09-15: a new flagship above GPT-5.6 Sol, confirmed independently on
  Copilot's own pricing page, OpenAI's general API pricing page, and the Codex CLI credits page
  (250/25/1250 credits ÷ 25 = $10.00/$1.00/$50.00), so no slug-guessing risk here. Same tiered shape
  as the GPT-5.6 family: cache-write at 1.25x input, long-context surcharge above 272K tokens/call
  (2x input/cache/cache-write, 1.5x output). OpenAI's page also lists a fast-mode rate
  ($20.00/$2.00/$100.00 short-context), not modeled, consistent with not modeling GPT-5.6 fast mode.
- **`gemini-3.8-flash`**: added 2026-09-15, new on Copilot's pricing page, same promotional rate and
  end date (Dec 31, 2026) as `gemini-3.6-flash`/`gemini-3.7-flash`.
- **Claude Opus 4.6 no longer listed on Copilot's model pricing page** as of the 2026-09-15 refresh
  (Opus 4.7, 4.8, and 5 still are), **still absent as of 2026-09-28**. Anthropic's own pricing page
  still lists Opus 4.6 unchanged, so this reads as Copilot not currently offering it as a selectable
  model: the same situation as `gpt-4.1` above, not a rate change. `claude-opus-4-6` is left in
  `RATES` unchanged; still correct for direct-API and any historical Copilot sessions.
- **Claude Mythos 5 and 5.1 no longer listed on Copilot's model pricing page** as of the 2026-09-28
  refresh (both were listed as of 2026-09-15). Anthropic's own pricing page still lists both
  unchanged (limited-availability Project Glasswing preview), so same situation as Opus 4.6 above:
  `claude-mythos-5`/`claude-mythos-5-1` left in `RATES` unchanged.
- **`gpt-6-sol`, `gpt-6-luna`**: added 2026-09-28, the rest of the GPT-6 family alongside
  `gpt-6-astra` (added 2026-09-15, see above), confirmed independently on Copilot's pricing page,
  OpenAI's own API pricing page, and the Codex CLI credits page, so no slug-guessing risk. Same
  tiered shape as `gpt-6-astra`: cache-write at 1.25x input, long-context surcharge above 272K
  tokens/call for both (see the "GPT-6 Luna's threshold" callout above; it does **not** inherit
  GPT-5.6-Luna's lower 200K threshold).
- **`claude-opus-5-5`, `claude-sonnet-5-5`**: added 2026-09-28, new this pass, confirmed on both
  Copilot's model pricing page and Anthropic's own pricing page (exact match on both). Opus 5.5 is
  priced *below* Opus 5 ($4.00/$5.00/$8.00/$0.20¹/$20.00 vs Opus 5's $5.00/$6.25/$10.00/$0.50/$25.00)
  despite the higher version number. Anthropic's page confirms this isn't a typo, it's a distinct,
  cheaper model. Sonnet 5.5 shares Sonnet 5's input/output/cache-write rate, but its cache hits are 0.05x ($0.10, footnote 2 on Anthropic's page; corrected 2026-10-11 from $0.20). See the Claude section below for the fast-mode
  entry and the cache-hit-rate exception (¹0.05x base input on Opus 5.5, vs the usual 0.1x).
- **`claude-sonnet-5-5` corrected 2026-10-11**: its cache-read rate is $0.10 (0.05x base input, the
  same exception as Opus 5.5), not $0.20. The 2026-09-28 pass added it at Sonnet 5's rate on the
  assumption that the two models matched. Anthropic's pricing page and this page both list $0.10.
- **`gpt-6.1-sol`, `claude-haiku-5-5`, `grok-4.7`**: added 2026-10-11, all listed on this page.
  `gpt-6.1-sol` is three-way confirmed (this page, OpenAI's API page, Codex credits 50/2.5/250 ÷ 25);
  same shape as `gpt-6-sol` (cache-write 1.25x input, long-context tier above 272K) except the
  cache-read rate is half. `claude-haiku-5-5` is confirmed here and on Anthropic's page; it is the
  one Claude model with a long-context tier (billed on the whole call; see the Claude section). `grok-4.7` matches
  `grok-4.5`/`4.6` exactly (also on OpenCode Zen's list at the same rates); slug guessed from the
  display name. `gpt-6.1-sol`'s context window isn't on any pricing page and is left at 0 (unknown)
  in `src/pricing.ts`.
- **`gpt-6.1-terra`, `gemini-4-argon`**: added 2026-11-08, both listed on this page. `gpt-6.1-terra` is
  three-way confirmed (this page, OpenAI's API page, Codex credits 25/1.25/125 ÷ 25) and is exactly half of
  `gpt-6.1-sol` in every category, with the same shape (cache-write 1.25x input, cache-read 0.05x input,
  long-context tier above 272K). `gemini-4-argon` is listed here at $2.00/$0.10/$10.00 with no cache-write
  rate; OpenCode Zen lists the identical figure and labels it "50% off" through Nov 30, 2026, so `RATES`
  carries the discounted rate (what a session is billed today) with a `promoNote`. Re-check right after
  that date, since the undiscounted rate would be double. Neither page states either model's context window,
  so both are left at 0 (unknown) in `src/pricing.ts`.
- **Gemini rows narrowed again 2026-11-08**: this page's Google tables now list only `gemini-3.8-flash` and
  `gemini-4-argon`. `gemini-3.7-flash` has dropped off since the last pass, and `gemini-2.5-pro`,
  `gemini-3-flash`, `gemini-3-pro`, `gemini-3.1-pro`, `gemini-3.5-flash` and `gemini-3.6-flash` remain
  absent. All kept in `RATES` unchanged and unconfirmed, the same treatment as `gpt-4.1` and Opus 4.6 above.
  Note this page is the *only* source cited for the Gemini section, so those keys now have no live source at
  all; if they need re-confirming, add Google's own pricing page (ai.google.dev/gemini-api/docs/pricing) as a
  second source for that section rather than guessing.
- **Claude fast-mode rows on this page 2026-11-08**: only **Opus 4.8 (fast mode) (preview)** is listed, at
  $10.00/$1.00/$12.50/$50.00, matching `claude-opus-4-8-fast`. Anthropic's own page is the authority for the
  rest of the fast-mode lineup (Opus 5.5 and Opus 5 both still listed there; see the Claude section).
- **Partly re-checked 2026-10-11**: this page's current tables list only `gemini-3.7-flash` and
  `gemini-3.8-flash` for Google and no longer show `raptor-mini`, `goldeneye`, `gemini-2.5-pro`,
  `gemini-3-flash`, `gemini-3-pro`, `gemini-3.1-pro`, `gemini-3.5-flash` or `gemini-3.6-flash`.
  `gemini-3.1-pro`, `gemini-3-flash` and `gemini-3.5-flash` match OpenCode Zen's list; the rest are
  unchanged and unconfirmed this pass, left in `RATES` as before.

---

## Claude

Claude Code CLI uses Anthropic API token-based pricing only, with no request-multiplier system.

### Billing model: Token-based (input / cache write / cache read / output)

**Who it applies to:** All Claude Code CLI users billed through the Anthropic API.

**Source:** <https://platform.claude.com/docs/en/about-claude/pricing> (verified 2026-11-09: **Claude Fable 5.2 and Claude Mythos 5.2 added** (Mythos 5.2 limited availability): $8.00 input / $10.00 5m write / $16.00 1h write / $0.20 cache hits / $40.00 output: *below* Fable/Mythos 5.1, and footnote 1's 0.025x cache-hit exception now names all four of Fable/Mythos 5.1 and 5.2. Both also have fast mode at $16/$80 (the fast-mode table now leads with them). Every other row re-checked and unchanged, including Opus 4/4.1 ($15/$18.75/$1.50/$75: now labelled "retired, except on Google Cloud/Bedrock", as Sonnet 4 is) and the Sonnet 5 permanent-pricing footnote. Prior pass (2026-11-08: **every rate on this page re-checked and confirmed unchanged**, row for row: the standard table, the fast-mode table (Opus 5.5 at $8/$40; Opus 5 and Opus 4.8 sharing $10/$50, both now marked research preview), Haiku 5.5's two prompt-length tiers, the Fable/Mythos 5.1 0.025x and Opus 5.5 / Sonnet 5.5 0.05x cache-hit footnotes, and the Sonnet 5 introductory-pricing-now-permanent note. No new Claude models, no removals. Two wording changes with no rate effect: Opus 4.7 fast mode is now simply absent from the fast-mode table rather than called out as removed (`claude-opus-4-7-fast` stays frozen for historical sessions), and Sonnet 4.5 is marked deprecated in the endpoint-pricing note while keeping its $3/$0.30/$3.75/$15 row. Prior pass (2026-10-11: **Claude Haiku 5.5 added** and **Claude Sonnet 5.5's cache-read corrected to $0.10**; every other rate re-checked and confirmed unchanged, including the Fable/Mythos 5.1 0.025x cache-read rate and the Sonnet 5 introductory-pricing-now-permanent note. Prior pass (2026-09-28): every existing rate re-checked and confirmed unchanged, including the Sonnet 5 introductory-pricing-now-permanent note and Fable/Mythos 5.1's 0.025x cache-read rate. New this pass: **Claude Opus 5.5** (priced below Opus 5: $4.00/$5.00/$8.00/$0.20/$20.00, with its own 0.05x cache-hit multiplier rather than the usual 0.1x: and its own fast-mode row, $8.00/$40.00) and **Claude Sonnet 5.5** (identical rate to Sonnet 5, no fast mode). Both independently confirmed on Copilot's model pricing page too.)))

**Formula:**

```text
cost = (input_tokens / 1_000_000 × inputRate)
     + (cache_creation_tokens / 1_000_000 × cacheWriteRate)
     + (cache_read_tokens / 1_000_000 × cacheReadRate)
     + (output_tokens / 1_000_000 × outputRate)
```

Where `input_tokens` is the raw (non-cached) input count. The session-level `inputTokens` field on `SessionSummaryCard` is the full total (input + cacheRead + cacheCreate), so decompose as:

```text
rawInput = inputTokens - cacheReadTokens - cacheCreateTokens
```

**OTEL fields (from Claude Code CLI telemetry):**

On `claude_code.llm_request` spans (per-API-call):

- `model` / `gen_ai.request.model`: model ID, e.g. `claude-sonnet-4-6`
- `input_tokens`: raw (non-cached) input tokens
- `output_tokens`: output tokens
- `cache_read_tokens`: prompt cache read tokens (charged at ~10% of input rate)
- `cache_creation_tokens`: prompt cache write tokens (charged at ~125% of input rate for 5-min TTL)
- `ttft_ms`: time to first token in ms
- `stop_reason`: e.g. `tool_use`, `end_turn`

**Rates (USD per 1M tokens, verified 2026-11-09: every existing row re-checked and unchanged; Fable 5.2 / Mythos 5.2 and their fast-mode rows added):**

| Model                                                                  | Input  | Cache Write (5m) | Cache Write (1h) | Cache Read | Output  |
| ----------------------------------------------------------------------- | ------ | ----------------- | ----------------- | ---------- | ------- |
| `claude-fable-5-2` (added 2026-11-09: 0.025x cache-hit multiplier, like 5.1) | $8.00  | $10.00             | $16.00             | $0.20      | $40.00  |
| `claude-mythos-5-2` (added 2026-11-09: limited availability)         | $8.00  | $10.00             | $16.00             | $0.20      | $40.00  |
| `claude-fable-5-1`                                                       | $10.00 | $12.50             | $20.00             | $0.25      | $50.00  |
| `claude-mythos-5-1` (limited availability, see anthropic.com/glasswing) | $10.00 | $12.50             | $20.00             | $0.25      | $50.00  |
| `claude-opus-5-5` (added 2026-09-28; 0.05x cache-hit multiplier, not the usual 0.1x) | $4.00  | $5.00              | $8.00              | $0.20      | $20.00  |
| `claude-opus-5`                                                          | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |
| `claude-opus-4-8`                                                        | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |
| `claude-opus-4-7`                                                        | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |
| `claude-opus-4-6`                                                        | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |
| `claude-opus-4-5`                                                        | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |
| `claude-sonnet-5-5` (added 2026-09-28; 0.05x cache-hit multiplier, corrected 2026-10-11; no fast mode) | $2.00  | $2.50              | $4.00              | $0.10      | $10.00  |
| `claude-sonnet-5` (standard; see note below)                           | $2.00  | $2.50              | $4.00              | $0.20      | $10.00  |
| `claude-sonnet-4-6`                                                      | $3.00  | $3.75              | $6.00              | $0.30      | $15.00  |
| `claude-sonnet-4-5`                                                      | $3.00  | $3.75              | $6.00              | $0.30      | $15.00  |
| `claude-sonnet-4`                                                        | $3.00  | $3.75              | $6.00              | $0.30      | $15.00  |
| `claude-haiku-5-5` (added 2026-10-11, prompts ≤100K; over 100K the whole call is $0.50/$0.625/$1.00/$0.05/$2.50) | $0.10  | $0.125             | $0.20              | $0.01      | $0.50   |
| `claude-haiku-4-5`                                                       | $1.00  | $1.25              | $2.00              | $0.10      | $5.00   |
| `claude-fable-5`                                                         | $10.00 | $12.50             | $20.00             | $1.00      | $50.00  |
| `claude-mythos-5` (limited availability, see anthropic.com/glasswing)   | $10.00 | $12.50             | $20.00             | $1.00      | $50.00  |
| `claude-fable-5-2` / `claude-mythos-5-2` (fast mode: added 2026-11-09) | $16.00 | $20.00²            | $32.00²            | $0.40²     | $80.00  |
| `claude-opus-5-5` (fast mode: added 2026-09-28, its own row, not shared with Opus 5/4.8) | $8.00  | $10.00¹            | $16.00¹            | $0.40¹     | $40.00  |
| `claude-opus-5` (fast mode, 2x)                                          | $10.00 | $12.50             | $20.00             | $1.00      | $50.00  |
| `claude-opus-4-8` (fast mode, 2x)                                        | $10.00 | $12.50             | $20.00             | $1.00      | $50.00  |
| `claude-opus-4-7` (fast mode, 6x, **historical only, removed**)        | $30.00 | $37.50             | $60.00             | $3.00      | $150.00 |
| `claude-opus-4-6` (fast mode; bills at standard rate, see note below)  | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |

¹ Anthropic's fast-mode table states only Opus 5.5 fast mode's input ($8.00) and output ($40.00)
directly; it doesn't give separate cache write/read figures for fast mode specifically, but does
state that caching multipliers "stack on top of fast mode pricing." Cache Write (5m)/(1h) here are
the $8.00 fast input at the usual 1.25x/2x multipliers; Cache Read is $8.00 at Opus 5.5's own 0.05x
cache-hit multiplier (not the standard 0.1x), derived, not read directly off a table row, so
re-verify against a real fast-mode+cache session if one shows an unexpected cost.

² Same derivation for Fable 5.2 / Mythos 5.2 fast mode (added 2026-11-09): the table states only $16.00
input and $80.00 output; cache writes are that $16.00 at 1.25x/2x, and cache read is $16.00 at these models'
own 0.025x cache-hit multiplier. Derived, not read off a row.

Fast mode is also available for Fable 5.2 and Mythos 5.2 as of 2026-11-09 (own row, $16/$80).
Fast mode is available for Opus 5.5, Opus 5, and Opus 4.8 (re-checked 2026-11-08): Opus 5.5 has its
own row at $8/$40, Opus 5 and Opus 4.8 share one at $10/$50, and as of this pass the page marks Opus 5's
and Opus 4.8's fast mode as research preview. The page also now states that fast-mode pricing "applies
across the full context window, including requests over 200k input tokens," which matches how `RATES`
models the `-fast` keys (flat, no tier). Opus 4.7 fast mode is simply absent from the fast-mode table as
of 2026-11-08 (earlier passes had an explicit statement that `speed: "fast"` returns an error); either
way it is not billable, so its `-fast` entry in `RATES` stays frozen for historical sessions only. `claude-opus-4-6` still doesn't
support fast mode: requests with `speed: "fast"` run at standard speed and bill at the standard
rate, so its `-fast` entry is set equal to the standard rate rather than a multiplied one. Sonnet
5.5 (like every other Sonnet) doesn't support fast mode at all, so it has no `-fast` entry.

**Tiered pricing: `claude-sonnet-4` and `claude-haiku-5-5`:**

Anthropic's rule (https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing): "A
request's prompt length counts all of its input tokens, including cache reads and cache writes. Each
request is priced on its own: a request over the threshold pays the higher prices even when part of
its prompt is a cache hit." So a call whose input + cache read + cache write is over the threshold
is billed (every category, output included) at the higher row. Claude 4.6 and later (except Haiku
5.5) have no tier: the full 1M context is at standard pricing.

| Token category | `claude-sonnet-4` ≤200K | >200K (1M-context beta) | `claude-haiku-5-5` ≤100K | >100K |
| -------------- | ----------- | ----------- | ------------ | ------------ |
| Input          | $3.00/MTok  | $6.00/MTok  | $0.10/MTok   | $0.50/MTok   |
| Output         | $15.00/MTok | $22.50/MTok | $0.50/MTok   | $2.50/MTok   |
| Cache write    | $3.75/MTok  | $7.50/MTok  | $0.125/MTok  | $0.625/MTok  |
| Cache read     | $0.30/MTok  | $0.60/MTok  | $0.01/MTok   | $0.05/MTok   |

Sonnet 4 is retired on the Claude API and its 1M-context tier is no longer on the pricing page; the
rates above are the ones it carried while it was (same whole-request rule), kept for historical
sessions and Bedrock/Google Cloud.

The threshold applies per API call, not cumulatively across a session. `calcSessionCostUsd` (the same code in `src/pricing.ts` and `media/src/pricing.ts`) prices each LLM call in the timeline on its own (tier included) and sums them. When a session has no per-call token data, its aggregate totals are priced at flat rates without the tier (a slight underestimate for sessions that really did make >200K calls, rather than the large overestimate of tiering the cumulative total).

**Deprecated models (for historical sessions):**

| Model                                | Input   | Cache Read | Output   |
| ------------------------------------ | ------- | ---------- | -------- |
| `claude-opus-4-1` / `claude-opus-4`  | $15.00  | $1.50      | $75.00   |
| `claude-haiku-3-5`                   | $0.80   | $0.08      | $4.00    |

**Tokenizer note:**

Claude Opus 4.7 and later Opus models, Claude Fable 5 / 5.1, Claude Mythos 5 / 5.1, Claude Mythos Preview, and Claude Sonnet 5 / 5.5 use a newer tokenizer that produces approximately 30% more tokens for the same input text than the previous tokenizer (used by Sonnet 4.6 and earlier). Per-token prices are unaffected; this only changes token counts, so effective cost per request can be meaningfully higher for these models even at the same rate card. (Anthropic's page as of 2026-09-28 phrases this more broadly as "Claude 4.7 and later models," which would also cover Opus 5.5, not spelled out as its own bullet previously since it's new this pass, but included by that generalization.)

**Known gaps:**

- **Cache write TTL**: Anthropic supports 5-minute and 1-hour cache TTLs at different rates (1.25x and 2x base input price respectively; cache reads are 0.1x base input). The `cache_creation_tokens` field in telemetry does not distinguish between them. Claude Code CLI uses 5-minute caches by default, so the 5-minute rate is used. If 1-hour caches are in use, cost will be underestimated by roughly 37%.
- **Fast mode (`/fast`)**: When fast mode is active, `usage.speed` is `"fast"` in the local JSONL log. TraceRoost reads this and appends `-fast` to the stored model ID (e.g. `claude-opus-4-7-fast`) so the correct rate is applied. See the fast-mode note under the rate table above for current per-model status.
  **This detection is log-only.** The OTEL fields Claude Code CLI exports on `claude_code.llm_request` spans (listed above: model, input/output/cache tokens, ttft_ms, stop_reason) don't include a speed/fast-mode attribute at all, so `src/summarizers/claude.ts` (the OTEL ingestion path) has nothing to key off: every OTEL-ingested session is priced at the standard rate regardless of whether fast mode was active. This is an upstream telemetry gap (Claude Code doesn't emit fast-mode status via OTEL), not a missed read on TraceRoost's side: re-check if Anthropic ever adds a speed-equivalent OTEL attribute. Sessions ingested from the local log file (rather than OTEL) are unaffected.
- **Data residency multiplier**: `inference_geo: "us"` (Opus 4.6, Sonnet 4.6, and later models) applies a 1.1x multiplier to all token pricing categories. Not currently modeled: cost is underestimated by ~10% for sessions pinned to US-only inference.
- **`claude-fable-5-2` / `claude-mythos-5-2`** (added 2026-11-09): confirmed on Anthropic's page only:
  Copilot's page doesn't list either yet. Slugs follow the file's hyphenated-minor convention
  (`claude-fable-5-1`), and `normalizeCostKey` resolves a dotted telemetry id to them. Their `-fast` rows'
  cache rates are derived (footnote ² above).
- **Deprecated models**: Models older than claude-opus-4 (e.g. claude-3-5-sonnet, claude-3-opus) may appear in historical sessions. Add them to `RATES` in `pricing.ts` if encountered; missing models show as `~$?`.

---

## Codex

Codex CLI uses OpenAI token-based pricing only, with no request-multiplier system.

### Billing model: Token-based (input / cached input / output)

**Who it applies to:** All Codex CLI users.

**Sources:**

- Rate card (official, may require login): <https://help.openai.com/en/articles/20001106-codex-rate-card>. Returned 403 on 2026-07-19; requires an authenticated session to fetch. Not re-attempted since.
- Codex CLI pricing page (credits; divide by 25 for USD): <https://developers.openai.com/codex/pricing>. As of 2026-08-07 this 308-redirects to <https://learn.chatgpt.com/docs/pricing>; use that URL directly.
- API pricing (USD, includes codex models): <https://developers.openai.com/api/docs/pricing>
- `codex-mini-latest` model spec: <https://developers.openai.com/api/docs/models/codex-mini-latest>
- Prompt caching mechanics: <https://developers.openai.com/api/docs/guides/prompt-caching> (verified
  2026-11-09: for GPT-5.6 and later, cache writes are 1.25x uncached input for the default 30-minute
  lifetime, 2.5x for the 12-hour option; cache reads 0.1x, 0.05x on GPT-6.1 Sol/Terra; no cache-write
  charge on earlier models: consistent with every row below)
- Token concepts: <https://developers.openai.com/api/docs/concepts/tokens>: **404 as of 2026-11-09**; no
  replacement URL found this pass. It only ever explained token concepts, not rates.

**Formula:**

```text
non_cached_input = gen_ai.usage.input_tokens - gen_ai.usage.cache_read.input_tokens
cost = (non_cached_input / 1_000_000 × inputRate)
     + (cacheReadTokens / 1_000_000 × cacheReadRate)
     + (outputTokens / 1_000_000 × outputRate)
```

**OTEL fields (from Codex CLI telemetry):**

On `handle_responses` spans (per-API-call):

- `gen_ai.usage.input_tokens`: total input including cached portion
- `gen_ai.usage.output_tokens`: total output including reasoning tokens
- `gen_ai.usage.cache_read.input_tokens`: cached portion of input
- `codex.usage.reasoning_output_tokens`: reasoning subset of output (billed at output rate; no separate reasoning rate observed)

On `session_task.turn` spans (per-turn aggregate):

- `codex.turn.token_usage.input_tokens`
- `codex.turn.token_usage.cached_input_tokens`
- `codex.turn.token_usage.non_cached_input_tokens`
- `codex.turn.token_usage.output_tokens`
- `codex.turn.token_usage.reasoning_output_tokens`

Model name available on `codex.user_prompt`, `codex.turn_ttft`, and `codex.tool_decision` spans via `model` attribute.

**Rates (USD per 1M tokens, verified 2026-11-09 against OpenAI's API pricing page and the Codex CLI credits page: every existing row that either page lists re-checked and unchanged; `gpt-rosalind-research` added. `gpt-4.1-nano` and `codex-mini-latest` are no longer on the API pricing page, and `gpt-5.1-codex*` still aren't: see Known gaps. Prior pass (2026-11-08): every existing row unchanged; `gpt-6.1-terra`, `gpt-6-cyber`, `daybreak-blue` and `daybreak-red` added. Prior pass (2026-10-11): every existing row unchanged, `gpt-6.1-sol` added):**

| Model                   | Input   | Cached Input | Cache Write | Output  | Cache discount | Notes                                          |
| ----------------------- | ------- | ------------ | ----------- | ------- | -------------- | ---------------------------------------------- |
| `gpt-rosalind-research` | $5.00   | $0.50        | — | $25.00  | 90%            | Added 2026-11-09: new on the Codex CLI credits page (125/12.5/625 credits ÷ 25), and OpenAI's API page lists the same $5.00/$0.50/$25.00. Neither gives a cache-write rate or long-context tier. |
| `gpt-6-cyber`           | $20.00  | $2.00        | $25.00      | $100.00 | 90%            | Added 2026-11-08: new on OpenAI's API pricing page (Cyber table), the GPT-6 successor to `gpt-5.6-cyber`. Short-context only; no long-context tier listed, same as 5.6-cyber. |
| `daybreak-blue`         | $4.00   | $0.40        | $5.00       | $20.00  | 90%            | Added 2026-11-08: codenamed model listed **only** on the Codex CLI credits page (100/10/500 credits ÷ 25). Slug guessed from the display name "Daybreak Blue"; cache write derived at the family's 1.25x input, not read off a table. Rates are identical to `gpt-5.6-sol`'s, so this may be a stealth alias: see Known gaps. |
| `daybreak-red`          | $12.50  | $1.25        | $15.625     | $75.00  | 90%            | Added 2026-11-08: same basis as `daybreak-blue` (312.5/31.25/1875 credits ÷ 25). Rates are identical to `gpt-5.6-cyber`'s. |
| `gpt-6-astra`           | $10.00  | $1.00        | $12.50      | $50.00  | 90%            | New flagship, added 2026-09-15: confirmed on Copilot's pricing page, OpenAI's own API pricing page, and here (250/25/1250 credits ÷ 25). Long-context surcharge tier above 272K (2x input/cache/cache-write, 1.5x output → $20.00/$2.00/$25.00/$75.00). A fast-mode rate is also listed on OpenAI's page ($20.00/$2.00/$100.00 short-context): not modeled, consistent with the rest of the family. |
| `gpt-6-sol`             | $2.00   | $0.20        | $2.50       | $10.00  | 90%            | Added 2026-09-28: three-way confirmed (Copilot's pricing page, OpenAI's own API pricing page, and here: 50/5/250 credits ÷ 25). Long-context surcharge tier above 272K → $4.00/$0.40/$5.00/$15.00. |
| `gpt-6-luna`            | $0.10   | $0.01        | $0.125      | $0.50   | 90%            | Added 2026-09-28: three-way confirmed (Copilot's pricing page, OpenAI's own API pricing page, and here: 2.5/0.25/12.5 credits ÷ 25). Long-context surcharge tier above **272K**: asked about specifically since it does *not* inherit GPT-5.6-Luna's lower 200K threshold → $0.20/$0.02/$0.25/$0.75. |
| `gpt-6.1-sol`           | $2.00   | $0.10        | $2.50       | $10.00  | 95%            | Added 2026-10-11: three-way confirmed (Copilot's pricing page, OpenAI's own API pricing page, and here: 50/2.5/250 credits ÷ 25). Same as `gpt-6-sol` except the cache-read rate is half. Long-context surcharge tier above 272K → $4.00/$0.20/$5.00/$15.00. |
| `gpt-6.1-terra`         | $1.00   | $0.05        | $1.25       | $5.00   | 95%            | Added 2026-11-08: three-way confirmed (Copilot's pricing page, OpenAI's own API pricing page, and here: 25/1.25/125 credits ÷ 25). Exactly half of `gpt-6.1-sol` in every category, same shape. Long-context surcharge tier above 272K → $2.00/$0.10/$2.50/$7.50. |
| `gpt-5.6-sol`           | $4.00   | $0.40        | $5.00       | $20.00  | 90%            | Flagship. Corrected 2026-08-26 (was $5.00/$0.50/$6.25/$30.00): OpenAI's own page labels this promotional, and as of 2026-11-08 its wording has firmed up from "at least through November 21, 2026" to "available until November 30, 2026": the rate is unchanged, but it now has a stated end rather than a floor, so re-check right after that date. Long-context surcharge tier above 272K (2x input/cache/cache-write, 1.5x output → $8.00/$0.80/$10.00/$30.00). Copilot separately layers its own extra 50% promotional discount on top of this figure for Copilot-sourced sessions specifically ($2.00/$0.20/$2.50/$10.00): not modeled in `RATES` (one shared rate per model regardless of source agent); Copilot-sourced sessions will show roughly 2x their actual cost until that discount ends. |
| `gpt-5.6-cyber`         | $12.50  | $1.25        | $15.625     | $75.00  | 90%            | Added 2026-08-26: new on OpenAI's API pricing page. Short-context only; no long-context tier listed. |
| `gpt-5.6-terra`         | $2.00   | $0.20        | $2.50       | $12.00  | 90%            | Mid tier. Long-context surcharge tier above 272K |
| `gpt-5.6-luna`          | $0.20   | $0.02        | $0.25       | $1.20   | 90%            | Small/fast tier. Long-context surcharge tier above 200K (lower threshold than the rest of the 5.6 family) |
| `gpt-5.5`               | $5.00   | $0.50        | —           | $30.00  | 90%            | Long-context surcharge tier above 272K |
| `gpt-5.4`               | $2.50   | $0.25        | —           | $15.00  | 90%            | Long-context surcharge tier above 272K |
| `gpt-5.4-mini`          | $0.75   | $0.075       | —           | $4.50   | 90%            |                                                 |
| `gpt-5.4-nano`          | $0.20   | $0.02        | —           | $1.25   | 90%            |                                                 |
| `gpt-5.3-codex`         | $1.75   | $0.175       | —           | $14.00  | 90%            | Deprecated, superseded by the GPT-5.6 family. Standard rate reconfirmed present on OpenAI's API page as of 2026-09-28 (alongside a separate fast-mode row, $3.50/$0.35/$28.00, not modeled); the 2026-09-01 refresh's "standard rate is gone" finding was a temporary page state, not a real removal; see Known gaps. |
| `gpt-5.3-codex-spark`   | TBD     | TBD          | —           | TBD     | —              | Research preview; specialized low-latency hardware; not available in the API, no rates published |
| `gpt-5.2`               | $1.75   | $0.175       | —           | $14.00  | 90%            | Deprecated                                     |
| `gpt-5.1`               | $1.25   | $0.125       | —           | $10.00  | 90%            | Corrected 2026-08-07 (was $1.75/$14.00; repriced down below gpt-5.2) |
| `gpt-5.1-codex`         | $1.75   | $0.175       | —           | $14.00  | 90%            | Deprecated; not independently re-confirmed since 2026-08-07 (see Known gaps) |
| `gpt-5.1-codex-mini`    | $0.75   | $0.075       | —           | $4.50   | 90%            | Deprecated; not independently re-confirmed since 2026-08-07 (see Known gaps) |
| `gpt-5`                 | $1.25   | $0.125       | —           | $10.00  | 90%            | Added 2026-08-26, confirmed on OpenAI's general API pricing page; not independently confirmed as reachable through Codex CLI or Copilot specifically (see Known gaps) |
| `gpt-4.1`               | $2.00   | $0.50        | —           | $8.00   | 75%            | Confirmed 2026-08-12 on OpenAI's general API pricing page (not currently on Copilot's own model list; see the Copilot section's Known gaps) |
| `gpt-4.1-mini`          | $0.40   | $0.10        | —           | $1.60   | 75%            | Added 2026-08-12, new to `RATES`, confirmed on the API pricing page |
| `gpt-4.1-nano`          | $0.10   | $0.025       | —           | $0.40   | 75%            | Added 2026-08-26; see Known gaps (same relevance caveat as `gpt-5` above) |
| `gpt-5-nano`            | $0.05   | $0.005       | —           | $0.40   | 90%            | Added 2026-08-26; see Known gaps (same relevance caveat as `gpt-5` above) |
| `codex-mini-latest`     | $1.50   | $0.375       | —           | $6.00   | 75%            | Fine-tuned o4-mini; 200K ctx; deprecated       |

**Credits to USD conversion:** Rates on the Codex CLI pricing page are expressed in credits. 1 USD = 25 credits. Verify by checking `inputPerMTok × 25` against the listed credits figure for any current model (e.g. gpt-5.6-sol: $4.00 × 25 = 100 credits, matching the page; re-confirmed 2026-09-28 via gpt-6-sol and gpt-6-luna, both matching exactly). As of the 2026-09-28 refresh the page's own explicit "1 USD = 25 credits" statement wasn't found in a general summary of the page (it may have moved or been reworded), but the arithmetic cross-check above still holds for every model checked, so the conversion itself hasn't changed; re-check the explicit statement's wording next pass. **Still missing as of 2026-11-08**, and the page now says only that credit purchase prices and discounts "depend on your plan or agreement." The ÷25 cross-check still lands exactly on the USD rates for every model listed on both this page and OpenAI's API page (Astra 250→$10.00, 6.1 Sol 50→$2.00, 6.1 Terra 25→$1.00, 6 Luna 2.5→$0.10, 5.6 Sol 100→$4.00), so the conversion is treated as holding, but note it is now the *only* basis for `daybreak-blue`/`daybreak-red`, which appear on no other page.

**Known gaps:**

- **`daybreak-blue`, `daybreak-red`** (added 2026-11-08): codenamed models on the Codex CLI credits page
  only, absent from OpenAI's API pricing page and from Copilot's, so there is no second source and no
  slug to confirm. Both guesses (`daybreak-blue`/`daybreak-red`) follow this file's display-name
  convention; a wrong guess fails safe to `~$?` rather than mis-pricing. Their credit rates convert to
  exactly `gpt-5.6-sol`'s and `gpt-5.6-cyber`'s USD rates respectively, which reads as either a deliberate
  price match or the same models under evaluation codenames. If a later pass resolves them to existing
  models, delete these keys rather than leaving two names for one rate. Neither page gives a cache-write
  rate or a context window: cache write is derived at the family's 1.25x input (flagged in the code
  comment), and no long-context tier is modeled since none is published.
- **`daybreak-blue` update 2026-11-09**: the Codex page now says outright that "Daybreak Blue uses GPT-5.6
  Sol credit rates", and that Daybreak access needs Trusted Access for Cyber approval (Daybreak Red
  separately provisioned). That settles the *rate* match as deliberate; it still doesn't say whether the
  model itself is GPT-5.6 Sol, so both keys stay.
- **`gpt-rosalind-research` promoted out of the list below 2026-11-09**: it now appears on the Codex CLI
  credits page, so it *is* reachable through a coding agent this file covers, and its rate matches across
  two sources. Its siblings `gpt-6-rosalind` and `gpt-rosalind-discovery` are still API-only.
- **Dropped off OpenAI's API pricing page 2026-11-09**: `gpt-4.1-nano` (no longer listed at all) and
  `codex-mini-latest` (its model page now marks it "Shut down"; still $1.50/$0.375/$6.00 there). Both kept
  in `RATES` at their last confirmed rates for historical sessions.
- **Specialized OpenAI models seen 2026-11-08 and deliberately not modeled**: `gpt-6-rosalind`,
  `gpt-rosalind-discovery`, `gpt-6-astra-law` (its own promotional rate, "at
  least through December 31, 2026"), `chat-latest`, `gpt-5-search-api`, `gpt-5.5-cyber`, the `-pro` rows
  (`gpt-5-pro`, `gpt-5.2-pro`, `gpt-5.4-pro`, `gpt-5.5-pro`), `o3` and `o3-pro`. None is reachable through
  a coding agent this file covers, and each would only ever resolve to `~$?` if one turned up. Add on
  demand rather than carrying the whole API catalog.
- **New billing tiers on OpenAI's page not modeled** (2026-11-08): a 12-hour cache-write rate beside the
  existing 30-minute one (`RATES` has a single `cacheWritePerMTok`, the shorter TTL, the same choice and
  the same ~2x understatement risk as Anthropic's 1h cache TTL, see the Claude section), and an
  **Ultrafast** tier above fast mode (listed for `gpt-6-astra` and `gpt-6.1-sol` only). Fast mode itself
  is still not modeled for any OpenAI model, so Ultrafast isn't either; a session that used it will
  understate cost by 6x.
- `gpt-5.3-codex-spark`: research preview with no published rates. OpenCode Zen now lists it at
  $1.75/$0.175/$14.00 (2026-11-08), but Zen's prices are Zen's own and routinely differ from the
  vendor's (it lists `gpt-5.1` at $1.07 against OpenAI's $1.25), so that is not read as OpenAI's list
  price and the entry stays TBD rather than being filled in from a reseller.
- `gpt-5.3-codex`: the 2026-09-01 refresh found OpenAI's API pricing page showing only a *fast-mode* rate
  ($3.50 input / $0.35 cached / $28.00 output), with the standard rate seemingly gone. As of the 2026-09-28
  refresh the standard rate ($1.75 / $0.175 / $14.00, matching `RATES`) is back alongside the fast-mode row,
  which reads as a temporary page state from the earlier pass rather than a real removal. Fast mode isn't modeled
  (consistent with not modeling fast mode for the rest of the Codex-only lineup either).
- Reasoning tokens (`codex.usage.reasoning_output_tokens`): included in `gen_ai.usage.output_tokens` and billed at the standard output rate per available data; verify against the official rate card once it's fetchable (see Sources above).
- Which GPT-5.6 variant (Sol/Terra/Luna) is the actual default model invoked by plain `codex` CLI runs (as opposed to an explicit model flag) is not confirmed by public docs.
- `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5.1-codex-max`: absent from the general API pricing
  page during the 2026-08-07, 2026-08-12, and 2026-08-26 refreshes (only base `gpt-5.1` is listed,
  and it had in fact been repriced back on 2026-08-07). Left unchanged on the assumption they didn't
  move; re-verify next refresh, ideally against the auth-gated rate card directly.
- `gpt-5`, `gpt-4.1-nano`, `gpt-5-nano`: added 2026-08-26 from OpenAI's general API pricing page, but
  neither Copilot's nor Codex CLI's own docs mentioned any of them this pass, so it's unconfirmed whether
  they're actually reachable through either agent, or just present on the underlying API that
  neither currently exposes. Added anyway per this file's own philosophy (a model that's never used
  costs nothing to have listed); re-check relevance next pass rather than remove speculatively.
- `gpt-5.6-sol`: OpenAI's own page describes the current rate as promotional, guaranteed only through
  November 21, 2026. Re-check before then even if the usual refresh cadence wouldn't otherwise
  trigger it. Copilot's additional 50%-off layer on top of this rate isn't modeled (see the rate
  table row above); sessions sourced from Copilot specifically will overstate cost by roughly 2x for
  this model until that promotion ends.

---

## Gemini

Gemini models reach TraceRoost through Copilot's marketplace and OpenCode, not a Gemini-specific agent, so
they had been documented inside the Copilot section above and cited only Copilot's page. **Promoted to its
own section 2026-11-08, with Google's own pricing page as the primary source**. Copilot's page had dropped
six of these models, leaving them with no live source at all, and it never showed the prompt-length tiers or
the post-promotion rates.

**Sources:**

- Google's own API pricing (primary): <https://aistudio.google.com/docs/pricing> (verified 2026-11-09:
  note `ai.google.dev/gemini-api/docs/pricing` now 301s here; use this URL directly. Every Gemini rate in
  `RATES` that this page lists re-checked and unchanged: `gemini-4-argon` and its 2026-12-01 step-up,
  `gemini-3.6-flash`/`3.8-flash` and their 2027-01-01 step-up, `gemini-3.1-pro-preview` and its 200K tier,
  `gemini-3-flash-preview`, `gemini-2.5-pro` and its tier. The page does not use the word "promotional" for
  the 3.6/3.8 Flash schedule: it just states dated prices: so the `promoNote`s quote the dates, not a label.)
- Copilot model pricing (secondary, for what Copilot actually resells):
  <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing> (verified 2026-11-09)

**What the first-party source settled on 2026-11-08**: each of these had been a judgement call or a blind
spot while Copilot's page was the only source:

| Model | Finding |
| --- | --- |
| `gemini-4-argon` | **Dated step-up, stated outright:** $2.00/$0.10/$10.00 through 2026-11-30, then **$4.00/$0.20/$20.00 from 2026-12-01**. Carried at today's rate, so **this row must be doubled on or after 2026-12-01**, the one rate in `RATES` with a known first-party expiry inside a month. Zen's "50% off" label was right about the shape but gave neither the post-promo figure nor a reliable date. |
| `gemini-3.6-flash`, `gemini-3.8-flash` | Promotional rate and its end date confirmed first-party, with the exact post-promo figure: $1.50/$0.15/$7.50 from 2027-01-01. `promoNote` now quotes Google rather than Copilot. |
| `gemini-3.1-pro` | $2.00/$0.20/$12.00 at or under 200K, $4.00/$0.40/$18.00 over, matching `RATES` exactly. Confirmed first-party after being unconfirmed since Copilot dropped it on 2026-10-11. |
| `gemini-3-flash` | $0.50/$0.05/$3.00, matching `RATES`. Same: confirmed first-party after Copilot dropped it. |
| `gemini-2.5-pro` | **A real pricing correction.** Google prices it $2.50/$0.25/$15.00 for a prompt over 200K; it was carried flat here, because Copilot's page never showed the tier. A call over 200K was therefore underbilled by half. Tier added; logged in `CHANGELOG.md` under Fixed. Also deprecated: Google routes it to `gemini-3.8-flash` from 2026-12-01, so the row is for historical sessions from then on. |
| `gemini-3-flash-preview`, `gemini-3.1-pro-preview` | **A real lookup bug.** These are the model ids Google's page actually uses; `RATES` had only the un-suffixed names taken from Copilot's display names. `normalizeCostKey` strips a trailing *date* suffix, not `-preview`, so a session reporting Google's own id matched nothing and showed `~$?`. Both ids added as keys beside their twins. Fixed by adding keys rather than by stripping `-preview` in normalization, since a preview and a GA model are free to carry different prices. |

**Known gaps:**

- **`gemini-3.7-flash` and `gemini-3.5-flash` are on neither source** as of 2026-11-08 (Google lists a
  `gemini-3.5-flash-lite`, which is a different, cheaper model, not a rename). Both kept in `RATES`
  unchanged and unconfirmed; `gemini-3.7-flash`'s `promoNote` is deliberately left in Copilot's wording
  rather than attributed to Google.
- **`gemini-3-pro`** is not listed as a text model on Google's page. Its only corroboration is indirect:
  the page says Nano Banana Pro's text is "priced the same as Gemini 3.1 Pro," which equals the
  $2.00/$0.20/$12.00 in `RATES`. Kept, still not a direct confirmation, and no tier modeled.
- **On Google's page but not in `RATES`**, deliberately: `gemini-3.5-flash-lite`,
  `gemini-3.1-flash-lite`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. None is offered by an agent this
  file covers; add on demand, as with OpenAI's specialized lineup.
- **Audio-input pricing is not modeled.** Several Gemini rows price audio input above text/image/video
  (e.g. `gemini-3-flash-preview` at $1.00 against $0.50). `ModelRates` has one input rate, and the agents
  TraceRoost reads send text, so the text rate is used throughout.
- **Cache *storage* is not modeled.** Google bills explicit context caching per 1M tokens per hour (e.g.
  $4.50/hour for 3.1 Pro) on top of the token rates. `ModelRates` has no storage dimension and telemetry
  reports no cache lifetime, so a session using explicit caching is underbilled by that amount. The
  `cacheWritePerMTok` of 0 on every Gemini row is correct as a *write* rate (Google charges none; 4 Argon
  is implicit-caching-only); it is not standing in for storage.
- **No first-party source is reachable for xAI, Moonshot (Kimi) or Microsoft (MAI).** `x.ai/api` returns
  403 to an unauthenticated fetch and `docs.x.ai` did not surface in search on 2026-11-08, so Grok, Kimi
  and MAI still rest on Copilot's page alone (Grok is corroborated by OpenCode Zen and by third-party rate
  trackers at $2.00/$0.50/$6.00 with a 200K tier of $4.00/$1.00/$12.00, matching `RATES`). The one
  outstanding disagreement is **Grok 4.5's cache read**: Copilot and the trackers say $0.50, Zen says
  $0.30. `RATES` keeps $0.50: Zen prices at its own rates throughout. Finding a fetchable first-party
  xAI source is the biggest remaining source gap in this file. (Still true 2026-11-09; a second
  reseller disagreement surfaced too: Zen lists **Kimi K3 with a $3.00 cache write**, where Copilot
  says N/A. `RATES` keeps 0, Copilot's figure, since no first-party Moonshot source is reachable either.)
- **Zen disagrees with Google on `gemini-3.8-flash` (2026-11-09)**: Zen lists it at $1.50/$0.15/$7.50:
  Google's *post-promotion* rate from 2027-01-01: while Google's own page and Copilot's both list
  $0.75/$0.075/$3.75 through Dec 31, 2026. Google is the authority; `RATES` keeps $0.75. Zen likewise lists
  `gemini-3.6-flash`/`3.7-flash` at $1.50 and `gemini-3.5-flash` at $1.50/$9.00: no change for any of them.

---

## OpenCode

OpenCode uses token-based pricing for third-party models (routed through its provider abstraction) and offers a free stealth model called **big-pickle** during a limited evaluation period.

### Free Zen-exclusive models

**Who it applies to:** Users of OpenCode's built-in Zen model tier during each model's limited evaluation period.

**Source:** <https://opencode.ai/docs/zen/> (verified 2026-11-09: the free list is the same as 2026-11-08 plus one new model, **`longcat-2.5-free`** (slug from the page's ID column), which sits where `longcat-2.5-preview-free` used to. Prior pass: 2026-11-08: the page now lists each model's **ID slug** beside its display name, so this pass's additions are confirmed rather than guessed. It also no longer uses the word "Zen" for the tier, calling the models free "for a limited time"; the section keeps the Zen name since that is still the docs path and the provider ID in OpenCode's SQLite.)

**Rates:** $0, free during evaluation. All token fields (`inputPerMTok`, `cacheReadPerMTok`, `cacheWritePerMTok`, `outputPerMTok`) are set to 0 in the rate table.

**Models in `RATES` (all free, all subject to becoming paid without notice; re-check the source URL periodically):**

- `big-pickle`: OpenCode's own stealth model
- `deepseek-v4-flash-free`, `mimo-v2.5-free`, `hy3-free`, `laguna-s-2.1-free`, `ling-3.0-tiny-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`: added 2026-08-12, exact ID slugs confirmed from the Zen docs (previously withheld pending confirmation)
- `ling-3.0-flash-fin-free`, `muse-spark-1.2-contributor-free`: added 2026-09-01. `muse-spark-1.2-contributor-free`'s slug was flagged unconfirmed last pass and is now confirmed on the page. `ling-3.0-flash-fin-free` is new this pass and looks like a rename of `ling-3.0-tiny-free` (which is gone from the page); the old key is kept anyway, see Known gaps.
- `muse-spark-1.3-contributor-free`: added 2026-09-15. `muse-spark-1.2-contributor-free` is gone from the page this pass, replaced by this, the same rename pattern as `ling-3.0-tiny-free` → `-flash-fin-free` above; the 1.2 key is kept anyway, see Known gaps.
- `space-bunny-free`, `longcat-2.5-preview-free`, `mimo-v2.6-flash-free`, `jev-1.13-free`: added 2026-09-28, new on the Zen docs this pass. Slugs guessed from display name (same convention/risk as the 2026-08-12 batch above); verify against real telemetry when encountered. `mimo-v2.5-free` (kept in `RATES`) is still separately listed alongside the new `mimo-v2.6-flash-free`, not a rename, both present.
- `exo-free`, `step-5-preview-free`, `ling-3.1-flash-free`: added 2026-10-11, new on the Zen docs this pass (Exo Free, Step 5 Preview Free, Ling 3.1 Flash Free). Slugs guessed from display name, same convention/risk as the batches above. `ling-3.1-flash-free` is almost certainly the successor to `ling-3.0-*-free` (both older keys kept, $0 either way).
- `iceman-free`, `inkling-2-small-free`, `crouton-alpha-free`, `glm-5.3-flash-free`,
  `deepseek-v4.1-flash-free`, `beam-free`, `flint-40b-free`, `nemotron-3.5-super-vl-free`: added
  2026-11-08, the page's full free list this pass. **Slugs confirmed from the page itself**, which now
  prints each model's ID, the first batch in this section that isn't guessed. `deepseek-v4.1-flash-free`
  is the return of a free DeepSeek variant (the older `deepseek-v4-flash-free` has been absent since
  2026-09-15 and is kept); `glm-5.3-flash-free` and `nemotron-3.5-super-vl-free` are new free siblings of
  paid rows on the same page.
- `longcat-2.5-free`: added 2026-11-09, slug confirmed from the page. Probably the GA form of
  `longcat-2.5-preview-free` (gone since 2026-11-08, kept: $0 either way).

**Model ID in OpenCode SQLite:** Stored as JSON `{"id":"<model-id>","providerID":"opencode"}` in the `model` column of the `session` table. TraceRoost extracts the `id` field and normalizes it for rate lookup.

**Known gaps:**

- All of the above are free "during limited evaluation"; any may become paid in the future. Check the source URL and update `RATES` when rates are published.
- Two models previously listed in this file's Known gaps (**North Mini Code Free** and **LongCat-2.0 Free**) were not found on the Zen docs page during the 2026-08-12 refresh. Unclear whether they were renamed, retired, or just missed by this pass; not removed from anywhere since they were never added to `RATES` in the first place. Re-check next refresh.
- **`deepseek-v4-flash-free`, `hy3-free`, `laguna-s-2.1-free`**: added 2026-08-12, absent again from
  the 2026-09-15 and 2026-09-28 passes (five refreshes running now where this page's free-model list
  has been inconsistent for these three). DeepSeek in particular is now listed on the page only as
  *paid* (V4 Pro / V4 Flash, peak/off-peak tiered), with no `-free` variant. Still not removed from
  `RATES`: they're $0 either way, so a stale "still listed" entry costs nothing, and a real historical
  session on one would otherwise fall to `~$?`. Re-check next refresh.
- **Seen on the Zen page 2026-10-11 but not in `RATES`**: a paid `Jev 1.13` row (listed at $0.042 input with free output and no cached-read rate; its free sibling's row on the page is malformed, with an extra value), not modeled. Zen's own paid third-party models are billed at Zen's prices, which differ from the vendors' (e.g. Zen charges $1.07 for `gpt-5.1` against OpenAI's $1.25); `RATES` keeps the vendors' list prices for those, so a session routed through Zen's paid tier is priced at the vendor rate.
- Still absent from the page 2026-10-11, as in the entries above: `deepseek-v4-flash-free`, `hy3-free`, `laguna-s-2.1-free`, `ling-3.0-tiny-free`, `muse-spark-1.2-contributor-free`. All kept in `RATES` ($0 either way).
- **The free list turned over almost completely on 2026-11-08.** Twelve keys dropped off the page in one
  pass (`deepseek-v4-flash-free`, `mimo-v2.5-free`, `hy3-free`, `laguna-s-2.1-free`,
  `ling-3.0-tiny-free`, `ling-3.0-flash-fin-free`, `ling-3.1-flash-free`,
  `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`, `space-bunny-free`,
  `longcat-2.5-preview-free`, `exo-free`, `step-5-preview-free`), leaving only `big-pickle`,
  `mimo-v2.6-flash-free`, `jev-1.13-free` and `nemotron-3-ultra-free`/`nemotron-3.5-lightning-free` from
  the earlier batches. All kept, per this section's standing rule: they are $0 either way, so a stale key
  costs nothing while a missing one sends a real historical session to `~$?`. This is the churn rate to
  expect here; don't read a key's absence as a rate change, and don't prune the list.
- **Paid Zen rows seen 2026-11-08 and not modeled** (same reason as the `gpt-5.3-codex-spark` note in the
  Codex section: Zen's prices are Zen's own, and `RATES` carries vendors' list prices): the MiniMax,
  GLM, Qwen, Mistral, Grok Build and Muse families, plus a paid `jev-1.13`. Zen also tiers
  `claude-sonnet-4-5` above 200K tokens ($6.00/$0.60/$7.50/$22.50) where Anthropic's own page prices it
  flat at $3.00. Anthropic is the authority for Claude, so `claude-sonnet-4-5` keeps no tier.
- **`ling-3.0-tiny-free`**: gone from the page since the 2026-09-01 pass; `ling-3.0-flash-fin-free`
  is almost certainly the rename. Both keys are in `RATES` now ($0), so a session on either resolves.
- **`muse-spark-1.2-contributor-free`**: gone from the page as of 2026-09-15, replaced by
  `muse-spark-1.3-contributor-free`. Both keys are in `RATES` now ($0), same pattern as
  `ling-3.0-tiny-free` above.
- OpenCode Zen also lists 40+ paid third-party models (GPT, Claude, Gemini, Grok, DeepSeek, Qwen, MiniMax, GLM, Kimi families) not covered here. Those are billed by the underlying provider at standard rates; TraceRoost applies the provider's published rates for those models automatically via the existing per-provider entries in `RATES` (not OpenCode-specific ones).
- Other models used through OpenCode (e.g. Anthropic, OpenAI, or Google models routed via OpenCode's provider abstraction) are billed by the underlying provider at their standard rates. TraceRoost applies the provider's published rates for those models automatically.

---

## Notes for maintainers

- The `PRICING_LAST_UPDATED` constant in `media/src/pricing.ts` surfaces in the UI. Update it whenever rates change.
- **Model-ID normalization for lookup (`normalizeCostKey()` in both `pricing.ts` files, kept in sync):**
  a lookup key is derived by lowercasing, stripping a trailing date suffix (e.g.
  `claude-sonnet-4-6-20260501`), then collapsing `.`, whitespace, and `_` to `-`. **Every `RATES`
  key is run through the same function**, so it does not matter whether you write a new key with a
  dot or a hyphen (`claude-opus-4-8` and `claude-opus-4.8` resolve identically), so pick whatever
  matches the vendor's own spelling. This is why the old `'gpt-5 mini'` space-variant alias key
  could be deleted. Normalization is lookup-only; the raw model ID from telemetry is what gets
  stored and shown. (Fixes GH #231, where dotted Copilot IDs missed the hyphenated Claude keys.)
- **Collision guard:** `RATES_BY_COST_KEY` is built at module load and *throws* if two distinct
  `RATES` keys collapse to the same normalized key with different rate objects. If you add a key
  that trips this, the tests (`src/test/pricing.test.ts`) and `tsc`/`mocha` will fail loudly;
  rename one of the two so they don't collide.
- If a model appears in telemetry but is missing from the rate table, the UI shows `~$?` rather than $0
  to avoid silently under-reporting cost. Add the model to `RATES` in `pricing.ts` to resolve.
- Pricing corrections that change displayed cost for real sessions (not just new-model additions)
  are user-facing bug fixes. Log them in `CHANGELOG.md` under `### Fixed` at the next release,
  same as any other bug.
