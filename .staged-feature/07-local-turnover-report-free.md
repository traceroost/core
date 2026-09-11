# 07 — Local turnover report (free)

**Phase 4 — the outcome metric.** Free-track, and the free tier’s activation event — see the README on why this should not wait for the SaaS.

**Goal:** put AL 06's number in front of a single developer, about their own
work, on first run — the activation event the whole funnel depends on.

**Tier:** **free forever, without qualification.** Gating this trades the entire
funnel for a marginal upgrade nudge.

**Depends on:** AL 06.

**Status:** staged, not filed.

**Related:** `src/dashboardPanel.ts`; `media/src/` (Preact dashboard, tab layout
in `ARCHITECTURE.md` §10); `standalone/server.ts`.

---

## What this has to do

State a specific, unexpected fact about the person's own work that they did not
previously have:

> 34% of the AI-authored code you merged in the last 90 days has since been
> rewritten or reverted. The healthy benchmark is under 22%.

Specific, about them, and screenshot-shaped. Developer tools spread on facts
people did not have about themselves; that property is what makes this the
distribution channel rather than a feature.

If this number does not land, nothing downstream matters — no amount of team
dashboard recovers a free tier nobody shares.

## Where it goes

A new **Outcomes** tab beside Sessions / Analytics / Advisor / Export / Import,
plus a first-run surfacing: when the tool has never shown this before and a
cohort is measurable, open on Outcomes rather than Sessions.

Contents:

- The 30-day and 90-day figures for **the developer's own commits**, each with
  its eligibility caption (line count, commit count, merge window) and its
  benchmark band.
- Attribution coverage, stated plainly next to the rate.
- Turnover by merge cohort over time — the shape matters more than the level.
- Per-repository breakdown for the repositories this install has seen.
- The `InsufficientData` states from AL 06, rendered as first-class panels with
  the reason and, where applicable, the date the number becomes available.

Every one of these works with no account, no network and no Pro.

## The wall, stated honestly and once

The free report answers for one developer and their own clones. It cannot answer
for the team, because a local install cannot see other people's machines — that
is physics, not a feature flag.

So the Outcomes tab carries exactly one Pro reference: a single line at the foot
of the cohort view saying the team-wide version exists, linking out. Not a modal,
not a banner on every tab, not a locked panel with a blurred screenshot behind
it, not a counter of what you are missing. One line. The free tier is the
distribution channel and resenting it is how the channel closes.

## Privacy invariants

- Nothing in this feature has a network path. It is computed and rendered
  locally, with no account and no telemetry — consistent with the standing
  decision in `.staged-issues/free-tier-telemetry-position.md`.
- The share affordance produces a PNG or a copyable summary containing counts and
  the repository *label the user chooses*, defaulting to none. It never embeds a
  repository name, path or file name by default, because the natural next action
  after seeing this number is to post it publicly.

---

## Steps

1. `media/src/tabs/Outcomes.tsx` — the tab, following the existing signal-based
   state pattern; no new state library.
2. Reuse the existing card, section-label and chart vocabulary from
   `media/src/styles/` rather than introducing new components.
3. `InsufficientData` panels — write these before the populated ones. They are
   what a majority of first runs will show.
4. First-run routing in `src/dashboardPanel.ts`: open on Outcomes when a cohort
   is measurable and this has not been shown before.
5. Share: render the current cohort card to PNG, with a checkbox to include the
   repository label, default off.
6. The single Pro line, in the cohort view footer only.

## Acceptance

- Fresh install on a repository with no AgentLens history: Outcomes opens,
  explains what it needs, and shows any trailer-attributable cohorts. No error,
  no empty white panel.
- The report renders with the machine offline.
- Nothing in the tab is disabled, blurred, watermarked or upsell-gated.
- The exported PNG contains no repository or file name unless the user opted in.

## Notes

The published-benchmark comparison is part of the output, not a tooltip. A number
without a reference point is a number nobody knows how to feel about, and the
comparison is most of what makes it shareable.
