import { signal } from '@preact/signals'

// Adapter health as the host sends it (`adapterHealth` message) — a hand-copied mirror of
// AdapterHealthMessage in ../../src/adapters/health.ts, which is the source of truth (this bundle
// can't import outside media/src; see signalFormulas.ts). Keep the two in sync by hand.

export type AgentStatus = 'ok' | 'unrecognized' | 'no-data' | 'not-verified'

export interface AgentReport { title: string; body: string; url: string }

export interface VersionHealth {
  version: string
  known: number
  ignored: number
  unknown: number
  unknownNames: Record<string, number>
  banner: boolean
  report?: AgentReport
}

export interface AgentHealthRow {
  key: 'claude' | 'codex' | 'copilot' | 'copilot_vscode' | 'opencode' | 'cursor'
  label: string
  support: 'verified' | 'fixture-tested' | 'best-effort'
  lastVerifiedVersion: string | null
  versionSeen: string | null
  lastFilesMs: number | null
  lastOtlpMs: number | null
  status: AgentStatus
  versions: VersionHealth[]
}

export const adapterHealth = signal<AgentHealthRow[] | null>(null)

/** A trace card's `source` → the adapters that produce it (Copilot CLI and Chat share one). */
export const ADAPTERS_BY_SOURCE: Record<string, ReadonlyArray<AgentHealthRow['key']>> = {
  claude_code: ['claude'],
  codex: ['codex'],
  copilot: ['copilot', 'copilot_vscode'],
  opencode: ['opencode'],
  cursor: ['cursor'],
}

// Banner dismissals, per agent version: a newer version with unknowns shows the banner again.
const DISMISSED_KEY = 'traceRoost.agentBannerDismissed'

function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export const dismissedAgentBanners = signal<string[]>(readDismissed())

export function dismissAgentBanner(key: string, version: string): void {
  const next = [...new Set([...dismissedAgentBanners.peek(), `${key}@${version}`])].slice(-200)
  dismissedAgentBanners.value = next
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)) } catch { /* not persisted */ }
}

/** The versions that should raise the banner: past the threshold and not dismissed, for agents
 *  the current agent filter shows. */
export function bannerVersions(rows: AgentHealthRow[] | null, agentFilter: string, dismissed: string[]): Array<{ row: AgentHealthRow; version: VersionHealth }> {
  if (!rows) return []
  const shown = agentFilter === 'all' ? null : new Set(ADAPTERS_BY_SOURCE[agentFilter] ?? [])
  return rows
    .filter(r => !shown || shown.has(r.key))
    .flatMap(row => row.versions.filter(v => v.banner && !dismissed.includes(`${row.key}@${v.version}`)).map(version => ({ row, version })))
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  'ok': 'OK',
  'unrecognized': 'Unrecognized data',
  'no-data': 'No data',
  'not-verified': 'Not verified on this version',
}
