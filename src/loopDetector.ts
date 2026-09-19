/**
 * Loop and malfunction detector for agent sessions.
 *
 * Detects 7 signal types that indicate an agent is stuck, spiraling, or working unreliably:
 *
 *   1. exact_tool_repeat     — identical tool call (by label) executed 3+ times with no edit in between
 *   2. edit_revert_cycle     — a file was edited then reverted to a prior state
 *   3. error_recurrence      — the same error message appearing 3+ times
 *   4. runaway_steps         — too many steps relative to inferred task complexity
 *   5. token_runaway         — context growing rapidly while output stays flat/declines
 *   6. chronic_tool_failures — an unusually high share of tool calls in the session failed
 *   7. context_flooding_risk — a tool call returned a result too large for the model to use well
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
import type { GitOutcome } from './gitOutcome'

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
}

// ── Public API ───────────────────────────────────────────────────────────────

export function detectLoopSignals(session: SessionSummaryCard): LoopSignal[] {
  const signals: LoopSignal[] = []
  detectExactToolRepeat(session, signals)
  detectEditRevertCycle(session, signals)
  detectErrorRecurrence(session, signals)
  detectRunawaySteps(session, signals)
  detectTokenRunaway(session, signals)
  detectChronicToolFailures(session, signals)
  detectContextFloodingRisk(session, signals)
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
  const streaks: Record<string, number> = {}
  const maxStreaks: Record<string, number> = {}
  const lastResult: Record<string, string | undefined> = {}

  for (const entry of session.timeline) {
    if (entry.editDetails && entry.editDetails.length > 0) {
      for (const key of Object.keys(streaks)) { streaks[key] = 0 }
    }
    if (entry.type !== 'tool') { continue }
    const key = (entry.label || '').trim()
    if (!key) { continue }

    const prevResult = lastResult[key]
    const contentChanged = prevResult !== undefined && entry.fullResult !== undefined && entry.fullResult !== prevResult

    streaks[key] = contentChanged ? 1 : (streaks[key] || 0) + 1
    maxStreaks[key] = Math.max(maxStreaks[key] || 0, streaks[key])
    lastResult[key] = entry.fullResult
  }

  const repeated = Object.entries(maxStreaks)
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
    outer:
    for (let j = 1; j < edits.length; j++) {
      for (let i = 0; i < j; i++) {
        if (edits[j].old === edits[i].new && edits[j].new === edits[i].old) {
          revertedFiles.push(file)
          if (j === edits.length - 1) { anyStillReverted = true }
          break outer
        }
      }
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

