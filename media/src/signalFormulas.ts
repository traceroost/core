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
      'Warning when the same tool call (same tool and arguments, and the same result whenever both runs recorded one) runs 30+ times with no file edit in between. Other calls in between don’t reset the count.',
      'Critical at 50+ times.',
    ],
    caveat: 'Tuned on real sessions: 30 and 50 sit near the top of how long these repeats normally run.',
    short: 'The same tool call ran 30+ times with no edit in between.',
    tip: 'Stop it and try a different approach; repeating it won’t change the result.',
    prompt: 'You have called the same tool with the same arguments many times and the result has not changed. Stop repeating it. State what you learned from the last result, then take a different action or tell me what you are missing.',
    dataSource: 'both',
    dataSourceNote:
      'Works from Claude Code, OpenCode and Cursor log files. Codex, Copilot CLI and Copilot Chat logs don’t record individual tool calls, so those agents need live OTel telemetry for this.',
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
      'Warning when a sequence of 2 to 5 tool calls repeats 5+ times back to back, with the same calls (and the same results, where recorded) each round and no file edit in between.',
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

/** Renders a signal's bullets as the `<ul>` HTML string LoopBlock's `why` prop expects. */
export function formulaHtml(bullets: string[]): string {
  return `<ul class="glossary-def-list">${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>`
}
