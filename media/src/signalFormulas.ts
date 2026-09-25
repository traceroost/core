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
export const SIGNAL_FORMULAS: Record<LoopSignalType, { formula: string; caveat?: string }> = {
  exact_tool_repeat: {
    formula: 'Same tool call (same label, and same result when both occurrences captured one) repeated 30+ times in a row with no file edit in between → warning; 50+ → critical.',
    caveat: 'Threshold set from real session history: calibrated against 236 real sessions (the 30/50 cutoffs sit near the p75/p95 of the fired-session streak-length distribution).',
  },
  edit_revert_cycle: {
    formula: 'A file’s (old→new) edit is exactly reversed by a later edit on the same file → warning; critical only if that revert was the file’s last edit before the session ended.',
    caveat: 'Fired on only 5% of 236 sessions checked, and just 11 of those had a resolvable outcome — too few to calibrate further, so this threshold is left as originally set.',
  },
  error_recurrence: {
    formula: 'The same error message (after stripping temp paths, timestamps, and hashes) recurs 3+ times → warning; 5+ times with a real error-message match (not a tool-label fallback) → critical.',
    caveat: 'Not recalibrated against session history — these thresholds are the original guess.',
  },
  runaway_steps: {
    formula: 'Total LLM + tool steps exceed a complexity-tiered threshold (simple 45 / medium 110 / complex 250 steps, complexity inferred from the prompt’s wording and how many files were touched) → warning; 2× that threshold → critical.',
    caveat: 'Recalibrated roughly 3x upward after the original thresholds fired on 56% of sessions checked with no correlation to whether the session actually went well.',
  },
  token_runaway: {
    formula: 'Across 4+ LLM calls, input tokens grow 15,000+ while the output/input ratio collapses to under 30% of its first-call value → warning; input growth over 50,000 tokens → critical.',
    caveat: 'Fired on only 4% of 236 sessions checked, and just 6 of those had a resolvable outcome — too few to validate one way or the other.',
  },
  chronic_tool_failures: {
    formula: 'At least 5 tool calls are made in the session and 20%+ of them fail → warning; 40%+ → critical.',
    caveat: 'Threshold is a guess — no real session has crossed it yet during calibration checks (zero firings across 236 sessions), so it’s unconfirmed.',
  },
  context_flooding_risk: {
    formula: 'Any single tool result exceeds 10,000 characters → warning; the total across all such large results reaches 300KB or more → critical.',
    caveat: 'Threshold is a guess — no real session has crossed it yet during calibration checks (zero firings across 236 sessions), so it’s unconfirmed.',
  },
  hallucinated_import: {
    formula: 'An edit imports a package name that isn’t declared in the project’s manifest (package.json / requirements.txt) and doesn’t resolve on disk (node_modules, stdlib/builtins excluded) → warning. Checked once an edit is complete, not mid-session like the seven signals above.',
    caveat: 'The best-validated signal in the taxonomy so far: fired on 15% of 236 sessions checked, with a 64% bad-outcome rate among those vs. a 49% baseline (n=33 with a resolvable outcome).',
  },
  failed_check_submission: {
    formula: 'The last tool call in the session invoked a recognized test/build runner and its result reads as a failure (an error status, or "fail"/"✗" in the output), with nothing after it → warning. Only the session’s very last tool call is checked, so a failing check followed by more edits does not trigger this.',
    caveat: 'Precision-good, recall-poor by design — zero firings across 236 sessions checked, which may just reflect how rarely a session both runs a check and ends immediately after a failure, not miscalibration.',
  },
}
