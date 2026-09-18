# 0001 — Session list stays client-side paginated; no incremental DB save either, for now

**Status:** accepted · 2026-09-18

## Context

`.staged-issues/scalability.md` named three risk points where TraceRoost's cost
scales with a developer's *total lifetime* trace history rather than new data
or the currently-visible page:

1. `LogReader.fileState` isn't persisted across restarts, so every extension
   activation re-parses every historical source-tool log file. **Fixed
   unconditionally** (independent of this record) — see
   `exportFileState`/`importFileState` on `LogReader` and
   `logReader.fileState.test.ts`. This was pure waste today, at current scale,
   not a scale question.
2. `TraceRoostDb.save()` re-serializes the *entire* in-memory sql.js DB on
   every save — cost is O(total DB size), not O(new data).
3. The primary Sessions list (`repository.listSessions()` →
   `media/src/App.tsx`) has no DB-level pagination — it loads every session
   row into the extension host and paginates client-side via `.slice()`.
   Search/Export already has real `LIMIT`/`OFFSET` + `COUNT(*)`
   (`DatabaseReader.searchSessions()`); the main list doesn't.

The doc's own instruction: **don't build incremental persistence or DB-level
pagination against a guess** — profile first, at a realistic multi-year DB
size, and only build #2/#3 if the numbers say they matter.

## The stress test

`src/test/database/scalability.stress.test.ts` seeds an in-memory sql.js DB
with 7,300 sessions (~10/day for 2 years, TraceRoost's own suggested order of
magnitude), each with a realistic-length prompt, file lists, tool counts, and
a 5-entry timeline, then measures:

| Measurement | Result |
| --- | --- |
| `db.export()` (the actual cost of `TraceRoostDb.save()`) | **1.3 ms**, 8.04 MB |
| `DatabaseReader.listSessions()` (unfiltered, the main list's query) | **32.8 ms**, 7,300 rows |
| `JSON.stringify()` of that result (the webview `postMessage` payload) | **5.1 ms**, 6.02 MB |

All three are far below anything a user would perceive as slow, and the
serialized payload (6 MB) is nowhere near V8's ~512 MB max string length —
the thing `spanStore.ts`'s `DEFAULT_MAX_SPANS`/`pruneSpans()` exists to guard
against on the standalone/OTLP-receiver path.

## Decision

**Do not build incremental `TraceRoostDb.save()` persistence, and do not add
DB-level `LIMIT`/`OFFSET` pagination to the primary Sessions list**, at this
time. The stress test shows both are fast and small at 2 years of realistic
daily use — building a second source of truth (staleness window, backfill
logic, a job that can fail silently) or real surgery on `App.tsx`/`state.ts`'s
pagination model for a cost that doesn't exist yet is exactly the mistake the
staged issue warned against.

**What *is* built regardless of this record** (risk #5, the safety valve):
`sessionRepository.listSessions()` now caps the number of rows returned to the
webview at `MAX_SESSIONS_TO_WEBVIEW` (see `src/sessionRepository.ts`), mirroring
`spanStore.ts`'s pattern — a known, tested ceiling beats discovering V8's
string-length limit in production, independent of whether today's numbers are
comfortable. Retention (`retention.ts`, default 90 days) already bounds row
count for the common case; this cap is the backstop for someone who sets
retention very high or unlimited.

## Consequences

- No new staleness window, no new job that can fail silently, no second
  source of truth for session data.
- The main Sessions list keeps loading its full (capped) result set into the
  extension host and paginating client-side — same code path as today, not a
  regression, just not a change.
- If a real user's DB genuinely grows past what this stress test modeled (much
  higher session volume, much larger per-session payloads, e.g. long
  timelines from very long sessions), re-run
  `scalability.stress.test.ts` against numbers closer to that shape before
  deciding whether to revisit. This record does not claim "fast forever," only
  "fast at the order of magnitude actually profiled."
- `.staged-issues/scalability.md`'s risk #1 (log file re-parsing) is the one
  item that doesn't wait on this — it's real waste today regardless of scale,
  and is fixed independently of this decision.
