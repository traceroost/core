/**
 * Loop and malfunction detector for agent sessions.
 *
 * Detects 14 signal types that indicate an agent is stuck, spiraling, or working unreliably or
 * wastefully:
 *
 *   1. exact_tool_repeat     — the same tool call (same tool, same arguments — toolCallIdentity.ts) executed 30+ times with no edit in between
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
 * Signals 8-14 were added from the 2026-09-26 signal-catalog research pass (a gap analysis of
 * published agent-failure taxonomies against what was already built; the surviving signals and
 * their calibration procedure are runbooks/SIGNAL_CALIBRATION.md). Every threshold
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
import { calcAggregateTokenCostUsd, calcEntryCostUsd, calcSessionCostUsd, lookupRates } from './pricing'
import { signalStep, withSteps, fmtInt, editExcerpt, firstLine, plural } from './signalEvidence'
import type { SignalStep } from './types'
import { toolCallKey, describeToolCall } from './toolCallIdentity'

// ── Pattern taxonomy names ───────────────────────────────────────────────────

// Three names were plainer-ed on 2026-10-22 (owner's call, signal review): 'State Corruption
// Spiral' → 'Edit Reverted', 'Hallucination Amplification Loop' → 'Repeated Error', 'Infinite
// Loop — Context Accumulation' → 'Context Runaway'. Each old name promised more than its detector
// measures (one revert, three recurring errors, a ratio drop across four calls), and an alarm that
// overclaims on a session that shipped costs trust in the whole column. Help ids are unchanged.
export const PATTERN_NAMES: Record<LoopSignalType, string> = {
  exact_tool_repeat: 'Tool Call Deadlock',
  edit_revert_cycle: 'Edit Reverted',
  error_recurrence:  'Repeated Error',
  runaway_steps:     'Ambiguous Success / Escalating Scope',
  token_runaway:     'Context Runaway',
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
    'The context sent to the model is growing rapidly while useful output is declining — the agent is accumulating context without making forward progress. '
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
    'An edit imports a package that isn\'t listed in the project\'s package.json or requirements.txt and isn\'t installed — '
    + 'likely a made-up dependency that will fail at install or when the code runs. '
    + 'Verify the package actually exists and is spelled correctly before asking the agent to use it, or add it to package.json / requirements.txt yourself if it is intentional.',

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
    'A model call saved a meaningful share of its context to the cache again instead of reusing the stored copy, at real dollar cost. '
    + 'This usually means something near the start of the context changed — tool definitions, the system prompt, thinking/effort settings, or images. '
    + 'Keep those stable across turns in the same session where possible.',

  ttl_expiry:
    'Context was saved to the cache again after a pause long enough for the stored copy to expire — a timing effect, not a changed prompt. '
    + 'If turns in this session are naturally spaced out, the cache will not survive the gaps; there is no fix beyond accepting the extra cost or working in tighter bursts.',

  low_cache_hit_ratio:
    'Little of this session\'s context was reused from the cache; most of it was processed fresh. '
    + 'Check whether something near the start of the request changes turn to turn and invalidates the stored copy (see Avoidable Cache Miss), or whether the session is naturally short-lived and caching was never going to help much.',

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
// list. `prompt` is the one thing in this map addressed to the *agent* rather than the person: a
// paste-ready instruction the Insights panel's Copy button puts on the clipboard (with the
// trace's evidence under it) and the Help tab shows under "Tell the agent". `tip` and
// LOOP_SIGNAL_ACTIONS stay addressed to the person, who decides whether to paste it.
// `dataSource` is NOT "every entry reads from both, no source-gated branch" — that's true of
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
  { bullets: string[]; caveat?: string; short: string; tip: string; prompt: string; dataSource: 'otel' | 'both'; dataSourceNote: string }
> = {
  exact_tool_repeat: {
    bullets: [
      'Warning when the same tool is called with the same arguments (and gets the same result whenever both runs recorded one) 30+ times with no file edit in between. Other calls in between don’t reset the count.',
      'A call whose arguments weren’t recorded never counts as a repeat on its tool name alone: different Bash commands are different calls, not one call made many times.',
      'Critical at 50+ times.',
    ],
    caveat: 'Tuned on real sessions: 30 and 50 sit near the top of how long these repeats normally run.',
    short: 'The same tool call, with the same arguments, ran 30+ times with no edit in between.',
    tip: 'Stop it and try a different approach; repeating it won’t change the result.',
    prompt: 'You have called the same tool with the same arguments many times and the result has not changed. Stop repeating it. State what you learned from the last result, then take a different action or tell me what you are missing.',
    dataSource: 'both',
    dataSourceNote:
      'Needs each call’s arguments (OTel with tool details on, or OpenCode’s log) or its recorded result. A source that records only the tool name can’t show two calls were the same, so this never fires from it. Codex, Copilot CLI and Copilot Chat logs don’t record individual tool calls, so those agents need live OTel telemetry for this.',
  },
  edit_revert_cycle: {
    bullets: [
      'Warning when a later edit exactly undoes an earlier edit to the same file, putting the old text back.',
      'Critical only when that undo is the file’s last edit before the trace ended.',
    ],
    caveat: 'Fires rarely (about 1 session in 20), too rarely to tune further, so the threshold is still the original setting.',
    short: 'A later edit exactly undid an earlier one.',
    tip: 'Give the agent one clear final target instead of iterating.',
    prompt: 'You edited a file and then put it back the way it was. Before touching it again, tell me the two requirements you are trying to satisfy and why they conflict. Do not change the file until I say which one wins.',
    dataSource: 'both',
    dataSourceNote:
      'From log files, only Claude Code’s works. Never fires for Codex, from telemetry or logs, because Codex doesn’t record the before-and-after text of an edit.',
  },
  error_recurrence: {
    bullets: [
      'Warning when the same error message comes back 3+ times. Temp-file paths, timestamps and long IDs are ignored when comparing messages.',
      'Critical at 5+ times, but only when the error text itself matched. If no error text was recorded, failures are grouped by the tool call instead, and that never goes past a warning.',
    ],
    caveat: 'Experimental: the thresholds aren’t tuned on real sessions yet.',
    short: 'The same error came back 3+ times.',
    tip: 'Step in with the real fix; retrying isn’t solving it.',
    prompt: 'The same error has come back several times, so your fixes are not reaching the cause. Stop retrying. Quote the exact error, list what you have already tried, and tell me what you think the root cause is before changing anything else.',
    dataSource: 'otel',
    dataSourceNote:
      'Needs to know which tool calls failed, which Claude Code, Codex, Copilot CLI/Chat and Cursor logs don’t record. OpenCode’s log is the one exception; other agents need live OTel telemetry.',
  },
  runaway_steps: {
    bullets: [
      'Warning when turns plus tool calls go past a budget for the task’s size: 45 steps for a simple task, 110 for a medium one, 250 for a complex one. Size is judged from the prompt’s wording and how many files the trace touched.',
      'Critical at twice the budget.',
    ],
    caveat: 'Thresholds were raised about 3× after the originals fired on over half of sessions with no link to how the session actually went.',
    short: 'Far more steps than expected for a task this size.',
    tip: 'Break the task into smaller, explicitly scoped steps.',
    prompt: 'This task has taken far more steps than it should. Stop. Summarize what is done, what is left and what you are unsure about. Then finish only the original request; do not widen the scope without asking me first.',
    dataSource: 'both',
    dataSourceNote:
      'Works from every source: it only needs a trace’s total turns, tool calls and files, which every source records. The task-size guess is rougher on sources that don’t record file paths.',
  },
  token_runaway: {
    bullets: [
      'Warning when, across 4+ model calls, the tokens sent to the model grow by 15,000+ from the first call to the last, while the model’s output as a share of what it was sent drops below 30% of where it started.',
      'Critical when that growth passes 50,000 tokens.',
    ],
    caveat: 'Fires rarely (about 1 session in 25), too rarely to confirm how well it predicts trouble.',
    short: 'The context keeps growing while the model’s output shrinks.',
    tip: 'Start a fresh session instead of continuing this one.',
    prompt: 'Your context keeps growing but your output is not making progress. In five lines, summarize what you have learned and what remains. I will start a fresh session from that summary.',
    dataSource: 'both',
    dataSourceNote:
      'Works from Claude Code log files (less precisely: calls that also used a tool are undercounted) and from OpenCode’s log. Codex, Copilot CLI/Chat and Cursor logs don’t record tokens per call.',
  },
  chronic_tool_failures: {
    bullets: [
      'Warning when a trace makes at least 5 tool calls and 20%+ of them fail.',
      'Critical at 40%+.',
    ],
    caveat: 'Experimental: no real session has reached this threshold yet, so it isn’t tuned.',
    short: '20%+ of this trace’s tool calls failed.',
    tip: 'Double-check the paths and commands you gave the agent.',
    prompt: 'Many of your tool calls are failing. Before the next command, confirm the path or command exists (list the directory, or check which binary is installed), and say which package manager and runtime this project uses.',
    dataSource: 'otel',
    dataSourceNote:
      'Same gap as Repeated Error: needs to know which tool calls failed, which Claude Code, Codex, Copilot CLI/Chat and Cursor logs don’t record. OpenCode’s log is the one exception.',
  },
  context_flooding_risk: {
    bullets: [
      'Warning when any single tool result is over 10,000 characters (roughly 2,500 tokens).',
      'Critical once all such large results add up to 300 KB or more.',
    ],
    caveat: 'Experimental: no real session has reached this threshold yet, so it isn’t tuned.',
    short: 'A tool returned so much text that it crowds the context.',
    tip: 'Ask for narrower reads — line ranges, not whole files.',
    prompt: 'A tool result was far too large to keep in context. From now on read files with a line range, use narrower search patterns, and pipe long command output through head or a filter.',
    dataSource: 'otel',
    dataSourceNote:
      'Never fires for Claude Code, from telemetry or logs, because Claude Code doesn’t report the full size of a tool’s result. Works from Codex or Copilot OTel telemetry, or from OpenCode’s log.',
  },
  hallucinated_import: {
    bullets: [
      'Warning when an edit imports a package that isn’t listed in the project’s package.json or requirements.txt and isn’t installed (not found in node_modules). Built-in modules, the standard library and the project’s own modules don’t count.',
      'Checked once an edit is complete, not while the trace runs like most other signals in this list.',
    ],
    caveat: 'The best-validated signal so far: sessions where it fires end badly noticeably more often than average.',
    short: 'Imports a package that isn’t installed or listed as a dependency.',
    tip: 'Verify the package name exists before trusting this edit.',
    prompt: 'You imported a package that is not in this project\'s manifest and is not installed. Check the manifest and the installed packages before importing anything; if the package is missing, stop and ask me whether to add it.',
    dataSource: 'both',
    dataSourceNote:
      'From log files, only Claude Code’s works, for the same reason as Edit Reverted. Never fires for Codex, from telemetry or logs.',
  },
  failed_check_submission: {
    bullets: [
      'Warning when the trace’s last tool call ran a recognized test or build command and it failed: it reported an error, or its output says "fail" or "✗". A summary like "0 failed" or "no failures" doesn’t count, though a test whose name contains the word still can.',
      'Only the very last tool call is checked, so a failing check followed by more tool calls doesn’t trigger this.',
    ],
    caveat: 'Built to be precise rather than catch everything, so it rarely fires: few sessions run a check and then stop right after it fails.',
    short: 'The trace ended right after a failing test or build.',
    tip: 'Re-run the check and confirm it passes before merging.',
    prompt: 'The last test or build you ran failed and you stopped there. Re-run it, read the failure and fix it. Do not report the task as done until that check passes.',
    dataSource: 'otel',
    dataSourceNote:
      'Needs the tool’s output, which Claude Code, Codex, Copilot CLI/Chat and Cursor logs don’t record. OpenCode’s log is the one exception; other agents need live OTel telemetry.',
  },
  tool_call_cycle: {
    bullets: [
      'Warning when a sequence of 2 to 5 tool calls repeats 5+ times back to back, with the same calls (same tools with the same arguments, and the same results where recorded) each round and no file edit in between.',
      'Critical at 10+ rounds.',
    ],
    caveat: 'Experimental: not tuned on real sessions yet. The 5 and 10 cutoffs come from Gemini CLI’s own default.',
    short: 'A sequence of steps (e.g. run tests → read log → run tests → read log) repeated 5+ times.',
    tip: 'Explain what changed between attempts, or step in with the missing information.',
    prompt: 'You are repeating the same sequence of actions and getting the same result. Explain what changed between the last two attempts. If nothing did, stop and tell me what information you need from me.',
    dataSource: 'both',
    dataSourceNote:
      'Reads the same data as Tool Call Deadlock, so the same limits apply: works from Claude Code, OpenCode and Cursor log files. Codex, Copilot CLI and Copilot Chat logs don’t record individual tool calls.',
  },
  file_reread: {
    bullets: [
      'Warning when the same file is read 3+ times with no edit to it in between. Reads are matched by file path, so reading a different part of the file still counts.',
      'Critical at 6+ times.',
    ],
    caveat: 'Experimental: not tuned on real sessions yet. File paths are picked out of each call by a best guess, so some re-reads may be missed on agents that don’t report a clean path.',
    short: 'The same file was read 3+ times with no edit in between.',
    tip: 'Ask the agent to summarize what it already knows instead of rereading.',
    prompt: 'You have read the same file several times without editing it. Summarize what you already know about it and do not read it again unless you have changed it.',
    dataSource: 'otel',
    dataSourceNote:
      'Needs the file path of each read. From log files, only OpenCode’s records it. Claude Code’s log groups several tool calls into one entry without per-call paths, and Cursor’s log only counts tool calls by name.',
  },
  cache_miss: {
    bullets: [
      'Warning when a model call saves at least 2,000 tokens of context to the cache again, and that is more than 5% of everything it sent. (The cache keeps context the model has already processed, so later calls can reuse it for far less than saving it again costs.)',
      'A model’s first call doesn’t count: nothing is stored yet, so saving then is normal.',
      'Critical once the re-saved tokens reach 90,000 across the trace.',
    ],
    caveat: 'Tuned on real sessions. This is a cost signal, not a sign the session went wrong: sessions where it fires don’t end badly more often than others.',
    short: 'A call re-saved context to the cache instead of reusing the stored copy.',
    tip: 'Keep tools, the system prompt and thinking/effort settings unchanged mid-task; changing them forces a re-save.',
    prompt: 'Finish this task without changing model, effort or thinking settings, permission mode, or the set of MCP tools; each of those rebuilds the cached context and costs more than the work itself.',
    dataSource: 'both',
    dataSourceNote:
      'Needs cache token counts for each call, like Context Runaway: works from Claude Code log files (less precisely) and OpenCode’s log. Codex, Copilot CLI/Chat and Cursor logs don’t record them.',
  },
  ttl_expiry: {
    bullets: [
      'Warning when, more than 1 hour after the previous model call, a call re-saves at least 2,000 tokens and more than 5% of what it sent (the same test as Avoidable Cache Miss). By then the stored copy has expired.',
      'Critical at 3+ such pauses in one trace.',
    ],
    caveat: 'Experimental: not tuned on real sessions yet. It assumes a Claude Code subscription’s 1-hour cache lifetime, because TraceRoost can’t tell a subscription from an API key. With an API key the cache lasts only 5 minutes, so some expiries go unflagged, but a cache that’s still live is never called expired.',
    short: 'The cache expired during a long pause, so context was saved again.',
    tip: 'Work in tighter bursts, or accept the extra cost when turns are far apart.',
    prompt: 'There was a long pause and the cached context expired. Finish the remaining steps in one go rather than one at a time, and if you need my input, ask all your questions at once.',
    dataSource: 'both',
    dataSourceNote:
      'Same limits as Avoidable Cache Miss: needs cache token counts and times for each call. Works from Claude Code log files (less precisely) and OpenCode’s log; not from Codex, Copilot CLI/Chat or Cursor logs.',
  },
  low_cache_hit_ratio: {
    bullets: [
      'Warning when under 30% of the tokens sent to the model across the trace were reused from the cache.',
      'Only checked once the trace has 2+ turns (a single call has nothing to reuse yet) and at least 2,000 tokens saved to or reused from the cache (so a source that never reports caching isn’t mistaken for poor caching).',
      'Critical under 10%.',
    ],
    caveat: 'Experimental: the 30% and 10% cutoffs and the 2,000-token floor aren’t tuned on real sessions yet.',
    short: 'Little of this trace’s context was reused from the cache.',
    tip: 'Check what changes near the start of the context from turn to turn.',
    prompt: 'Little of your context is being served from cache. Keep the start of the conversation stable: do not change tools or settings mid-task, and batch your questions to me instead of asking one per turn.',
    dataSource: 'both',
    dataSourceNote:
      'Only needs a trace’s total cache counts, which every OTel source and the Claude Code and OpenCode log readers record. The 2,000-token floor exists because sources that never report caching (Cursor, Copilot CLI/Chat) would otherwise look like 0% reuse, and "no data" isn’t "nothing reused".',
  },
  budget_overrun: {
    bullets: [
      'Warning when the trace’s estimated cost goes over the budget you set. Each model call is priced at its own model’s rate where per-call token counts exist; otherwise the trace’s token totals are priced at flat rates.',
      'Critical at twice the budget.',
      'Off unless TRACEROOST_BUDGET_CAP_USD is set; there is no default budget.',
    ],
    caveat: 'There is no default budget to tune: the right limit is a dollar figure you choose for yourself (SWE-agent’s own default of $3 per task is one reference point).',
    short: 'The trace cost more than the budget you set.',
    tip: 'Check whether a loop or retry pattern elsewhere in this list is driving the cost.',
    prompt: 'This session has passed its cost budget. Stop and summarize what is done and what remains, with the smallest useful next step. Do not continue until I confirm.',
    dataSource: 'both',
    dataSourceNote:
      'Only needs a trace’s token totals and model, which every source records. The estimate is less precise on sources that don’t separate cached tokens cleanly.',
  },
  model_tier_mismatch: {
    bullets: [
      'Warning when no file was edited, at least 3 tool calls were made and 90%+ of them only read or searched (read, grep, search, list and similar), the model charges more than $3 per million tokens sent (Opus-class; Sonnet, at $3, doesn’t count), and replies averaged 300 tokens or fewer per model call.',
      'Never critical: this is a cost-saving tip, not a malfunction.',
    ],
    caveat: 'Experimental: none of the cutoffs (the 90% read-only share, the over-$3-per-million price line, the 300-token reply limit) are tuned on real sessions yet.',
    short: 'A premium model did read-only work with short replies.',
    tip: 'Send reading and searching to a smaller model.',
    prompt: 'This stretch was read-only research. For searching and reading, use a smaller model (in Claude Code, a subagent with model: haiku); use the main model only for turns that edit.',
    dataSource: 'both',
    dataSourceNote:
      'Needs the model and output tokens for each call, like Context Runaway: works from Claude Code log files (less precisely) and OpenCode’s log; not from Codex, Copilot CLI/Chat or Cursor logs.',
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
 * Counts repeats of the same tool call — the same tool with the same arguments, as toolCallKey()
 * (toolCallIdentity.ts) defines it. The label alone used to be the key, on the assumption it
 * encoded the arguments ("read_file types.ts L1-50"); on Claude Code's OTel spans it is the bare
 * tool name, so every `Bash` call in a session looked like one call repeated. An entry that
 * captured neither arguments nor a result has no identity and is never counted as a repeat.
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
  // `idx` holds the timeline positions of the current streak; `bestIdx` keeps the array of each
  // label's longest one (a new streak gets a fresh array, so a shorter later streak can't overwrite it).
  const streaks = new Map<string, { n: number; run: number; idx: number[] }>()
  const maxStreaks = new Map<string, number>()
  const bestIdx = new Map<string, number[]>()
  const lastResult = new Map<string, string | undefined>()
  const display = new Map<string, string>()
  let run = 0

  const timeline = session.timeline
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i]
    if (entry.editDetails && entry.editDetails.length > 0) { run++ }
    if (entry.type !== 'tool') { continue }
    const key = toolCallKey(entry)
    if (!key) { continue }
    if (!display.has(key)) { display.set(key, describeToolCall(entry)) }

    const prevResult = lastResult.get(key)
    const contentChanged = prevResult !== undefined && entry.fullResult !== undefined && entry.fullResult !== prevResult

    let streak = streaks.get(key)
    if (!contentChanged && streak && streak.run === run) {
      streak.n++
      streak.idx.push(i)
    } else {
      streak = { n: 1, run, idx: [i] }
      streaks.set(key, streak)
    }
    if (streak.n > (maxStreaks.get(key) || 0)) { bestIdx.set(key, streak.idx) }
    maxStreaks.set(key, Math.max(maxStreaks.get(key) || 0, streak.n))
    lastResult.set(key, entry.fullResult)
  }

  const repeated = Object.entries(toOrderedRecord(maxStreaks))
    .filter(([, n]) => n >= EXACT_REPEAT_WARNING_STREAK)
    .sort((a, b) => b[1] - a[1])

  if (repeated.length === 0) { return }

  const topCount = repeated[0][1]
  const steps: SignalStep[] = []
  for (const [label] of repeated.slice(0, 3)) {
    const idx = bestIdx.get(label) ?? []
    idx.forEach((i, k) => steps.push(signalStep(timeline, i, `identical call ${k + 1} of ${idx.length}`)))
  }
  signals.push({
    type: 'exact_tool_repeat',
    severity: topCount >= EXACT_REPEAT_CRITICAL_STREAK ? 'critical' : 'warning',
    evidence: `${plural(repeated.length, 'tool call')} made with the same arguments ${EXACT_REPEAT_WARNING_STREAK}+ times with no edit in between`,
    count: topCount,
    examples: repeated.slice(0, 3).map(([key, n]) => `"${(display.get(key) ?? key).slice(0, 60)}" ×${n}`),
    patternName: PATTERN_NAMES.exact_tool_repeat,
    action: LOOP_SIGNAL_ACTIONS.exact_tool_repeat,
    ...withSteps(steps,
      `The most repeated call, "${(display.get(repeated[0][0]) ?? repeated[0][0]).slice(0, 60)}", ran ${topCount} times with no file edit in between,`
      + ' getting the same result whenever one was recorded.'
      + ' Repeating a call that returns the same thing uses time and tokens without making progress.'
      + ` Flagged at ${EXACT_REPEAT_WARNING_STREAK} repeats; critical at ${EXACT_REPEAT_CRITICAL_STREAK}.`),
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

/** One edit pair, with `index` = the timeline position of the entry that made it. */
export interface FileEdit { old: string; new: string; index: number }

function collectEditDetails(session: SessionSummaryCard, type: 'llm' | 'tool'): Record<string, FileEdit[]> {
  const fileEdits: Record<string, FileEdit[]> = {}

  session.timeline.forEach((entry, index) => {
    if (entry.type !== type || !entry.editDetails) { return }
    for (const detail of entry.editDetails) {
      if (!detail.filePath || !detail.oldString || !detail.newString) { continue }
      if (!fileEdits[detail.filePath]) { fileEdits[detail.filePath] = [] }
      fileEdits[detail.filePath].push({ old: detail.oldString, new: detail.newString, index })
    }
  })

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
export function getFileEditCounts(session: SessionSummaryCard): Record<string, FileEdit[]> {
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
  const steps: SignalStep[] = []
  let anyStillReverted = false

  for (const [file, edits] of Object.entries(fileEdits)) {
    if (edits.length < 2) { continue }
    // The earlier edit that edits[j] exactly reverses, or -1.
    const revertedBy = (j: number): number => {
      for (let i = 0; i < j; i++) {
        if (edits[j].old === edits[i].new && edits[j].new === edits[i].old) { return i }
      }
      return -1
    }
    const name = file.split('/').pop() || file
    const record = (i: number, j: number, final: boolean): void => {
      steps.push(signalStep(session.timeline, edits[i].index, `edit to ${name}, later undone`, 'context',
        editExcerpt(edits[i].old, edits[i].new)))
      steps.push(signalStep(session.timeline, edits[j].index,
        `undoes the earlier edit to ${name}` + (final ? ' (its last edit in this trace)' : ''), 'trigger',
        editExcerpt(edits[j].old, edits[j].new)))
    }
    // The final edit is checked on its own, not just "the first revert found": a file reverted
    // early on and then reverted AGAIN as its last edit is still stuck, and stopping at the first
    // match used to miss that.
    const last = edits.length - 1
    const lastReverts = revertedBy(last)
    if (lastReverts >= 0) {
      revertedFiles.push(file)
      record(lastReverts, last, true)
      anyStillReverted = true
      continue
    }
    for (let j = 1; j < last; j++) {
      const i = revertedBy(j)
      if (i >= 0) { revertedFiles.push(file); record(i, j, false); break }
    }
  }

  if (revertedFiles.length === 0) { return }

  signals.push({
    type: 'edit_revert_cycle',
    severity: anyStillReverted ? 'critical' : 'warning',
    evidence: `${plural(revertedFiles.length, 'file')} had an edit undone by a later edit`,
    count: revertedFiles.length,
    examples: revertedFiles.slice(0, 3).map(f => f.split('/').pop() || f),
    patternName: PATTERN_NAMES.edit_revert_cycle,
    action: LOOP_SIGNAL_ACTIONS.edit_revert_cycle,
    ...withSteps(steps,
      `${plural(revertedFiles.length, 'file')} had an edit exactly undone by a later edit, which put the old text back.`
      + (anyStillReverted
        ? (revertedFiles.length === 1 ? ' The undo was the file’s last edit' : ' For at least one of them, the undo was its last edit')
          + ', so that change did not survive the trace.'
        : (revertedFiles.length === 1 ? ' The file was' : ' Each was') + ' edited again afterwards, so the agent moved on.')
      + ' Flagged on any exact undo; critical when the undo is the file’s last edit in the trace.'),
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
 * Groups error timeline entries by normalized errorMessage content. Falls back to the call itself
 * (describeToolCall: tool plus its identifying argument, `Bash: pnpm test`) when errorMessage is
 * absent — so three different failing commands are three groups, not one. When the arguments
 * weren't captured either, the fallback is the bare tool name and can still merge unrelated
 * errors that happen to share a tool, so a fallback grouping is inherently less certain than a
 * real errorMessage match and is capped below critical regardless of count.
 *
 * Thresholds: 3+ occurrences → warning, 5+ (with a real errorMessage match) → critical.
 */
export function detectErrorRecurrence(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const groups: Record<string, { count: number; example: string; fromFallback: boolean; idx: number[]; msgs: string[] }> = {}
  session.timeline.forEach((entry, i) => {
    if (!entry.isError) { return }
    const fromFallback = !entry.errorMessage
    const raw = (fromFallback ? describeToolCall(entry) : entry.errorMessage!).trim() || 'unknown error'
    const key = normalizeErrorMessage(raw).slice(0, 200)
    if (!groups[key]) { groups[key] = { count: 0, example: raw.slice(0, 200), fromFallback, idx: [], msgs: [] } }
    groups[key].count++
    groups[key].idx.push(i)
    groups[key].msgs.push(entry.errorMessage ? firstLine(entry.errorMessage) : '')
    if (fromFallback) { groups[key].fromFallback = true }
  })

  const recurring = Object.entries(groups)
    .filter(([, g]) => g.count >= 3)
    .sort((a, b) => b[1].count - a[1].count)

  if (recurring.length === 0) { return }

  const top = recurring[0][1]
  const steps: SignalStep[] = []
  // The trigger quotes the top error; the notes only repeat a message when several errors recur.
  for (const [, g] of recurring.slice(0, 3)) {
    const which = recurring.length > 1 ? `: "${g.example.slice(0, 50)}${g.example.length > 50 ? '…' : ''}"` : ''
    g.idx.forEach((i, k) => steps.push(signalStep(session.timeline, i, `occurrence ${k + 1} of ${g.count}${which}`, 'trigger', g.msgs[k])))
  }
  signals.push({
    type: 'error_recurrence',
    severity: top.count >= 5 && !top.fromFallback ? 'critical' : 'warning',
    evidence: `${plural(recurring.length, 'error')} came back 3+ times`,
    count: recurring.reduce((s, [, g]) => s + g.count, 0),
    examples: recurring.slice(0, 3).map(([, g]) => `"${g.example.slice(0, 60)}" ×${g.count}`),
    patternName: PATTERN_NAMES.error_recurrence,
    action: LOOP_SIGNAL_ACTIONS.error_recurrence,
    ...withSteps(steps,
      (top.fromFallback
        ? `"${top.example.slice(0, 100)}${top.example.length > 100 ? '…' : ''}" failed ${top.count} times.`
          + ' No error text was recorded, so the failures were matched by the call itself, and this stays a warning.'
        : `The same error appeared ${top.count} times: "${top.example.slice(0, 100)}${top.example.length > 100 ? '…' : ''}".`)
      + ' A recurring error usually means the fixes aren’t reaching its cause.'
      + ' Flagged at 3 repeats; critical at 5 when the error text itself matches.'),
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

  // The step counters are session totals; the timeline is walked separately to find where it
  // crossed the line. They can disagree (a source whose timeline is partial), in which case the
  // crossing just isn't marked rather than marked somewhere wrong.
  const timeline = session.timeline
  const steps: SignalStep[] = []
  let n = 0
  let crossedAt = -1
  let lastStep = -1
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].type !== 'llm' && timeline[i].type !== 'tool') { continue }
    n++
    lastStep = i
    if (n === threshold + 1) {
      crossedAt = i
      steps.push(signalStep(timeline, i, `step ${n} — first step past the ${threshold}-step budget for a ${complexity} task`))
    } else if (n === threshold * 2) {
      steps.push(signalStep(timeline, i, `step ${n} — twice the budget (critical)`))
    }
  }
  if (crossedAt >= 0 && lastStep > crossedAt) {
    steps.push(signalStep(timeline, lastStep, `step ${n} — the trace's last step`, 'context'))
  }
  const filesAffected = new Set([...session.filesRead, ...session.filesChanged, ...session.filesSearched]).size

  signals.push({
    type: 'runaway_steps',
    severity: totalSteps >= threshold * 2 ? 'critical' : 'warning',
    evidence: `${totalSteps} steps for a ${complexity} task (budget: ${threshold})`,
    count: totalSteps,
    examples: [
      plural(session.totalLlmCalls, 'turn'),
      plural(session.totalToolCalls, 'tool call'),
      `"${(session.userRequest || '').slice(0, 60)}"`,
    ],
    patternName: PATTERN_NAMES.runaway_steps,
    action: LOOP_SIGNAL_ACTIONS.runaway_steps,
    ...withSteps(steps,
      `This trace took ${totalSteps} steps (${plural(session.totalLlmCalls, 'turn')} and ${plural(session.totalToolCalls, 'tool call')}),`
      + ` against a budget of ${threshold} for a ${complexity} task.`
      + ` The task was judged ${complexity} from the prompt's wording and the ${plural(filesAffected, 'file')} it touched.`
      + ' That many steps often points to an unclear goal or a growing scope.'
      + ` Flagged past ${threshold} steps; critical at ${threshold * 2}.`),
    ...(crossedAt >= 0 && lastStep > crossedAt
      ? { range: { from: crossedAt, to: lastStep, note: `past the ${threshold}-step budget` } }
      : {}),
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
  const llmIdx: number[] = []
  session.timeline.forEach((e, i) => { if (e.type === 'llm' && (e.inputTokens ?? 0) > 0) { llmIdx.push(i) } })
  const llmCalls = llmIdx.map(i => session.timeline[i])
  if (llmCalls.length < 4) { return }

  const inputs  = llmCalls.map(e => e.inputTokens  ?? 0)
  const outputs = llmCalls.map(e => e.outputTokens ?? 0)

  const inputGrowth = inputs[inputs.length - 1] - inputs[0]
  if (inputGrowth < 15000) { return }

  const earlyRatio = outputs[0] / Math.max(inputs[0], 1)
  const lateRatio  = outputs[outputs.length - 1] / Math.max(inputs[inputs.length - 1], 1)

  const ratioDrop = earlyRatio > 0.01 && lateRatio < earlyRatio * 0.3

  if (!ratioDrop) { return }

  const pct = (out: number, inp: number): string => `${((out / Math.max(inp, 1)) * 100).toFixed(1)}%`
  const last = llmCalls.length - 1
  const steps: SignalStep[] = [
    signalStep(session.timeline, llmIdx[0],
      `first call: ${fmtInt(inputs[0])} tokens sent → ${fmtInt(outputs[0])} out (${pct(outputs[0], inputs[0])})`, 'context'),
    signalStep(session.timeline, llmIdx[last],
      `last call: ${fmtInt(inputs[last])} tokens sent → ${fmtInt(outputs[last])} out (${pct(outputs[last], inputs[last])})`),
  ]
  // The three calls whose context jumped most over the call before — where the growth came from.
  const jumps = inputs.slice(1).map((v, k) => ({ k: k + 1, d: v - inputs[k] })).filter(j => j.d > 0)
  jumps.sort((a, b) => b.d - a.d)
  for (const j of jumps.slice(0, 3)) {
    steps.push(signalStep(session.timeline, llmIdx[j.k], `context grew ${fmtInt(j.d)} tokens over the previous call`))
  }

  signals.push({
    type: 'token_runaway',
    severity: inputGrowth > 50000 ? 'critical' : 'warning',
    evidence:
      `Context grew ${inputGrowth.toLocaleString()} tokens across ${llmCalls.length} model calls`
      + ` while output fell from ${(earlyRatio * 100).toFixed(1)}% to ${(lateRatio * 100).toFixed(1)}% of what was sent`,
    count: llmCalls.length,
    examples: [
      `First call: ${inputs[0].toLocaleString()} tokens sent → ${outputs[0].toLocaleString()} out`,
      `Last call: ${inputs[inputs.length - 1].toLocaleString()} tokens sent → ${outputs[outputs.length - 1].toLocaleString()} out`,
    ],
    patternName: PATTERN_NAMES.token_runaway,
    action: LOOP_SIGNAL_ACTIONS.token_runaway,
    ...withSteps(steps,
      `The context sent to the model grew by ${fmtInt(inputGrowth)} tokens across ${plural(llmCalls.length, 'model call')}.`
      + ` Meanwhile the model's output fell from ${(earlyRatio * 100).toFixed(1)}% to ${(lateRatio * 100).toFixed(1)}% of what it was sent.`
      + ' The agent is carrying more and more context without producing more.'
      + ' Flagged when the context grows 15,000+ tokens over 4+ calls and that output share drops below 30% of where it started.'
      + ' Critical once the growth passes 50,000 tokens.'),
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
  const steps: SignalStep[] = []
  let failedCount = 0
  session.timeline.forEach((entry, i) => {
    if (entry.type !== 'tool' || !entry.isError) { return }
    failedCount++
    const key = (entry.label || '').split(' ')[0] || 'unknown'
    failedByLabel[key] = (failedByLabel[key] || 0) + 1
    const msg = entry.errorMessage ? firstLine(entry.errorMessage) : ''
    steps.push(signalStep(session.timeline, i, msg ? 'failed' : 'failed (no error message recorded)', 'trigger', msg))
  })
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
    ...withSteps(steps,
      `${failedCount} of ${toolEntries.length} tool calls failed (${(rate * 100).toFixed(0)}%).`
      + ' Frequent failures often mean wrong paths or commands that aren’t available, and each one costs a recovery turn.'
      + ` Flagged at ${CHRONIC_FAILURE_WARNING_RATE * 100}% once a trace has ${CHRONIC_FAILURE_MIN_SAMPLE}+ tool calls;`
      + ` critical at ${CHRONIC_FAILURE_CRITICAL_RATE * 100}%.`),
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
  const steps: SignalStep[] = []
  session.timeline.forEach((entry, i) => {
    if (entry.type !== 'tool' || !entry.fullResult) { return }
    if (entry.fullResult.length <= LARGE_RESULT_CHARS) { return }
    largeResults.push({ tool: (entry.label || '').split(' ')[0] || 'unknown', size: entry.fullResult.length })
    steps.push(signalStep(session.timeline, i,
      `returned ${fmtInt(entry.fullResult.length)} characters (~${fmtInt(entry.fullResult.length / 4)} tokens) into the context`,
      'trigger', 'begins: ' + firstLine(entry.fullResult)))
  })
  if (largeResults.length === 0) { return }

  largeResults.sort((a, b) => b.size - a.size)
  const totalKb = largeResults.reduce((s, r) => s + r.size, 0) / 1024

  signals.push({
    type: 'context_flooding_risk',
    severity: totalKb >= LARGE_RESULT_CRITICAL_KB ? 'critical' : 'warning',
    evidence: `${plural(largeResults.length, 'tool call')} returned large results (${totalKb.toFixed(0)} KB in all)`,
    count: largeResults.length,
    examples: largeResults.slice(0, 3).map(r => `${r.tool} (${(r.size / 1024).toFixed(1)}KB)`),
    patternName: PATTERN_NAMES.context_flooding_risk,
    action: LOOP_SIGNAL_ACTIONS.context_flooding_risk,
    ...withSteps(steps,
      `${plural(largeResults.length, 'tool result')} ${largeResults.length === 1 ? 'was' : 'were each'} over ${fmtInt(LARGE_RESULT_CHARS)} characters,`
      + ` ${totalKb.toFixed(0)} KB in all.`
      + ' Everything a tool returns stays in the context for later calls and crowds out other information.'
      + ` Flagged for any single result over ${fmtInt(LARGE_RESULT_CHARS)} characters; critical once they reach ${LARGE_RESULT_CRITICAL_KB} KB in all.`),
  })
}

// ── Detector 8: Tool-call cycle ──────────────────────────────────────────────
//
// Signal-catalog stage 01 (runbooks/SIGNAL_CALIBRATION.md). detectExactToolRepeat above only catches a
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
  // segIdx parallels segments: the timeline position of each call.
  const segments: string[][] = [[]]
  const segIdx: number[][] = [[]]
  const display = new Map<string, string>()
  session.timeline.forEach((entry, i) => {
    if (entry.editDetails && entry.editDetails.length > 0) {
      segments.push([])
      segIdx.push([])
      return
    }
    if (entry.type !== 'tool') { return }
    const key = toolCallKey(entry)
    if (!key) { return }
    display.set(key, describeToolCall(entry))
    segments[segments.length - 1].push(`${key}\u0001${entry.fullResult ?? ''}`)
    segIdx[segIdx.length - 1].push(i)
  })

  let best: { period: number; repeats: number; pattern: string[]; seg: number } | null = null
  for (let segN = 0; segN < segments.length; segN++) {
    const seg = segments[segN]
    for (let period = TOOL_CYCLE_MIN_PERIOD; period <= TOOL_CYCLE_MAX_PERIOD; period++) {
      const repeats = periodicSuffixRepeats(seg, period)
      if (repeats < TOOL_CYCLE_WARNING_REPEATS) { continue }
      const pattern = seg.slice(-period)
      // A tail where every element in the period is identical is a length-1 streak wearing a
      // longer period's clothes — that's detectExactToolRepeat's signal, not this one.
      if (new Set(pattern).size < 2) { continue }
      if (!best || repeats * period > best.repeats * best.period) {
        best = { period, repeats, pattern, seg: segN }
      }
    }
  }
  if (!best) { return }
  const found = best

  // The cycle is the segment's tail: its last period × repeats calls.
  const cycleIdx = segIdx[found.seg].slice(-(found.period * found.repeats))
  const steps = cycleIdx.map((i, k) => signalStep(session.timeline, i,
    `round ${Math.floor(k / found.period) + 1} of ${found.repeats}, step ${(k % found.period) + 1} of ${found.period}`))

  signals.push({
    type: 'tool_call_cycle',
    severity: best.repeats >= TOOL_CYCLE_CRITICAL_REPEATS ? 'critical' : 'warning',
    evidence: `A ${best.period}-step sequence of tool calls repeated ${best.repeats} times in a row with no edit in between`,
    count: best.repeats,
    examples: best.pattern.map(p => { const key = p.split('\u0001')[0]; return (display.get(key) ?? key).slice(0, 60) }),
    patternName: PATTERN_NAMES.tool_call_cycle,
    action: LOOP_SIGNAL_ACTIONS.tool_call_cycle,
    ...withSteps(steps,
      `The sequence ${found.pattern.map(p => { const key = p.split('\u0001')[0]; return (display.get(key) ?? key).slice(0, 40) }).join(' → ')} ran ${found.repeats} times back to back,`
      + ' with the same results each time (where recorded) and no file edit in between.'
      + ' The agent is reacting to the same feedback without changing its approach.'
      + ` Flagged at ${TOOL_CYCLE_WARNING_REPEATS} rounds; critical at ${TOOL_CYCLE_CRITICAL_REPEATS}.`),
  })
}

// ── Detector 9: File reread ──────────────────────────────────────────────────
//
// Signal-catalog stage 02 (runbooks/SIGNAL_CALIBRATION.md). Keyed on resolved file path rather than the
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
  // Timeline positions of each path's current write-free run of reads, and of its longest one.
  const runIdx: Record<string, number[]> = {}
  const bestIdx: Record<string, number[]> = {}

  session.timeline.forEach((entry, i) => {
    if (entry.editDetails) {
      for (const d of entry.editDetails) {
        if (d.filePath) { counts[d.filePath] = 0; runIdx[d.filePath] = [] }
      }
    }
    if (entry.type !== 'tool') { return }
    const label = (entry.label || '').trim()
    if (!READ_TOOL_LABEL_PATTERN.test(label)) { return }
    const filePath = extractReadPath(entry)
    if (!filePath) { return }
    counts[filePath] = (counts[filePath] || 0) + 1
    ;(runIdx[filePath] ??= []).push(i)
    if (counts[filePath] > (maxCounts[filePath] || 0)) { bestIdx[filePath] = runIdx[filePath] }
    maxCounts[filePath] = Math.max(maxCounts[filePath] || 0, counts[filePath])
    const size = (entry.fullResult ?? entry.resultSummary ?? '').length
    if (size > 0) { (sizeSamples[filePath] ??= []).push(size) }
  })

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
  const steps: SignalStep[] = []
  for (const [path] of reread.slice(0, 5)) {
    const idx = bestIdx[path] ?? []
    const name = path.split('/').pop() || path
    idx.forEach((i, k) => steps.push(signalStep(session.timeline, i,
      k === 0 ? `first read of ${name}` : `read ${name} again (${k + 1} of ${idx.length}), no edit since the first`,
      k === 0 ? 'context' : 'trigger')))
  }
  signals.push({
    type: 'file_reread',
    severity: topCount >= FILE_REREAD_CRITICAL_COUNT ? 'critical' : 'warning',
    evidence: `${plural(reread.length, 'file')} read ${FILE_REREAD_WARNING_COUNT}+ times with no edit in between`
      + (wasteUsd > 0 ? ` (~$${wasteUsd.toFixed(3)} spent re-reading)` : ''),
    count: topCount,
    examples: reread.slice(0, 3).map(([path, n]) => `${path.split('/').pop() || path} ×${n}`),
    patternName: PATTERN_NAMES.file_reread,
    action: LOOP_SIGNAL_ACTIONS.file_reread,
    ...withSteps(steps,
      `${reread[0][0].split('/').pop() || reread[0][0]} was read ${topCount} times with no edit to it in between`
      + (reread.length > 1
        ? `, and ${plural(reread.length - 1, 'other file')} ${FILE_REREAD_WARNING_COUNT} or more times${reread.length > 2 ? ' each' : ''}`
        : '') + '.'
      + ' Each re-read adds the file to the context again.'
      + ` Flagged at ${FILE_REREAD_WARNING_COUNT} reads without an edit; critical at ${FILE_REREAD_CRITICAL_COUNT}.`),
    ...(wasteUsd > 0 ? { wasteUsd } : {}),
  })
}

// ── Detector 10/11: Cache miss and TTL expiry ────────────────────────────────
//
// Signal-catalog stage 03 (runbooks/SIGNAL_CALIBRATION.md). Claude Code's own /usage rule,
// applied per LLM call: a call counts as a miss when it re-processed more than 5% and at least
// 2,000 tokens of what it could have read from cache instead. TTL expiry is the subset of misses
// where the gap since the previous call exceeds the cache's TTL — a miss caused by waiting too
// long, not by a changed prompt.

const CACHE_MISS_MIN_SHARE = 0.05
const CACHE_MISS_MIN_TOKENS = 2000
// Calibrated (2026-09-26, scripts/calibrateSignals.ts against 908 real sessions): the original
// 10,000-token critical bar was below the *median* fired session (p50=17,483), so 81% of firings
// (105 of 130) were marked critical regardless of severity — not a useful triage split. Raised to
// ~p90 of the real fired-session waste distribution (p50=17,483, p75=38,109, p90=94,834,
// p95=150,445, max=454,942) so critical marks the real tail again. See the SIGNAL_FORMULAS caveat
// for this signal's outcome-lift result — it doesn't predict bad outcomes (-7pp vs. baseline),
// consistent with this being a cost-efficiency signal, not a reliability one.
const CACHE_MISS_CRITICAL_TOKENS = 90_000
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

/** "re-saved 18,402 tokens to the cache (42% of the 43,800 tokens sent)". */
function cacheMissStep(timeline: TimelineEntry[], i: number, verb: string, lead = ''): SignalStep {
  const e = timeline[i]
  const cacheCreate = e.cacheCreateTokens ?? 0
  const prefix = Math.max(e.inputTokens ?? 0, cacheCreate + (e.cacheReadTokens ?? 0))
  return signalStep(timeline, i,
    `${lead}${verb} ${fmtInt(cacheCreate)} tokens to the cache (${Math.round((cacheCreate / Math.max(prefix, 1)) * 100)}% of the ${fmtInt(prefix)} tokens sent)`)
}

export function detectCacheMiss(session: SessionSummaryCard, signals: LoopSignal[]): void {
  // The first call on each model has nothing cached yet — writing its prefix to cache is the
  // cold start every session pays, not a miss. Caches are per-model, so a subagent or /model
  // switch gets its own cold first call too.
  const seenModels = new Set<string>()
  const missIdx: number[] = []
  session.timeline.forEach((e, i) => {
    if (e.type !== 'llm') { return }
    const model = e.model || session.model || ''
    const first = !seenModels.has(model)
    seenModels.add(model)
    if (!first && isCacheMissEntry(e)) { missIdx.push(i) }
  })
  const misses = missIdx.map(i => session.timeline[i])
  if (misses.length === 0) { return }

  const totalWasted = misses.reduce((s, e) => s + (e.cacheCreateTokens ?? 0), 0)
  // Waste = what writing this much to cache cost, minus what reading it back would have cost.
  const wasteUsd =
    calcAggregateTokenCostUsd(0, 0, totalWasted, 0, session.model) - calcAggregateTokenCostUsd(0, totalWasted, 0, 0, session.model)

  signals.push({
    type: 'cache_miss',
    severity: totalWasted >= CACHE_MISS_CRITICAL_TOKENS ? 'critical' : 'warning',
    evidence: `${plural(misses.length, 'model call')} re-saved ${totalWasted.toLocaleString()} tokens of context instead of reusing the cached copy`
      + (wasteUsd > 0 ? ` (~$${wasteUsd.toFixed(3)} extra)` : ''),
    count: misses.length,
    examples: [`${totalWasted.toLocaleString()} tokens re-saved across ${plural(misses.length, 'call')}`],
    patternName: PATTERN_NAMES.cache_miss,
    action: LOOP_SIGNAL_ACTIONS.cache_miss,
    ...withSteps(missIdx.map(i => cacheMissStep(session.timeline, i, 're-saved')),
      `${plural(misses.length, 'later model call')} saved ${fmtInt(totalWasted)} tokens of context to the model's cache again,`
      + ' where reusing the stored copy was likely possible.'
      + ' Saving to the cache costs much more than reusing from it.'
      + ` Flagged when a call re-saves at least ${fmtInt(CACHE_MISS_MIN_TOKENS)} tokens and more than ${CACHE_MISS_MIN_SHARE * 100}% of what it sends.`
      + " A model's first call doesn't count, since nothing is stored yet."
      + ` Critical once the total reaches ${fmtInt(CACHE_MISS_CRITICAL_TOKENS)} tokens.`),
    ...(wasteUsd > 0 ? { wasteUsd } : {}),
  })
}

export function detectTtlExpiry(session: SessionSummaryCard, signals: LoopSignal[]): void {
  const llmCalls = session.timeline.filter(e => e.type === 'llm')
  if (llmCalls.length < 2) { return }

  let prevTs: number | null = null
  let prevIdx = -1
  const expiryGapsMs: number[] = []
  const steps: SignalStep[] = []
  session.timeline.forEach((e, i) => {
    if (e.type !== 'llm') { return }
    const ts = Date.parse(e.timestamp)
    if (isCacheMissEntry(e) && prevTs !== null && !Number.isNaN(ts) && ts - prevTs > CACHE_TTL_MS) {
      const gapMin = Math.round((ts - prevTs) / 60_000)
      expiryGapsMs.push(ts - prevTs)
      steps.push(signalStep(session.timeline, prevIdx, `last call before a ${gapMin}-minute pause`, 'context'))
      steps.push(cacheMissStep(session.timeline, i, 're-saved', `${gapMin} minutes after the previous call; `))
    }
    if (!Number.isNaN(ts)) { prevTs = ts; prevIdx = i }
  })
  if (expiryGapsMs.length === 0) { return }

  signals.push({
    type: 'ttl_expiry',
    severity: expiryGapsMs.length >= 3 ? 'critical' : 'warning',
    evidence: `${plural(expiryGapsMs.length, 'model call')} re-saved the context after a pause of over ${Math.round(CACHE_TTL_MS / 60_000)} minutes`
      + ' (a timing effect, not a changed prompt)',
    count: expiryGapsMs.length,
    examples: expiryGapsMs.slice(0, 3).map(ms => `${Math.round(ms / 60_000)}-minute pause`),
    patternName: PATTERN_NAMES.ttl_expiry,
    action: LOOP_SIGNAL_ACTIONS.ttl_expiry,
    ...withSteps(steps,
      `${plural(expiryGapsMs.length, 'model call')} came after a pause of more than ${Math.round(CACHE_TTL_MS / 60_000)} minutes`
      + ' and saved the context to the cache again.'
      + ' The cache keeps it for about an hour, so the stored copy had likely expired.'
      + ` The longest pause was ${plural(Math.round(Math.max(...expiryGapsMs) / 60_000), 'minute')}.`
      + ` Flagged when a call after such a pause re-saves at least ${fmtInt(CACHE_MISS_MIN_TOKENS)} tokens`
      + ` and more than ${CACHE_MISS_MIN_SHARE * 100}% of what it sends. Critical at 3 or more such pauses.`),
  })
}

// ── Detector 12: Low cache hit ratio ─────────────────────────────────────────
//
// Signal-catalog stage 03 (runbooks/SIGNAL_CALIBRATION.md). Promotes the session-level
// `cacheHitRate` already shown in the Cost tab from a number to an actual signal — same
// promotion pattern as chronic_tool_failures. Guarded by a minimum-activity floor: a source that
// never reports caching at all (Cursor, Copilot CLI/Chat) would otherwise read as a 0% hit ratio,
// which is "no data," not "poor caching."

const LOW_CACHE_HIT_MIN_ACTIVITY_TOKENS = 2000
const LOW_CACHE_HIT_WARNING_RATIO = 0.3
const LOW_CACHE_HIT_CRITICAL_RATIO = 0.1

export function detectLowCacheHitRatio(session: SessionSummaryCard, signals: LoopSignal[]): void {
  // A session with one LLM call has nothing to read from cache yet — its only cache activity is
  // the cold-start write every session pays (the same exemption detectCacheMiss gives a model's
  // first call), so a 0% ratio there is the normal case, not poor caching.
  if (session.totalLlmCalls < 2) { return }
  const totalCacheActivity = session.cacheReadTokens + session.cacheCreateTokens
  if (totalCacheActivity < LOW_CACHE_HIT_MIN_ACTIVITY_TOKENS) { return }
  if (session.cacheHitRate >= LOW_CACHE_HIT_WARNING_RATIO) { return }

  // The session-level ratio has no single cause; the calls that re-processed the most input
  // without reading it from cache are where it went.
  const worst = session.timeline
    .map((e, i) => ({ e, i, uncached: Math.max(0, (e.inputTokens ?? 0) - (e.cacheReadTokens ?? 0)) }))
    .filter(x => x.e.type === 'llm' && x.uncached > 0)
    .sort((a, b) => b.uncached - a.uncached)
    .slice(0, 5)
  const steps = worst.map(({ e, i, uncached }) => signalStep(session.timeline, i,
    `${fmtInt(uncached)} of ${fmtInt(e.inputTokens ?? 0)} tokens sent were not reused from the cache`
    + ` (${Math.round(((e.cacheReadTokens ?? 0) / Math.max(e.inputTokens ?? 0, 1)) * 100)}% reused)`))

  signals.push({
    type: 'low_cache_hit_ratio',
    severity: session.cacheHitRate < LOW_CACHE_HIT_CRITICAL_RATIO ? 'critical' : 'warning',
    evidence: `Only ${(session.cacheHitRate * 100).toFixed(0)}% of this trace's context was reused from the cache`,
    count: Math.round(session.cacheHitRate * 100),
    examples: [
      `${session.cacheReadTokens.toLocaleString()} tokens reused from the cache`,
      `${session.cacheCreateTokens.toLocaleString()} tokens saved to the cache`,
    ],
    patternName: PATTERN_NAMES.low_cache_hit_ratio,
    action: LOOP_SIGNAL_ACTIONS.low_cache_hit_ratio,
    ...withSteps(steps,
      `Only ${(session.cacheHitRate * 100).toFixed(0)}% of the tokens sent to the model across ${plural(session.totalLlmCalls, 'turn')}`
      + ' were reused from the cache. The rest were processed fresh, at full price or more.'
      + ` Flagged under ${LOW_CACHE_HIT_WARNING_RATIO * 100}% once a trace has 2+ turns and at least ${fmtInt(LOW_CACHE_HIT_MIN_ACTIVITY_TOKENS)} tokens`
      + ` saved to or reused from the cache (this one had ${fmtInt(totalCacheActivity)}). Critical under ${LOW_CACHE_HIT_CRITICAL_RATIO * 100}%.`
      + (steps.length > 0 ? ' The calls below processed the most tokens fresh.' : '')),
  })
}

// ── Detector 13: Budget overrun ──────────────────────────────────────────────
//
// Signal-catalog stage 04 (runbooks/SIGNAL_CALIBRATION.md). Unlike every other threshold in
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

  const priciest = session.timeline
    .map((e, i) => ({ i, usd: e.type === 'llm' ? calcEntryCostUsd(e, session.model) : 0 }))
    .filter(x => x.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 5)
  const steps = priciest.map(({ i, usd }) => signalStep(session.timeline, i,
    `~$${usd.toFixed(2)} — ${Math.round((usd / costUsd) * 100)}% of the trace's cost`))

  signals.push({
    type: 'budget_overrun',
    severity: costUsd >= cap * 2 ? 'critical' : 'warning',
    evidence: `Trace cost ~$${costUsd.toFixed(2)}, over the $${cap.toFixed(2)} budget`,
    count: Math.round(costUsd * 100),
    examples: [`$${costUsd.toFixed(2)} total`, `budget: $${cap.toFixed(2)}`],
    patternName: PATTERN_NAMES.budget_overrun,
    action: LOOP_SIGNAL_ACTIONS.budget_overrun,
    ...withSteps(steps,
      `This trace cost about $${costUsd.toFixed(2)}, over the $${cap.toFixed(2)} budget set in TRACEROOST_BUDGET_CAP_USD.`
      + ` Flagged above the budget; critical at twice the budget ($${(cap * 2).toFixed(2)}).`
      + (steps.length > 0 ? ' The most expensive model calls are below.' : '')),
  })
}

// ── Detector 14: Model tier mismatch ─────────────────────────────────────────
//
// Signal-catalog stage 04 (runbooks/SIGNAL_CALIBRATION.md). Local-only (see toWireLoopSignal
// in src/cloud/forward/schema.ts) — this is a cost-optimization tip, not a loop/malfunction
// pattern, so it deliberately doesn't ship to cloud. "Premium" is derived from pricing.ts's own
// rate table rather than a hardcoded model-name list, so it tracks new models automatically.

const READ_ONLY_TOOL_LABEL_PATTERN = /^(read_file|read|cat|view|show_file|show|grep|search|glob|find|list|ls|get)\b/i
const TIER_MISMATCH_MIN_READ_ONLY_SHARE = 0.9
// Strictly above this rate counts as premium. Sonnet sits exactly at $3/M and is Claude Code's
// default model, so an inclusive bar flagged every no-edit question-and-answer session on it and
// offered only Haiku as the fix — the most-ignored signal in the list. Above $3 the signal means
// Opus-class (and the equivalent OpenAI tiers), where the same read-only stretch is a genuine
// several-fold overspend and the advice gets acted on (owner's decision, 2026-10-22).
const TIER_MISMATCH_PREMIUM_INPUT_RATE_PER_MTOK = 3
const TIER_MISMATCH_MAX_AVG_OUTPUT_TOKENS = 300
const TIER_MISMATCH_MIN_TOOL_CALLS = 3

export function detectModelTierMismatch(session: SessionSummaryCard, signals: LoopSignal[]): void {
  if (session.filesChanged.length > 0) { return }

  const toolEntries = session.timeline.filter(e => e.type === 'tool')
  if (toolEntries.length < TIER_MISMATCH_MIN_TOOL_CALLS) { return }
  const readOnlyIdx: number[] = []
  session.timeline.forEach((e, i) => {
    if (e.type === 'tool' && READ_ONLY_TOOL_LABEL_PATTERN.test((e.label || '').trim())) { readOnlyIdx.push(i) }
  })
  const readOnlyCount = readOnlyIdx.length
  if (readOnlyCount / toolEntries.length < TIER_MISMATCH_MIN_READ_ONLY_SHARE) { return }

  const rates = lookupRates(session.model)
  if (!rates || rates.inputPerMTok <= TIER_MISMATCH_PREMIUM_INPUT_RATE_PER_MTOK) { return }

  const llmCalls = session.timeline.filter(e => e.type === 'llm')
  const avgOutput = llmCalls.length > 0
    ? llmCalls.reduce((s, e) => s + (e.outputTokens ?? 0), 0) / llmCalls.length
    : 0
  if (avgOutput > TIER_MISMATCH_MAX_AVG_OUTPUT_TOKENS) { return }

  signals.push({
    type: 'model_tier_mismatch',
    severity: 'warning',
    evidence: `A premium model (${session.model}) did read-only work: ${readOnlyCount} of ${toolEntries.length} tool calls only read or searched,`
      + ' with no edits and short replies',
    count: readOnlyCount,
    examples: [`model: ${session.model}`, `average reply: ${plural(Math.round(avgOutput), 'token')} per call`],
    patternName: PATTERN_NAMES.model_tier_mismatch,
    action: LOOP_SIGNAL_ACTIONS.model_tier_mismatch,
    ...withSteps(readOnlyIdx.map(i => signalStep(session.timeline, i, `read-only call on ${session.model}`)),
      `${readOnlyCount} of ${toolEntries.length} tool calls only read or searched, and no file was edited.`
      + ` The model, ${session.model}, charges $${rates.inputPerMTok} per million tokens sent,`
      + ` and its replies averaged ${plural(Math.round(avgOutput), 'token')} per call.`
      + ' A cheaper model usually handles this kind of work as well.'
      + ` Flagged when nothing is edited, there are ${TIER_MISMATCH_MIN_TOOL_CALLS}+ tool calls, and at least ${TIER_MISMATCH_MIN_READ_ONLY_SHARE * 100}% of them are read-only.`
      + ` The model must also charge more than $${TIER_MISMATCH_PREMIUM_INPUT_RATE_PER_MTOK} per million tokens sent,`
      + ` with replies averaging ${TIER_MISMATCH_MAX_AVG_OUTPUT_TOKENS} tokens or fewer.`),
  })
}

