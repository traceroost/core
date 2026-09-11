# Cloud feature summary

What `src/cloud/` actually does, feature by feature. For *how* it's built, see
[CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) and
[ARCHITECTURE.md §15](ARCHITECTURE.md#15-agentlens-pro--team-link). For *why
it's a separate directory and license*, see
[src/cloud/README.md](src/cloud/README.md). This is the merged result of the
`pro/01`–`pro/09` design series (`.staged-feature/01`–`09`); "AL NN" below
cites the plan a feature shipped from.

| # | Feature | Tier | Entry point |
| - | --- | --- | --- |
| 1 | Team link | Free panel, Pro capability | Command palette, Team panel |
| 2 | Payload schema & repo identity | Infrastructure | `src/cloud/forward/schema.ts` |
| 3 | Rollup builder & `--explain-payload` | Infra / free tool | `standalone/cloud/explainPayload.ts` |
| 4 | Forwarding queue | Pro, inert unless linked | `src/cloud/forward/` |
| 5 | AI authorship attribution | **Free forever** | `src/cloud/attribution/` |
| 6 | Cohort turnover engine | **Free forever** | `src/cloud/turnover/` |
| 7 | Local turnover report (Outcomes tab) | **Free forever** | `media/src/cloud/tabs/Outcomes.tsx` |
| 8 | Instruction telemetry & apply loop | Local Advisor free; pooled evidence Pro | `src/cloud/team/instructionTelemetry.ts` |
| 9 | Free/paid boundary & hand-off | Both, by definition | throughout |

## 1. Team link — join, status, leave

One place to opt into everything else on this list: a Team panel (a slide-in
beside Settings) plus three commands (`AgentLens: Link This Machine to a
Team`, `… Team Link Status`, `… Leave Team`) and a matching CLI
(`agentlens team <link|status|leave> [--device]`). Supports both an
interactive OAuth 2.0 PKCE flow (opens a browser, catches the redirect on a
one-shot local loopback server) and the Device Authorization Grant (RFC 8628)
for remote/headless machines. The panel ships to every install; everything
reachable from it is inert until linked. Leaving is local-first — the
credential is deleted and forwarding stops before the server-side revoke
call is even attempted, so it works offline.

## 2. Payload schema and repo identity

The one contract both this repo and the closed-source hosted service
(`alsaas`) agree on: a hand-written wire schema (`schema/rollup.v1.json` +
matching TypeScript types) with no field capable of carrying source code —
every string is a hash, an enum, or a count, never free text. Repository
identity is derived from the local clone's root commit via HKDF/HMAC, never
from the repo's name or filesystem path. Pure infrastructure — nothing
user-visible, nothing gated — but it's the thing that makes the privacy
claim in CLOUD_ARCHITECTURE.md checkable rather than just asserted.

## 3. Rollup builder and `--explain-payload`

Turns a closed session, a batch of commits, or a turnover sample into the
exact wire records the schema defines — explicit field-by-field mapping, no
spreads, so nothing can ride along unnoticed. `agentlens --explain-payload`
prints exactly what would be queued for a real session, stable-key-ordered,
and works on a free install with no team linked — the transparency tool
doesn't require the thing it's proving trustworthy.

## 4. Forwarding queue

The disk-backed, idempotent queue and sender that actually gets a rollup to
the hosted service — `~/.agentlens/forward-queue.jsonl`, 0600, capped with
oldest-first eviction, deduplicated on an idempotency key so a retry after an
ambiguous failure is free. Drains on its own timer, started only while
linked, never synchronously from a session close. Every failure mode (offline,
401, 403, 400, 429, disk full) degrades to "the dashboard stays stale," never
to a broken client — see the failure table in `src/cloud/forward/sender.ts`.

## 5. AI authorship attribution — free forever

For every line in a commit, decides whether an agent wrote it and how
confident that judgment is: **certain** (an agent trailer, or the commit
lands inside a session's own span), **probable** (the session touched the
file and the commit landed within a 72-hour lookback), or **unknown** — most
commits on a real repo, and excluded from any denominator rather than
guessed at. Built from `git log --numstat` and `git blame --line-porcelain`
joined against local session records; no network path in its dependency
graph at all. This is the numerator every outcome metric below rests on.

## 6. Cohort turnover engine — free forever

Computes the number the whole feature set exists to produce: of the
AI-authored lines merged in a given month, what share has already been
overwritten or deleted (`git blame HEAD`, bucketed by originating commit). A
cohort is only measured once its window has fully elapsed
(`measurableAt`/`isWindowElapsed`) — no partial-window guesses. Returns
`TurnoverResult | InsufficientData`, never a bare percentage without a
line/commit count and date range attached. Published benchmark bands (30-day
12–18%, healthy <15%; 90-day ~22%) live in one file so they're easy to
revisit as more data comes in.

## 7. Local turnover report — the Outcomes tab, free forever

Puts feature 6's number in front of a single developer about their own work,
on first run, with no team required — this is deliberately the free tier's
activation event, not a Pro upsell: gating it would trade the whole
top-of-funnel for a marginal nudge. `InsufficientData` states are first-class
UI, not an error path. The only Pro mention anywhere in the tab is one line
in the cohort footer pointing at team-wide comparison.

## 8. Instruction telemetry and the apply loop

Reports enough about a repository's agent instruction files (CLAUDE.md,
`.cursorrules`, etc.) and changes applied to them for the hosted service to
pool evidence across a team about which instructions actually change
behavior. The local Advisor — detecting instruction files, suggesting edits,
measuring a before/after baseline — stays free and unchanged; what's Pro is
the cross-developer pooling a single install structurally cannot produce
itself. `agentlens advise --apply <id>` regenerates instruction text with
real local paths and captures the baseline; `agentlens cohort --repo …`
answers a team's "show me an example" request on the machine that actually
has the repo, via a deep link, so the hosted service never needs to hold
source.

## 9. The free/paid boundary itself

Not a feature with its own UI — the plan that makes the line between free
and Pro structural rather than a matter of good behavior. The two rules in
CLOUD_ARCHITECTURE.md (privacy is a property, not a promise; free is
single-player, paid is multiplayer) are enforced the same three ways
everywhere: directory placement, a `loadCredentials()` guard at every
network entry point that no-ops before touching disk when unlinked, and a
dependency-graph rule — the free engines (`attribution/`, `turnover/`) never
import from `team/` or `forward/`, and `forward/schema.ts` structurally
cannot import `SessionSummaryCard`. See
`src/test/cloud/team/pricingBoundary.test.ts`, which pins
`docs/pricing-boundary.md` against the shipped copy so the pricing page and
the repo can't drift apart.
