# 05 — AI authorship attribution

**Phase 4 — the outcome metric.** Free-track: nothing in phases 1–3 depends on this, and it can start at any time.

**Goal:** decide, for every line in a commit, whether an agent wrote it — and say
how confident that is. Everything downstream is a ratio whose numerator this
produces.

**Tier:** free forever. This runs locally for a single developer and is half of
the free activation report.

**Depends on:** AL 02 (for the `attribution` enum and `CommitRecord` shape). Blocks AL 06.

**Status:** staged, not filed.

**Related:** `src/gitOutcome.ts`; `src/sessionRepository.ts`; `src/database/schema.ts`
(`sessions.files_changed`, `sessions.start_time`).

---

## What exists and why it is not this

`src/gitOutcome.ts` answers a session-scoped question: for the files *this
session* changed, compare content immediately before the session against content
now, and classify `productive | reverted | abandoned | ambiguous`. That is a
useful per-session verdict and it stays.

It is not attribution. It never touches commits, it works on whole files rather
than lines, and it has no notion of who or what authored a line. The cohort
metric needs *which lines in which commits were agent-written*, which is a
different join.

## The join

AgentLens already stores, per session: the workspace, a start and end time, and
`files_changed`. Git already stores which commits touched which files, when, and
what lines each changed. The attribution is the intersection.

For each commit in the window:

1. `git log --numstat` for the commit gives files and line counts.
2. Candidate sessions are those whose `workspace` resolves to this repo and whose
   time span ends at or before the commit timestamp, within a bounded lookback
   (default 72 hours — a session's work is normally committed the same day, and
   an unbounded window turns every old session into a candidate for every commit).
3. A file in the commit is agent-touched if a candidate session lists it in
   `files_changed`.
4. `git blame --line-porcelain` on the commit attributes lines to it; lines in
   agent-touched files introduced by this commit are counted as AI lines.

**Confidence tiers**, which are the honest part:

- **certain** — the commit message or trailer names the agent
  (`Co-Authored-By:` an agent identity, or an equivalent trailer), *or* a session
  lists the file and the commit lands inside that session's own time span.
- **probable** — a session lists the file and the commit lands within the
  lookback window after it.
- **unknown** — no session record and no trailer. This includes every commit
  made before AgentLens was installed, which on a real repository is most of them.

## Coverage is reported, never assumed

Unknown lines are **excluded from the denominator**, not counted as
human-authored. That makes every turnover rate a rate over *the lines we could
attribute*, and the honest presentation of it carries coverage alongside:

> 16.4% · attribution determined for 68% of merged lines in this window

A single blended percentage with no coverage figure invites exactly the objection
the product has to survive, and it is the objection that is hardest to recover
from because it is correct.

## Privacy invariants

- Commit messages are read to detect trailers and are **never stored, hashed into
  anything reversible, or transmitted**. Only the resulting enum leaves this step.
- Blame output is line content; it stays in memory and is never written to the
  local database or a log.
- Author identity from git is used only to bind a commit to the local member.
  Other contributors' names and emails are not recorded and not sent.

---

## Steps

1. `src/attribution/commitScan.ts` — walk `git log` for a repo and window,
   returning commits with per-file line counts.
2. `src/attribution/sessionJoin.ts` — the candidate-session lookup above, driven
   by `SessionRepository`. Bounded lookback, configurable, default 72h.
3. `src/attribution/blame.ts` — per-commit line attribution. Cap fan-out the way
   `gitOutcome.ts` caps it (`MAX_FILES`, `GIT_TIMEOUT_MS`); a repository with a
   10,000-line generated file must not hang the report.
4. `src/attribution/index.ts` — assemble `CommitRecord[]` per AL 02, with
   `attribution` and `ai_lines`.
5. Cache results in SQLite keyed by `commit_sha`. A commit's attribution never
   changes once computed, so this is computed once per commit for the life of the
   install.
6. Tests over a fixture repository built by a script (see `TEST_DATA.md` for the
   existing pattern): a commit with a trailer, a commit inside a session span, a
   commit in the lookback window, a commit with neither, and a merge commit.

## Acceptance

- Running against a repository with no AgentLens history yields 0% coverage and
  no crash — the common first-run case.
- Merge commits are not double-counted.
- Attribution for a given `commit_sha` is stable across runs and across machines
  with the same session history.
- No commit message text appears in the SQLite database or in any log output.

## Notes

Rename detection (`git log --follow`) is deliberately out of scope for v1. A
renamed file breaks the line lineage and its lines fall to `unknown`, which
lowers coverage rather than producing a wrong number. That is the right failure.
