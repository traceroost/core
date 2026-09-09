import { useState } from 'preact/hooks'
import { displaySessions } from '../state'
import {
  getErrorHealth,
  getIdenticalToolRepeat,
  getPeakContextUsage,
  sessionDisplayName,
} from '../sessionMetrics'
import {
  AgentThresholdInputs,
  AgentThresholdNumberInputs,
} from '../AgentThresholdInputs'
import {
  AGENT_ORDER,
  getAgentProfiles,
  resetAgentProfiles,
  resolveAgentProfile,
  saveAgentProfiles,
  type AgentProfileMetric,
  type AgentSource,
  type AgentThresholdProfiles,
} from '../agentProfiles'
import type { SessionSummaryCard } from '../types'

// ── Types ──────────────────────────────────────────────────────────────────────

type AgentThresholdMap = Record<AgentSource, number>

export interface AutomationConfig {
  id: string
  label: string
  severity: 'warning' | 'critical' | 'info'
  description: string
  enabled: boolean
  writePromptsFile: boolean
  threshold: number
  unit: string
  min: number
  max: number
  step: number
  agentThresholds?: AgentThresholdMap
}

export interface AutomationTrigger {
  automationId: string
  label: string
  writePromptsFile: boolean
  agent: string
  sessionTitle: string
  sessionId: string
  prompt: string
}

interface AutomationEvaluation {
  triggered: boolean
  stage: 'nudge' | 'hard_stop'
  metric: number
  threshold: number
  unit: string
  evidence: string
}

const HARD_STOP_IDENTICAL_TOOL_REPEATS = 8
const HARD_STOP_CONSECUTIVE_ERRORS = 8

// ── Defaults ───────────────────────────────────────────────────────────────────

export const DEFAULT_AUTOMATION_CONFIGS: AutomationConfig[] = [
  {
    id: 'context_compaction',
    label: 'Context Compaction',
    severity: 'warning',
    description: 'When a trace reaches the configured peak input-token threshold for that agent, prompt the agent to summarize and compact its context.',
    enabled: false,
    writePromptsFile: false,
    threshold: 140000,
    unit: 'tokens',
    min: 10000,
    max: 1000000,
    step: 1000,
    agentThresholds: { claude_code: 140000, copilot: 89600, codex: 280000, opencode: 140000 },
  },
  {
    id: 'loop_break',
    label: 'Loop Breaker',
    severity: 'critical',
    description: 'When the same tool with identical arguments repeats beyond the agent-specific threshold without file changes between repeats, prompt the agent to stop and choose a different approach. A hard-stop backstop fires at 8 repeats.',
    enabled: false,
    writePromptsFile: false,
    threshold: 3,
    unit: 'agent profile',
    min: 3,
    max: 8,
    step: 1,
  },
  {
    id: 'error_cascade',
    label: 'Error Cascade Stop',
    severity: 'critical',
    description: 'When a trace hits its agent-specific consecutive-error streak, prompt the agent to stop, diagnose the root cause, and change strategy. A hard-stop backstop fires at 8 consecutive errors.',
    enabled: false,
    writePromptsFile: false,
    threshold: 3,
    unit: 'agent profile',
    min: 2,
    max: 8,
    step: 1,
  },
  {
    id: 'high_turns',
    label: 'Turn Limit Wrap-up',
    severity: 'warning',
    description: 'When a trace reaches its agent-specific turn threshold, prompt the agent to summarize progress, merge check-in details, and work toward a stopping point.',
    enabled: false,
    writePromptsFile: false,
    threshold: 120,
    unit: 'agent profile',
    min: 20,
    max: 300,
    step: 10,
  },
]

// ── Persistence ────────────────────────────────────────────────────────────────

type SavedAutomationConfig = {
  id: string
  enabled?: boolean
  writePromptsFile?: boolean
  threshold?: number
  agentThresholds?: Partial<Record<AgentSource, number>>
}

function cloneAgentThresholds(thresholds?: AgentThresholdMap): AgentThresholdMap | undefined {
  if (!thresholds) return undefined
  return {
    claude_code: thresholds.claude_code,
    copilot: thresholds.copilot,
    codex: thresholds.codex,
    opencode: thresholds.opencode,
  }
}

function cloneAutomationConfig(config: AutomationConfig): AutomationConfig {
  return {
    ...config,
    agentThresholds: cloneAgentThresholds(config.agentThresholds),
  }
}

function fallbackAgentThresholds(threshold: number): AgentThresholdMap {
  return {
    claude_code: threshold,
    copilot: threshold,
    codex: threshold,
    opencode: threshold,
  }
}

function normalizeAgentThresholds(def: AutomationConfig, saved?: SavedAutomationConfig): AgentThresholdMap | undefined {
  const thresholds = cloneAgentThresholds(def.agentThresholds)
  if (!thresholds) return undefined

  const legacyThreshold = Number(saved?.threshold)
  if (
    !saved?.agentThresholds
    && Number.isFinite(legacyThreshold)
    && legacyThreshold >= def.min
    && legacyThreshold <= def.max
  ) {
    for (const source of AGENT_ORDER) {
      thresholds[source] = legacyThreshold
    }
  }

  for (const source of AGENT_ORDER) {
    const value = Number(saved?.agentThresholds?.[source])
    if (Number.isFinite(value) && value >= def.min && value <= def.max) {
      thresholds[source] = value
    }
  }
  return thresholds
}

function getConfigAgentThresholds(cfg: AutomationConfig): AgentThresholdMap {
  return cloneAgentThresholds(cfg.agentThresholds) ?? fallbackAgentThresholds(cfg.threshold)
}

function getAutomationAgentThreshold(cfg: AutomationConfig, source: AgentSource): number {
  return cfg.agentThresholds?.[source] ?? cfg.threshold
}

export function getAutomationConfigs(): AutomationConfig[] {
  try {
    const stored = localStorage.getItem('traceRoost.automationConfigs')
    if (!stored) return DEFAULT_AUTOMATION_CONFIGS.map(cloneAutomationConfig)
    const saved = JSON.parse(stored) as SavedAutomationConfig[]
    return DEFAULT_AUTOMATION_CONFIGS.map(def => {
      const s = saved.find(x => x.id === def.id)
      if (!s) return cloneAutomationConfig(def)
      const savedThreshold = Number(s.threshold)
      const threshold = savedThreshold >= def.min && savedThreshold <= def.max ? savedThreshold : def.threshold
      return {
        ...cloneAutomationConfig(def),
        enabled: typeof s.enabled === 'boolean' ? s.enabled : def.enabled,
        writePromptsFile: typeof s.writePromptsFile === 'boolean' ? s.writePromptsFile : def.writePromptsFile,
        threshold,
        agentThresholds: normalizeAgentThresholds(def, s),
      }
    })
  } catch {
    return DEFAULT_AUTOMATION_CONFIGS.map(cloneAutomationConfig)
  }
}

function saveAutomationConfigs(configs: AutomationConfig[]): void {
  try {
    localStorage.setItem('traceRoost.automationConfigs',
      JSON.stringify(configs.map(c => ({
        id: c.id,
        enabled: c.enabled,
        writePromptsFile: c.writePromptsFile,
        threshold: c.threshold,
        agentThresholds: c.agentThresholds,
      })))
    )
  } catch { /* ignore */ }
}

function hasSharedThreshold(cfg: AutomationConfig): boolean {
  return cfg.id === 'context_compaction'
}

function automationProfileMetrics(cfg: AutomationConfig): AgentProfileMetric[] {
  switch (cfg.id) {
    case 'high_turns':
      return ['turnNudge']
    case 'loop_break':
      return ['identicalRepeatNudge']
    case 'error_cascade':
      return ['consecutiveErrorNudge']
    default:
      return []
  }
}

// ── Prompt generation ──────────────────────────────────────────────────────────

function buildPrompt(
  id: string,
  session: SessionSummaryCard,
  _cfg: AutomationConfig,
  evaluation: AutomationEvaluation,
  profiles: AgentThresholdProfiles
): string {
  const evidenceBlock = `Triggering evidence:
- Session: ${sessionDisplayName(session)}
- Signal: ${evaluation.evidence}
- Threshold: ${evaluation.threshold.toLocaleString()} ${evaluation.unit}
`
  switch (id) {
    case 'context_compaction': {
      const usage = getPeakContextUsage(session, profiles)
      return `${evidenceBlock}
Your conversation context is large — peak input is ${usage.peakTokens.toLocaleString()} tokens, crossing the ${evaluation.threshold.toLocaleString()}-token threshold configured for this agent.

Please do the following right now:
1. Write a compact summary of: key decisions made, files changed, and what still needs to be done
2. Continue the task using only this summary as working context, discarding the detailed history

This will reduce token cost and prevent context window exhaustion.`
    }
    case 'loop_break': {
      const repeat = getIdenticalToolRepeat(session)
      const repeatedAction = repeat?.display ?? 'the same tool call'
      const count = repeat?.count ?? evaluation.metric
      const hardStop = evaluation.stage === 'hard_stop'
      return `${hardStop ? 'HARD STOP.\n\n' : ''}${evidenceBlock}
You have repeated the identical tool call "${repeatedAction}" ${count} times in this session — this indicates a stuck loop.

Stop calling that tool with those arguments immediately and:
1. Explain what you were trying to accomplish with this tool
2. Describe why the repeated calls have not worked
3. Choose a completely different approach to reach the goal

${hardStop ? 'Do not make another tool call until you have written the diagnosis and a different plan.' : 'If you are genuinely blocked, ask for clarification rather than retrying the same action.'}`
    }
    case 'error_cascade': {
      const health = getErrorHealth(session)
      const recentErrors = health.recentErrors.map(e => `  - ${e}`).join('\n')
      const hardStop = evaluation.stage === 'hard_stop'
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
    default: return ''
  }
}

// ── Automation evaluation (called from App.tsx on every update) ────────────────

// Tracks which session+automation combos have already fired, to prevent re-firing
// within the same threshold-crossing stage. Key: `${automationId}:${sessionId}:${stage}:${threshold}`
const firedSet = new Set<string>()

export function getInProgressSessions(sessions: SessionSummaryCard[]): SessionSummaryCard[] {
  return sessions.filter(s => s.outcome === 'unknown')
}

function evaluateAutomation(cfg: AutomationConfig, session: SessionSummaryCard, profiles: AgentThresholdProfiles): AutomationEvaluation {
  const profile = resolveAgentProfile(session.source, profiles)
  switch (cfg.id) {
    case 'context_compaction': {
      const usage = getPeakContextUsage(session, profiles)
      const threshold = getAutomationAgentThreshold(cfg, session.source)
      return {
        triggered: usage.peakTokens >= threshold,
        stage: 'nudge',
        metric: usage.peakTokens,
        threshold,
        unit: 'tokens',
        evidence: 'peak context ' + usage.peakTokens.toLocaleString() + ' tokens',
      }
    }
    case 'loop_break': {
      const repeat = getIdenticalToolRepeat(session)
      const count = repeat?.count ?? 0
      const stage = count >= HARD_STOP_IDENTICAL_TOOL_REPEATS ? 'hard_stop' : 'nudge'
      return {
        triggered: count >= profile.identicalRepeatNudge,
        stage,
        metric: count,
        threshold: stage === 'hard_stop' ? HARD_STOP_IDENTICAL_TOOL_REPEATS : profile.identicalRepeatNudge,
        unit: 'identical repeats',
        evidence: repeat
          ? '"' + repeat.display + '" repeated ' + count + ' times without intervening file changes'
          : 'no identical tool repeat detected',
      }
    }
    case 'error_cascade': {
      const health = getErrorHealth(session)
      const stage = health.maxConsecutive >= HARD_STOP_CONSECUTIVE_ERRORS ? 'hard_stop' : 'nudge'
      return {
        triggered: health.maxConsecutive >= profile.consecutiveErrorNudge,
        stage,
        metric: health.maxConsecutive,
        threshold: stage === 'hard_stop' ? HARD_STOP_CONSECUTIVE_ERRORS : profile.consecutiveErrorNudge,
        unit: 'consecutive errors',
        evidence: health.maxConsecutive + ' consecutive error(s), '
          + health.errorCount + ' total error(s)',
      }
    }
    case 'high_turns': {
      const turns = session.totalLlmCalls ?? 0
      return {
        triggered: turns >= profile.turnNudge,
        stage: 'nudge',
        metric: turns,
        threshold: profile.turnNudge,
        unit: 'LLM turns',
        evidence: turns + ' LLM turn(s)',
      }
    }
    default:
      return { triggered: false, stage: 'nudge', metric: 0, threshold: 0, unit: '', evidence: '' }
  }
}

const AUTOMATION_RECENCY_MS = 120_000

export function checkAutomations(sessions: SessionSummaryCard[]): AutomationTrigger[] {
  if (!sessions.length) return []
  const configs = getAutomationConfigs()
  const profiles = getAgentProfiles()
  const triggers: AutomationTrigger[] = []
  const allInProgress = getInProgressSessions(sessions)
  if (!allInProgress.length) return []

  // Only evaluate sessions with activity in the last 2 minutes.
  // This guards against historical sessions firing when the display filter expands.
  const now = Date.now()
  const active = allInProgress.filter(s => {
    const lastEntry = s.timeline && s.timeline.length > 0 ? s.timeline[s.timeline.length - 1] : null
    const lastTs = lastEntry?.timestamp ?? s.startTime
    if (!lastTs) return false
    const tsNum = typeof lastTs === 'number' ? lastTs : Date.parse(lastTs)
    return now - tsNum < AUTOMATION_RECENCY_MS
  })

  const activeKeys = new Set<string>()
  const visibleSessionKeys = new Set(active.map(s => s.traceId ?? s.sessionId))

  for (const cfg of configs) {
    if (!cfg.enabled) continue

    for (const session of active) {
      const evaluation = evaluateAutomation(cfg, session, profiles)
      if (!evaluation.triggered) continue
      const sessionKey = session.traceId ?? session.sessionId
      const stageThreshold = evaluation.stage === 'hard_stop' ? 'hard' : String(evaluation.threshold)
      const key = `${cfg.id}:${sessionKey}:${evaluation.stage}:${stageThreshold}`
      activeKeys.add(key)
      if (!firedSet.has(key)) {
        firedSet.add(key)
        const body = buildPrompt(cfg.id, session, cfg, evaluation, profiles)
        if (!body) continue

        triggers.push({
          automationId: cfg.id,
          label: evaluation.stage === 'hard_stop' ? cfg.label + ' Hard Stop' : cfg.label,
          writePromptsFile: cfg.writePromptsFile,
          agent: session.source ?? 'generic',
          sessionTitle: (session.userRequest ?? '').slice(0, 70) || '(trace in progress)',
          sessionId: session.sessionId,
          prompt: body,
        })
      }
    }
  }

  // Only remove fired keys for sessions that are currently visible AND no longer triggered.
  // Keys for sessions outside the current display filter are preserved — otherwise expanding
  // the filter would cause already-resolved conditions to re-fire.
  for (const key of Array.from(firedSet)) {
    if (activeKeys.has(key)) continue
    // Parse session key from key format: cfgId:sessionKey:stage:threshold
    const firstColon = key.indexOf(':')
    const rest = key.slice(firstColon + 1)
    const secondColon = rest.indexOf(':')
    const sessionKey = rest.slice(0, secondColon)
    if (visibleSessionKeys.has(sessionKey)) {
      firedSet.delete(key)
    }
  }

  return triggers
}

// ── UI ─────────────────────────────────────────────────────────────────────────

export function Automation() {
  const sessions = displaySessions.value
  const [configs, setConfigs] = useState(getAutomationConfigs)
  const [profiles, setProfiles] = useState(getAgentProfiles)

  function updateConfig(id: string, changes: Partial<AutomationConfig>) {
    setConfigs(prev => {
      const next = prev.map(c => c.id === id ? { ...c, ...changes } : c)
      saveAutomationConfigs(next)
      return next
    })
  }

  function updateAgentThreshold(source: AgentSource, metric: AgentProfileMetric, value: number) {
    const next = {
      ...profiles,
      [source]: {
        ...profiles[source],
        [metric]: value,
      },
    }
    saveAgentProfiles(next)
    setProfiles(next)
  }

  function updateConfigAgentThreshold(cfg: AutomationConfig, source: AgentSource, value: number) {
    updateConfig(cfg.id, {
      agentThresholds: {
        ...getConfigAgentThresholds(cfg),
        [source]: value,
      },
    })
  }

  const enabledCount = configs.filter(c => c.enabled).length
  const _inProgressCount = getInProgressSessions(sessions).length

  const standalone = !!window.__STANDALONE__

  return (
    <div id="automation-content">
      <div style="font-size:11px;color:var(--muted);padding:6px 10px;margin-bottom:12px;border-left:2px solid var(--border)">
        <strong>Settings below are adjustable per agent. Reminder: your choice of LLM model significantly affects efficiency and may require threshold adjustments.</strong>
      </div>
      <div style="padding:12px 16px;margin:0 0 16px;border-radius:6px;border:1px solid var(--border);background:var(--vscode-editorWidget-background,var(--bg));font-size:12px;line-height:1.6">
        <div class="section-label" style="margin-bottom:6px">How Automation Works</div>
        <div style="color:var(--muted)">
          Automations monitor in-progress agent sessions only — completed sessions are ignored.
          {standalone ? (
            <> When a threshold is crossed, TraceRoost shows a notification with a <strong style="color:var(--fg)">Copy Prompt</strong> button. Enable <strong style="color:var(--fg)">Write prompts file</strong> to automatically write the prompt to <code>traceroost-prompts-&#123;agent&#125;.md</code> in the current directory instead.</>
          ) : (
            <> When a threshold is crossed, TraceRoost shows a VS Code notification with a <strong style="color:var(--fg)">Copy Prompt</strong> button. Enable <strong style="color:var(--fg)">Write prompts file</strong> to automatically write the prompt to <code>traceroost-prompts-&#123;agent&#125;.md</code> in your workspace root instead.</>
          )}
          {' '}All automations are <strong style="color:var(--fg)">off by default</strong> and debounce each threshold crossing.
        </div>
        {enabledCount > 0 && (
          <div style="margin-top:8px;color:var(--accent);font-weight:600;font-size:11px">
            {enabledCount} automation{enabledCount > 1 ? 's' : ''} active
          </div>
        )}
      </div>

      {configs.map(cfg => {
        const sev = cfg.severity
        const sevColor = sev === 'critical' ? 'var(--error)' : sev === 'warning' ? '#f6a623' : 'var(--accent)'
        const borderColor = cfg.enabled ? sevColor : 'var(--border)'
        const profileMetrics = automationProfileMetrics(cfg)

        return (
          <div key={cfg.id} style={`border:1px solid ${borderColor};border-left:4px solid ${borderColor};border-radius:6px;padding:12px 14px;margin-bottom:10px`}>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <div class="flex-8">
                <strong style="font-size:13px">{cfg.label}</strong>
                <span style={`font-size:10px;padding:1px 6px;border-radius:3px;background:${sevColor};color:#000;font-weight:700;letter-spacing:.4px`}>
                  {sev.toUpperCase()}
                </span>
              </div>
              <label class="toggle-switch">
                <input
                  type="checkbox"
                  checked={cfg.enabled}
                  onChange={e => updateConfig(cfg.id, { enabled: (e.target as HTMLInputElement).checked })}
                />
                <span class="toggle-track"><span class="toggle-thumb" /></span>
                <span class={'toggle-label' + (cfg.enabled ? ' on' : '')}>{cfg.enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>

            <div style="font-size:12px;color:var(--muted);margin-bottom:8px;line-height:1.5">{cfg.description}</div>

            {hasSharedThreshold(cfg) ? (
              <AgentThresholdNumberInputs
                profiles={profiles}
                metricName="Context window tokens"
                unit="tokens"
                values={getConfigAgentThresholds(cfg)}
                min={cfg.min}
                max={cfg.max}
                onChange={(source, value) => updateConfigAgentThreshold(cfg, source, value)}
              />
            ) : (
              profileMetrics.length > 0 && (
                <>
                  <AgentThresholdInputs
                    profiles={profiles}
                    metrics={profileMetrics}
                    onChange={updateAgentThreshold}
                  />
                  {(cfg.id === 'loop_break' || cfg.id === 'error_cascade') && (
                    <div style="font-size:12px;color:var(--muted);margin:6px 0 8px">Hard stop: 8 for all agents</div>
                  )}
                </>
              )
            )}

            {cfg.enabled && (
              <label class="toggle-switch">
                <input
                  type="checkbox"
                  checked={cfg.writePromptsFile}
                  onChange={e => updateConfig(cfg.id, { writePromptsFile: (e.target as HTMLInputElement).checked })}
                />
                <span class="toggle-track"><span class="toggle-thumb" /></span>
                <span class={'toggle-label' + (cfg.writePromptsFile ? ' on' : '')}>
                  <strong>Write prompts file</strong>
                  {' — '}
                  {cfg.writePromptsFile
                    ? 'writes prompt to traceroost-prompts-{agent}.md automatically when triggered'
                    : 'show a Copy Prompt notification — click to copy, then paste into your agent'}
                </span>
              </label>
            )}
          </div>
        )
      })}

      <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="display:flex;gap:6px">
          <button
            onClick={() => { const next = configs.map(c => ({ ...cloneAutomationConfig(c), enabled: true })); saveAutomationConfigs(next); setConfigs(next) }}
            style="font-size:11px;background:none;border:1px solid var(--border);border-radius:3px;padding:3px 10px;cursor:pointer;color:var(--fg)"
          >Enable All</button>
          <button
            onClick={() => { const next = configs.map(c => ({ ...cloneAutomationConfig(c), enabled: false })); saveAutomationConfigs(next); setConfigs(next) }}
            style="font-size:11px;background:none;border:1px solid var(--border);border-radius:3px;padding:3px 10px;cursor:pointer;color:var(--muted)"
          >Disable All</button>
        </div>
        <button
          onClick={() => {
            firedSet.clear()
            try { localStorage.removeItem('traceRoost.automationConfigs') } catch { /* ignore */ }
            setConfigs(DEFAULT_AUTOMATION_CONFIGS.map(cloneAutomationConfig))
          }}
          style="font-size:11px;color:var(--muted);background:none;border:1px solid var(--border);border-radius:3px;padding:3px 10px;cursor:pointer"
        >
          Reset to Defaults
        </button>
        <button
          onClick={() => setProfiles(resetAgentProfiles())}
          style="font-size:11px;color:var(--muted);background:none;border:1px solid var(--border);border-radius:3px;padding:3px 10px;cursor:pointer"
        >
          Reset Agent Thresholds
        </button>
      </div>
    </div>
  )
}
