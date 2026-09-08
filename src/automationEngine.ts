/**
 * Server-side port of the Automation feature's threshold evaluation, so MCP tools can check for
 * triggered corrections without going through the webview.
 *
 * This is a parallel implementation, not a shared import — media/src/tabs/Automation.tsx has its
 * own copy of this same logic (webview code can't import from src/, see media/tsconfig.json's
 * rootDir). Keep the two in sync by hand if the detection rules or defaults change (the existing
 * src/instructionAdvisor.ts / media/src/tabs/Instructions.tsx split follows the same pattern).
 *
 * Known simplification vs. the webview version: there is no server-side equivalent of the
 * per-user threshold customization stored in the browser's localStorage (traceRoost.automationConfigs,
 * traceRoost.agentProfiles) — this always evaluates against the same defaults shown in the
 * Settings panel until a user changes them there. Fired-trigger dedup is in-memory only and
 * resets on server restart.
 */

import type { SessionSummaryCard, TimelineEntry } from './summarizers/summarizerTypes'

// ── Agent profiles (mirrors media/src/agentProfiles.ts defaults) ───────────────

export type AgentSource = SessionSummaryCard['source']

interface AgentThresholdProfile {
  contextWindowTokens: number
  turnNudge: number
  identicalRepeatNudge: number
  consecutiveErrorNudge: number
}

type AgentThresholdProfiles = Record<AgentSource, AgentThresholdProfile>

const DEFAULT_AGENT_PROFILES: AgentThresholdProfiles = {
  claude_code: { contextWindowTokens: 200000, turnNudge: 80,  identicalRepeatNudge: 3, consecutiveErrorNudge: 3 },
  copilot:     { contextWindowTokens: 128000, turnNudge: 150, identicalRepeatNudge: 3, consecutiveErrorNudge: 3 },
  codex:       { contextWindowTokens: 400000, turnNudge: 250, identicalRepeatNudge: 4, consecutiveErrorNudge: 4 },
  opencode:    { contextWindowTokens: 200000, turnNudge: 80,  identicalRepeatNudge: 3, consecutiveErrorNudge: 3 },
}

function resolveAgentProfile(source: AgentSource | null | undefined): AgentThresholdProfile {
  if (source && DEFAULT_AGENT_PROFILES[source]) return DEFAULT_AGENT_PROFILES[source]
  return DEFAULT_AGENT_PROFILES.copilot
}

// ── Automation configs (mirrors media/src/tabs/Automation.tsx DEFAULT_AUTOMATION_CONFIGS) ──────

export type AutomationId = 'context_compaction' | 'loop_break' | 'error_cascade' | 'high_turns'

interface AutomationConfig {
  id: AutomationId
  label: string
  threshold: number // context_compaction only — the other three use per-agent profile thresholds
}

const DEFAULT_AUTOMATION_CONFIGS: AutomationConfig[] = [
  { id: 'context_compaction', label: 'Context Compaction', threshold: 140000 },
  { id: 'loop_break',         label: 'Loop Breaker',        threshold: 3 },
  { id: 'error_cascade',      label: 'Error Cascade Stop',  threshold: 3 },
  { id: 'high_turns',         label: 'Turn Limit Wrap-up',  threshold: 120 },
]

const HARD_STOP_IDENTICAL_TOOL_REPEATS = 8
const HARD_STOP_CONSECUTIVE_ERRORS = 8
const AUTOMATION_RECENCY_MS = 120_000 // only evaluate sessions with activity in the last 2 minutes

// ── Session-metric helpers (ported from media/src/sessionMetrics.ts) ───────────

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + stableJson(obj[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function normalizeToolInput(input: string | undefined): string {
  const raw = (input ?? '').trim()
  if (!raw) return ''
  try {
    return stableJson(JSON.parse(raw))
  } catch {
    return raw.replace(/\s+/g, ' ')
  }
}

function toolName(entry: TimelineEntry): string {
  return (entry.label ?? '').trim().split(/\s+/)[0] || 'tool'
}

function changesFiles(entry: TimelineEntry): boolean {
  if ((entry.editDetails ?? []).length > 0) return true
  const label = (entry.label ?? '').toLowerCase()
  return label.includes('write') || label.includes('edit') || label.includes('create_file')
}

function getIdenticalToolRepeat(timeline: TimelineEntry[]): { display: string; count: number } | null {
  const counts = new Map<string, { display: string; count: number; fileChangeGeneration: number }>()
  let best: { display: string; count: number } | null = null
  let fileChangeGeneration = 0
  for (const entry of timeline) {
    if (entry.type === 'tool') {
      const tool = toolName(entry)
      const normalizedInput = normalizeToolInput(entry.toolInput)
      const key = tool + '\n' + (normalizedInput || (entry.label ?? '').trim())
      const current = counts.get(key)
      const count = current && current.fileChangeGeneration === fileChangeGeneration ? current.count + 1 : 1
      const display = normalizedInput ? tool + ' ' + normalizedInput.slice(0, 90) : (entry.label ?? tool)
      counts.set(key, { display, count, fileChangeGeneration })
      if (count > 1 && (!best || count > best.count)) best = { display, count }
    }
    if (changesFiles(entry)) fileChangeGeneration++
  }
  return best
}

function getErrorHealth(timeline: TimelineEntry[], fallbackErrorCount: number): { maxConsecutive: number; errorCount: number; recentErrors: string[] } {
  const measured = timeline.filter(e => e.type === 'llm' || e.type === 'tool')
  let maxConsecutive = 0
  let current = 0
  let errorCount = 0
  const recentErrors: string[] = []
  for (const entry of measured) {
    if (entry.isError) {
      errorCount++
      current++
      maxConsecutive = Math.max(maxConsecutive, current)
      const msg = entry.errorMessage || entry.label
      if (msg) recentErrors.push(msg.slice(0, 140))
    } else {
      current = 0
    }
  }
  return { maxConsecutive, errorCount: Math.max(errorCount, fallbackErrorCount), recentErrors: recentErrors.slice(-3) }
}

function getPeakContextTokens(session: SessionSummaryCard, timeline: TimelineEntry[]): number {
  const llmInputs = timeline.filter(e => e.type === 'llm').map(e => e.inputTokens ?? 0).filter(n => n > 0)
  if (llmInputs.length > 0) return Math.max(...llmInputs)
  return session.totalLlmCalls > 0 ? Math.round((session.inputTokens ?? 0) / session.totalLlmCalls) : 0
}

// ── Evaluation ───────────────────────────────────────────────────────────────

interface AutomationEvaluation {
  triggered: boolean
  stage: 'nudge' | 'hard_stop'
  threshold: number
  unit: string
  evidence: string
}

function evaluateAutomation(cfg: AutomationConfig, session: SessionSummaryCard, timeline: TimelineEntry[]): AutomationEvaluation {
  const profile = resolveAgentProfile(session.source)
  switch (cfg.id) {
    case 'context_compaction': {
      const peakTokens = getPeakContextTokens(session, timeline)
      return {
        triggered: peakTokens >= cfg.threshold,
        stage: 'nudge',
        threshold: cfg.threshold,
        unit: 'tokens',
        evidence: `peak context ${peakTokens.toLocaleString()} tokens`,
      }
    }
    case 'loop_break': {
      const repeat = getIdenticalToolRepeat(timeline)
      const count = repeat?.count ?? 0
      const stage = count >= HARD_STOP_IDENTICAL_TOOL_REPEATS ? 'hard_stop' : 'nudge'
      return {
        triggered: count >= profile.identicalRepeatNudge,
        stage,
        threshold: stage === 'hard_stop' ? HARD_STOP_IDENTICAL_TOOL_REPEATS : profile.identicalRepeatNudge,
        unit: 'identical repeats',
        evidence: repeat
          ? `"${repeat.display}" repeated ${count} times without intervening file changes`
          : 'no identical tool repeat detected',
      }
    }
    case 'error_cascade': {
      const health = getErrorHealth(timeline, session.errors ?? 0)
      const stage = health.maxConsecutive >= HARD_STOP_CONSECUTIVE_ERRORS ? 'hard_stop' : 'nudge'
      return {
        triggered: health.maxConsecutive >= profile.consecutiveErrorNudge,
        stage,
        threshold: stage === 'hard_stop' ? HARD_STOP_CONSECUTIVE_ERRORS : profile.consecutiveErrorNudge,
        unit: 'consecutive errors',
        evidence: `${health.maxConsecutive} consecutive error(s), ${health.errorCount} total error(s)`,
      }
    }
    case 'high_turns': {
      const turns = session.totalLlmCalls ?? 0
      return {
        triggered: turns >= profile.turnNudge,
        stage: 'nudge',
        threshold: profile.turnNudge,
        unit: 'LLM turns',
        evidence: `${turns} LLM turn(s)`,
      }
    }
  }
}

function buildPrompt(cfg: AutomationConfig, session: SessionSummaryCard, timeline: TimelineEntry[], evaluation: AutomationEvaluation): string {
  const evidenceBlock = `Triggering evidence:
- Session: ${(session.userRequest ?? '').slice(0, 70) || '(trace in progress)'}
- Signal: ${evaluation.evidence}
- Threshold: ${evaluation.threshold.toLocaleString()} ${evaluation.unit}
`
  const hardStop = evaluation.stage === 'hard_stop'
  switch (cfg.id) {
    case 'context_compaction': {
      const peakTokens = getPeakContextTokens(session, timeline)
      return `${evidenceBlock}
Your conversation context is large — peak input is ${peakTokens.toLocaleString()} tokens, crossing the ${evaluation.threshold.toLocaleString()}-token threshold configured for this agent.

Please do the following right now:
1. Write a compact summary of: key decisions made, files changed, and what still needs to be done
2. Continue the task using only this summary as working context, discarding the detailed history

This will reduce token cost and prevent context window exhaustion.`
    }
    case 'loop_break': {
      const repeat = getIdenticalToolRepeat(timeline)
      const repeatedAction = repeat?.display ?? 'the same tool call'
      const count = repeat?.count ?? 0
      return `${hardStop ? 'HARD STOP.\n\n' : ''}${evidenceBlock}
You have repeated the identical tool call "${repeatedAction}" ${count} times in this session — this indicates a stuck loop.

Stop calling that tool with those arguments immediately and:
1. Explain what you were trying to accomplish with this tool
2. Describe why the repeated calls have not worked
3. Choose a completely different approach to reach the goal

${hardStop ? 'Do not make another tool call until you have written the diagnosis and a different plan.' : 'If you are genuinely blocked, ask for clarification rather than retrying the same action.'}`
    }
    case 'error_cascade': {
      const health = getErrorHealth(timeline, session.errors ?? 0)
      const recentErrors = health.recentErrors.map(e => `  - ${e}`).join('\n')
      return `${hardStop ? 'HARD STOP.\n\n' : ''}${evidenceBlock}
This session has hit ${health.maxConsecutive} consecutive error(s)${recentErrors ? `:\n${recentErrors}\n` : '. '}
Stop attempting the current approach and:
1. Identify the root cause of these repeated failures
2. Propose a different strategy before making any more tool calls
3. If you are blocked by missing information or permissions, say so explicitly

${hardStop ? 'Do not make another tool call until the root cause and new strategy are clear.' : 'Do not proceed until you have a clear reason to believe the next attempt will succeed.'}`
    }
    case 'high_turns': {
      const turns = session.totalLlmCalls ?? 0
      return `${evidenceBlock}
This session has made ${turns} LLM calls. Please assess where things stand:

1. Summarize what has been completed
2. List what remains to be done
3. Decide whether you can finish in a few more steps
4. If not, stop and explain what guidance or information is needed

Aim to reach a clear stopping point or completion within the next 2-3 steps.`
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface AutomationTrigger {
  automationId: AutomationId
  label: string
  sessionId: string
  sessionTitle: string
  agent: string
  prompt: string
  evidence: string
}

// In-memory dedup so repeated polling of an unresolved trigger doesn't keep re-surfacing the
// identical prompt. Process-lifetime only — resets on server restart, not persisted to disk.
const firedSet = new Set<string>()

/**
 * Evaluates the four built-in automations against a workspace's currently in-progress,
 * recently-active session(s), using default thresholds (see module doc comment for why these
 * can't reflect a user's in-app customization). Read-only — no notification, no file write.
 */
export function checkAutomationTriggers(
  sessions: SessionSummaryCard[],
  workspace: string,
  getTimeline: (sessionId: string) => TimelineEntry[],
): AutomationTrigger[] {
  const inProgress = sessions.filter(s =>
    s.outcome === 'unknown'
    && ((s.workspace ?? '') === workspace || s.workspace?.startsWith(workspace))
  )
  if (!inProgress.length) return []

  const now = Date.now()
  const triggers: AutomationTrigger[] = []

  for (const session of inProgress) {
    const timeline = getTimeline(session.sessionId)
    const lastEntry = timeline.length > 0 ? timeline[timeline.length - 1] : null
    const lastTs = lastEntry?.timestamp ?? session.startTime
    if (!lastTs) continue
    const tsNum = Date.parse(lastTs)
    if (!Number.isFinite(tsNum) || now - tsNum >= AUTOMATION_RECENCY_MS) continue

    for (const cfg of DEFAULT_AUTOMATION_CONFIGS) {
      const evaluation = evaluateAutomation(cfg, session, timeline)
      if (!evaluation.triggered) continue

      const key = `${cfg.id}:${session.sessionId}:${evaluation.stage}:${evaluation.threshold}`
      if (firedSet.has(key)) continue
      firedSet.add(key)

      const prompt = buildPrompt(cfg, session, timeline, evaluation)
      triggers.push({
        automationId: cfg.id,
        label: evaluation.stage === 'hard_stop' ? cfg.label + ' Hard Stop' : cfg.label,
        sessionId: session.sessionId,
        sessionTitle: (session.userRequest ?? '').slice(0, 70) || '(trace in progress)',
        agent: session.source ?? 'generic',
        prompt,
        evidence: evaluation.evidence,
      })
    }
  }

  return triggers
}
