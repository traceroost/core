import { signal } from '@preact/signals'

// Adapter health as the host sends it (`adapterHealth` message) — a hand-copied mirror of
// AdapterHealthMessage in ../../src/adapters/health.ts, which is the source of truth (this bundle
// can't import outside media/src; see signalFormulas.ts). Keep the two in sync by hand.

export type AgentStatus = 'ok' | 'missing-data' | 'unrecognized' | 'no-data' | 'not-verified'

export interface AgentReport { title: string; body: string; url: string }

export interface VersionHealth {
  version: string
  known: number
  ignored: number
  unknown: number
  unknownNames: Record<string, number>
  unreadFiles: number
  damaged: number
  impact: 'loss' | 'skipped' | 'none'
  lastImpactMs: number | null
  banner: boolean
  report?: AgentReport
}

export interface AgentHealthRow {
  key: 'claude' | 'codex' | 'copilot' | 'copilot_vscode' | 'opencode' | 'cursor' | 'antigravity'
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
  antigravity: ['antigravity'],
}

// Banner dismissals, per agent version: a newer version that loses data shows the banner again.
const DISMISSED_KEY = 'traceRoost.agentBannerDismissed'

function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export const dismissedAgentBanners = signal<string[]>(readDismissed())

/** Dismisses an agent's banner: each of the versions it spoke for. */
export function dismissAgentBanner(key: string, versions: readonly string[]): void {
  const next = [...new Set([...dismissedAgentBanners.peek(), ...versions.map(v => `${key}@${v}`)])].slice(-200)
  dismissedAgentBanners.value = next
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)) } catch { /* not persisted */ }
}

/** One banner per agent: its versions that raise one (data lost, recently — see health.ts) and
 *  aren't dismissed, newest first, for agents the current agent filter shows. */
export function bannerAgents(rows: AgentHealthRow[] | null, agentFilter: string, dismissed: string[]): Array<{ row: AgentHealthRow; versions: VersionHealth[] }> {
  if (!rows) return []
  const shown = agentFilter === 'all' ? null : new Set(ADAPTERS_BY_SOURCE[agentFilter] ?? [])
  return rows
    .filter(r => !shown || shown.has(r.key))
    .map(row => ({ row, versions: row.versions.filter(v => v.banner && !dismissed.includes(`${row.key}@${v.version}`)) }))
    .filter(b => b.versions.length > 0)
}

/** What the data loss amounts to, in the user's terms — no record names. */
export function lossSummary(versions: readonly VersionHealth[]): string {
  const unread = versions.reduce((n, v) => n + v.unreadFiles, 0)
  if (unread > 0) return `${unread} session${unread === 1 ? '' : 's'} couldn't be fully read`
  return 'some sessions are missing cost or prompt data'
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  'ok': 'OK',
  'missing-data': 'Missing data',
  'unrecognized': 'Unrecognized data',
  'no-data': 'No data',
  'not-verified': 'Not verified on this version',
}
