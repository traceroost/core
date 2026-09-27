# Signal calibration

Checking whether the loop/malfunction signals in `src/loopDetector.ts` and
`src/sessionRiskSignals.ts` actually correlate with real outcomes, using this project's own
dogfooded session history as ground truth, instead of leaving their thresholds as guesses forever.

**Trigger:** run periodically as the session corpus grows (the first pass, 2026-09, used 236
sessions with 110 resolvable git outcomes — a real but small sample), or whenever a signal's fire
rate looks suspicious in normal use (e.g. it seems to fire on nearly everything, or never fires at
all). Not scheduled or automated — there's no CI check for this.

## What it measures

`classifySessionOutcome` (`src/gitOutcome.ts`) already answers, after the fact, whether a session's
changes survived (`merged`/`committed`) or didn't (`abandoned`/`ambiguous`). A signal that's doing
its job — flagging a genuinely stuck or unreliable session — should fire disproportionately on the
bad-outcome side. A signal firing at roughly the same rate regardless of outcome isn't
discriminating anything, whatever its own code comment assumed when it was written.

This can only validate signals against **this project's own history** — `classifySessionOutcome`
shells out to the real git repo a session ran in, so it only resolves for sessions whose recorded
workspace still exists on disk. In practice that's whichever of this project's own workspaces
you've worked in locally (`traceroost/core`, `traceroost/cloud`), not a broad external sample.
Treat every finding as directional evidence from one codebase's usage patterns, not a settled
statistical result — say so explicitly when acting on it (see the code comments this pass already
left in `loopDetector.ts` / `sessionRiskSignals.ts` as the model to follow).

It also can't measure everything: `find_relevant_context` and `malformed_tool_call` were removed
rather than calibrated (2026-09 pass) because neither's question — "was the retrieval relevant,"
"did the regex match real harness wording" — is something a git-outcome comparison can answer.
Outcome-based calibration only applies to signals whose claim is "this predicts trouble."

## How to run it

1. `npx esbuild scripts/calibrateSignals.ts --bundle --platform=node --format=cjs --outfile=/tmp/calibrateSignals.js`
   (no `ts-node` in this repo, so bundle first — same reason `standalone/server.js` is a checked-in
   bundle rather than run from `.ts` directly).
2. `node /tmp/calibrateSignals.js`
3. Read the two tables it prints:
   - **Per-signal table** — fire count (raw and as % of all sessions), warning/critical split, and
     bad-outcome rate among fired sessions vs. the baseline (lift). A signal firing on a large
     majority of *all* sessions has already failed regardless of lift — that's not anomaly
     detection anymore, whatever the number says. `(n<5, noisy)` on a lift figure means don't act
     on that number alone.
   - **Count distribution** — percentiles (p50/p75/p90/p95/max) of each signal's `count` field
     among sessions where it fired. Use this to pick a new threshold from the actual data (e.g.
     "set critical near p90-p95") instead of guessing a round number.

## How to act on results

- **Fires on a small, real minority of sessions, with real lift over baseline** → working as
  intended, leave it. (`hallucinated_import` was the clearest example in the 2026-09 pass: 15% fire
  rate, +15pp lift.)
- **Fires on most/all sessions, ~zero lift over baseline** → the threshold is catching ordinary
  behavior, not anomalies. Raise it using the count-distribution percentiles so it marks a real
  tail again, and update the code comment with the specific numbers this run found (see
  `EXACT_REPEAT_WARNING_STREAK`/`EXACT_REPEAT_CRITICAL_STREAK` and `STEP_THRESHOLDS` in
  `loopDetector.ts` for the pattern to follow). Don't just cap severity and move on — a signal that
  still fires on the majority of sessions erodes trust even at "warning" severity.
- **Fires on too few sessions to read a rate confidently (single digits, or `n<5` known-outcome)**
  → don't rewrite the threshold off that sample; it's noise either direction. Leave it, and note in
  the code comment that it's still uncalibrated and why (small sample), same discipline as
  `instructionEffectiveness.ts`'s confidence-by-sample-size pattern.
- **Never fires at all** → no data either way. Could mean the threshold is too strict, or that this
  codebase's sessions genuinely don't hit that failure mode. Leave it and note the zero-firing
  result in the comment; don't loosen a threshold just to make it fire.

## Verify after changing a threshold

- `pnpm run check-types && pnpm run lint`
- `pnpm run test:unit` — update `src/test/loopDetector.test.ts` fixtures to use counts that clear
  the new thresholds (they're currently hand-written to match whatever `EXACT_REPEAT_*`/
  `STEP_THRESHOLDS` are; grep for the old numbers if you change them again)
- Rebuild `media/dashboard.js` (`node esbuild.js`) if any Help.tsx/README copy cites the old
  threshold numbers — grep for the specific digits, not just the signal name
