import type { LoopSignalType } from './types'

// Hand-copied mirror of `SIGNAL_FORMULAS` in ../../src/loopDetector.ts — that file is the source
// of truth; keep this in sync with it by hand.
//
// Why a copy instead of a real import: this webview bundle (media/src/dashboard.tsx, bundled with
// esbuild's `platform: 'browser'`) is type-checked under media/tsconfig.json, whose `rootDir` is
// `media/src` — verified empirically (`tsc --noEmit -p media/tsconfig.json` against a throwaway
// `import { PATTERN_NAMES } from '../../src/loopDetector'` fails with TS6059, "File ... is not
// under 'rootDir'") because loopDetector.ts's own module graph (spanSummarizer.ts,
// summarizerTypes.ts, the per-agent summarizers) reaches well outside media/src. That's the same
// constraint signalIcons.tsx's LOOP_SIGNAL_ICON_TYPE already documents for
// src/cloud/forward/schema.ts's toWireLoopSignal — a hand-copy with a "keep in sync" comment, not
// a real import, is this codebase's existing answer to a webview needing extension-host-only data.
//
// `bullets` (one trigger condition per entry) renders as a real <ul> here and in Help.tsx's
// glossary. `short`/`tip` are the condensed one-line versions the Sessions.tsx hover tooltip uses
// instead — `short` restates the trigger, `tip` is what to actually do about it. `dataSource` is
// NOT "every entry reads from both" — several log sub-parsers never build a tool timeline at all,
// and several TimelineEntry fields these detectors need are populated by only a handful of
// sources, even under OTel. `dataSourceNote` states the real per-source gap. See the comment on
// this map in ../../src/loopDetector.ts for the full reasoning.
export const SIGNAL_FORMULAS: Record<
  LoopSignalType,
  { bullets: string[]; caveat?: string; short: string; tip: string; prompt: string; dataSource: 'otel' | 'both'; dataSourceNote: string }
> = {
  exact_tool_repeat: {
    bullets: [
      'Same tool call (same label, and same result when both occurrences captured one) repeated 30+ times in a row with no file edit in between → warning',
      '50+ → critical',
    ],
    caveat: 'Tuned on real sessions: the 30/50 cutoffs sit near the upper end of how long these streaks actually run.',
    short: 'Same tool call repeated 30+ times in a row with no edit.',
    tip: 'Stop it and change approach — repeating won’t change the result.',
    prompt: 'You have called the same tool with the same arguments many times and the result has not changed. Stop repeating it. State what you learned from the last result, then take a different action or tell me what you are missing.',
    dataSource: 'both',
    dataSourceNote:
      'Log-capable from Claude Code, OpenCode, and Cursor logs. Codex, Copilot CLI, and Copilot Chat logs never build a tool timeline at all — those need live OTel from that agent instead.',
  },
  edit_revert_cycle: {
    bullets: [
      'A file’s (old→new) edit is exactly reversed by a later edit on the same file → warning',
      'critical only if that revert was the file’s last edit before the session ended',
    ],
    caveat: 'Fires rarely (about 1 session in 20), too rarely to tune further, so the threshold is still the original setting.',
    short: 'A file’s edit was exactly undone by a later edit.',
    tip: 'Give the agent one clear final target instead of iterating.',
    prompt: 'You edited a file and then put it back the way it was. Before touching it again, tell me the two requirements you are trying to satisfy and why they conflict. Do not change the file until I say which one wins.',
    dataSource: 'both',
    dataSourceNote:
      'Log-capable only from Claude Code’s own log file. Never fires for Codex — from OTel or log — since Codex never records the old/new edit content this needs.',
  },
  error_recurrence: {
    bullets: [
      'The same error message (after stripping temp paths, timestamps, and hashes) recurs 3+ times → warning',
      '5+ times with a real error-message match (not a tool-label fallback) → critical',
    ],
    caveat: 'Experimental — thresholds not yet tuned on real sessions.',
    short: 'The same error message recurred 3+ times.',
    tip: 'Step in with the actual fix — retrying isn’t resolving it.',
    prompt: 'The same error has come back several times, so your fixes are not reaching the cause. Stop retrying. Quote the exact error, list what you have already tried, and tell me what you think the root cause is before changing anything else.',
    dataSource: 'otel',
    dataSourceNote:
      'Needs per-tool error status that Claude, Codex, Copilot CLI/Chat, and Cursor logs don’t capture. OpenCode’s log is the one exception.',
  },
  runaway_steps: {
    bullets: [
      'Total LLM + tool steps exceed a complexity-tiered threshold (simple 45 / medium 110 / complex 250 steps, complexity inferred from the prompt’s wording and how many files were touched) → warning',
      '2× that threshold → critical',
    ],
    caveat: 'Thresholds were raised about 3x after the originals fired on over half of sessions with no link to how the session actually went.',
    short: 'Far more steps than expected for a task this size.',
    tip: 'Break the task into smaller, explicitly scoped steps.',
    prompt: 'This task has taken far more steps than it should. Stop. Summarize what is done, what is left and what you are unsure about. Then finish only the original request; do not widen the scope without asking me first.',
    dataSource: 'both',
    dataSourceNote:
      'The one signal that’s genuinely source-agnostic — it only reads session-level step/file counts every source populates. Complexity inference is coarser on sources that don’t capture file paths.',
  },
  token_runaway: {
    bullets: [
      'Across 4+ LLM calls, input tokens grow 15,000+ while the output/input ratio collapses to under 30% of its first-call value → warning',
      'input growth over 50,000 tokens → critical',
    ],
    caveat: 'Fires rarely (about 1 session in 25), too rarely to confirm how well it predicts trouble.',
    short: 'Context is ballooning while output isn’t improving.',
    tip: 'Start a fresh session instead of continuing this one.',
    prompt: 'Your context keeps growing but your output is not making progress. In five lines, summarize what you have learned and what remains. I will start a fresh session from that summary.',
    dataSource: 'both',
    dataSourceNote:
      'Log-capable from Claude Code (degraded — undercounts calls that also used a tool) and OpenCode. Not available from Codex, Copilot CLI/Chat, or Cursor logs — none of those capture per-call token counts.',
  },
  chronic_tool_failures: {
    bullets: [
      'At least 5 tool calls are made in the session and 20%+ of them fail → warning',
      '40%+ → critical',
    ],
    caveat: 'Experimental — no real session has reached this threshold yet, so it isn’t tuned.',
    short: '20%+ of this session’s tool calls failed.',
    tip: 'Double-check the paths/commands you gave the agent.',
    prompt: 'Many of your tool calls are failing. Before the next command, confirm the path or command exists (list the directory, or check which binary is installed), and say which package manager and runtime this project uses.',
    dataSource: 'otel',
    dataSourceNote:
      'Same gap as error_recurrence: needs per-tool error status Claude, Codex, Copilot CLI/Chat, and Cursor logs don’t capture. OpenCode’s log is the one exception.',
  },
  context_flooding_risk: {
    bullets: [
      'Any single tool result exceeds 10,000 characters → warning',
      'the total across all such large results reaches 300KB or more → critical',
    ],
    caveat: 'Experimental — no real session has reached this threshold yet, so it isn’t tuned.',
    short: 'A tool result was too large and crowded out context.',
    tip: 'Ask for narrower reads — line ranges, not whole files.',
    prompt: 'A tool result was far too large to keep in context. From now on read files with a line range, use narrower search patterns, and pipe long command output through head or a filter.',
    dataSource: 'otel',
    dataSourceNote:
      'Never fires for Claude Code, from OTel or log, at any configuration level — Claude’s telemetry doesn’t capture full tool-result size. Works from Codex or Copilot OTel, or from OpenCode’s log.',
  },
  hallucinated_import: {
    bullets: [
      'An edit imports a package name that isn’t declared in the project’s manifest (package.json / requirements.txt) and doesn’t resolve on disk (node_modules, stdlib/builtins excluded) → warning',
      'Checked once an edit is complete, not mid-session like most of the other signals in this list',
    ],
    caveat: 'The best-validated signal so far: sessions where it fires end badly noticeably more often than average.',
    short: 'Imports a package that isn’t installed or declared.',
    tip: 'Verify the package name exists before trusting this edit.',
    prompt: 'You imported a package that is not in this project\'s manifest and is not installed. Check the manifest and the installed packages before importing anything; if the package is missing, stop and ask me whether to add it.',
    dataSource: 'both',
    dataSourceNote:
      'Log-capable only from Claude Code’s own log file — same reason as edit_revert_cycle. Never fires for Codex in either form.',
  },
  failed_check_submission: {
    bullets: [
      'The last tool call in the session invoked a recognized test/build runner and its result reads as a failure (an error status, or "fail"/"✗" in the output — a "0 failed" / "no failures" summary doesn\'t count, but a test *named* with the word still can), with nothing after it → warning',
      'Only the session’s very last tool call is checked, so a failing check followed by more edits does not trigger this',
    ],
    caveat: 'Built to be precise rather than catch everything, so it rarely fires: few sessions run a check and then stop right after it fails.',
    short: 'Session ended right after a failing test/build check.',
    tip: 'Re-run the check and confirm it passes before merging.',
    prompt: 'The last test or build you ran failed and you stopped there. Re-run it, read the failure and fix it. Do not report the task as done until that check passes.',
    dataSource: 'otel',
    dataSourceNote:
      'Needs captured tool output Claude, Codex, Copilot CLI/Chat, and Cursor logs don’t provide. OpenCode’s log is the one exception.',
  },
  tool_call_cycle: {
    bullets: [
      'A 2-to-5-step tool-call sequence (same labels, and same results when captured) repeats 5+ times in a row with no file edit in between → warning',
      '10+ repeats → critical',
    ],
    caveat: 'Experimental — thresholds not yet tuned on real sessions. The 5/10-repeat cutoffs are borrowed from Gemini CLI’s own default.',
    short: 'A multi-step sequence (e.g. edit → build → edit → build) repeated 5+ times.',
    tip: 'Explain what changed between attempts, or step in with the missing information.',
    prompt: 'You are repeating the same sequence of actions and getting the same result. Explain what changed between the last two attempts. If nothing did, stop and tell me what information you need from me.',
    dataSource: 'both',
    dataSourceNote:
      'Same fields as exact_tool_repeat (label + fullResult), so the same source constraint applies: log-capable from Claude Code, OpenCode, and Cursor logs. Codex, Copilot CLI, and Copilot Chat logs never build a tool timeline at all.',
  },
  file_reread: {
    bullets: [
      'The same file is read 3+ times with no write to it in between (matched by path, not literal call label, so a different line range still counts) → warning',
      '6+ times → critical',
    ],
    caveat: 'Experimental — thresholds not yet tuned on real sessions. File paths are detected heuristically, so some re-reads may be missed on agents that don’t report a clean path.',
    short: 'The same file was read 3+ times with no write in between.',
    tip: 'Ask the agent to summarize what it already knows instead of rereading.',
    prompt: 'You have read the same file several times without editing it. Summarize what you already know about it and do not read it again unless you have changed it.',
    dataSource: 'otel',
    dataSourceNote:
      'Needs a parseable per-call path (toolInput JSON, or a path embedded in the label). Log-capable only from OpenCode\'s log, which captures both. Claude Code\'s own log batches multiple tool calls into one message-level entry with no per-call path, so this can\'t fire from it; Cursor\'s log captures only tool name+count, not paths.',
  },
  cache_miss: {
    bullets: [
      'An LLM call re-writes 5%+ of its prefix as new cache-write tokens, and that re-written share is 2,000+ tokens → warning (the first call on each model is skipped — nothing is cached yet, so writing its prefix is the normal cold start, not a miss)',
      '90,000+ re-written tokens → critical',
    ],
    caveat: 'Tuned on real sessions. This is a cost signal, not a sign the session went wrong: sessions where it fires don’t end badly more often than others.',
    short: 'A call re-wrote context it could plausibly have read from cache.',
    tip: 'Keep tool definitions, system prompt, and thinking/effort settings stable across turns.',
    prompt: 'Finish this task without changing model, effort or thinking settings, permission mode, or the set of MCP tools; each of those rebuilds the cached context and costs more than the work itself.',
    dataSource: 'both',
    dataSourceNote:
      'Same per-call cache-token fields as token_runaway: log-capable from Claude Code (degraded) and OpenCode. Not available from Codex, Copilot CLI/Chat, or Cursor logs — none of those capture per-call cache-token counts.',
  },
  ttl_expiry: {
    bullets: [
      'A cache_miss (above) where the gap since the previous LLM call exceeds a 1-hour TTL → warning',
      '3+ such gaps in one session → critical',
    ],
    caveat: 'Experimental — not yet tuned on real sessions. It assumes the 1-hour cache lifetime of a Claude Code subscription, because TraceRoost can’t tell subscription from API-key use; an API-key session’s shorter 5-minute cache can expire without being flagged, but a still-live cache is never labeled expired.',
    short: 'A cache miss followed a gap longer than the cache\'s TTL.',
    tip: 'Work in tighter bursts, or accept the re-processing cost for spaced-out turns.',
    prompt: 'There was a long pause and the cached context expired. Finish the remaining steps in one go rather than one at a time, and if you need my input, ask all your questions at once.',
    dataSource: 'both',
    dataSourceNote:
      'Same constraint as cache_miss/token_runaway — needs per-call cache tokens and timestamps. Claude Code (degraded) and OpenCode logs; not Codex, Copilot CLI/Chat, or Cursor logs.',
  },
  low_cache_hit_ratio: {
    bullets: [
      'The session made 2+ LLM calls (a single call has nothing to read from cache yet), reports at least 2,000 combined cache-read + cache-write tokens (real cache activity, not just a source that never reports caching), and cache-read tokens are under 30% of the session’s total input tokens → warning',
      'under 10% → critical',
    ],
    caveat: 'Experimental — the 30%/10% cutoffs and the 2,000-token activity floor are not yet tuned on real sessions.',
    short: 'Little of this session\'s context came from cache.',
    tip: 'Check what\'s invalidating the cached prefix turn to turn.',
    prompt: 'Little of your context is being served from cache. Keep the start of the conversation stable: do not change tools or settings mid-task, and batch your questions to me instead of asking one per turn.',
    dataSource: 'both',
    dataSourceNote:
      'Reads only the session-level cache totals every OTel summarizer and the Claude Code / OpenCode log parsers already accumulate. The 2,000-token activity floor exists specifically because a source that never reports caching at all (Cursor, Copilot CLI/Chat) would otherwise read as a 0% hit ratio — "no data" is not "zero cache hits."',
  },
  budget_overrun: {
    bullets: [
      'Session cost (each LLM call priced at its own model’s rate where per-call tokens exist, otherwise the session’s token totals at flat rates) exceeds a configured cap → warning',
      '2× that cap → critical',
      'Disabled unless TRACEROOST_BUDGET_CAP_USD is set — there is no default cap',
    ],
    caveat: 'There is no default cap to tune: the right limit is a dollar figure you choose for yourself (SWE-agent’s own default of $3 per task is one reference point).',
    short: 'Session cost exceeded the configured budget cap.',
    tip: 'Check whether a loop or retry pattern elsewhere in this list is driving the cost.',
    prompt: 'This session has passed its cost budget. Stop and summarize what is done and what remains, with the smallest useful next step. Do not continue until I confirm.',
    dataSource: 'both',
    dataSourceNote:
      'Reads only session-level token totals and model, the same source-agnostic fields runaway_steps uses — every source populates these. Precision degrades wherever the underlying cost estimate does (sources that don\'t split cache buckets cleanly).',
  },
  model_tier_mismatch: {
    bullets: [
      'No file was edited this session, 3+ tool calls were made and 90%+ of them are read-only (grep/search/glob/list/read), the model\'s input rate is above $3/M tokens (Opus-class — Sonnet, at $3, does not count), and average output per LLM call is under 300 tokens → warning',
      'No critical tier — this is a cost-optimization tip, not a malfunction',
    ],
    caveat: 'Experimental — every cutoff here (the 90% read-only share, the above-$3/M input-rate line, the 300-token output ceiling) is not yet tuned on real sessions.',
    short: 'A premium-tier model ran a read-only, low-output stretch of 3+ tool calls.',
    tip: 'Route read/search-heavy turns to a smaller model.',
    prompt: 'This stretch was read-only research. For searching and reading, use a smaller model (in Claude Code, a subagent with model: haiku); use the main model only for turns that edit.',
    dataSource: 'both',
    dataSourceNote:
      'Needs per-call model tags and output tokens, the same constraint token_runaway has: log-capable from Claude Code (degraded) and OpenCode, not from Codex, Copilot CLI/Chat, or Cursor logs.',
  },
}

/** Renders a signal's bullets as the `<ul>` HTML string LoopBlock's `why` prop expects. */
export function formulaHtml(bullets: string[]): string {
  return `<ul class="glossary-def-list">${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>`
}
