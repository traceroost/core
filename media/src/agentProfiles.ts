import type { SessionSummaryCard } from './types'

export type AgentSource = SessionSummaryCard['source']

export type AgentProfileMetric =
  | 'contextWindowTokens'
  | 'turnNudge'
  | 'turnAlert'
  | 'identicalRepeatNudge'
  | 'identicalRepeatAlert'
  | 'consecutiveErrorNudge'
  | 'consecutiveErrorAlert'
  | 'activeMinutesAlert'

export interface AgentThresholdProfile {
  source: AgentSource
  label: string
  shortLabel: string
  color: string
  contextWindowTokens: number
  turnNudge: number
  turnAlert: number
  identicalRepeatNudge: number
  identicalRepeatAlert: number
  consecutiveErrorNudge: number
  consecutiveErrorAlert: number
  activeMinutesAlert: number
}

export type AgentThresholdProfiles = Record<AgentSource, AgentThresholdProfile>

export const AGENT_ORDER: AgentSource[] = ['copilot', 'claude_code', 'codex', 'opencode']

export const DEFAULT_AGENT_PROFILES: AgentThresholdProfiles = {
  claude_code: {
    source: 'claude_code',
    label: 'Claude',
    shortLabel: 'CL',
    color: '#FFB085',
    contextWindowTokens: 200000,
    turnNudge: 80,
    turnAlert: 150,
    identicalRepeatNudge: 3,
    identicalRepeatAlert: 4,
    consecutiveErrorNudge: 3,
    consecutiveErrorAlert: 4,
    activeMinutesAlert: 30,
  },
  copilot: {
    source: 'copilot',
    label: 'Copilot',
    shortLabel: 'CP',
    color: '#00EAFF',
    contextWindowTokens: 128000,
    turnNudge: 150,
    turnAlert: 275,
    identicalRepeatNudge: 3,
    identicalRepeatAlert: 5,
    consecutiveErrorNudge: 3,
    consecutiveErrorAlert: 5,
    activeMinutesAlert: 45,
  },
  codex: {
    source: 'codex',
    label: 'Codex',
    shortLabel: 'CX',
    color: '#F0FF42',
    contextWindowTokens: 400000,
    turnNudge: 250,
    turnAlert: 450,
    identicalRepeatNudge: 4,
    identicalRepeatAlert: 6,
    consecutiveErrorNudge: 4,
    consecutiveErrorAlert: 6,
    activeMinutesAlert: 60,
  },
  opencode: {
    source: 'opencode',
    label: 'OpenCode',
    shortLabel: 'OC',
    color: '#FFFFFF',
    contextWindowTokens: 200000,
    turnNudge: 80,
    turnAlert: 150,
    identicalRepeatNudge: 3,
    identicalRepeatAlert: 4,
    consecutiveErrorNudge: 3,
    consecutiveErrorAlert: 4,
    activeMinutesAlert: 30,
  },
}

export const AGENT_PROFILE_FIELD_META: Record<AgentProfileMetric, { label: string; unit: string; min: number; max: number; step: number }> = {
  contextWindowTokens:     { label: 'Window',       unit: 'tokens', min: 16000, max: 1000000, step: 1000 },
  turnNudge:               { label: 'Turn nudge',   unit: 'turns',  min: 10,    max: 1000,    step: 5 },
  turnAlert:               { label: 'Turn alert',   unit: 'turns',  min: 10,    max: 1000,    step: 5 },
  identicalRepeatNudge:    { label: 'Repeat nudge', unit: 'calls',  min: 2,     max: 8,       step: 1 },
  identicalRepeatAlert:    { label: 'Repeat alert', unit: 'calls',  min: 2,     max: 20,      step: 1 },
  consecutiveErrorNudge:   { label: 'Error nudge',  unit: 'errors', min: 2,     max: 8,       step: 1 },
  consecutiveErrorAlert:   { label: 'Error alert',  unit: 'errors', min: 2,     max: 20,      step: 1 },
  activeMinutesAlert:      { label: 'Active alert', unit: 'min',    min: 5,     max: 240,     step: 5 },
}

function cloneDefaultProfiles(): AgentThresholdProfiles {
  return {
    claude_code: { ...DEFAULT_AGENT_PROFILES.claude_code },
    copilot: { ...DEFAULT_AGENT_PROFILES.copilot },
    codex: { ...DEFAULT_AGENT_PROFILES.codex },
    opencode: { ...DEFAULT_AGENT_PROFILES.opencode },
  }
}

function validMetricValue(metric: AgentProfileMetric, value: unknown): number | null {
  const n = Number(value)
  const meta = AGENT_PROFILE_FIELD_META[metric]
  if (!Number.isFinite(n) || n < meta.min || n > meta.max) return null
  return n
}

export function getAgentProfiles(): AgentThresholdProfiles {
  const defaults = cloneDefaultProfiles()
  try {
    const stored = localStorage.getItem('traceRoost.agentProfiles')
    if (!stored) return defaults
    const saved = JSON.parse(stored) as Partial<Record<AgentSource, Partial<Record<AgentProfileMetric, number>>>>
    for (const source of AGENT_ORDER) {
      const profile = saved[source]
      if (!profile) continue
      for (const metric of Object.keys(AGENT_PROFILE_FIELD_META) as AgentProfileMetric[]) {
        const value = validMetricValue(metric, profile[metric])
        if (value !== null) {
          defaults[source][metric] = value
        }
      }
    }
  } catch { /* ignore malformed saved profile */ }
  return defaults
}

export function saveAgentProfiles(profiles: AgentThresholdProfiles): void {
  try {
    const payload: Partial<Record<AgentSource, Partial<Record<AgentProfileMetric, number>>>> = {}
    for (const source of AGENT_ORDER) {
      payload[source] = {}
      for (const metric of Object.keys(AGENT_PROFILE_FIELD_META) as AgentProfileMetric[]) {
        payload[source]![metric] = profiles[source][metric]
      }
    }
    localStorage.setItem('traceRoost.agentProfiles', JSON.stringify(payload))
  } catch { /* ignore */ }
}

export function resetAgentProfiles(): AgentThresholdProfiles {
  try { localStorage.removeItem('traceRoost.agentProfiles') } catch { /* ignore */ }
  return cloneDefaultProfiles()
}

export function resolveAgentProfile(
  source: AgentSource | null | undefined,
  profiles: AgentThresholdProfiles = getAgentProfiles()
): AgentThresholdProfile {
  if (source && profiles[source]) return profiles[source]
  return profiles.copilot
}
