/**
 * Loop and malfunction detector for agent sessions.
 *
 * Detects 14 signal types that indicate an agent is stuck, spiraling, or working unreliably or
 * wastefully:
 *
 *   1. exact_tool_repeat     — identical tool call (by label) executed 30+ times with no edit in between
 *   2. edit_revert_cycle     — a file was edited then reverted to a prior state
 *   3. error_recurrence      — the same error message appearing 3+ times
 *   4. runaway_steps         — too many steps relative to inferred task complexity
 *   5. token_runaway         — context growing rapidly while output stays flat/declines
 *   6. chronic_tool_failures — an unusually high share of tool calls in the session failed
 *   7. context_flooding_risk — a tool call returned a result too large for the model to use well
 *   8. tool_call_cycle       — a 2-5-step tool-call sequence oscillates 5+ times (run tests → read log → run tests → read log)
 *   9. file_reread           — the same file read 3+ times with no write in between
 *  10. cache_miss            — a call re-wrote context it could plausibly have read from cache
 *  11. ttl_expiry            — a cache miss caused by waiting longer than the cache's TTL
 *  12. low_cache_hit_ratio   — a session's cache hit ratio is low despite real cache activity
 *  13. budget_overrun        — session cost exceeded a user-configured cap (opt-in, no default)
 *  14. model_tier_mismatch   — a premium model ran a long read-only, low-output stretch
 *
 * Signals 8-14 were added from the 2026-09-26 signal-catalog research pass
 * (.staged-issues/signal-catalog-*.md, stages 01-04) — see those files for the research this
 * catalog is drawn from and the gap analysis against what was already built. Every threshold
 * introduced there is flagged "unconfirmed" in SIGNAL_FORMULAS below until it's been run through
 * scripts/calibrateSignals.ts against real session history, same discipline as signals 1-7.
 *
 * The last 2 started as ad-hoc frontend-only checks (media/src/tabs/Insights.tsx), promoted here
 * so MCP tools and the Instruction Advisor's cross-session aggregation — everything that reads
 * session.loopSignals — can see them too, not just the Insights tab. (A third promoted check,
 * malformed_tool_call, was removed after review: its regex was a best guess at three different
 * agent harnesses' rejection wording, never verified against real session text, and outcome-based
 * calibration can't validate wording accuracy the way it can a threshold.)
 *
 * Each detector is exported individually so tests can exercise them in isolation.
 *
 * Two more signal types (hallucinated_import, failed_check_submission) share this file's
 * PATTERN_NAMES/LOOP_SIGNAL_ACTIONS taxonomy but are detected elsewhere, by
 * src/sessionRiskSignals.ts — they're post-hoc checks (only knowable once a session, or at least
 * an edit, is complete) rather than the real-time in-session signals this file computes, so they
 * live in a separate on-demand module instead of detectLoopSignals below. See that file's
 * docstring for why.
 */

import { LoopSignal, LoopSignalType } from './types'
import { SessionSummaryCard } from './spanSummarizer'
import type { TimelineEntry } from './summarizers/summarizerTypes'
import type { GitOutcome } from './gitOutcome'
import { calcAggregateTokenCostUsd, calcSessionCostUsd, lookupRates } from './pricing'

// ── Pattern taxonomy names ───────────────────────────────────────────────────

export const PATTERN_NAMES: Record<LoopSignalType, string> = {
  exact_tool_repeat: 'Tool Call Deadlock',
  edit_revert_cycle: 'State Corruption Spiral',
  error_recurrence:  'Hallucination Amplification Loop',
  runaway_steps:     'Ambiguous Success / Escalating Scope',
  token_runaway:     'Infinite Loop — Context Accumulation',
  chronic_tool_failures: 'Chronic Tool Unreliability',
  context_flooding_risk: 'Context Flooding Risk',
  hallucinated_import:     'Fabricated Dependency',
  failed_check_submission: 'Unverified Submission',
  tool_call_cycle:      'Multi-Step Oscillation',
  file_reread:          'Redundant Context Reload',
  cache_miss:           'Avoidable Cache Miss',
  ttl_expiry:           'Cache TTL Expiry',
  low_cache_hit_ratio:  'Poor Cache Utilization',
  budget_overrun:       'Budget Overrun',
  model_tier_mismatch:  'Model Tier Mismatch',
}

// ── Actionable recommendations per signal type ──────────────────────────────

export const LOOP_SIGNAL_ACTIONS: Record<LoopSignalType, string> = {
  exact_tool_repeat:
    'The agent is calling the same tool with identical arguments repeatedly, usually because it isn\'t using or retaining the result. '
    + 'Add explicit context-retention instructions: "After reading a file, do not re-read it unless you have made changes." '
    + 'Or scope the task more narrowly so the agent can complete it without re-querying the same resource.',

  edit_revert_cycle:
    'The agent is oscillating between two file states — a sign it is trying to reconcile conflicting constraints. '
    + 'Clarify success criteria upfront: provide the exact final state you want, not iterative instructions. '
    + 'If you are using "make it pass the tests", ensure the tests are deterministic and not themselves the source of the conflict.',

  error_recurrence:
    'The same error is repeating, which means the agent\'s fix attempts are not resolving the root cause. '
    + 'This often happens with missing packages, wrong file paths, or hallucinated API names. '
    + 'Verify the package/function exists before asking the agent to use it. '
    + 'If the error persists after 2 attempts, intervene manually rather than asking the agent to retry.',

  runaway_steps:
    'The session used far more steps than expected for this type of task — a sign of unclear success criteria, escalating scope, or a loop. '
    + 'Break the task into smaller, explicitly scoped subtasks with clear completion conditions. '
    + 'Avoid open-ended instructions like "fix all the bugs" or "clean up the code" with no stopping condition.',

  token_runaway:
    'Input context is growing rapidly while useful output is declining — the agent is accumulating context without making forward progress. '
    + 'This pattern often accompanies tool-call loops or repeated failed fixes. '
    + 'Start a fresh session with a focused prompt, or explicitly tell the agent what it has already tried and what to do differently.',

  chronic_tool_failures:
    'A high share of this session\'s tool calls failed — well above the ordinary rate of an occasional wrong path corrected along the way. '
    + 'Be explicit in your prompt about file locations, available commands, and the runtime/package manager in use. '
    + 'Verify paths and commands exist before asking the agent to use them.',

  context_flooding_risk:
    'One or more tool calls returned a very large result, which gets appended to context in full and crowds out everything else for the rest of the session. '
    + 'Use narrower reads — specify line ranges instead of whole files, tighten search patterns, or pipe command output through something that limits it.',

  hallucinated_import:
    'An edit imports a package that is not declared in the project\'s manifest (package.json, requirements.txt) and does not resolve on disk — '
    + 'a likely hallucinated dependency that will fail at install or runtime. '
    + 'Verify the package actually exists and is spelled correctly before asking the agent to use it, or add it to the manifest yourself if it is intentional.',

  failed_check_submission:
    'The last test/build check run in this session reported a failure, with no further fix attempt before the session ended. '
    + 'Ask the agent to re-run the check and confirm it passes before considering the task done, or review the failure yourself before accepting the change.',

  tool_call_cycle:
    'The agent is oscillating between two or more distinct actions (e.g. run tests → read log → run tests → read log) rather than repeating one call — '
    + 'a sign it\'s reacting to the same feedback each time without changing approach. '
    + 'Interrupt and ask it to explain what changed between attempts, or supply the missing information yourself.',

  file_reread:
    'The agent is rereading the same file repeatedly instead of retaining what it already read — often because a long session pushed the '
    + 'earlier read out of active context, or because it\'s double-checking work it should already trust. '
    + 'Ask it to summarize what it already knows about the file before reading it again, or split the session so the file stays in recent context.',

  cache_miss:
    'A call re-wrote a meaningful share of its prompt prefix instead of reading it from cache, at real dollar cost. '
    + 'This usually means something upstream of the cached content changed — tool definitions, system prompt, thinking/effort settings, or images. '
    + 'Keep those stable across turns in the same session where possible.',

  ttl_expiry:
    'A cache miss followed a gap long enough for the prefix cache to expire, not a changed prompt. '
    + 'If turns in this session are naturally spaced out, consider that the cache will not survive the gap — there is no fix beyond accepting the re-processing cost or working in tighter bursts.',

  low_cache_hit_ratio:
    'Little of this session\'s context came from cache relative to how much was re-processed. '
    + 'Check whether something in the request is varying turn to turn in a way that invalidates the cached prefix (see cache_miss), or whether the session is naturally short-lived and caching was never going to help much.',

  budget_overrun:
    'This session\'s cost exceeded the cap configured for it. '
    + 'Review whether the task genuinely needed this much work, or whether a loop/retry pattern elsewhere in this signal list is driving the cost.',

  model_tier_mismatch:
    'A premium-tier model ran a long stretch of read-only calls with no edits and short output — the kind of work a cheaper model typically handles just as well. '
    + 'Consider routing read/search-heavy turns to a smaller model and reserving the premium one for edits.',
}

// ── Formula/caveat text per signal type ─────────────────────────────────────
//
// Single source of truth for the "why did this fire" copy shown in Help.tsx's Signals
// section and in the per-icon hover tooltips (Sessions.tsx here, and — hand-copied, since cloud
// is a separate repo with no shared build — help-body.tsx/traces-table.tsx in traceroost/cloud).
// `bullets` is a precise, user-facing restatement of the actual threshold this file (or, for the
// two post-hoc types, sessionRiskSignals.ts) checks, one trigger condition per entry so it renders
// as a real list instead of one long run-on sentence. `caveat` states the calibration status
// honestly — several of these thresholds are still guesses that have never fired on real session
// history, and that should read differently from one calibrated against 236 real sessions. `short`
// and `tip` are the condensed one-line versions shown in the hover tooltip (bullets/caveat are too
// long for a title attribute) — `short` restates the trigger, `tip` is what to actually do about
// it; the fuller LOOP_SIGNAL_ACTIONS paragraph above stays reserved for Help.tsx's "how to fix"
// list. `dataSource` is NOT "every entry reads from both, no source-gated branch" — that's true of
// the detector *code* (no `if (dataSource === 'otel')` anywhere below) but false as a claim about
// whether a signal can actually *fire*: several log sub-parsers in logReader.ts never build a tool
// timeline at all (Codex, Copilot CLI, Copilot Chat), several TimelineEntry fields these detectors
// read (fullResult, editDetails, isError) are populated by only a handful of the six log
// sub-parsers, and even OTel needs Claude's enhanced-telemetry env vars before its span timeline is
// usable. `dataSource: 'otel'` below means "log data essentially can't produce this for the
// agents most people use" — usually with exactly one narrow exception, OpenCode's SQLite log,
// noted in `dataSourceNote`. `dataSource: 'both'` means it fires from OTel and from a *real*
// non-niche log source too (most often Claude Code's own JSONL log), still with per-agent gaps
// worth stating in `dataSourceNote` rather than implying blanket parity. Verified against
// spanSummarizer.ts (OTel) and each per-agent sub-parser in logReader.ts (log), field by field —
// re-verify against those before ever changing a value here back to a blanket claim. Keep this in
// sync with the detector comments above (and with sessionRiskSignals.ts for the two post-hoc types)
// rather than letting Help.tsx grow its own
// hand-typed paraphrase again.
export const SIGNAL_FORMULAS: Record<
  LoopSignalType,
  { bullets: string[]; caveat?: string; short: string; tip: string; dataSource: 'otel' | 'both'; dataSourceNote: string }
> = {
  exact_tool_repeat: {
    bullets: [
      'Same tool call (same label, and same result when both occurrences captured one) repeated 30+ times in a row with no file edit in between → warning',
      '50+ → critical',
    ],
    caveat: 'Threshold set from real session history: calibrated against 236 real sessions (the 30/50 cutoffs sit near the p75/p95 of the fired-session streak-length distribution).',
    short: 'Same tool call repeated 30+ times in a row with no edit.',
    tip: 'Stop it and change approach — repeating won’t change the result.',
    dataSource: 'both',
    dataSourceNote:
      'Log-capable from Claude Code, OpenCode, and Cursor logs. Codex, Copilot CLI, and Copilot Chat logs never build a tool timeline at all — those need live OTel from that agent instead.',
  },
  edit_revert_cycle: {
    bullets: [
      'A file’s (old→new) edit is exactly reversed by a later edit on the same file → warning',
      'critical only if that revert was the file’s last edit before the session ended',
    ],
    caveat: 'Fired on only 5% of 236 sessions checked, and just 11 of those had a resolvable outcome — too few to calibrate further, so this threshold is left as originally set.',
    short: 'A file’s edit was exactly undone by a later edit.',
    tip: 'Give the agent one clear final target instead of iterating.',
    dataSource: 'both',
    dataSourceNote:
      'Log-capable only from Claude Code’s own log file. Never fires for Codex — from OTel or log — since Codex never records the old/new edit content this needs.',
  },
  error_recurrence: {
    bullets: [
      'The same error message (after stripping temp paths, timestamps, and hashes) recurs 3+ times → warning',
      '5+ times with a real error-message match (not a tool-label fallback) → critical',
    ],
    caveat: 'Not recalibrated against session history — these thresholds are the original guess.',
    short: 'The same error message recurred 3+ times.',
    tip: 'Step in with the actual fix — retrying isn’t resolving it.',
    dataSource: 'otel',
    dataSourceNote:
      'Needs per-tool error status that Claude, Codex, Copilot CLI/Chat, and Cursor logs don’t capture. OpenCode’s log is the one exception.',
  },
  runaway_steps: {
    bullets: [
      'Total LLM + tool steps exceed a complexity-tiered threshold (simple 45 / medium 110 / complex 250 steps, complexity inferred from the prompt’s wording and how many files were touched) → warning',
      '2× that threshold → critical',
    ],
    caveat: 'Recalibrated roughly 3x upward after the original thresholds fired on 56% of sessions checked with no correlation to whether the session actually went well.',
    short: 'Far more steps than expected for a task this size.',
    tip: 'Break the task into smaller, explicitly scoped steps.',
    dataSource: 'both',
    dataSourceNote:
      'The one signal that’s genuinely source-agnostic — it only reads session-level step/file counts every source populates. Complexity inference is coarser on sources that don’t capture file paths.',
  },
  token_runaway: {
    bullets: [
      'Across 4+ LLM calls, input tokens grow 15,000+ while the output/input ratio collapses to under 30% of its first-call value → warning',
      'input growth over 50,000 tokens → critical',
    ],
    caveat: 'Fired on only 4% of 236 sessions checked, and just 6 of those had a resolvable outcome — too few to validate one way or the other.',
    short: 'Context is ballooning while output isn’t improving.',
    tip: 'Start a fresh session instead of continuing this one.',
    dataSource: 'both',
    dataSourceNote:
      'Log-capable from Claude Code (degraded — undercounts calls that also used a tool) and OpenCode. Not available from Codex, Copilot CLI/Chat, or Cursor logs — none of those capture per-call token counts.',
  },
  chronic_tool_failures: {
    bullets: [
      'At least 5 tool calls are made in the session and 20%+ of them fail → warning',
      '40%+ → critical',
    ],
    caveat: 'Threshold is a guess — no real session has crossed it yet during calibration checks (zero firings across 236 sessions), so it’s unconfirmed.',
    short: '20%+ of this session’s tool calls failed.',
    tip: 'Double-check the paths/commands you gave the agent.',
    dataSource: 'otel',
    dataSourceNote:
      'Same gap as error_recurrence: needs per-tool error status Claude, Codex, Copilot CLI/Chat, and Cursor logs don’t capture. OpenCode’s log is the one exception.',
  },
  context_flooding_risk: {
    bullets: [
      'Any single tool result exceeds 10,000 characters → warning',
      'the total across all such large results reaches 300KB or more → critical',
    ],
    caveat: 'Threshold is a guess — no real session has crossed it yet during calibration checks (zero firings across 236 sessions), so it’s unconfirmed.',
    short: 'A tool result was too large and crowded out context.',
    tip: 'Ask for narrower reads — line ranges, not whole files.',
    dataSource: 'otel',
    dataSourceNote:
      'Never fires for Claude Code, from OTel or log, at any configuration level — Claude’s telemetry doesn’t capture full tool-result size. Works from Codex or Copilot OTel, or from OpenCode’s log.',
  },
  hallucinated_import: {
    bullets: [
      'An edit imports a package name that isn’t declared in the project’s manifest (package.json / requirements.txt) and doesn’t resolve on disk (node_modules, stdlib/builtins excluded) → warning',
      'Checked once an edit is complete, not mid-session like most of the other signals in this list',
    ],
    caveat: 'The best-validated signal in the taxonomy so far: fired on 15% of 236 sessions checked, with a 64% bad-outcome rate among those vs. a 49% baseline (n=33 with a resolvable outcome).',
    short: 'Imports a package that isn’t installed or declared.',
    tip: 'Verify the package name exists before trusting this edit.',
    dataSource: 'both',
    dataSourceNote:
      'Log-capable only from Claude Code’s own log file — same reason as edit_revert_cycle. Never fires for Codex in either form.',
  },
  failed_check_submission: {
    bullets: [
      'The last tool call in the session invoked a recognized test/build runner and its result reads as a failure (an error status, or "fail"/"✗" in the output), with nothing after it → warning',
      'Only the session’s very last tool call is checked, so a failing check followed by more edits does not trigger this',
    ],
    caveat: 'Precision-good, recall-poor by design — zero firings across 236 sessions checked, which may just reflect how rarely a session both runs a check and ends immediately after a failure, not miscalibration.',
    short: 'Session ended right after a failing test/build check.',
    tip: 'Re-run the check and confirm it passes before merging.',
    dataSource: 'otel',
    dataSourceNote:
      'Needs captured tool output Claude, Codex, Copilot CLI/Chat, and Cursor logs don’t provide. OpenCode’s log is the one exception.',
  },
  tool_call_cycle: {
    bullets: [
      'A 2-to-5-step tool-call sequence (same labels, and same results when captured) repeats 5+ times in a row with no file edit in between → warning',
      '10+ repeats → critical',
    ],
    caveat: 'Newly added (2026-09-26), unconfirmed — the 5/10-repeat thresholds are borrowed from Gemini CLI\'s own default, not calibrated against this project\'s session history yet. Run scripts/calibrateSignals.ts once enough sessions have this signal computed.',
    short: 'A multi-step sequence (e.g. run tests → read log → run tests → read log) repeated 5+ times with no edit.',
    tip: 'Explain what changed between attempts, or step in with the missing information.',
    dataSource: 'both',
    dataSourceNote:
      'Same fields as exact_tool_repeat (label + fullResult), so the same source constraint applies: log-capable from Claude Code, OpenCode, and Cursor logs. Codex, Copilot CLI, and Copilot Chat logs never build a tool timeline at all.',
  },
  file_reread: {
    bullets: [
      'The same file is read 3+ times with no write to it in between (matched by path, not literal call label, so a different line range still counts) → warning',
      '6+ times → critical',
    ],
    caveat: 'Newly added (2026-09-26), unconfirmed — the 3/6-read thresholds are a guess, not calibrated against real sessions. Path extraction from toolInput/label is heuristic and may undercount on sources that don\'t expose a clean path field.',
    short: 'The same file was read 3+ times with no write in between.',
    tip: 'Ask the agent to summarize what it already knows instead of rereading.',
    dataSource: 'otel',
    dataSourceNote:
      'Needs a parseable per-call path (toolInput JSON, or a path embedded in the label). Log-capable only from OpenCode\'s log, which captures both. Claude Code\'s own log batches multiple tool calls into one message-level entry with no per-call path, so this can\'t fire from it; Cursor\'s log captures only tool name+count, not paths.',
  },
  cache_miss: {
    bullets: [
      'An LLM call re-writes 5%+ of its prefix as new cache-write tokens, and that re-written share is 2,000+ tokens → warning (the first call on each model is skipped — nothing is cached yet, so writing its prefix is the normal cold start, not a miss)',
      '10,000+ re-written tokens → critical',
    ],
    caveat: 'Newly added (2026-09-26), unconfirmed — the 5%/2,000-token rule is copied verbatim from Claude Code\'s own published /usage rule, not calibrated against this project\'s own session history.',
    short: 'A call re-wrote context it could plausibly have read from cache.',
    tip: 'Keep tool definitions, system prompt, and thinking/effort settings stable across turns.',
    dataSource: 'both',
    dataSourceNote:
      'Same per-call cache-token fields as token_runaway: log-capable from Claude Code (degraded) and OpenCode. Not available from Codex, Copilot CLI/Chat, or Cursor logs — none of those capture per-call cache-token counts.',
  },
  ttl_expiry: {
    bullets: [
      'A cache_miss (above) where the gap since the previous LLM call exceeds a 1-hour TTL → warning',
      '3+ such gaps in one session → critical',
    ],
    caveat: 'Newly added (2026-09-26), unconfirmed. The 1-hour TTL is a single conservative constant (Claude Code\'s subscription TTL) — this codebase has no per-session record of subscription vs. API-key auth to pick the shorter 5-minute API TTL instead, so a real API-key expiry can go unflagged until the gap is this large. Chose the longer TTL deliberately: it undercounts real expiries rather than mislabeling a still-live cache as expired.',
    short: 'A cache miss followed a gap longer than the cache\'s TTL.',
    tip: 'Work in tighter bursts, or accept the re-processing cost for spaced-out turns.',
    dataSource: 'both',
    dataSourceNote:
      'Same constraint as cache_miss/token_runaway — needs per-call cache tokens and timestamps. Claude Code (degraded) and OpenCode logs; not Codex, Copilot CLI/Chat, or Cursor logs.',
  },
  low_cache_hit_ratio: {
    bullets: [
      'The session reports at least 2,000 combined cache-read + cache-write tokens (real cache activity, not just a source that never reports caching), and cache-read tokens are under 30% of the session’s total input tokens → warning',
      'under 10% → critical',
    ],
    caveat: 'Newly added (2026-09-26), unconfirmed — the 30%/10% cutoffs and the 2,000-token activity floor are guesses, not calibrated against real sessions.',
    short: 'Little of this session\'s context came from cache.',
    tip: 'Check what\'s invalidating the cached prefix turn to turn.',
    dataSource: 'both',
    dataSourceNote:
      'Reads only the session-level cache totals every OTel summarizer and the Claude Code / OpenCode log parsers already accumulate. The 2,000-token activity floor exists specifically because a source that never reports caching at all (Cursor, Copilot CLI/Chat) would otherwise read as a 0% hit ratio — "no data" is not "zero cache hits."',
  },
  budget_overrun: {
    bullets: [
      'Session cost (each LLM call priced at its own model via pricing.ts where per-call tokens exist, otherwise the session’s token totals at flat rates) exceeds a configured cap → warning',
      '2× that cap → critical',
      'Disabled unless TRACEROOST_BUDGET_CAP_USD is set — there is no default cap',
    ],
    caveat: 'Newly added (2026-09-26), unconfirmed. Deliberately has no default threshold to calibrate — unlike every other signal here, the right cap is a dollar figure the user should set for themselves (SWE-agent\'s own default is $3/task, offered only as a reference point, not shipped as this signal\'s default).',
    short: 'Session cost exceeded the configured budget cap.',
    tip: 'Check whether a loop or retry pattern elsewhere in this list is driving the cost.',
    dataSource: 'both',
    dataSourceNote:
      'Reads only session-level token totals and model, the same source-agnostic fields runaway_steps uses — every source populates these. Precision degrades wherever the underlying cost estimate does (sources that don\'t split cache buckets cleanly).',
  },
  model_tier_mismatch: {
    bullets: [
      'No file was edited this session, 90%+ of tool calls are read-only (grep/search/glob/list/read), the model\'s input rate is $3+/M tokens (pricing.ts), and average output per LLM call is under 300 tokens → warning',
      'No critical tier — this is a cost-optimization tip, not a malfunction',
    ],
    caveat: 'Newly added (2026-09-26), unconfirmed — every cutoff here (the 90% read-only share, the $3/M premium-tier line, the 300-token output ceiling) is a guess, not calibrated against real sessions.',
    short: 'A premium-tier model ran a long, read-only, low-output stretch.',
    tip: 'Route read/search-heavy turns to a smaller model.',
    dataSource: 'both',
    dataSourceNote:
      'Needs per-call model tags and output tokens, the same constraint token_runaway has: log-capable from Claude Code (degraded) and OpenCode, not from Codex, Copilot CLI/Chat, or Cursor logs.',
  },
}

// ── Public API ───────────────────────────────────────────────────────────────

export function detectLoopSignals(session: SessionSummaryCard): LoopSignal[] {
  const signals: LoopSignal[] = []
  detectExactToolRepeat(session, signals)
  detectToolCallCycle(session, signals)
  detectEditRevertCycle(session, signals)
  detectErrorRecurrence(session, signals)
  detectRunawaySteps(session, signals)
  detectTokenRunaway(session, signals)
  detectChronicToolFailures(session, signals)
  detectContextFloodingRisk(session, signals)
  detectFileReread(session, signals)
  detectCacheMiss(session, signals)
  detectTtlExpiry(session, signals)
  detectLowCacheHitRatio(session, signals)
  detectBudgetOverrun(session, signals)
  detectModelTierMismatch(session, signals)
  return signals
}

/**
 * Tempers already-computed signal severity using a session's eventual git outcome, when known.
 * None of the 5 detectors above check whether a session ultimately succeeded — a session that
 * tripped a critical signal mid-session and then recovered gets the same alarm level as one that
 * never did. Deliberately conservative: only ever downgrades (a confirmed-committed outcome —
 * 'merged' or 'committed', either way the change survived — softens a critical signal to a
 * warning), never upgrades — a clean signal list on a session with a bad outcome isn't evidence
 * this function should invent one.
 *
 * Not wired into the eager per-session-card computation in spanSummarizer.ts/extension.ts.
 * `GitOutcome` is deliberately computed on demand (see gitOutcome.ts) because it shells out to git
 * per session — running it eagerly for every session on a dashboard load would reintroduce exactly
 * the cost that lazy computation exists to avoid. Call this instead wherever a `GitOutcome` is
 * already being computed on demand (session detail view) to get outcome-aware severity there
 * specifically, without changing how signals are computed for the session list.
 */
export function temperLoopSignalSeverity(signals: LoopSignal[], outcome: GitOutcome | null): LoopSignal[] {
  if (!outcome || (outcome.overall !== 'merged' && outcome.overall !== 'committed')) { return signals }
  return signals.map(s => s.severity === 'critical' ? { ...s, severity: 'warning' as const } : s)
}

// ── Detector 1: Exact tool repeat ────────────────────────────────────────────

/**
 * Counts tool call labels verbatim. The label already encodes tool name + key
 * arguments (e.g. "read_file types.ts L1-50"), so an identical label means
 * the agent is making the exact same call again.
 *
 * A streak only counts toward the threshold if nothing changed between repeats — any file edit
 * anywhere in the session resets every label's streak, since that's forward progress, not
 * redundancy. Without this, re-running a verification command (tests, lint) after each fix looks
 * identical to an agent re-issuing the same call because it isn't retaining results.
 *
 * That edit-reset only catches changes made through the agent's own recognized edit tool. A file
 * can just as legitimately change out from under a repeated read via a bash command, an external
 * process, or another agent/user — none of which produce editDetails. So when both the current and
 * previous occurrence of a label carry a `fullResult`, the streak breaks on content too: identical
 * label but different result means the resource changed and this wasn't a redundant call, whatever
 * changed it. When either side lacks `fullResult` (some sources/telemetry configs never capture it —
 * see getFileEditCounts's docstring), we can't tell, so it falls back to the label-only behavior
 * above.
 *
 * Thresholds calibrated against this project's own session history (scripts/calibrateSignals.ts,
 * see runbooks/SIGNAL_CALIBRATION.md) rather than guessed. The original 3+/5+ thresholds fired on
 * 87% of all 236 sessions checked (83% of *all* sessions at critical) with zero correlation to
 * outcome (49% bad-outcome rate whether it fired or not, vs. a 49% baseline) — a streak of 3-5
 * turned out to be completely ordinary, not anomalous, on real agentic-coding sessions. Among
 * sessions that did cross the old floor, the streak-length distribution was p50=21, p75=32,
 * p90=44, p95=48 — the thresholds below sit near p75/p95 of that distribution, so only a real
 * minority of sessions should flag: 30+ → warning, 50+ → critical. Revisit as the corpus grows;
 * this was one calibration pass on one codebase's history, not a settled constant.
 */
const EXACT_REPEAT_WARNING_STREAK = 30
const EXACT_REPEAT_CRITICAL_STREAK = 50

export function detectExactToolRepeat(session: SessionSummaryCard, signals: LoopSignal[]): void {
  // An edit resets every label's streak. Rather than zeroing each one (O(labels) per edit), a
  // streak only counts while it was last extended in the current edit-free run (`run`).
  const streaks = new Map<string, { n: number; run: number }>()
  const maxStreaks = new Map<string, number>()
  const lastResult = new Map<string, string | undefined>()
  let run = 0

  for (const entry of session.timeline) {
    if (entry.editDetails && entry.editDetails.length > 0) { run++ }
    if (entry.type !== 'tool') { continue }
    const key = (entry.label || '').trim()
    if (!key) { continue }

    const prevResult = lastResult.get(key)
    const contentChanged = prevResult !== undefined && entry.fullResult !== undefined && entry.fullResult !== prevResult

    const streak = streaks.get(key)
    const n = contentChanged ? 1 : (streak && streak.run === run ? streak.n : 0) + 1
    if (streak) { streak.n = n; streak.run = run } else { streaks.set(key, { n, run }) }
    maxStreaks.set(key, Math.max(maxStreaks.get(key) || 0, n))
    lastResult.set(key, entry.fullResult)
  }

  const repeated = Object.entries(toOrderedRecord(maxStreaks))
    .filter(([, n]) => n >= EXACT_REPEAT_WARNING_STREAK)
    .sort((a, b) => b[1] - a[1])

  if (repeated.length === 0) { return }

  const topCount = repeated[0][1]
  signals.push({
    type: 'exact_tool_repeat',
    severity: topCount >= EXACT_REPEAT_CRITICAL_STREAK ? 'critical' : 'warning',
    evidence: `${repeated.length} tool call(s) executed identically ${EXACT_REPEAT_WARNING_STREAK}+ times with no edit in between`,
    count: topCount,
    examples: repeated.slice(0, 3).map(([label, n]) => `"${label.slice(0, 60)}" ×${n}`),
    patternName: PATTERN_NAMES.exact_tool_repeat,
    action: LOOP_SIGNAL_ACTIONS.exact_tool_repeat,
  })
}

/** A Map's entries as a plain object, so `Object.entries` enumerates them in exactly the order a
 *  Record built key by key would (integer-like keys first) — detectExactToolRepeat tracks with Maps
 *  for speed but keeps its original tie-breaking order. */
function toOrderedRecord(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of map) { out[k] = v }
  return out
}

// ── Shared: per-file edit extraction ─────────────────────────────────────────

function collectEditDetails(session: SessionSummaryCard, type: 'llm' | 'tool'): Record<string, Array<{ old: string; new: string }>> {
  const fileEdits: Record<string, Array<{ old: string; new: string }>> = {}

  for (const entry of session.timeline) {
    if (entry.type !== type || !entry.editDetails) { continue }
    for (const detail of entry.editDetails) {
      if (!detail.filePath || !detail.oldString || !detail.newString) { continue }
      if (!fileEdits[detail.filePath]) { fileEdits[detail.filePath] = [] }
      fileEdits[detail.filePath].push({ old: detail.oldString, new: detail.newString })
    }
  }

  return fileEdits
}

/**
 * Walks a session's timeline and groups every (oldString, newString) edit pair by the file it
 * touched. Shared by detectEditRevertCycle below and by oneShotRate.ts's retry-rate metric — both
 * need the same "how many times, and how, was each file edited" data, just aggregated differently.
 *
 * For Claude Code, src/summarizers/claude.ts populates edit details in two places for the *same*
 * underlying tool call: on the 'llm' entry from the assistant's gen_ai.output.messages tool_use
 * blocks (primary source, only needs CLAUDE_CODE_ENHANCED_TELEMETRY_BETA), and separately on the
 * 'tool' entry from claude_code.tool span attributes (secondary source, needs
 * OTEL_LOG_TOOL_DETAILS). Reading both unconditionally would double-count every edit when both
 * telemetry flags are set. Instead: prefer 'llm' entries whenever any exist in the session, and
 * only fall back to 'tool' entries when the session has none — restricting to 'tool' only (the
 * original behavior here) silently dropped the primary source, reading zero edits for any session
 * that only had the former.
 */
export function getFileEditCounts(session: SessionSummaryCard): Record<string, Array<{ old: string; new: string }>> {
  const fromLlm = collectEditDetails(session, 'llm')
  if (Object.keys(fromLlm).length > 0) { return fromLlm }
  return collectEditDetails(session, 'tool')
}

// ── Detector 2: Edit-revert cycle ────────────────────────────────────────────

/**
 * Detects when a file is edited (A→B) and later reverted to its prior state
 * (B→A). Checks every pair of edits on the same file for exact string reversal.
 *
 * Critical only if at least one reverted file's revert was still its *final* edit when the session
 * ended — a revert followed by further edits to that file means the agent reconsidered and moved on,
 * not that it's still stuck. Downgraded to a warning otherwise: the pattern happened, but the
 * session recovered from it.
 *
 * Calibration check (scripts/calibrateSignals.ts): fired on only 5% of 236 sessions checked — a
 * real minority, not the near-universal firing exact_tool_repeat and runaway_steps had before their
 * own recalibration — so no threshold change made here. But only 11 fired sessions had a resolvable
 * outcome, too few to read a reliable bad-outcome rate off (result was noisy and close to
 * baseline). Left as-is rather than tuned off a sample that small; revisit via
 * runbooks/SIGNAL_CALIBRATION.md once more sessions accumulate.
 */
export function detectEditRevertCycle(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const fileEdits = getFileEditCounts(session)

  const revertedFiles: string[] = []
  let anyStillReverted = false

  for (const [file, edits] of Object.entries(fileEdits)) {
    if (edits.length < 2) { continue }
    const isRevert = (j: number): boolean => {
      for (let i = 0; i < j; i++) {
        if (edits[j].old === edits[i].new && edits[j].new === edits[i].old) { return true }
      }
      return false
    }
    // The final edit is checked on its own, not just "the first revert found": a file reverted
    // early on and then reverted AGAIN as its last edit is still stuck, and stopping at the first
    // match used to miss that.
    const last = edits.length - 1
    if (isRevert(last)) {
      revertedFiles.push(file)
      anyStillReverted = true
      continue
    }
    for (let j = 1; j < last; j++) {
      if (isRevert(j)) { revertedFiles.push(file); break }
    }
  }

  if (revertedFiles.length === 0) { return }

  signals.push({
    type: 'edit_revert_cycle',
    severity: anyStillReverted ? 'critical' : 'warning',
    evidence: `${revertedFiles.length} file(s) were edited then reverted to a prior state`,
    count: revertedFiles.length,
    examples: revertedFiles.slice(0, 3).map(f => f.split('/').pop() || f),
    patternName: PATTERN_NAMES.edit_revert_cycle,
    action: LOOP_SIGNAL_ACTIONS.edit_revert_cycle,
  })
}

// ── Detector 3: Error recurrence ─────────────────────────────────────────────

/**
 * Strips the specific patterns that make an otherwise-identical error message look unique each
 * time it recurs — a temp-file path, an ISO timestamp, a long hex id/hash. Deliberately does NOT
 * touch plain short numbers (line numbers, counts, error codes): those usually distinguish
 * genuinely different errors, and stripping them would trade one false-positive-merge problem
 * ("line 42" and "line 43" treated as the same error) for another.
 */
const DYNAMIC_TOKEN_PATTERN = /\/tmp\/\S+|\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b|\b[0-9a-f]{8,}\b/gi

function normalizeErrorMessage(msg: string): string {
  return msg.replace(DYNAMIC_TOKEN_PATTERN, '<var>')
}

/**
 * Groups error timeline entries by normalized errorMessage content. Falls back to tool label when
 * errorMessage is absent — but a label-fallback grouping can merge unrelated errors that happen to
 * share a tool (three different Bash failures, say), so it's inherently less certain than a real
 * errorMessage match and is capped below critical regardless of count.
 *
 * Thresholds: 3+ occurrences → warning, 5+ (with a real errorMessage match) → critical.
 */
export function detectErrorRecurrence(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const groups: Record<string, { count: number; example: string; fromFallback: boolean }> = {}
  for (const entry of session.timeline) {
    if (!entry.isError) { continue }
    const raw = (entry.errorMessage || entry.label || 'unknown error').trim()
    const fromFallback = !entry.errorMessage
    const key = normalizeErrorMessage(raw).slice(0, 200)
    if (!groups[key]) { groups[key] = { count: 0, example: raw.slice(0, 200), fromFallback } }
    groups[key].count++
    if (fromFallback) { groups[key].fromFallback = true }
  }

  const recurring = Object.entries(groups)
    .filter(([, g]) => g.count >= 3)
    .sort((a, b) => b[1].count - a[1].count)

  if (recurring.length === 0) { return }

  const top = recurring[0][1]
  signals.push({
    type: 'error_recurrence',
    severity: top.count >= 5 && !top.fromFallback ? 'critical' : 'warning',
    evidence: `${recurring.length} error(s) recurring 3+ times`,
    count: recurring.reduce((s, [, g]) => s + g.count, 0),
    examples: recurring.slice(0, 3).map(([, g]) => `"${g.example.slice(0, 60)}" ×${g.count}`),
    patternName: PATTERN_NAMES.error_recurrence,
    action: LOOP_SIGNAL_ACTIONS.error_recurrence,
  })
}

// ── Detector 4: Runaway steps ─────────────────────────────────────────────────

const COMPLEX_KEYWORDS = [
  'implement', 'refactor', 'build', 'design', 'migrate', 'convert',
  'rewrite', 'integrate', 'architect', 'scaffold', 'rework',
  // Debugging/investigation tasks are often exploration-heavy without touching many files (many
  // iterations against one stubborn file), so the files-touched behavioral override below doesn't
  // reliably catch them — they need to be recognized from the prompt text too.
  'debug', 'investigate', 'diagnose', 'root cause', 'flaky', 'intermittent',
]
const SIMPLE_KEYWORDS = [
  'fix typo', 'rename', 'delete', 'move file', 'add comment',
  'add line', 'update string', 'change message', 'add import',
]

// Calibrated against this project's own session history (scripts/calibrateSignals.ts, see
// runbooks/SIGNAL_CALIBRATION.md) after the original {15, 35, 80} fired on 56% of all 236 sessions
// checked (32% of *all* sessions at critical) with zero correlation to outcome (50% bad-outcome
// rate whether it fired or not, vs. a 49% baseline) — real agentic-coding sessions on this
// codebase run far more steps than these thresholds assumed (fired-session step count: p50=140,
// already exceeding even the old "complex" threshold). Scaled up ~3x across all three tiers so the
// thresholds mark genuine outliers rather than ordinary multi-file work. This is a coarse,
// order-of-magnitude correction, not a per-tier statistical fit (the underlying complexity
// classifier is still an uncalibrated keyword heuristic) — revisit as the corpus grows.
const STEP_THRESHOLDS = { simple: 45, medium: 110, complex: 250 } as const
type Complexity = keyof typeof STEP_THRESHOLDS

/**
 * Infers task complexity from the user request text and, when available,
 * behavioral signals (number of distinct files the agent touched).
 *
 * The optional session parameter enables behavioral calibration — sessions that
 * touched many files are upgraded to at least medium regardless of prompt text.
 */
export function inferTaskComplexity(
  request: string,
  session?: Pick<SessionSummaryCard, 'filesRead' | 'filesChanged' | 'filesSearched'>,
): Complexity {
  const lower = request.toLowerCase()

  // Behavioral signals override keyword matching when session data is available
  const filesAffected = session
    ? new Set([...session.filesRead, ...session.filesChanged, ...session.filesSearched]).size
    : 0

  if (filesAffected >= 8) { return 'complex' }
  if (filesAffected >= 4) { return 'medium' }

  // Keyword matching
  if (SIMPLE_KEYWORDS.some(k => lower.includes(k))) { return 'simple' }
  const complexMatches = COMPLEX_KEYWORDS.filter(k => lower.includes(k)).length
  if (request.length > 150 || complexMatches >= 2) { return 'complex' }
  if (complexMatches >= 1 || request.length > 80) { return 'medium' }

  // Very short requests with no domain keywords are simple
  if (request.length <= 20) { return 'simple' }
  return 'medium'
}

/**
 * Compares total steps (LLM calls + tool calls) against a complexity-aware
 * threshold. Complexity is inferred from both prompt text and session behavior.
 *
 * Thresholds: >threshold → warning, >2× threshold → critical.
 */
export function detectRunawaySteps(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const totalSteps = session.totalLlmCalls + session.totalToolCalls
  const complexity = inferTaskComplexity(session.userRequest || '', session)
  const threshold = STEP_THRESHOLDS[complexity]

  if (totalSteps <= threshold) { return }

  signals.push({
    type: 'runaway_steps',
    severity: totalSteps >= threshold * 2 ? 'critical' : 'warning',
    evidence: `${totalSteps} steps for a ${complexity} task (threshold: ${threshold})`,
    count: totalSteps,
    examples: [
      `${session.totalLlmCalls} LLM calls`,
      `${session.totalToolCalls} tool calls`,
      `"${(session.userRequest || '').slice(0, 60)}"`,
    ],
    patternName: PATTERN_NAMES.runaway_steps,
    action: LOOP_SIGNAL_ACTIONS.runaway_steps,
  })
}

// ── Detector 5: Token runaway ─────────────────────────────────────────────────

/**
 * Detects context accumulation without forward progress: input tokens growing
 * rapidly across turns while output tokens remain flat or decline.
 *
 * Requires at least 4 LLM calls to establish a trend.
 *
 * Triggers when input grew >15k tokens AND output ratio collapsed to <30% of
 * its starting value (a 70% drop is a strong signal of a stuck agent).
 *
 * A windowed/median baseline (first 2-3 calls instead of literally the first) was tried here to
 * guard against a single atypical opening exchange skewing the comparison, but the existing test
 * suite caught it doing more harm than good: in a genuine runaway, the 2nd/3rd calls are often
 * already mid-decline, so blending them into the baseline drags it down and suppresses detection
 * exactly when it should fire. Reverted to the literal first-call baseline rather than ship a
 * change proven worse by the tests already in place.
 *
 * Calibration check (scripts/calibrateSignals.ts, see runbooks/SIGNAL_CALIBRATION.md): fired on
 * only 4% of 236 sessions checked, and just 6 of those had a resolvable git outcome — far too few
 * to read a reliable bad-outcome rate off (the +1pp lift over baseline this run measured is noise,
 * not a verdict either way). Threshold left unchanged; revisit once the corpus is bigger.
 */
export function detectTokenRunaway(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const llmCalls = session.timeline.filter(
    e => e.type === 'llm' && (e.inputTokens ?? 0) > 0,
  )
  if (llmCalls.length < 4) { return }

  const inputs  = llmCalls.map(e => e.inputTokens  ?? 0)
  const outputs = llmCalls.map(e => e.outputTokens ?? 0)

  const inputGrowth = inputs[inputs.length - 1] - inputs[0]
  if (inputGrowth < 15000) { return }

  const earlyRatio = outputs[0] / Math.max(inputs[0], 1)
  const lateRatio  = outputs[outputs.length - 1] / Math.max(inputs[inputs.length - 1], 1)

  const ratioDrop = earlyRatio > 0.01 && lateRatio < earlyRatio * 0.3

  if (!ratioDrop) { return }

  signals.push({
    type: 'token_runaway',
    severity: inputGrowth > 50000 ? 'critical' : 'warning',
    evidence:
      `Input grew ${inputGrowth.toLocaleString()} tokens across ${llmCalls.length} LLM calls`
      + ` while output ratio collapsed (${(earlyRatio * 100).toFixed(1)}% → ${(lateRatio * 100).toFixed(1)}%)`,
    count: llmCalls.length,
    examples: [
      `First call: ${inputs[0].toLocaleString()} in → ${outputs[0].toLocaleString()} out`,
      `Last call:  ${inputs[inputs.length - 1].toLocaleString()} in → ${outputs[outputs.length - 1].toLocaleString()} out`,
    ],
    patternName: PATTERN_NAMES.token_runaway,
    action: LOOP_SIGNAL_ACTIONS.token_runaway,
  })
}

// ── Detector 6: Chronic tool failures ────────────────────────────────────────

// Below this, an occasional wrong path corrected along the way is normal exploratory behavior,
// not a reliability problem — the threshold needs to sit clearly above that ambient baseline.
// Still guessed at 20%/40%, not measured: scripts/calibrateSignals.ts (see
// runbooks/SIGNAL_CALIBRATION.md) found zero firings across 236 real sessions checked, so there's
// no data yet to confirm or correct this against — a threshold that never fires can't be
// validated by outcome correlation either way. Left unchanged; worth checking again once sessions
// with real tool-failure cascades show up in the corpus.
const CHRONIC_FAILURE_WARNING_RATE = 0.2
const CHRONIC_FAILURE_CRITICAL_RATE = 0.4
const CHRONIC_FAILURE_MIN_SAMPLE = 5

/**
 * Promoted from an ad-hoc frontend-only check in Insights.tsx. Unlike error_recurrence (which
 * only fires when the *same* error recurs 3+ times), this catches a session with many different
 * one-off tool failures — a real gap the recurrence-based detector can't see, since nothing here
 * has to repeat.
 *
 * Requires at least 5 tool calls before evaluating, so a 2-of-3 session doesn't read the same as
 * a 20-of-50 one.
 */
export function detectChronicToolFailures(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const toolEntries = session.timeline.filter(e => e.type === 'tool')
  if (toolEntries.length < CHRONIC_FAILURE_MIN_SAMPLE) { return }

  const failedByLabel: Record<string, number> = {}
  let failedCount = 0
  for (const entry of toolEntries) {
    if (!entry.isError) { continue }
    failedCount++
    const key = (entry.label || '').split(' ')[0] || 'unknown'
    failedByLabel[key] = (failedByLabel[key] || 0) + 1
  }
  if (failedCount === 0) { return }

  const rate = failedCount / toolEntries.length
  if (rate < CHRONIC_FAILURE_WARNING_RATE) { return }

  const topFailing = Object.entries(failedByLabel).sort((a, b) => b[1] - a[1])

  signals.push({
    type: 'chronic_tool_failures',
    severity: rate >= CHRONIC_FAILURE_CRITICAL_RATE ? 'critical' : 'warning',
    evidence: `${failedCount} of ${toolEntries.length} tool calls failed (${(rate * 100).toFixed(0)}%)`,
    count: failedCount,
    examples: topFailing.slice(0, 3).map(([tool, n]) => `${tool} ×${n}`),
    patternName: PATTERN_NAMES.chronic_tool_failures,
    action: LOOP_SIGNAL_ACTIONS.chronic_tool_failures,
  })
}

// ── Detector 7: Context flooding risk ────────────────────────────────────────

const LARGE_RESULT_CHARS = 10_000
const LARGE_RESULT_CRITICAL_KB = 300

/**
 * Promoted from an ad-hoc frontend-only check in Insights.tsx — same underlying threshold
 * (10,000 characters per result). Worth confirming during rollout whether fullResult is already
 * truncated somewhere upstream in the capture pipeline before this check runs on it; if so this
 * threshold needs to be checked against whatever that cap actually is.
 *
 * Calibration check (scripts/calibrateSignals.ts, see runbooks/SIGNAL_CALIBRATION.md): zero
 * firings across 236 real sessions checked — no data yet either way on whether 10,000 chars is the
 * right bar. Left unchanged; revisit if it turns out to be firing too rarely (or too often) once
 * real usage surfaces some examples.
 */
export function detectContextFloodingRisk(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const largeResults: Array<{ tool: string; size: number }> = []
  for (const entry of session.timeline) {
    if (entry.type !== 'tool' || !entry.fullResult) { continue }
    if (entry.fullResult.length <= LARGE_RESULT_CHARS) { continue }
    largeResults.push({ tool: (entry.label || '').split(' ')[0] || 'unknown', size: entry.fullResult.length })
  }
  if (largeResults.length === 0) { return }

  largeResults.sort((a, b) => b.size - a.size)
  const totalKb = largeResults.reduce((s, r) => s + r.size, 0) / 1024

  signals.push({
    type: 'context_flooding_risk',
    severity: totalKb >= LARGE_RESULT_CRITICAL_KB ? 'critical' : 'warning',
    evidence: `${largeResults.length} tool call(s) returned large results (${totalKb.toFixed(0)}KB total)`,
    count: largeResults.length,
    examples: largeResults.slice(0, 3).map(r => `${r.tool} (${(r.size / 1024).toFixed(1)}KB)`),
    patternName: PATTERN_NAMES.context_flooding_risk,
    action: LOOP_SIGNAL_ACTIONS.context_flooding_risk,
  })
}

// ── Detector 8: Tool-call cycle ──────────────────────────────────────────────
//
// .staged-issues/signal-catalog-01-tool-call-cycle.md. detectExactToolRepeat above only catches a
// literal repeated label (a length-1 streak); this catches a multi-step oscillation across 2-5
// distinct calls (run tests → read log → run tests → read log) that a length-1 streak, and edit_revert_cycle's
// single-file string reversal, both miss.

const TOOL_CYCLE_MIN_PERIOD = 2
const TOOL_CYCLE_MAX_PERIOD = 5
// Borrowed from Gemini CLI's own default (5 repeats before it declares a loop), not calibrated
// against this project's session history yet — see the SIGNAL_FORMULAS caveat above.
const TOOL_CYCLE_WARNING_REPEATS = 5
const TOOL_CYCLE_CRITICAL_REPEATS = 10

/** Length of the longest suffix of `seg` that repeats with the given period, expressed as a
 *  repeat count (period * repeats <= seg.length). Returns 0 if the tail isn't periodic at all. */
function periodicSuffixRepeats(seg: string[], period: number): number {
  if (seg.length < period) { return 0 }
  let matched = period
  for (let i = seg.length - period - 1; i >= 0; i--) {
    if (seg[i] === seg[i + period]) { matched++ } else { break }
  }
  return Math.floor(matched / period)
}

export function detectToolCallCycle(session: SessionSummaryCard, signals: LoopSignal[]): void {
  // Same segmentation as detectExactToolRepeat: any file edit is forward progress and resets
  // tracking, so a cycle is only ever measured within one edit-free run.
  const segments: string[][] = [[]]
  for (const entry of session.timeline) {
    if (entry.editDetails && entry.editDetails.length > 0) {
      segments.push([])
      continue
    }
    if (entry.type !== 'tool') { continue }
    const key = (entry.label || '').trim()
    if (!key) { continue }
    segments[segments.length - 1].push(`${key}\u0000${entry.fullResult ?? ''}`)
  }

  let best: { period: number; repeats: number; pattern: string[] } | null = null
  for (const seg of segments) {
    for (let period = TOOL_CYCLE_MIN_PERIOD; period <= TOOL_CYCLE_MAX_PERIOD; period++) {
      const repeats = periodicSuffixRepeats(seg, period)
      if (repeats < TOOL_CYCLE_WARNING_REPEATS) { continue }
      const pattern = seg.slice(-period)
      // A tail where every element in the period is identical is a length-1 streak wearing a
      // longer period's clothes — that's detectExactToolRepeat's signal, not this one.
      if (new Set(pattern).size < 2) { continue }
      if (!best || repeats * period > best.repeats * best.period) {
        best = { period, repeats, pattern }
      }
    }
  }
  if (!best) { return }

  signals.push({
    type: 'tool_call_cycle',
    severity: best.repeats >= TOOL_CYCLE_CRITICAL_REPEATS ? 'critical' : 'warning',
    evidence: `A ${best.period}-step tool-call sequence repeated ${best.repeats}+ times in a row with no edit in between`,
    count: best.repeats,
    examples: best.pattern.map(p => p.split('\u0000')[0].slice(0, 60)),
    patternName: PATTERN_NAMES.tool_call_cycle,
    action: LOOP_SIGNAL_ACTIONS.tool_call_cycle,
  })
}

// ── Detector 9: File reread ──────────────────────────────────────────────────
//
// .staged-issues/signal-catalog-02-file-reread.md. Keyed on resolved file path rather than the
// literal label, so a reread with a different line range (`read_file foo.ts L1-50` then
// `read_file foo.ts L40-90`) still counts — detectExactToolRepeat's literal-label match misses it.

const FILE_REREAD_WARNING_COUNT = 3
const FILE_REREAD_CRITICAL_COUNT = 6
const READ_TOOL_LABEL_PATTERN = /^(read_file|read|cat|view|show_file|show)\b/i

/** Best-effort path extraction: prefer a parsed JSON field from toolInput (real per-call data on
 *  OTel sources and OpenCode's log); fall back to stripping the tool-name token and any trailing
 *  line-range suffix off the label itself. Heuristic, not exhaustive — see the SIGNAL_FORMULAS
 *  caveat for this signal. */
function extractReadPath(entry: TimelineEntry): string | null {
  if (entry.toolInput) {
    try {
      const parsed = JSON.parse(entry.toolInput) as Record<string, unknown>
      for (const key of ['file_path', 'filePath', 'path', 'target_file', 'notebook_path']) {
        const v = parsed[key]
        if (typeof v === 'string' && v) { return v }
      }
    } catch { /* toolInput isn't JSON on this source — fall through to the label */ }
  }
  const label = (entry.label || '').trim()
  if (!label) { return null }
  const colonIdx = label.indexOf(':')
  const rest = colonIdx >= 0 ? label.slice(colonIdx + 1).trim() : label.replace(/^\S+\s*/, '')
  const withoutRange = rest.replace(/\s+L?\d+(-\d+)?$/i, '').trim()
  return withoutRange || null
}

export function detectFileReread(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const counts: Record<string, number> = {}
  const maxCounts: Record<string, number> = {}
  const sizeSamples: Record<string, number[]> = {}

  for (const entry of session.timeline) {
    if (entry.editDetails) {
      for (const d of entry.editDetails) {
        if (d.filePath) { counts[d.filePath] = 0 }
      }
    }
    if (entry.type !== 'tool') { continue }
    const label = (entry.label || '').trim()
    if (!READ_TOOL_LABEL_PATTERN.test(label)) { continue }
    const filePath = extractReadPath(entry)
    if (!filePath) { continue }
    counts[filePath] = (counts[filePath] || 0) + 1
    maxCounts[filePath] = Math.max(maxCounts[filePath] || 0, counts[filePath])
    const size = (entry.fullResult ?? entry.resultSummary ?? '').length
    if (size > 0) { (sizeSamples[filePath] ??= []).push(size) }
  }

  const reread = Object.entries(maxCounts)
    .filter(([, n]) => n >= FILE_REREAD_WARNING_COUNT)
    .sort((a, b) => b[1] - a[1])
  if (reread.length === 0) { return }

  // Price-weighted waste estimate (design principle: weight tokens by price, not raw count) —
  // approximates each avoidable reread's cost as its average captured result size, treated as
  // plain input tokens re-fed into context. Not a claim of cache-accounting precision.
  let avoidableTokens = 0
  for (const [path, n] of reread) {
    const samples = sizeSamples[path] || []
    const avgChars = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0
    avoidableTokens += Math.round((avgChars / 4) * (n - 1))
  }
  const wasteUsd = avoidableTokens > 0 ? calcAggregateTokenCostUsd(avoidableTokens, 0, 0, 0, session.model) : 0

  const topCount = reread[0][1]
  signals.push({
    type: 'file_reread',
    severity: topCount >= FILE_REREAD_CRITICAL_COUNT ? 'critical' : 'warning',
    evidence: `${reread.length} file(s) read ${FILE_REREAD_WARNING_COUNT}+ times with no write in between`
      + (wasteUsd > 0 ? ` (~$${wasteUsd.toFixed(3)} in avoidable rereads)` : ''),
    count: topCount,
    examples: reread.slice(0, 3).map(([path, n]) => `${path.split('/').pop() || path} ×${n}`),
    patternName: PATTERN_NAMES.file_reread,
    action: LOOP_SIGNAL_ACTIONS.file_reread,
  })
}

// ── Detector 10/11: Cache miss and TTL expiry ────────────────────────────────
//
// .staged-issues/signal-catalog-03-cache-and-ttl-signals.md. Claude Code's own /usage rule,
// applied per LLM call: a call counts as a miss when it re-processed more than 5% and at least
// 2,000 tokens of what it could have read from cache instead. TTL expiry is the subset of misses
// where the gap since the previous call exceeds the cache's TTL — a miss caused by waiting too
// long, not by a changed prompt.

const CACHE_MISS_MIN_SHARE = 0.05
const CACHE_MISS_MIN_TOKENS = 2000
const CACHE_MISS_CRITICAL_TOKENS = 10_000
// See the SIGNAL_FORMULAS caveat: this project has no per-session record of subscription vs.
// API-key auth, so there's no way to pick Claude Code's shorter 5-minute API TTL instead. The
// longer 1-hour subscription TTL is used everywhere as a deliberate choice to undercount real
// expiries rather than mislabel a still-live cache as expired.
const CACHE_TTL_MS = 60 * 60 * 1000

function isCacheMissEntry(e: TimelineEntry): boolean {
  const cacheCreate = e.cacheCreateTokens ?? 0
  const cacheRead = e.cacheReadTokens ?? 0
  // inputTokens is stored inclusive of cache reads/writes (see the summarizers), so the prompt
  // size is inputTokens itself — adding the cache fields on top would count them twice. max()
  // keeps this right for any source that reports inputTokens exclusive of cache instead.
  const totalPrefix = Math.max(e.inputTokens ?? 0, cacheCreate + cacheRead)
  return totalPrefix > 0 && cacheCreate >= CACHE_MISS_MIN_TOKENS && cacheCreate / totalPrefix > CACHE_MISS_MIN_SHARE
}

export function detectCacheMiss(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const llmCalls = session.timeline.filter(e => e.type === 'llm')
  // The first call on each model has nothing cached yet — writing its prefix to cache is the
  // cold start every session pays, not a miss. Caches are per-model, so a subagent or /model
  // switch gets its own cold first call too.
  const seenModels = new Set<string>()
  const misses = llmCalls.filter(e => {
    const model = e.model || session.model || ''
    const first = !seenModels.has(model)
    seenModels.add(model)
    return !first && isCacheMissEntry(e)
  })
  if (misses.length === 0) { return }

  const totalWasted = misses.reduce((s, e) => s + (e.cacheCreateTokens ?? 0), 0)
  // Waste = what writing this much to cache cost, minus what reading it back would have cost.
  const wasteUsd =
    calcAggregateTokenCostUsd(0, 0, totalWasted, 0, session.model) - calcAggregateTokenCostUsd(0, totalWasted, 0, 0, session.model)

  signals.push({
    type: 'cache_miss',
    severity: totalWasted >= CACHE_MISS_CRITICAL_TOKENS ? 'critical' : 'warning',
    evidence: `${misses.length} LLM call(s) re-wrote ${totalWasted.toLocaleString()} tokens of context that could plausibly have been read from cache instead`
      + (wasteUsd > 0 ? ` (~$${wasteUsd.toFixed(3)} wasted)` : ''),
    count: misses.length,
    examples: [`${totalWasted.toLocaleString()} cache-write tokens across ${misses.length} call(s)`],
    patternName: PATTERN_NAMES.cache_miss,
    action: LOOP_SIGNAL_ACTIONS.cache_miss,
  })
}

export function detectTtlExpiry(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const llmCalls = session.timeline.filter(e => e.type === 'llm')
  if (llmCalls.length < 2) { return }

  let prevTs: number | null = null
  const expiryGapsMs: number[] = []
  for (const e of llmCalls) {
    const ts = Date.parse(e.timestamp)
    if (isCacheMissEntry(e) && prevTs !== null && !Number.isNaN(ts) && ts - prevTs > CACHE_TTL_MS) {
      expiryGapsMs.push(ts - prevTs)
    }
    if (!Number.isNaN(ts)) { prevTs = ts }
  }
  if (expiryGapsMs.length === 0) { return }

  signals.push({
    type: 'ttl_expiry',
    severity: expiryGapsMs.length >= 3 ? 'critical' : 'warning',
    evidence: `${expiryGapsMs.length} cache miss(es) followed a gap longer than the cache's TTL (~${Math.round(CACHE_TTL_MS / 60_000)} min) — waiting too long, not a changed prompt`,
    count: expiryGapsMs.length,
    examples: expiryGapsMs.slice(0, 3).map(ms => `${Math.round(ms / 60_000)} min gap`),
    patternName: PATTERN_NAMES.ttl_expiry,
    action: LOOP_SIGNAL_ACTIONS.ttl_expiry,
  })
}

// ── Detector 12: Low cache hit ratio ─────────────────────────────────────────
//
// .staged-issues/signal-catalog-03-cache-and-ttl-signals.md. Promotes the session-level
// `cacheHitRate` already shown in the Cost tab from a number to an actual signal — same
// promotion pattern as chronic_tool_failures. Guarded by a minimum-activity floor: a source that
// never reports caching at all (Cursor, Copilot CLI/Chat) would otherwise read as a 0% hit ratio,
// which is "no data," not "poor caching."

const LOW_CACHE_HIT_MIN_ACTIVITY_TOKENS = 2000
const LOW_CACHE_HIT_WARNING_RATIO = 0.3
const LOW_CACHE_HIT_CRITICAL_RATIO = 0.1

export function detectLowCacheHitRatio(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const totalCacheActivity = session.cacheReadTokens + session.cacheCreateTokens
  if (totalCacheActivity < LOW_CACHE_HIT_MIN_ACTIVITY_TOKENS) { return }
  if (session.cacheHitRate >= LOW_CACHE_HIT_WARNING_RATIO) { return }

  signals.push({
    type: 'low_cache_hit_ratio',
    severity: session.cacheHitRate < LOW_CACHE_HIT_CRITICAL_RATIO ? 'critical' : 'warning',
    evidence: `Only ${(session.cacheHitRate * 100).toFixed(0)}% of this session's context came from cache`,
    count: Math.round(session.cacheHitRate * 100),
    examples: [
      `${session.cacheReadTokens.toLocaleString()} cache-read tokens`,
      `${session.cacheCreateTokens.toLocaleString()} cache-write tokens`,
    ],
    patternName: PATTERN_NAMES.low_cache_hit_ratio,
    action: LOOP_SIGNAL_ACTIONS.low_cache_hit_ratio,
  })
}

// ── Detector 13: Budget overrun ──────────────────────────────────────────────
//
// .staged-issues/signal-catalog-04-budget-and-tier-mismatch.md. Unlike every other threshold in
// this file, the right cap isn't derivable from this project's own session history — it's a
// dollar figure the user should set for themselves. No default cap ships; this stays a no-op
// until TRACEROOST_BUDGET_CAP_USD is set, so nobody starts seeing a new warning the moment this
// ships. SWE-agent's own default ($3/task) is a reference point, not applied automatically here.

function budgetCapUsd(): number {
  const raw = process.env['TRACEROOST_BUDGET_CAP_USD']
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function detectBudgetOverrun(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const cap = budgetCapUsd()
  if (cap <= 0) { return }

  // Same per-call/flat-fallback pricing as the stored cost_usd. (Previously priced the raw
  // inclusive inputTokens *plus* cache reads/writes again — double-counting cache — and applied
  // the long-context tier to the session's cumulative total.)
  const costUsd = calcSessionCostUsd(session)
  if (costUsd <= cap) { return }

  signals.push({
    type: 'budget_overrun',
    severity: costUsd >= cap * 2 ? 'critical' : 'warning',
    evidence: `Session cost ~$${costUsd.toFixed(2)} exceeded the configured $${cap.toFixed(2)} cap`,
    count: Math.round(costUsd * 100),
    examples: [`$${costUsd.toFixed(2)} total`, `cap: $${cap.toFixed(2)}`],
    patternName: PATTERN_NAMES.budget_overrun,
    action: LOOP_SIGNAL_ACTIONS.budget_overrun,
  })
}

// ── Detector 14: Model tier mismatch ─────────────────────────────────────────
//
// .staged-issues/signal-catalog-04-budget-and-tier-mismatch.md. Local-only (see toWireLoopSignal
// in src/cloud/forward/schema.ts) — this is a cost-optimization tip, not a loop/malfunction
// pattern, so it deliberately doesn't ship to cloud. "Premium" is derived from pricing.ts's own
// rate table rather than a hardcoded model-name list, so it tracks new models automatically.

const READ_ONLY_TOOL_LABEL_PATTERN = /^(read_file|read|cat|view|show_file|show|grep|search|glob|find|list|ls|get)\b/i
const TIER_MISMATCH_MIN_READ_ONLY_SHARE = 0.9
const TIER_MISMATCH_PREMIUM_INPUT_RATE_PER_MTOK = 3
const TIER_MISMATCH_MAX_AVG_OUTPUT_TOKENS = 300
const TIER_MISMATCH_MIN_TOOL_CALLS = 3

export function detectModelTierMismatch(session: SessionSummaryCard, signals: LoopSignal[]): void {
  if (session.filesChanged.length > 0) { return }

  const toolEntries = session.timeline.filter(e => e.type === 'tool')
  if (toolEntries.length < TIER_MISMATCH_MIN_TOOL_CALLS) { return }
  const readOnlyCount = toolEntries.filter(e => READ_ONLY_TOOL_LABEL_PATTERN.test((e.label || '').trim())).length
  if (readOnlyCount / toolEntries.length < TIER_MISMATCH_MIN_READ_ONLY_SHARE) { return }

  const rates = lookupRates(session.model)
  if (!rates || rates.inputPerMTok < TIER_MISMATCH_PREMIUM_INPUT_RATE_PER_MTOK) { return }

  const llmCalls = session.timeline.filter(e => e.type === 'llm')
  const avgOutput = llmCalls.length > 0
    ? llmCalls.reduce((s, e) => s + (e.outputTokens ?? 0), 0) / llmCalls.length
    : 0
  if (avgOutput > TIER_MISMATCH_MAX_AVG_OUTPUT_TOKENS) { return }

  signals.push({
    type: 'model_tier_mismatch',
    severity: 'warning',
    evidence: `A premium-tier model (${session.model}) ran ${readOnlyCount} of ${toolEntries.length} read-only tool calls with no edits and short output`,
    count: readOnlyCount,
    examples: [`model: ${session.model}`, `avg output: ${Math.round(avgOutput)} tokens/call`],
    patternName: PATTERN_NAMES.model_tier_mismatch,
    action: LOOP_SIGNAL_ACTIONS.model_tier_mismatch,
  })
}

