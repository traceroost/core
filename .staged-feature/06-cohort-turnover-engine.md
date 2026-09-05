# 06 — Cohort turnover engine

**Phase 4 — the outcome metric.** Free-track.

**Goal:** compute the number the entire product rests on — of the AI-authored
lines merged in a given window, what share is no longer in `HEAD`.

**Tier:** free forever, for one developer's own repositories.

**Depends on:** AL 05. Blocks AL 07 and SA 08.

**Status:** staged, not filed.

**Related:** `claude/pro-functional-spec.md` §3 (the presentation rules this
engine has to make possible); `src/gitOutcome.ts`.

---

## The definition, stated once

For a cohort — the set of commits merged inside a date range — and a window of
30 or 90 days:

```
turnover = 1 − (AI-authored lines from that cohort still present in HEAD)
               ────────────────────────────────────────────────────────
               (AI-authored lines that cohort introduced)
```

"Still present" is decided by `git blame` on `HEAD`: a line survives if `HEAD`
attributes it to one of the cohort's commits. A line that was moved survives; a
line that was edited does not, which is the intended reading — an edited line is
rework.

## Eligibility is the part that gets this wrong

**A cohort can only be measured once its window has fully elapsed.** A 90-day
figure computed today describes commits that are themselves at least 90 days
old — work merged three months to a year ago, not recent work.

This has two consequences that are engineering requirements, not presentation
notes:

1. Every result carries the cohort's **line count, commit count and merge date
   range**. A bare percentage is uninterpretable, and the UI cannot manufacture
   this after the fact.
2. A cohort whose window has not elapsed produces **no result** — not zero, not
   a partial figure, not an extrapolation. The return type is
   `TurnoverResult | InsufficientData`, and `InsufficientData` carries *why*
   (window not elapsed / too few attributed lines / repository younger than the
   window) and, where it applies, the date the cohort becomes measurable. The
   day-one screen is built entirely from that structure.

A minimum sample floor applies: below 200 attributed lines in a cohort the result
is `InsufficientData`, because a 40-line cohort produces percentages that swing
25 points on a single edit and read as noise.

## Why this makes self-serve possible at all

Collected forward, this metric takes 90 days to say anything, and a product whose
first number arrives three months after install cannot be sold without a
conversation. Git history is already retrospective: the moment the tool can read
a repository it can compute the last several cohorts from commits already there.
Time to value goes from ninety days to about ninety seconds. That is the reason
this engine is free and local, and the reason it is step 3 rather than step 12.

## Privacy invariants

- Blame and diff content stay in memory. Only counts are persisted.
- Cohort results are keyed by `repo_hash`, never by repository path or name.
- Nothing here initiates a network call. The engine has no transport.

---

## Steps

1. `src/turnover/cohorts.ts` — enumerate measurable cohorts for a repository:
   monthly by merge date, filtered to fully-elapsed windows.
2. `src/turnover/survival.ts` — blame `HEAD` once per repository, bucket
   surviving lines by originating commit, join to AL 05's `CommitRecord`s.
   One full-repo blame is far cheaper than per-commit blames and is the reason
   this is fast enough to run on first launch.
3. `src/turnover/index.ts` — `computeTurnover(repo, cohort, windowDays)` returning
   the discriminated union above. Emit `TurnoverSample[]` per AL 02.
4. Persist samples in SQLite; recompute only when `HEAD` has moved.
5. Benchmark constants in one module, sourced and commented:
   30-day band 12–18%, healthy under 15%; 90-day 22%. These are published figures
   and they will move — one place to change them.
6. Tests: a cohort with no surviving lines (100%), a cohort fully surviving (0%),
   a cohort below the sample floor, a repository younger than the window, and a
   repository with zero attributed lines.

## Acceptance

- A first run on a two-year-old repository with no prior AgentLens history
  produces cohort results from commit trailers alone, or a clean
  `InsufficientData` if there are none — in both cases within a few seconds on a
  repository of ~50k commits.
- No code path can return a percentage without an accompanying line count,
  commit count and date range.
- Re-running with an unchanged `HEAD` does no git work.

## Notes

Squash-merge workflows collapse a branch into one commit, which is fine — the
cohort is defined by merge date and the squashed commit carries the lines. Rebase
workflows rewrite SHAs; a rebased commit looks new, and its cohort is its new
date. Both are correct readings of "when did this land on the main line."
