import { signal, computed } from '@preact/signals'
import { calcSessionCost } from './sessionMetrics'
import type {
  FullSummary, SessionSummaryCard, TimelineEntry, GitOutcome,
  AgentFilter, InitiatorFilter, DataSourceFilter, InsightFilter, WorkspaceFilter, VsCodeApi,
  DailyStatRow, LifetimeStats, BurnRate, Projection,
} from './types'

// Maximum sessions rendered in any single chart or table
export const CHART_MAX = 25

// ── Time range navigation ─────────────────────────────────────────────────────

export type TimePreset = '1h' | '6h' | '24h' | '7d' | '30d' | 'all'

export interface TimeRange {
  preset: TimePreset
  since?: number   // unix ms — undefined means no lower bound
  until?: number   // unix ms — undefined means now
}

export const TIME_PRESETS: Array<{ id: TimePreset; label: string; ms: number | null }> = [
  { id: '1h',   label: '1h',   ms: 60 * 60_000 },
  { id: '6h',   label: '6h',   ms: 6 * 60 * 60_000 },
  { id: '24h',  label: '24h',  ms: 24 * 60 * 60_000 },
  { id: '7d',   label: '7d',   ms: 7 * 86_400_000 },
  { id: '30d',  label: '30d',  ms: 30 * 86_400_000 },
  { id: 'all',  label: 'All',  ms: null },
]

export function makeTimeRange(preset: TimePreset): TimeRange {
  const p = TIME_PRESETS.find(t => t.id === preset)!
  if (p.ms === null) return { preset }
  return { preset, since: Date.now() - p.ms }
}

// Active time range — defaults to 'all' (no time bound, always live)
export const timeRange = signal<TimeRange>({ preset: 'all' })

// DB-queried sessions for the active time range (separate from the Search tab results)
export const rangedSearchResults = signal<SearchResultData | null>(null)

// DB-queried sessions for a full, uncapped Export — rangedSearchResults above is intentionally
// capped to CHART_MAX for chart/table rendering, which is wrong for "export everything matching
// my filters"; this is a dedicated signal so the Export tab's own uncapped fetch never clobbers
// (or gets clobbered by) the capped view every other tab reads from.
export const exportSearchResults = signal<SearchResultData | null>(null)

// ── Analytics signals ─────────────────────────────────────────────────────────

export const dailyStats = signal<DailyStatRow[]>([])
export const lifetimeStats = signal<LifetimeStats | null>(null)

export interface BurnRateData {
  sessionId: string
  burnRate: BurnRate
  projection: Projection | null
}
export const burnRateData = signal<BurnRateData | null>(null)

export interface SearchResultData {
  sessions: SessionSummaryCard[]
  totalCount: number
  offset: number
}
export const searchResults = signal<SearchResultData | null>(null)

// ── Global session text filter + sort ─────────────────────────────────────────

export type SortKey = 'start_time' | 'total_tokens' | 'duration_ms' | 'errors' | 'prompt' | 'model' | 'source' | 'cost'
export const sessionTextFilter = signal('')
export const sessionSortKey = signal<SortKey>('start_time')
export const sessionSortDir = signal<'asc' | 'desc'>('desc')

// When set, Sessions tab shows only these session IDs (used by Instructions "View sessions" button
// and by clicking a conversation's colored bar in the Sessions table). evidenceSessionLabel
// describes the reason, shown in the filter banner (e.g. "from instruction suggestion", "from this
// conversation") — set both together; a caller that doesn't set the label falls back to the
// original instruction-suggestion wording, the mechanism's first and, until now, only use.
// evidenceSessionPrompt is optional extra context shown after the label (currently just the
// isolated conversation's first prompt) — null for callers with no single representative prompt
// (e.g. instruction-suggestion evidence, which spans unrelated sessions).
export const evidenceSessionIds = signal<Set<string> | null>(null)
export const evidenceSessionLabel = signal('from instruction suggestion')
export const evidenceSessionPrompt = signal<string | null>(null)

// ── Set signal helper ─────────────────────────────────────────────────────────

function makeSetSignal<T>() {
  const s = signal<ReadonlySet<T>>(new Set<T>())
  return {
    get value(): ReadonlySet<T> { return s.value },
    peek(): ReadonlySet<T> { return s.peek() },
    has(item: T): boolean { return s.value.has(item) },
    add(item: T): void { const n = new Set(s.value); n.add(item); s.value = n },
    delete(item: T): void { const n = new Set(s.value); n.delete(item); s.value = n },
    toggle(item: T): void { const n = new Set(s.value); n.has(item) ? n.delete(item) : n.add(item); s.value = n },
    clear(): void { s.value = new Set<T>() },
    get size(): number { return s.value.size },
  }
}

// ── Core data signals ─────────────────────────────────────────────────────────

export const sessionSummary = signal<FullSummary | null>(window.__INITIAL_SESSION_SUMMARY__ ?? null)
export const toolCalls = signal<Record<string, number>>(window.__INITIAL_TOOL_CALLS__ ?? {})

// ── Lazy timeline cache: sessionId → loaded timeline entries ──────────────────
// Populated by sessionDetail messages from the extension host.
// blobCache: `${spanId}:${field}` → content string

export const sessionTimelines = signal<Record<string, TimelineEntry[]>>({})
export const blobCache = signal<Record<string, string>>({})

// Lazy git-outcome cache: sessionId → classification, or null once fetched but not applicable
// (no git repo, no changed files, etc). Absent key = not yet requested. See gitOutcome.ts.
export const gitOutcomes = signal<Record<string, GitOutcome | null>>({})

// ── UI control signals ────────────────────────────────────────────────────────

// Focused session — set by clicking any session in any view.
// Traces and Flow auto-open to it; a context bar shows it across all tabs.
export const focusedSessionId = signal<string | null>(null)

// sessionLimit scopes how many recent sessions feed Alerts/Charts/Cost/Automation's analysis
// (see displaySessions below) — a data-scoping concept, unrelated to the Sessions table's own
// pagination (sessionsPageSize/sessionsPage, defined further down), which only controls how many
// rows render at once and never excludes a session from any other tab's analysis.
export const sessionLimit = signal(25)
export const selectedAgentFilter = signal<AgentFilter>('all')
export const initiatorFilter = signal<InitiatorFilter>('all')
export const dataSourceFilter = signal<DataSourceFilter>('all')
export const insightFilter = signal<InsightFilter>('all')
export const workspaceFilter = signal<WorkspaceFilter>('all')
export const activeTab = signal('sessions')

// ── Ingestion settings ────────────────────────────────────────────────────────

export const enableOtelIngestion = signal(true)
export const enableLogIngestion = signal(true)
export const otlpPort = signal(4318)

export type OtelReconfigureResult = {
  claudeCode: { changed: boolean; error?: string }
  codex: { changed: boolean; error?: string }
  copilot: { changed: boolean; error?: string }
} | { error: string }
export const otelReconfigureResult = signal<OtelReconfigureResult | null>(null)

// ── Session retention signals ─────────────────────────────────────────────────

export const swRetainedSessions = signal<SessionSummaryCard[]>([])
export const swLastSessionCount = signal(0)

// ── Set-based signals ─────────────────────────────────────────────────────────

export const dismissedSpanIds = makeSetSignal<string>()
export const lastSeenTraceIds = makeSetSignal<string>()
export const ignoredInsightKeys = makeSetSignal<string>()

// ── VS Code API handle ────────────────────────────────────────────────────────

export let vscode: VsCodeApi | null = null
export function setVscode(api: VsCodeApi): void { vscode = api }

// ── Theme preference (standalone only — the VS Code webview always follows the
//    IDE's own theme, so this signal/attribute is simply never touched there) ──

export type ThemePreference = 'system' | 'dark' | 'light'

const THEME_STORAGE_KEY = 'traceroost-theme'

function readStoredTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
  } catch { /* localStorage unavailable (private browsing, blocked) — fall back to system */ }
  return 'system'
}

function applyThemeAttribute(pref: ThemePreference): void {
  const root = document.documentElement
  if (pref === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', pref)
}

export const themePreference = signal<ThemePreference>(readStoredTheme())

// Mirrors the anti-flash inline script in standalone/server.ts's <head> — that script sets the
// attribute before first paint using the same localStorage key; this keeps the signal (and any
// future change via setThemePreference) in sync with it rather than a second, divergent source.
applyThemeAttribute(themePreference.value)

export function setThemePreference(pref: ThemePreference): void {
  themePreference.value = pref
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref)
  } catch { /* localStorage unavailable — preference just won't survive a reload */ }
  applyThemeAttribute(pref)
}

// ── Sessions table pagination (both VS Code and standalone — no built-in equivalent to defer to
//    in either context, unlike theme) ──────────────────────────────────────────

// Rendering every matching session as its own live component with no cap was the mechanism behind
// .staged-issues/session-list-scaling.md — fine at hundreds, unbounded past that, and the one time
// range ("All") most likely to be selected had no cap at all. 50 is picked as a reasonable
// default — enough to browse a full day or two of normal usage on one page without constant
// clicking, small enough to keep the DOM light — not a measured number, same honesty standard as
// every other threshold in this project; adjustable in Settings for anyone who wants it larger.
export const SESSIONS_PAGE_SIZE_OPTIONS = [25, 50, 100, 250, 500] as const
const DEFAULT_SESSIONS_PAGE_SIZE = 50
const SESSIONS_PAGE_SIZE_STORAGE_KEY = 'traceroost-sessions-page-size'

function readStoredSessionsPageSize(): number {
  try {
    const v = Number(localStorage.getItem(SESSIONS_PAGE_SIZE_STORAGE_KEY))
    if (SESSIONS_PAGE_SIZE_OPTIONS.includes(v as typeof SESSIONS_PAGE_SIZE_OPTIONS[number])) return v
  } catch { /* localStorage unavailable — fall back to the default every load */ }
  return DEFAULT_SESSIONS_PAGE_SIZE
}

export const sessionsPageSize = signal<number>(readStoredSessionsPageSize())

export function setSessionsPageSize(size: number): void {
  sessionsPageSize.value = size
  sessionsPage.value = 0  // changing page size mid-browse would otherwise land on a confusing offset
  try {
    localStorage.setItem(SESSIONS_PAGE_SIZE_STORAGE_KEY, String(size))
  } catch { /* localStorage unavailable — preference just won't survive a reload */ }
}

// Current page, 0-indexed. Deliberately not persisted — always start back at the most recent
// sessions on reload, and reset it (see Sessions.tsx) whenever the underlying filtered list
// changes shape, rather than leaving the user stranded on a now-out-of-range page.
export const sessionsPage = signal(0)

/** Shared by Sessions.tsx (the table itself) and App.tsx's SearchFilterBar (the compact Prev/Next
 *  next to the filter row) so both always agree on the current page and page count — clamps
 *  locally rather than writing back into the signal, so loosening a filter later makes a
 *  previously out-of-range page valid again on its own. */
export function getSessionsPagination(totalCount: number): { page: number; totalPages: number; pageSize: number } {
  const pageSize = sessionsPageSize.value
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const page = Math.min(sessionsPage.value, totalPages - 1)
  return { page, totalPages, pageSize }
}

// ── Navigation helpers ────────────────────────────────────────────────────────

export function goToHelp(anchor: string): void {
  activeTab.value = 'help'
  setTimeout(() => {
    const el = document.getElementById(anchor)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, 80)
}

// ── Color palette ─────────────────────────────────────────────────────────────

export const COLORS = [
  '#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4dd0e1',
  '#fff176', '#a1887f', '#90a4ae', '#f06292', '#aed581', '#7986cb',
]

// ── Workspace helpers ─────────────────────────────────────────────────────────

export function shortWorkspaceName(ws: string): string {
  if (!ws) return 'Unknown project'
  const parts = ws.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length === 0) return ws
  if (parts.length === 1) return parts[0]
  return parts.slice(-2).join('/')
}

// ── Derived (computed) signals ─────────────────────────────────────────────────

export const availableWorkspaces = computed<string[]>(() => {
  const all = sessionSummary.value?.sessions ?? []
  const paths = new Set(all.map(s => s.workspace ?? ''))
  return [...paths].sort((a, b) =>
    shortWorkspaceName(a).localeCompare(shortWorkspaceName(b), undefined, { sensitivity: 'base' })
  )
})

export const agentFilteredSessions = computed<SessionSummaryCard[]>(() => {
  let all = sessionSummary.value?.sessions ?? []
  const filter = selectedAgentFilter.value
  if (filter !== 'all') all = all.filter(s => s.source === filter)
  const dsFilter = dataSourceFilter.value
  if (dsFilter !== 'all') all = all.filter(s => (s.dataSource ?? 'otel') === dsFilter)
  const wsFilter = workspaceFilter.value
  if (wsFilter !== 'all') all = all.filter(s => (s.workspace ?? '') === wsFilter)
  return all
})

export const displaySessions = computed<SessionSummaryCard[]>(() => {
  const all = agentFilteredSessions.value
  const limit = sessionLimit.value
  if (limit >= all.length) return all
  return all.slice(0, limit)   // sessions are newest-first; take the first N (most recent)
})

// Sessions scoped to the active time range + agent filter.
// Live/All → in-memory displaySessions.
// Bounded preset → merge DB results with in-memory sessions that fall in the window
// so that sessions not yet persisted to the DB are never missed.
export const rangedSessions = computed<SessionSummaryCard[]>(() => {
  const range = timeRange.value
  const agent = selectedAgentFilter.value

  if (range.preset === 'all') {
    return agentFilteredSessions.value
  }

  const since = range.since ?? 0
  const until = range.until ?? Date.now()

  // Always include in-memory sessions that fall in the window (covers sessions not yet in DB)
  const allInMemory = agentFilteredSessions.value
  const inMemory = allInMemory.filter(s => {
    if (!s.startTime) return false
    const ms = new Date(s.startTime).getTime()
    return ms >= since && ms <= until
  })

  const dbResults = rangedSearchResults.value
  if (!dbResults) return inMemory  // still loading — show in-memory matches as fallback

  // Merge DB results (historical) with in-memory sessions, deduplicate by sessionId
  const dbIds = new Set(dbResults.sessions.map(s => s.sessionId))
  const merged = [
    ...dbResults.sessions,
    ...inMemory.filter(s => !dbIds.has(s.sessionId)),
  ]
  merged.sort((a, b) => Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0'))

  const wsFilter = workspaceFilter.value
  const scoped = wsFilter === 'all' ? merged : merged.filter(s => (s.workspace ?? '') === wsFilter)

  if (agent === 'all') return scoped
  return scoped.filter(s => s.source === agent)
})

// Text-filtered + sorted view of rangedSessions — used by Efficiency, Cost, Traces, Search, Insights
export const filteredSessions = computed<SessionSummaryCard[]>(() => {
  let sessions = rangedSessions.value
  const evIds = evidenceSessionIds.value
  if (evIds !== null) {
    sessions = sessions.filter(s => evIds.has(s.sessionId))
  } else {
    const text = sessionTextFilter.value.toLowerCase().trim()
    if (text) {
      sessions = sessions.filter(s => (s.userRequest ?? '').toLowerCase().includes(text))
    }
  }
  const iFilter = initiatorFilter.value
  if (iFilter !== 'all') {
    sessions = sessions.filter(s => (s.initiator ?? 'user') === iFilter)
  }
  const key = sessionSortKey.value
  const dir = sessionSortDir.value
  if (key === 'start_time') return dir === 'asc' ? [...sessions].reverse() : sessions
  return [...sessions].sort((a, b) => {
    let cmp = 0
    switch (key) {
      case 'total_tokens': cmp = (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens); break
      case 'duration_ms':  cmp = b.durationMs - a.durationMs; break
      case 'errors':       cmp = b.errors - a.errors; break
      case 'prompt':       cmp = (a.userRequest ?? '').localeCompare(b.userRequest ?? ''); break
      case 'model':        cmp = (a.model ?? '').localeCompare(b.model ?? ''); break
      case 'source':       cmp = (a.source ?? '').localeCompare(b.source ?? ''); break
      case 'cost': {
        const costA = calcSessionCost(a, 'token').totalUsd
        const costB = calcSessionCost(b, 'token').totalUsd
        cmp = costB - costA
        break
      }
    }
    return dir === 'asc' ? -cmp : cmp
  })
})

export const agentPresence = computed(() => {
  const sessions = rangedSessions.value
  return {
    claude:    sessions.some(s => s.source === 'claude_code'),
    copilot:   sessions.some(s => s.source === 'copilot'),
    codex:     sessions.some(s => s.source === 'codex'),
    opencode:  sessions.some(s => s.source === 'opencode'),
  }
})
