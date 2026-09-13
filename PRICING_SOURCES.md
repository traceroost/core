# Pricing Sources

This file records exactly where each agent's billing data is retrieved from, and the current
best-known rates for each model. It's a reference + refresh runbook, not a changelog — pricing
corrections that change displayed cost belong in `CHANGELOG.md` at release time, not here.

## How to refresh this file

Do this on its own branch, with its own PR, scoped to pricing changes only — don't bundle a
pricing refresh into a PR that also does something else. This keeps `git blame` on the rate tables
meaningful (every pricing PR is a pricing PR, nothing more) and makes each refresh easy to review
and revert independently if a source turns out to have been misread.

1. Fetch each source URL below and compare against the rate tables here.
2. Update `RATES` in both `src/pricing.ts` and `media/src/pricing.ts` to match. See
   "Notes for maintainers" at the bottom for lookup/normalization details.
3. If you added, removed, or renamed a model key in `RATES`, update `PRICING_SECTIONS` in
   `media/src/pricing.ts` to match — it's the vendor grouping + source citations the in-app Pricing
   page (`$` icon in the header, `media/src/tabs/Pricing.tsx`) renders. A model left out doesn't go
   missing — the page has an "Uncategorized" fallback for exactly this — but it should still land in
   the right vendor group rather than sit there as a nudge to finish the job. If a source URL in a
   section changed, update `PRICING_SECTIONS[].sources` too.
4. Bump every date that records when pricing was last verified — there's more than one, and it's
   easy to miss one:
   - `PRICING_LAST_UPDATED` in `media/src/pricing.ts`
   - The `PRICING_LAST_UPDATED: <date>` comment at the top of `src/pricing.ts`
   - Every per-section "verified `<date>`" source line below, for whichever sections you actually
     re-checked
   - The matching `PRICING_SECTIONS[].verified` date(s) in `media/src/pricing.ts` — these mirror the
     sections below and drive the "verified `<date>`" text shown on the in-app Pricing page itself
   - `ARCHITECTURE.md`'s "Cost Calculation" section — it has its own "Last updated: `<date>`" line
     independent of the two constants above (found missed once already; check it every time)
5. If a source explicitly labels a rate as promotional/temporary (its own wording, not your
   inference), set `promoNote` on that model's entry in `media/src/pricing.ts` — free text, quote
   or closely paraphrase the source's own wording including any stated end date (e.g. `'OpenAI:
   promotional pricing, at least through Nov 21, 2026'`). This surfaces as a hover-note `‡` marker
   next to the model name on the in-app Pricing page. Deliberately not a computed
   expiration/start-stop date — vendors don't reliably honor their own stated windows, so don't
   build logic that treats the note as expired once its date passes; just re-verify the rate (and
   the note) at the next refresh like any other rate, regardless of whether the stated window has
   technically ended. Clear `promoNote` only once a source confirms the rate is no longer
   promotional (folded into the standard rate, or reverted).
6. Run `tsc --noEmit` (both configs), `eslint src media/src`, and `mocha` to confirm nothing broke.
7. If a rate or model can't be confirmed from a source, add it to that section's "Known gaps"
   instead of guessing.

---

## Copilot

Copilot has three billing models depending on plan type and date.

### Model 1 — Token-based AI Credits (from Jun 1, 2026)

**Who it applies to:** All Copilot plans on the new billing model, default from June 1, 2026.

**Source:** <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing> (verified 2026-09-01 — all token rates re-checked and unchanged. Note: the page now states Copilot's own extra 50%-off promo on GPT-5.6 Sol runs "through September 3, 2026"; this is separate from OpenAI's own promotional rate for the model and is still not modeled in `RATES` — see the Known gaps below.)

**What this page provides:**

- Per-model token rates: `inputPerMTok`, `cacheReadPerMTok`, `cacheWritePerMTok`, `outputPerMTok` (USD per 1M tokens)
- List of included models (effectively $0 — look for models with no token rate listed)
- Per-model "long context" surcharge tiers for some models — 2x input/cache-read/cache-write, 1.5x
  output above a per-model token-per-call threshold (272K for GPT-5.4/5.5/5.6-Sol/5.6-Terra, 200K
  for GPT-5.6-Luna/Gemini 3.1 Pro/Grok 4.5). Modeled in `RATES` via `longContextThresholdTokens` +
  the `*AboveThresholdPerMTok` fields (`src/pricing.ts` only — `media/src/pricing.ts`'s
  session-level estimate stays flat-rate, see that file's own comment for why).

**Formula:**

```text
cost = (inputTokens / 1_000_000 × inputRate)
     + (cacheReadTokens / 1_000_000 × cacheReadRate)
     + (cacheWriteTokens / 1_000_000 × cacheWriteRate)
     + (outputTokens / 1_000_000 × outputRate)
aiCredits = cost / 0.01
```

### Model 2 — Annual-plan request-based (from Jun 1, 2026)

**Who it applies to:** Copilot annual-plan holders who opt to stay on request-based billing
after June 1, 2026. These users face significantly higher multipliers than the pre-June rates.

**Source:** <https://docs.github.com/en/copilot/reference/copilot-billing/model-multipliers-for-annual-plans> (verified 2026-09-01 — re-checked, unchanged. Still no rows for claude-opus-5, the Claude Fable/Mythos family, the GPT-5.6 family, gpt-4.1-mini/-nano, gpt-5/-nano, grok-4.5/4.6, kimi-k3, or gemini-3.6/3.7-flash; `multiplierAnnualPostJun1` stays 0 for those until published.)

**What this page provides:**

- Post-June multipliers for annual plan holders (`multiplierAnnualPostJun1` field in `ModelRates`)
- Formula is the same as Model 3 — only the multiplier values differ
- A separate note: Copilot code review has a model multiplier of 13 (each code review request
  deducts 13 from the premium request quota) — see Known gaps below

**Formula:**

```text
cost = userPromptCount × multiplierAnnualPostJun1 × $0.04
```

### Model 3 — Request-based with multipliers *(deprecated — pre-Jun 1, 2026)*

**Who it applies to:** All Copilot plans before June 1, 2026. No longer active for new sessions.

**Source:** <https://docs.github.com/en/copilot/concepts/billing/copilot-requests>

**What this page provides:**

- Per-model request multipliers (`multiplier` field in `ModelRates`)
- Clarification that only **user-initiated prompts** count as premium requests in agentic sessions —
  autonomous tool calls and internal LLM calls within a session do NOT count
- Models with a 0× multiplier are included and cost nothing under this model

**Formula:**

```text
cost = userPromptCount × multiplier × $0.04
```

This model is now fully historical (we're past the June 1, 2026 cutover), so its source page no
longer lists per-model multipliers directly — it points to the annual-plan legacy page instead,
which 404s. `multiplier` values in `RATES` are frozen at their last-known state for historical
sessions; don't expect to re-verify them.

**Known gaps:**

- **Copilot code review multiplier**: not currently modeled in `pricing.ts` — TraceRoost doesn't
  distinguish code-review-triggered requests from regular premium requests.
- `gpt-4o`, `gpt-4o-mini` are no longer listed on the current AI Credits pricing page at all (paid
  or included). Kept in `RATES` at their legacy rate for historical/legacy sessions; treat as
  deprecated. `gpt-4.1` is **not** listed on Copilot's own model pricing page as of 2026-08-12
  (confirmed absent, re-checked twice this refresh) — but it's still live on OpenAI's general API
  pricing page at the same rate ($2.00/$0.50/$8.00) that Codex CLI uses directly (see the Codex
  section below), so `RATES` is left unchanged. Copilot apparently just doesn't currently offer it
  as a selectable model; that's a different thing from the rate being wrong.
- `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5.1-codex-max`: not independently re-confirmed in the
  2026-08-07 refresh — absent from the general API pricing page (only base `gpt-5.1` was listed,
  and it turned out to have been repriced down to $1.25/$10.00 from $1.75/$14.00). Left unchanged
  at their prior values on the assumption they didn't move, but that's unverified — re-check next
  refresh.
- **New third-party marketplace models** (`grok-4.5`, `kimi-k3`, `gemini-3.6-flash`): added
  2026-08-07 from the Copilot pricing page. Exact telemetry model-ID slugs are unconfirmed (guessed
  from the docs display name, following the existing naming convention) — verify against real
  telemetry when encountered. `mai-code-1.1-flash` added 2026-08-12 on the same basis (new on the
  pricing page this refresh, slug guessed from display name). Separately: `grok-4.5`, `kimi-k3`,
  `kimi-k2.7-code`, and `mai-code-1-flash` existed in `media/src/pricing.ts` (browser) but had never
  been added to `src/pricing.ts` (extension host) — a real sync gap, not a rate error, that made
  `cost_usd` store as `0` rather than the correct amount for any Copilot session using them. Fixed
  2026-08-12; both files now match. `grok-4.6` and `gemini-3.7-flash` added 2026-08-26, same basis
  (new on the Copilot pricing page this refresh, slug guessed from display name) — added to both
  files together this time, no sync gap introduced. `gemini-3.6-flash` was corrected the same pass:
  its price dropped from $1.50/$0.15/$7.50 to $0.75/$0.075/$3.75, labeled on Copilot's page as
  "promotional pricing through Dec 31, 2026" — the same promotional rate the new 3.7-flash launched
  at. `gpt-5.6-cyber` also added 2026-08-26, confirmed on OpenAI's own API pricing page rather than
  Copilot's (not yet independently confirmed as reachable through Copilot specifically).

---

## Claude

Claude Code CLI uses Anthropic API token-based pricing only — no request-multiplier system.

### Billing model — Token-based (input / cache write / cache read / output)

**Who it applies to:** All Claude Code CLI users billed through the Anthropic API.

**Source:** <https://platform.claude.com/docs/en/about-claude/pricing> (verified 2026-09-01 — every existing rate re-checked and confirmed unchanged, including the Sonnet 5 introductory-pricing-now-permanent note and fast-mode model support. New this pass: Claude Fable 5.1 and Claude Mythos 5.1 added to the page — same input/output/cache-write as the .0 releases, but cache reads priced at 0.025x base input ($0.25/MTok) instead of the usual 0.1x ($1.00/MTok). Both added to `RATES` as `claude-fable-5-1` / `claude-mythos-5-1`.)

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

- `model` / `gen_ai.request.model` — model ID, e.g. `claude-sonnet-4-6`
- `input_tokens` — raw (non-cached) input tokens
- `output_tokens` — output tokens
- `cache_read_tokens` — prompt cache read tokens (charged at ~10% of input rate)
- `cache_creation_tokens` — prompt cache write tokens (charged at ~125% of input rate for 5-min TTL)
- `ttft_ms` — time to first token in ms
- `stop_reason` — e.g. `tool_use`, `end_turn`

**Rates (USD per 1M tokens, verified 2026-09-01 — every existing row unchanged from the last check; Fable/Mythos 5.1 added):**

| Model                                                                  | Input  | Cache Write (5m) | Cache Write (1h) | Cache Read | Output  |
| ----------------------------------------------------------------------- | ------ | ----------------- | ----------------- | ---------- | ------- |
| `claude-fable-5-1`                                                       | $10.00 | $12.50             | $20.00             | $0.25      | $50.00  |
| `claude-mythos-5-1` (limited availability, see anthropic.com/glasswing) | $10.00 | $12.50             | $20.00             | $0.25      | $50.00  |
| `claude-opus-5`                                                          | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |
| `claude-opus-4-8`                                                        | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |
| `claude-opus-4-7`                                                        | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |
| `claude-opus-4-6`                                                        | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |
| `claude-opus-4-5`                                                        | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |
| `claude-sonnet-5` (standard — see note below)                           | $2.00  | $2.50              | $4.00              | $0.20      | $10.00  |
| `claude-sonnet-4-6`                                                      | $3.00  | $3.75              | $6.00              | $0.30      | $15.00  |
| `claude-sonnet-4-5`                                                      | $3.00  | $3.75              | $6.00              | $0.30      | $15.00  |
| `claude-sonnet-4`                                                        | $3.00  | $3.75              | $6.00              | $0.30      | $15.00  |
| `claude-haiku-4-5`                                                       | $1.00  | $1.25              | $2.00              | $0.10      | $5.00   |
| `claude-fable-5`                                                         | $10.00 | $12.50             | $20.00             | $1.00      | $50.00  |
| `claude-mythos-5` (limited availability, see anthropic.com/glasswing)   | $10.00 | $12.50             | $20.00             | $1.00      | $50.00  |
| `claude-opus-5` (fast mode, 2x)                                          | $10.00 | $12.50             | $20.00             | $1.00      | $50.00  |
| `claude-opus-4-8` (fast mode, 2x)                                        | $10.00 | $12.50             | $20.00             | $1.00      | $50.00  |
| `claude-opus-4-7` (fast mode, 6x — **historical only, removed**)        | $30.00 | $37.50             | $60.00             | $3.00      | $150.00 |
| `claude-opus-4-6` (fast mode — bills at standard rate, see note below)  | $5.00  | $6.25              | $10.00             | $0.50      | $25.00  |

Fast mode is currently available only for Opus 5 and Opus 4.8 (both listed together, same rate, on
Anthropic's fast-mode pricing table). Anthropic's docs continue to confirm (re-checked 2026-09-01)
that Opus 4.7 fast mode has been removed — requests with `speed: "fast"` now return an error
rather than being billed. Its `-fast` entry in `RATES` is frozen for historical sessions only.
`claude-opus-4-6` still doesn't support fast mode — requests with `speed: "fast"` run at standard
speed and bill at the standard rate, so its `-fast` entry is set equal to the standard rate rather
than a multiplied one.

**Tiered pricing — `claude-sonnet-4` only:**

`claude-sonnet-4` has a two-tier rate structure where per-token rates increase once a single API call exceeds 200K tokens for a given token category. The tier is applied per-category (input, output, cache read, cache write each evaluated against the 200K threshold independently):

| Token category | ≤200K rate | >200K rate |
| -------------- | ---------- | ---------- |
| Input          | $3.00/MTok | $6.00/MTok |
| Output         | $15.00/MTok| $22.50/MTok|
| Cache write    | $3.75/MTok | $7.50/MTok |
| Cache read     | $0.30/MTok | $0.60/MTok |

The threshold applies per API call, not cumulatively across a session. `calcTokenCostUsd` in `src/pricing.ts` applies this tiered rate per turn (which corresponds to one API call). The session-level `calcTokenCost` in `media/src/pricing.ts` uses flat rates as an approximation because it operates on session totals rather than per-call counts.

**Deprecated models (for historical sessions):**

| Model                                | Input   | Cache Read | Output   |
| ------------------------------------ | ------- | ---------- | -------- |
| `claude-opus-4-1` / `claude-opus-4`  | $15.00  | $1.50      | $75.00   |
| `claude-haiku-3-5`                   | $0.80   | $0.08      | $4.00    |

**Tokenizer note:**

Claude Opus 4.7 and later Opus models, Claude Fable 5 / 5.1, Claude Mythos 5 / 5.1, Claude Mythos Preview, and Claude Sonnet 5 use a newer tokenizer that produces approximately 30% more tokens for the same input text than the previous tokenizer (used by Sonnet 4.6 and earlier). Per-token prices are unaffected — this only changes token counts, so effective cost per request can be meaningfully higher for these models even at the same rate card.

**Known gaps:**

- **Cache write TTL**: Anthropic supports 5-minute and 1-hour cache TTLs at different rates (1.25x and 2x base input price respectively; cache reads are 0.1x base input). The `cache_creation_tokens` field in telemetry does not distinguish between them. Claude Code CLI uses 5-minute caches by default, so the 5-minute rate is used. If 1-hour caches are in use, cost will be underestimated by roughly 37%.
- **Fast mode (`/fast`)**: When fast mode is active, `usage.speed` is `"fast"` in the local JSONL log. TraceRoost reads this and appends `-fast` to the stored model ID (e.g. `claude-opus-4-7-fast`) so the correct rate is applied. See the fast-mode note under the rate table above for current per-model status.
  **This detection is log-only.** The OTEL fields Claude Code CLI exports on `claude_code.llm_request` spans (listed above — model, input/output/cache tokens, ttft_ms, stop_reason) don't include a speed/fast-mode attribute at all, so `src/summarizers/claude.ts` (the OTEL ingestion path) has nothing to key off — every OTEL-ingested session is priced at the standard rate regardless of whether fast mode was active. This is an upstream telemetry gap (Claude Code doesn't emit fast-mode status via OTEL), not a missed read on TraceRoost's side — re-check if Anthropic ever adds a speed-equivalent OTEL attribute. Sessions ingested from the local log file (rather than OTEL) are unaffected.
- **Data residency multiplier**: `inference_geo: "us"` (Opus 4.6, Sonnet 4.6, and later models) applies a 1.1x multiplier to all token pricing categories. Not currently modeled — cost is underestimated by ~10% for sessions pinned to US-only inference.
- **Deprecated models**: Models older than claude-opus-4 (e.g. claude-3-5-sonnet, claude-3-opus) may appear in historical sessions. Add them to `RATES` in `pricing.ts` if encountered; missing models show as `~$?`.

---

## Codex

Codex CLI uses OpenAI token-based pricing only — no request-multiplier system.

### Billing model — Token-based (input / cached input / output)

**Who it applies to:** All Codex CLI users.

**Sources:**

- Rate card (official, may require login): <https://help.openai.com/en/articles/20001106-codex-rate-card> — returned 403 on 2026-07-19; requires an authenticated session to fetch. Not re-attempted since.
- Codex CLI pricing page (credits; divide by 25 for USD): <https://developers.openai.com/codex/pricing> — as of 2026-08-07 this 308-redirects to <https://learn.chatgpt.com/docs/pricing>; use that URL directly.
- API pricing (USD, includes codex models): <https://developers.openai.com/api/docs/pricing>
- `codex-mini-latest` model spec: <https://developers.openai.com/api/docs/models/codex-mini-latest>
- Prompt caching mechanics: <https://developers.openai.com/api/docs/guides/prompt-caching>
- Token concepts: <https://developers.openai.com/api/docs/concepts/tokens>

**Formula:**

```text
non_cached_input = gen_ai.usage.input_tokens - gen_ai.usage.cache_read.input_tokens
cost = (non_cached_input / 1_000_000 × inputRate)
     + (cacheReadTokens / 1_000_000 × cacheReadRate)
     + (outputTokens / 1_000_000 × outputRate)
```

**OTEL fields (from Codex CLI telemetry):**

On `handle_responses` spans (per-API-call):

- `gen_ai.usage.input_tokens` — total input including cached portion
- `gen_ai.usage.output_tokens` — total output including reasoning tokens
- `gen_ai.usage.cache_read.input_tokens` — cached portion of input
- `codex.usage.reasoning_output_tokens` — reasoning subset of output (billed at output rate; no separate reasoning rate observed)

On `session_task.turn` spans (per-turn aggregate):

- `codex.turn.token_usage.input_tokens`
- `codex.turn.token_usage.cached_input_tokens`
- `codex.turn.token_usage.non_cached_input_tokens`
- `codex.turn.token_usage.output_tokens`
- `codex.turn.token_usage.reasoning_output_tokens`

Model name available on `codex.user_prompt`, `codex.turn_ttft`, and `codex.tool_decision` spans via `model` attribute.

**Rates (USD per 1M tokens, verified 2026-09-01 — every listed rate re-checked and unchanged):**

| Model                   | Input   | Cached Input | Cache Write | Output  | Cache discount | Notes                                          |
| ----------------------- | ------- | ------------ | ----------- | ------- | -------------- | ---------------------------------------------- |
| `gpt-5.6-sol`           | $4.00   | $0.40        | $5.00       | $20.00  | 90%            | Flagship. Corrected 2026-08-26 (was $5.00/$0.50/$6.25/$30.00) — OpenAI's own page labels this "promotional pricing... at least through November 21, 2026," so re-check sooner than the usual cadence. Long-context surcharge tier above 272K (2x input/cache/cache-write, 1.5x output → $8.00/$0.80/$10.00/$30.00). Copilot separately layers its own extra 50% promotional discount on top of this figure for Copilot-sourced sessions specifically ($2.00/$0.20/$2.50/$10.00) — not modeled in `RATES` (one shared rate per model regardless of source agent); Copilot-sourced sessions will show roughly 2x their actual cost until that discount ends. |
| `gpt-5.6-cyber`         | $12.50  | $1.25        | $15.625     | $75.00  | 90%            | Added 2026-08-26 — new on OpenAI's API pricing page. Short-context only; no long-context tier listed. |
| `gpt-5.6-terra`         | $2.00   | $0.20        | $2.50       | $12.00  | 90%            | Mid tier. Long-context surcharge tier above 272K |
| `gpt-5.6-luna`          | $0.20   | $0.02        | $0.25       | $1.20   | 90%            | Small/fast tier. Long-context surcharge tier above 200K (lower threshold than the rest of the 5.6 family) |
| `gpt-5.5`               | $5.00   | $0.50        | —           | $30.00  | 90%            | Long-context surcharge tier above 272K |
| `gpt-5.4`               | $2.50   | $0.25        | —           | $15.00  | 90%            | Long-context surcharge tier above 272K |
| `gpt-5.4-mini`          | $0.75   | $0.075       | —           | $4.50   | 90%            |                                                 |
| `gpt-5.4-nano`          | $0.20   | $0.02        | —           | $1.25   | 90%            |                                                 |
| `gpt-5.3-codex`         | $1.75   | $0.175       | —           | $14.00  | 90%            | Deprecated — superseded by the GPT-5.6 family. As of 2026-09-01 OpenAI's API page lists **only a fast-mode rate** for it ($3.50/$0.35/$28.00); the standard rate is no longer shown. `RATES` keeps the last-known standard rate for historical sessions — see Known gaps. |
| `gpt-5.3-codex-spark`   | TBD     | TBD          | —           | TBD     | —              | Research preview; specialized low-latency hardware; not available in the API, no rates published |
| `gpt-5.2`               | $1.75   | $0.175       | —           | $14.00  | 90%            | Deprecated                                     |
| `gpt-5.1`               | $1.25   | $0.125       | —           | $10.00  | 90%            | Corrected 2026-08-07 (was $1.75/$14.00 — repriced down below gpt-5.2) |
| `gpt-5.1-codex`         | $1.75   | $0.175       | —           | $14.00  | 90%            | Deprecated; not independently re-confirmed since 2026-08-07 (see Known gaps) |
| `gpt-5.1-codex-mini`    | $0.75   | $0.075       | —           | $4.50   | 90%            | Deprecated; not independently re-confirmed since 2026-08-07 (see Known gaps) |
| `gpt-5`                 | $1.25   | $0.125       | —           | $10.00  | 90%            | Added 2026-08-26 — confirmed on OpenAI's general API pricing page; not independently confirmed as reachable through Codex CLI or Copilot specifically (see Known gaps) |
| `gpt-4.1`               | $2.00   | $0.50        | —           | $8.00   | 75%            | Confirmed 2026-08-12 on OpenAI's general API pricing page (not currently on Copilot's own model list — see the Copilot section's Known gaps) |
| `gpt-4.1-mini`          | $0.40   | $0.10        | —           | $1.60   | 75%            | Added 2026-08-12 — new to `RATES`, confirmed on the API pricing page |
| `gpt-4.1-nano`          | $0.10   | $0.025       | —           | $0.40   | 75%            | Added 2026-08-26 — see Known gaps (same relevance caveat as `gpt-5` above) |
| `gpt-5-nano`            | $0.05   | $0.005       | —           | $0.40   | 90%            | Added 2026-08-26 — see Known gaps (same relevance caveat as `gpt-5` above) |
| `codex-mini-latest`     | $1.50   | $0.375       | —           | $6.00   | 75%            | Fine-tuned o4-mini; 200K ctx; deprecated       |

**Credits to USD conversion:** Rates on the Codex CLI pricing page are expressed in credits. 1 USD = 25 credits — verify by checking `inputPerMTok × 25` against the listed credits figure for any current model (e.g. gpt-5.6-sol: $4.00 × 25 = 100 credits, matching the page).

**Known gaps:**

- `gpt-5.3-codex-spark`: research preview with no published rates.
- `gpt-5.3-codex`: as of the 2026-09-01 refresh OpenAI's API pricing page shows only a *fast-mode* rate for it
  ($3.50 input / $0.35 cached / $28.00 output) — the standard rate is gone from the page. `RATES` keeps the prior
  standard $1.75 / $0.175 / $14.00 for historical sessions (the model is already flagged deprecated); re-verify
  against the auth-gated rate card if the standard rate matters for a real session.
- Reasoning tokens (`codex.usage.reasoning_output_tokens`): included in `gen_ai.usage.output_tokens` and billed at the standard output rate per available data; verify against the official rate card once it's fetchable (see Sources above).
- Which GPT-5.6 variant (Sol/Terra/Luna) is the actual default model invoked by plain `codex` CLI runs (as opposed to an explicit model flag) is not confirmed by public docs.
- `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5.1-codex-max`: absent from the general API pricing
  page during the 2026-08-07, 2026-08-12, and 2026-08-26 refreshes (only base `gpt-5.1` is listed,
  and it had in fact been repriced back on 2026-08-07). Left unchanged on the assumption they didn't
  move — re-verify next refresh, ideally against the auth-gated rate card directly.
- `gpt-5`, `gpt-4.1-nano`, `gpt-5-nano`: added 2026-08-26 from OpenAI's general API pricing page, but
  neither Copilot's nor Codex CLI's own docs mentioned any of them this pass — unconfirmed whether
  they're actually reachable through either agent, or just present on the underlying API that
  neither currently exposes. Added anyway per this file's own philosophy (a model that's never used
  costs nothing to have listed); re-check relevance next pass rather than remove speculatively.
- `gpt-5.6-sol`: OpenAI's own page describes the current rate as promotional, guaranteed only through
  November 21, 2026 — re-check before then even if the usual refresh cadence wouldn't otherwise
  trigger it. Copilot's additional 50%-off layer on top of this rate isn't modeled (see the rate
  table row above) — sessions sourced from Copilot specifically will overstate cost by roughly 2x for
  this model until that promotion ends.

---

## OpenCode

OpenCode uses token-based pricing for third-party models (routed through its provider abstraction) and offers a free stealth model called **big-pickle** during a limited evaluation period.

### Free Zen-exclusive models

**Who it applies to:** Users of OpenCode's built-in Zen model tier during each model's limited evaluation period.

**Source:** <https://opencode.ai/docs/zen/> (verified 2026-09-01)

**Rates:** $0 — free during evaluation. All token fields (`inputPerMTok`, `cacheReadPerMTok`, `cacheWritePerMTok`, `outputPerMTok`) are set to 0 in the rate table.

**Models in `RATES` (all free, all subject to becoming paid without notice — re-check the source URL periodically):**

- `big-pickle` — OpenCode's own stealth model
- `deepseek-v4-flash-free`, `mimo-v2.5-free`, `hy3-free`, `laguna-s-2.1-free`, `ling-3.0-tiny-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free` — added 2026-08-12, exact ID slugs confirmed from the Zen docs (previously withheld pending confirmation)
- `ling-3.0-flash-fin-free`, `muse-spark-1.2-contributor-free` — added 2026-09-01. `muse-spark-1.2-contributor-free`'s slug was flagged unconfirmed last pass and is now confirmed on the page. `ling-3.0-flash-fin-free` is new this pass and looks like a rename of `ling-3.0-tiny-free` (which is gone from the page) — the old key is kept anyway, see Known gaps.

**Model ID in OpenCode SQLite:** Stored as JSON `{"id":"<model-id>","providerID":"opencode"}` in the `model` column of the `session` table. TraceRoost extracts the `id` field and normalizes it for rate lookup.

**Known gaps:**

- All of the above are free "during limited evaluation" — any may become paid in the future. Check the source URL and update `RATES` when rates are published.
- Two models previously listed in this file's Known gaps — **North Mini Code Free** and **LongCat-2.0 Free** — were not found on the Zen docs page during the 2026-08-12 refresh. Unclear whether they were renamed, retired, or just missed by this pass; not removed from anywhere since they were never added to `RATES` in the first place. Re-check next refresh.
- **`deepseek-v4-flash-free`, `hy3-free`, `laguna-s-2.1-free`** — added 2026-08-12, absent from the
  2026-08-26 *and* 2026-09-01 passes (three refreshes now where this page's free-model list has been
  inconsistent). DeepSeek in particular is now listed on the page only as *paid* (V4 Pro / V4 Flash,
  peak/off-peak tiered) — no `-free` variant. Still not removed from `RATES`: they're $0 either way, so
  a stale "still listed" entry costs nothing, and a real historical session on one would otherwise fall
  to `~$?`. Re-check next refresh.
- **`ling-3.0-tiny-free`** — gone from the page this pass; a new `ling-3.0-flash-fin-free` appeared and
  is almost certainly the rename. Both keys are in `RATES` now ($0), so a session on either resolves.
- **"Muse Spark 1.2 Contributor Free"** — flagged last pass with an unconfirmed slug; the page now
  shows `muse-spark-1.2-contributor-free`, which is added to `RATES` this pass.
- OpenCode Zen also lists 40+ paid third-party models (GPT, Claude, Gemini, Grok, DeepSeek, Qwen, MiniMax, GLM, Kimi families) not covered here — those are billed by the underlying provider at standard rates; TraceRoost applies the provider's published rates for those models automatically via the existing per-provider entries in `RATES` (not OpenCode-specific ones).
- Other models used through OpenCode (e.g. Anthropic, OpenAI, or Google models routed via OpenCode's provider abstraction) are billed by the underlying provider at their standard rates. TraceRoost applies the provider's published rates for those models automatically.

---

## Notes for maintainers

- The `PRICING_LAST_UPDATED` constant in `media/src/pricing.ts` surfaces in the UI. Update it whenever rates change.
- **Model-ID normalization for lookup (`normalizeCostKey()` in both `pricing.ts` files, kept in sync):**
  a lookup key is derived by lowercasing, stripping a trailing date suffix (e.g.
  `claude-sonnet-4-6-20260501`), then collapsing `.`, whitespace, and `_` to `-`. **Every `RATES`
  key is run through the same function**, so it does not matter whether you write a new key with a
  dot or a hyphen (`claude-opus-4-8` and `claude-opus-4.8` resolve identically) — pick whatever
  matches the vendor's own spelling. This is why the old `'gpt-5 mini'` space-variant alias key
  could be deleted. Normalization is lookup-only; the raw model ID from telemetry is what gets
  stored and shown. (Fixes GH #231, where dotted Copilot IDs missed the hyphenated Claude keys.)
- **Collision guard:** `RATES_BY_COST_KEY` is built at module load and *throws* if two distinct
  `RATES` keys collapse to the same normalized key with different rate objects. If you add a key
  that trips this, the tests (`src/test/pricing.test.ts`) and `tsc`/`mocha` will fail loudly —
  rename one of the two so they don't collide.
- If a model appears in telemetry but is missing from the rate table, the UI shows `~$?` rather than $0
  to avoid silently under-reporting cost. Add the model to `RATES` in `pricing.ts` to resolve.
- Pricing corrections that change displayed cost for real sessions (not just new-model additions)
  are user-facing bug fixes — log them in `CHANGELOG.md` under `### Fixed` at the next release,
  same as any other bug.
