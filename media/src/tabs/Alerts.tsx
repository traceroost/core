import { useState } from 'preact/hooks'
import { displaySessions } from '../state'
import { buildDisplaySummary, formatMs } from '../utils'
import {
  fmtUsd,
  getActiveComputeMs,
  getDailyCostUsd,
  getErrorHealth,
  getIdenticalToolRepeat,
  getPeakContextUsage,
  sessionDisplayName,
} from '../sessionMetrics'
import {
  AgentThresholdInputs,
  AgentThresholdNumberInputs,
  ThresholdNumberTextInput,
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

const ALERT_TOOLTIPS: Record<string, string> = {
  context_window: 'Peak context use is the largest single LLM input in a trace, not the average. Cache hits can make high input cheap, but they still occupy the context window.',
  high_turns:     'High turn counts often mean the task has become too broad. Ask for a wrap-up, split the task, or provide more exact files and stopping conditions.',
  error_spike:    'Counts errors in the session. Stop retries and diagnose the root cause once the threshold is crossed.',
  long_session:   'Uses active LLM/tool compute time, not wall-clock waiting time.',
  no_cache:       'Only checks sessions above the input-token gate. Cache can be low for small sessions without being a problem.',
  tool_loop:      'Counts identical tool plus argument repeats, not just the same tool name.',
  daily_cost:     'Estimated cost only, not a real billing figure. Sums today (UTC) across every agent using token-based pricing, so it will overcount for Copilot plans on legacy request-based billing.',
}

type AgentThresholdMap = Record<AgentSource, number>

interface AlertConfig {
  id: string
  label: string
  severity: 'error' | 'warning' | 'info'
  description: string
  enabled: boolean
  threshold: number
  unit: string
  min: number
  max: number
  step: number
  agentThresholds?: AgentThresholdMap
}

interface AlertResult {
  triggered: boolean
  detail?: string
  key?: string
}

const DEFAULT_CONFIGS: AlertConfig[] = [
  { id: 'daily_cost', label: 'Daily Cost Threshold', severity: 'warning', description: 'Fires when today\'s total estimated cost across all agents crosses the configured dollar threshold.', enabled: false, threshold: 20, unit: 'usd', min: 1, max: 500, step: 1 },
  { id: 'context_window', label: 'Context Window Filling Up', severity: 'warning', description: 'Fires when any session reaches the configured peak input-token threshold for that agent.', enabled: true, threshold: 170000, unit: 'tokens', min: 10000, max: 1000000, step: 1000, agentThresholds: { claude_code: 170000, copilot: 108800, codex: 340000, opencode: 170000 } },
  { id: 'high_turns', label: 'Too Many Turns Per Trace', severity: 'warning', description: 'Fires when any trace reaches its agent-specific LLM turn alert threshold. High turn counts often indicate scope creep or a task that should be split.', enabled: true, threshold: 200, unit: 'agent profile', min: 20, max: 500, step: 10 },
  { id: 'error_spike', label: 'Error Spike', severity: 'error', description: 'Fires when any session reaches its agent-specific error count threshold.', enabled: true, threshold: 5, unit: 'agent profile', min: 2, max: 20, step: 1 },
  { id: 'long_session', label: 'Long Active Trace', severity: 'info', description: 'Fires when active LLM/tool compute time exceeds the agent-specific threshold. Wall-clock idle time does not count.', enabled: true, threshold: 60, unit: 'agent profile', min: 10, max: 240, step: 10 },
  { id: 'no_cache', label: 'Zero Cache Utilization', severity: 'info', description: 'Fires when any session above that agent\'s input-token gate has 0% cache hit rate.', enabled: true, threshold: 30000, unit: 'tokens', min: 5000, max: 200000, step: 5000, agentThresholds: { claude_code: 30000, copilot: 30000, codex: 30000, opencode: 30000 } },
  { id: 'tool_loop', label: 'Identical Tool Repeat', severity: 'warning', description: 'Fires when the same tool with identical arguments repeats beyond the agent-specific threshold without a file change between repeats.', enabled: true, threshold: 5, unit: 'agent profile', min: 3, max: 20, step: 1 },
]

type EffSummary = ReturnType<typeof buildDisplaySummary>['efficiency']
type SavedAlertConfig = {
  id: string
  enabled?: boolean
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

function cloneAlertConfig(config: AlertConfig): AlertConfig {
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

function normalizeAgentThresholds(def: AlertConfig, saved?: SavedAlertConfig): AgentThresholdMap | undefined {
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

function getConfigAgentThresholds(cfg: AlertConfig): AgentThresholdMap {
  return cloneAgentThresholds(cfg.agentThresholds) ?? fallbackAgentThresholds(cfg.threshold)
}

function getAlertAgentThreshold(cfg: AlertConfig, source: AgentSource): number {
  return cfg.agentThresholds?.[source] ?? cfg.threshold
}

function getAlertConfigs(): AlertConfig[] {
  try {
    const stored = localStorage.getItem('traceRoost.alertConfigs')
    if (!stored) return DEFAULT_CONFIGS.map(cloneAlertConfig)
    const saved = JSON.parse(stored) as SavedAlertConfig[]
    return DEFAULT_CONFIGS.map(def => {
      const s = saved.find(x => x.id === def.id)
      if (!s) return cloneAlertConfig(def)
      const savedThreshold = Number(s.threshold)
      const threshold = savedThreshold >= def.min && savedThreshold <= def.max ? savedThreshold : def.threshold
      return {
        ...cloneAlertConfig(def),
        enabled: typeof s.enabled === 'boolean' ? s.enabled : def.enabled,
        threshold,
        agentThresholds: normalizeAgentThresholds(def, s),
      }
    })
  } catch {
    return DEFAULT_CONFIGS.map(cloneAlertConfig)
  }
}

function saveAlertConfigs(configs: AlertConfig[]): void {
  try {
    localStorage.setItem('traceRoost.alertConfigs', JSON.stringify(
      configs.map(c => ({ id: c.id, enabled: c.enabled, threshold: c.threshold, agentThresholds: c.agentThresholds }))
    ))
  } catch { /* ignore */ }
}

function hasSharedThreshold(cfg: AlertConfig): boolean {
  return cfg.id === 'context_window' || cfg.id === 'no_cache'
}

function alertProfileMetrics(cfg: AlertConfig): AgentProfileMetric[] {
  switch (cfg.id) {
    case 'high_turns':
      return ['turnAlert']
    case 'error_spike':
      return ['consecutiveErrorAlert']
    case 'long_session':
      return ['activeMinutesAlert']
    case 'tool_loop':
      return ['identicalRepeatAlert']
    default:
      return []
  }
}

function sharedAlertMetricName(cfg: AlertConfig): string {
  return cfg.id === 'context_window' ? 'Context window tokens' : 'Input tokens'
}

function evaluateAlert(
  cfg: AlertConfig,
  sessions: SessionSummaryCard[],
  _eff: EffSummary,
  profiles: AgentThresholdProfiles = getAgentProfiles()
): AlertResult {
  if (!sessions?.length) return { triggered: false }
  switch (cfg.id) {
    case 'context_window': {
      const rows = sessions
        .map(session => ({
          session,
          usage: getPeakContextUsage(session, profiles),
          profile: resolveAgentProfile(session.source, profiles),
          threshold: getAlertAgentThreshold(cfg, session.source),
        }))
        .filter(row => row.usage.peakTokens > 0)
      if (!rows.length) return { triggered: false }
      const worst = rows.reduce((a, b) => {
        const aRatio = a.usage.peakTokens / Math.max(a.threshold, 1)
        const bRatio = b.usage.peakTokens / Math.max(b.threshold, 1)
        return bRatio > aRatio ? b : a
      }, rows[0])
      if (worst.usage.peakTokens < worst.threshold) return { triggered: false }
      return {
        triggered: true,
        key: worst.session.traceId || worst.session.sessionId,
        detail: 'Peak context ' + worst.usage.peakTokens.toLocaleString() + ' tokens vs '
          + worst.profile.label + ' threshold ' + worst.threshold.toLocaleString()
          + ' — "' + sessionDisplayName(worst.session) + '"',
      }
    }
    case 'high_turns': {
      const over = sessions
        .map(session => ({ session, profile: resolveAgentProfile(session.source, profiles) }))
        .filter(row => (row.session.totalLlmCalls ?? 0) >= row.profile.turnAlert)
      if (!over.length) return { triggered: false }
      const worst = over.reduce((a, b) => (b.session.totalLlmCalls ?? 0) > (a.session.totalLlmCalls ?? 0) ? b : a, over[0])
      return {
        triggered: true,
        key: worst.session.traceId || worst.session.sessionId,
        detail: over.length + ' session(s) reached threshold. Worst: ' + worst.session.totalLlmCalls
          + ' turns vs ' + worst.profile.label + ' alert ' + worst.profile.turnAlert
          + ' — "' + sessionDisplayName(worst.session) + '"',
      }
    }
    case 'error_spike': {
      const rows = sessions.map(session => ({ session, health: getErrorHealth(session), profile: resolveAgentProfile(session.source, profiles) }))
      const errSess = rows.filter(row => row.health.errorCount >= row.profile.consecutiveErrorAlert)
      if (!errSess.length) return { triggered: false }
      const worst = errSess.reduce((a, b) => b.health.errorCount > a.health.errorCount ? b : a, errSess[0])
      return {
        triggered: true,
        key: worst.session.traceId || worst.session.sessionId,
        detail: 'Worst: ' + worst.health.errorCount + ' error(s) vs '
          + worst.profile.label + ' threshold ' + worst.profile.consecutiveErrorAlert
          + ' — "' + sessionDisplayName(worst.session) + '"',
      }
    }
    case 'long_session': {
      const long = sessions
        .map(session => ({ session, activeMs: getActiveComputeMs(session), profile: resolveAgentProfile(session.source, profiles) }))
        .filter(row => row.activeMs >= row.profile.activeMinutesAlert * 60 * 1000)
      if (!long.length) return { triggered: false }
      const longest = long.reduce((a, b) => b.activeMs > a.activeMs ? b : a, long[0])
      return {
        triggered: true,
        key: longest.session.traceId || longest.session.sessionId,
        detail: long.length + ' session(s) exceeded threshold. Longest active compute: ' + formatMs(longest.activeMs)
          + ' vs ' + longest.profile.label + ' alert ' + longest.profile.activeMinutesAlert + 'min',
      }
    }
    case 'no_cache': {
      const noCache = sessions
        .map(session => ({
          session,
          profile: resolveAgentProfile(session.source, profiles),
          threshold: getAlertAgentThreshold(cfg, session.source),
        }))
        .filter(row => (row.session.inputTokens ?? 0) >= row.threshold && (row.session.cacheHitRate ?? 0) === 0)
      if (!noCache.length) return { triggered: false }
      const worst = noCache.reduce((a, b) => (b.session.inputTokens ?? 0) > (a.session.inputTokens ?? 0) ? b : a, noCache[0])
      return {
        triggered: true,
        key: worst.session.traceId || worst.session.sessionId,
        detail: '0% cache hit rate on ' + worst.session.inputTokens.toLocaleString()
          + ' input tokens vs ' + worst.profile.label + ' gate ' + worst.threshold.toLocaleString()
          + ' — "' + sessionDisplayName(worst.session) + '"',
      }
    }
    case 'tool_loop': {
      const rows = sessions
        .map(session => ({ session, repeat: getIdenticalToolRepeat(session), profile: resolveAgentProfile(session.source, profiles) }))
        .filter((row): row is { session: SessionSummaryCard; repeat: NonNullable<ReturnType<typeof getIdenticalToolRepeat>>; profile: ReturnType<typeof resolveAgentProfile> } => Boolean(row.repeat))
      const over = rows.filter(row => row.repeat.count >= row.profile.identicalRepeatAlert)
      if (!over.length) return { triggered: false }
      const worst = over.reduce((a, b) => b.repeat.count > a.repeat.count ? b : a, over[0])
      return {
        triggered: true,
        key: (worst.session.traceId || worst.session.sessionId) + ':' + worst.repeat.key,
        detail: '"' + worst.repeat.display + '" repeated ' + worst.repeat.count + ' times without intervening file changes vs '
          + worst.profile.label + ' alert ' + worst.profile.identicalRepeatAlert + ' — "' + sessionDisplayName(worst.session) + '"',
      }
    }
    case 'daily_cost': {
      // Aggregate across the full session set, not the `sessions` param — callers may pass a
      // narrowed slice (e.g. checkAlerts()'s 30-second-recent window), which would undercount.
      const today = new Date().toISOString().slice(0, 10)
      const total = getDailyCostUsd(buildDisplaySummary().sessions, today)
      if (total < cfg.threshold) return { triggered: false }
      return {
        triggered: true,
        key: 'daily_cost:' + today,
        detail: 'Estimated cost today: ' + fmtUsd(total) + ' vs threshold ' + fmtUsd(cfg.threshold),
      }
    }
    default: return { triggered: false }
  }
}

export interface TriggeredAlert {
  label: string
  severity: 'error' | 'warning' | 'info'
  detail: string
}

export function getTriggeredAlerts(): TriggeredAlert[] {
  const configs = getAlertConfigs()
  const profiles = getAgentProfiles()
  const { sessions, efficiency } = buildDisplaySummary()
  const out: TriggeredAlert[] = []
  for (const cfg of configs) {
    if (!cfg.enabled) continue
    const result = evaluateAlert(cfg, sessions, efficiency, profiles)
    if (result.triggered) out.push({ label: cfg.label, severity: cfg.severity, detail: result.detail ?? '' })
  }
  return out
}

export function computeAlertCount(): number {
  return getTriggeredAlerts().length
}

// Tracks which alert instances have already fired a notification this trigger cycle.
// Cleared when the alert un-triggers so it can re-notify if the condition returns.
const firedAlertKeys = new Set<string>()

export interface AlertNotification {
  label: string
  detail?: string
  severity: 'error' | 'warning' | 'info'
}

export function checkAlerts(): AlertNotification[] {
  const configs = getAlertConfigs()
  const profiles = getAgentProfiles()
  const { sessions, efficiency } = buildDisplaySummary()
  // Only consider sessions updated in the last 30 seconds
  const now = Date.now()
  const RECENT_WINDOW_MS = 30 * 1000
  const recentSessions = sessions.filter(s => {
    const lastTs = s.timeline && s.timeline.length > 0 ? s.timeline[s.timeline.length - 1].timestamp : s.startTime
    if (!lastTs) return false
    const tsNum = typeof lastTs === 'number' ? lastTs : Date.parse(lastTs)
    return now - tsNum < RECENT_WINDOW_MS
  })
  const notifications: AlertNotification[] = []
  const activeKeys = new Set<string>()
  for (const cfg of configs) {
    if (!cfg.enabled) { continue }
    const result = evaluateAlert(cfg, recentSessions, efficiency, profiles)
    if (result.triggered) {
      const key = cfg.id + ':' + (result.key ?? 'global')
      activeKeys.add(key)
      if (firedAlertKeys.has(key)) { continue }
      firedAlertKeys.add(key)
      notifications.push({ label: cfg.label, detail: result.detail, severity: cfg.severity })
    }
  }
  for (const key of Array.from(firedAlertKeys)) {
    if (!activeKeys.has(key)) { firedAlertKeys.delete(key) }
  }
  return notifications
}

export function Alerts() {
  const sessions = displaySessions.value
  const [configs, setConfigs] = useState(getAlertConfigs)
  const [profiles, setProfiles] = useState(getAgentProfiles)
  const hasSessions = sessions.length > 0

  const { sessions: displayed, efficiency } = buildDisplaySummary()
  const results = configs.map(cfg => ({
    config: cfg,
    ...(cfg.enabled ? evaluateAlert(cfg, displayed, efficiency, profiles) : { triggered: false } as AlertResult),
  }))
  const triggeredCount = results.filter(r => r.triggered).length

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

  function updateConfig(id: string, changes: Partial<AlertConfig>) {
    setConfigs(prev => {
      const next = prev.map(c => c.id === id ? { ...c, ...changes } : c)
      saveAlertConfigs(next)
      return next
    })
  }

  function updateConfigAgentThreshold(cfg: AlertConfig, source: AgentSource, value: number) {
    updateConfig(cfg.id, {
      agentThresholds: {
        ...getConfigAgentThresholds(cfg),
        [source]: value,
      },
    })
  }

  return (
    <div id="alerts-content">
      <div style="font-size:11px;color:var(--muted);padding:6px 10px;margin-bottom:12px;border-left:2px solid var(--border)">
        <strong>Settings below are adjustable per agent. Reminder: your choice of LLM model significantly affects efficiency and may require threshold adjustments.</strong>
      </div>
      {!hasSessions ? (
        <div style="background:var(--panel-bg);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:14px">
          <strong>No agent sessions recorded</strong>
          <span style="color:var(--muted);font-size:12px;margin-left:8px">alert configuration is available below</span>
        </div>
      ) : triggeredCount > 0 ? (
        <div style="background:rgba(239,83,80,0.12);border:1px solid var(--error);border-radius:6px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
          <span style="font-size:18px">⚠</span>
          <div>
            <strong class="err">{triggeredCount} alert{triggeredCount > 1 ? 's' : ''} triggered</strong>
            <span style="color:var(--muted);font-size:12px;margin-left:8px">based on your displayed sessions</span>
          </div>
        </div>
      ) : (
        <div style="background:rgba(129,199,132,0.1);border:1px solid #81c784;border-radius:6px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
          <span style="font-size:18px;color:#81c784">✓</span>
          <div>
            <strong style="color:#81c784">All clear</strong>
            <span style="color:var(--muted);font-size:12px;margin-left:8px">no alerts triggered for current sessions</span>
          </div>
        </div>
      )}

      {results.map(({ config: cfg, triggered, detail }) => {
        const sev = cfg.severity
        const trigColor = sev === 'error' ? 'var(--error)' : sev === 'info' ? '#4fc3f7' : '#f6a623'
        const borderColor = triggered ? trigColor : 'var(--border)'
        const statusIcon = !cfg.enabled ? '○' : triggered ? (sev === 'error' ? '⛔' : sev === 'info' ? 'ℹ' : '⚠') : '✓'
        const statusColor = !cfg.enabled ? 'var(--muted)' : triggered ? trigColor : '#81c784'
        const profileMetrics = alertProfileMetrics(cfg)

        return (
          <div key={cfg.id} style={`border:1px solid ${borderColor};border-left:4px solid ${borderColor};border-radius:6px;padding:12px 14px;margin-bottom:10px`}>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <div class="flex-8">
                <span style={`font-size:15px;color:${statusColor};line-height:1`}>{statusIcon}</span>
                <strong style="font-size:13px">{cfg.label}</strong>
                {triggered && <span style={`font-size:10px;background:${trigColor};color:#000;padding:1px 7px;border-radius:3px;font-weight:700;letter-spacing:.4px`}>TRIGGERED</span>}
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
            <div style="font-size:12px;color:var(--muted);margin-bottom:8px;line-height:1.5">
              {cfg.description}
              {ALERT_TOOLTIPS[cfg.id] && (
                <> {' '}<span data-tip={ALERT_TOOLTIPS[cfg.id]} style="font-size:11px;color:var(--vscode-textLink-foreground,#4fc3f7);border-bottom:1px dotted currentColor;cursor:help;white-space:nowrap">Why?</span></>
              )}
            </div>
            {triggered && detail && (
              <div style={`font-size:12px;padding:7px 10px;background:var(--panel-bg);border-radius:4px;border-left:3px solid ${trigColor};margin-bottom:8px;line-height:1.4`}>{detail}</div>
            )}
            {hasSharedThreshold(cfg) ? (
              <AgentThresholdNumberInputs
                profiles={profiles}
                metricName={sharedAlertMetricName(cfg)}
                unit="tokens"
                values={getConfigAgentThresholds(cfg)}
                min={cfg.min}
                max={cfg.max}
                onChange={(source, value) => updateConfigAgentThreshold(cfg, source, value)}
              />
            ) : profileMetrics.length > 0 ? (
              <AgentThresholdInputs
                profiles={profiles}
                metrics={profileMetrics}
                onChange={updateAgentThreshold}
              />
            ) : (
              // Globally-scoped configs (e.g. daily_cost) — one flat threshold, not per-agent.
              <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin:8px 0">
                <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;font-weight:700">Threshold</span>
                {cfg.unit === 'usd' && <span style="color:var(--muted)">$</span>}
                <ThresholdNumberTextInput
                  value={cfg.threshold}
                  min={cfg.min}
                  max={cfg.max}
                  width={70}
                  ariaLabel={cfg.label + ' threshold'}
                  onChange={value => updateConfig(cfg.id, { threshold: value })}
                />
                {cfg.unit !== 'usd' && <span style="color:var(--muted)">{cfg.unit}</span>}
              </div>
            )}
          </div>
        )
      })}

      <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="display:flex;gap:6px">
          <button
            onClick={() => { const next = configs.map(c => ({ ...cloneAlertConfig(c), enabled: true })); saveAlertConfigs(next); setConfigs(next) }}
            style="font-size:11px;background:none;border:1px solid var(--border);border-radius:3px;padding:3px 10px;cursor:pointer;color:var(--fg)"
          >Enable All</button>
          <button
            onClick={() => { const next = configs.map(c => ({ ...cloneAlertConfig(c), enabled: false })); saveAlertConfigs(next); setConfigs(next) }}
            style="font-size:11px;background:none;border:1px solid var(--border);border-radius:3px;padding:3px 10px;cursor:pointer;color:var(--muted)"
          >Disable All</button>
        </div>
        <button
          onClick={() => {
            try { localStorage.removeItem('traceRoost.alertConfigs') } catch { /* ignore */ }
            setConfigs(DEFAULT_CONFIGS.map(cloneAlertConfig))
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
