import { signal, computed } from '@preact/signals'
import { calcSessionCost } from './sessionMetrics'
import { formatTraceIdHash } from './hash'
import type {
  FullSummary, SessionSummaryCard, TimelineEntry, GitOutcome, FileOutcome, LoopSignal,
  AgentFilter, InitiatorFilter, DataSourceFilter, InsightFilter, WorkspaceFilter, OutcomeFilter, VsCodeApi,
  DailyStatRow, LifetimeStats, BurnRate, Projection,
} from './types'

// Maximum sessions rendered in any single chart or table
export const CHART_MAX = 25

// ── Time range navigation ─────────────────────────────────────────────────────

export type TimePreset = '1h' | '6h' | '24h' | '7d' | '30d' | 'all' | 'custom'

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
  // 'custom' deliberately excluded — it has no fixed lookback ms, and is constructed by
  // makeCustomTimeRange below rather than looked up by id here.
]

export function makeTimeRange(preset: TimePreset): TimeRange {
  const p = TIME_PRESETS.find(t => t.id === preset)!
  if (p.ms === null) return { preset }
  return { preset, since: Date.now() - p.ms }
}

// A user-picked start/end (TimeRangePicker's "Custom range" popover) — either bound may be
// omitted (an open start or an open-ended "through now"), same optionality every other TimeRange
// already allows. rangedSessions/Agents/Export etc. all already branch on `preset === 'all'` vs.
// read `since`/`until` with a fallback, so 'custom' needs no special-casing anywhere downstream.
export function makeCustomTimeRange(since: number | undefined, until: number | undefined): TimeRange {
  return { preset: 'custom', since, until }
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

export type SortKey = 'start_time' | 'total_tokens' | 'duration_ms' | 'errors' | 'prompt' | 'model' | 'source' | 'cost' | 'workspace' | 'turns' | 'outcome' | 'signals'
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

// Sessions the host has told us are "deferred" — still inside their active-session grace window
// (reconciliationService.ts's ACTIVE_GRACE_MS), so no git classification has run or will run for
// them yet. Kept separate from `gitOutcomes` (which means "resolved, here's the answer") so the
// Outcome filter's "resolving N outcomes" spinner — meant to reflect actual git CLI work in
// progress, see GitCommandStatusBar — doesn't count a session that's simply waiting out a timer
// with no git subprocess running. Cleared once a real `gitOutcome` reply lands for the session.
export const deferredGitOutcomeSessionIds = makeSetSignal<string>()

// Live snapshot of `git` command lines currently in flight on the host, pushed unsolicited by a
// `runningGitCommands` message (gitOutcome.ts's onRunningGitCommandsChanged) — feeds the status
// line under the Outcome filter's "resolving N outcomes" spinner. Empty when nothing is running.
export const runningGitCommands = signal<string[]>([])

// FileOutcome (this session's overall git classification) → the coarser Outcome filter bucket, or
// null when there's nothing to filter on ('ambiguous', or "not applicable" — a null GitOutcome).
// A null bucket never equals any pill's value, so those sessions simply don't match a specific
// Outcome filter and only appear under 'all'.
function outcomeToFilterBucket(overall: FileOutcome | null): Exclude<OutcomeFilter, 'all'> | null {
  if (overall === 'merged') return 'merged'
  if (overall === 'committed') return 'committed'
  if (overall === 'abandoned') return 'abandoned'
  return null
}

// Same best-to-worst ordering as OUTCOME_META's own entries (Sessions.tsx) — 'merged' outranks
// 'committed' outranks 'abandoned'. 'ambiguous' and a not-yet-resolved/not-applicable (null)
// outcome both sort last, below every resolved outcome, since there's nothing to rank them by.
const OUTCOME_RANK: Partial<Record<FileOutcome, number>> = { merged: 3, committed: 2, abandoned: 1 }
function outcomeRank(overall: FileOutcome | null | undefined): number {
  if (!overall) return -1
  return OUTCOME_RANK[overall] ?? 0
}

// Worst-first score for the Signals column: any critical signal outranks any number of warnings,
// then more signals outranks fewer — same "most/worst first" reading as the errors/tokens sorts.
function signalsScore(signals: LoopSignal[] | undefined): number {
  if (!signals || signals.length === 0) return 0
  let critical = 0
  for (const s of signals) if (s.severity === 'critical') critical++
  return critical * 1000 + signals.length
}

// Caps how many not-yet-resolved sessions get a `getGitOutcome` request fired per call, and
// staggers them a little — not to protect the host from concurrent git subprocesses (it now
// bounds that itself, gitOutcome.ts's per-session classification gate), just so switching the
// Outcome filter on over a large, otherwise-unfiltered session set doesn't fire an enormous
// number of postMessage calls in one synchronous burst. The host caches each sessionId's result
// (dashboardPanel.ts's gitOutcomeCache), so re-calling this for sessions already resolved (or
// already in flight) is cheap: they're filtered out below.
const GIT_OUTCOME_FETCH_CAP = 150
const GIT_OUTCOME_FETCH_STAGGER_MS = 2

export function requestGitOutcomesFor(sessions: SessionSummaryCard[]): void {
  const cache = gitOutcomes.peek()
  const pending = sessions.filter(s => cache[s.sessionId] === undefined)
  if (pending.length === 0) return

  // A session with no changed files is "not applicable" — resolve it locally, same verdict
  // classifySessionOutcome itself would reach, without a round trip to the host.
  const immediate: Record<string, null> = {}
  const needsFetch: SessionSummaryCard[] = []
  for (const s of pending) {
    if (s.filesChanged.length === 0) immediate[s.sessionId] = null
    else needsFetch.push(s)
  }
  if (Object.keys(immediate).length > 0) {
    gitOutcomes.value = { ...gitOutcomes.value, ...immediate }
  }

  if (!vscode) return
  const batch = needsFetch.slice(0, GIT_OUTCOME_FETCH_CAP)
  batch.forEach((s, i) => {
    const endTime = s.startTime && s.durationMs
      ? new Date(new Date(s.startTime).getTime() + s.durationMs).toISOString()
      : s.startTime
    setTimeout(() => {
      vscode?.postMessage({
        type: 'getGitOutcome',
        sessionId: s.sessionId,
        workspace: s.workspace,
        filesChanged: s.filesChanged,
        endTime,
      })
    }, i * GIT_OUTCOME_FETCH_STAGGER_MS)
  })

  // The cap above only bounds one *batch* — a caller passing more than that (the Outcome filter
  // does, with every session currently matching the other filters, unlike the Sessions table's own
  // per-page call) must still see every one of them eventually resolve, or its "resolving N
  // outcomes" spinner spins forever. Chain the remainder as a follow-up batch once this one's
  // stagger window finishes, rather than silently dropping it.
  const overflow = needsFetch.slice(GIT_OUTCOME_FETCH_CAP)
  if (overflow.length > 0) {
    setTimeout(() => requestGitOutcomesFor(overflow), batch.length * GIT_OUTCOME_FETCH_STAGGER_MS)
  }
}

// `hash` is the same one traceroost-cloud shows in its own Repo column (repoKey.ts's repoHash).
// `name` is the git repo root's own basename, prefixed with its parent folder's name where one
// exists (e.g. "traceroost/core") — resolved through git rather than read off the workspace path,
// which may be a subfolder of the repo (or, with multiple worktrees/clones, a differently-named
// checkout of it) — see dashboardPanel.ts's sendRepoHash. `githubUrl` is the `origin` remote
// normalized to `https://github.com/owner/repo`, or null if there's no remote or it isn't on
// github.com — local-only (repoRemote.ts), never sent to traceroost-cloud, unlike `hash`.
export interface RepoInfo { name: string; hash: string; githubUrl: string | null }

// Lazy repo-info cache: workspace path → RepoInfo, or null once fetched but ungrouped (not a repo,
// shallow clone, no root commit). Absent key = not yet requested. There are only ever a handful of
// distinct workspaces open at once (unlike sessions), so unlike git outcomes this is cheap to
// request for every one of them up front — no cap/stagger needed.
export const repoInfo = signal<Record<string, RepoInfo | null>>({})

export function requestRepoHash(workspace: string): void {
  if (!workspace || repoInfo.peek()[workspace] !== undefined || !vscode) return
  vscode.postMessage({ type: 'getRepoHash', workspace })
}

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
export const workspaceFilter = signal<WorkspaceFilter>('')
// The one real folder open in this VS Code window (dashboardPanel.ts's 'update' message,
// vscode.workspace.workspaceFolders[0]) — null until the first message arrives, or if no folder
// is open. Distinct from workspaceFilter above (a freeform search box that can match any
// historical repo's sessions): this is what Apply/getInstructionFiles actually write to, so
// Instructions.tsx scopes its evidence and applied/dismissed state to this, not the search box.
export const currentWorkspace = signal<string | null>(null)
export const outcomeFilter = signal<OutcomeFilter>('all')
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

// Rendering every matching trace as its own live component with no cap was the mechanism behind
// .staged-issues/session-list-scaling.md — fine at hundreds, unbounded past that, and the one time
// range ("All") most likely to be selected had no cap at all. 20 is picked as a reasonable
// default — enough to browse recent activity on one page without constant clicking, small enough
// to keep the DOM light — not a measured number, same honesty standard as every other threshold
// in this project; adjustable in Settings for anyone who wants it larger.
export const SESSIONS_PAGE_SIZE_OPTIONS = [20, 50, 100, 250, 500] as const
const DEFAULT_SESSIONS_PAGE_SIZE = 20
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

// Freeform repo search — matches a workspace's git-derived repo name and hash (repoInfo, once
// resolved), or falls back to the raw workspace path (before repoInfo arrives, or when the
// workspace isn't a keyable git repo). Substring, case-insensitive — same convention as
// sessionTextFilter's own prompt search.
export function matchesRepoQuery(ws: string, query: string, info: Record<string, RepoInfo | null>): boolean {
  const q = query.toLowerCase()
  const entry = info[ws]
  if (entry) return entry.name.toLowerCase().includes(q) || entry.hash.toLowerCase().includes(q)
  return ws.toLowerCase().includes(q)
}

// The name to actually show for a workspace — its git repo root's own basename (repoInfo) once
// resolved, with its hash appended in parentheses, truncated to 4 characters (shorter than
// traceroost-cloud's own `hash.slice(0, 10)` in its Repo column — there's more room to spare there
// than in this table's narrower Repo column). Falls back to a path-derived guess
// (shortWorkspaceName) until the hash resolves, or permanently if it isn't a keyable git repo.
// Prefer this over shortWorkspaceName directly anywhere a repo name is displayed, so two sessions
// recorded from different subfolders of the same repo always show the same name.
export function repoDisplayName(ws: string, info: Record<string, RepoInfo | null>): string {
  const entry = info[ws]
  if (!entry) return shortWorkspaceName(ws)
  return `${entry.name} (${entry.hash.slice(0, 4)}…)`
}

// The repo cell's hover title's first line — the GitHub URL when the repo's `origin` remote
// resolved to one, since that's more useful to click into than the bare name repoDisplayName
// shows in the cell itself. Falls back to repoDisplayName's "name (hash)" form for a repo with no
// GitHub remote (GitLab/Bitbucket/local-only) or before the lookup has resolved.
export function repoTooltipName(ws: string, info: Record<string, RepoInfo | null>): string {
  const entry = info[ws]
  return entry?.githubUrl ?? repoDisplayName(ws, info)
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
  const wsFilter = workspaceFilter.value.trim()
  if (wsFilter !== '') {
    const info = repoInfo.value
    all = all.filter(s => matchesRepoQuery(s.workspace ?? '', wsFilter, info))
  }
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

  const wsFilter = workspaceFilter.value.trim()
  const scoped = wsFilter === '' ? merged : (() => {
    const info = repoInfo.value
    return merged.filter(s => matchesRepoQuery(s.workspace ?? '', wsFilter, info))
  })()

  if (agent === 'all') return scoped
  return scoped.filter(s => s.source === agent)
})

// Text- + initiator-filtered view of rangedSessions, ahead of the Outcome filter — this is the
// candidate set OutcomeFilterBar (App.tsx) eagerly requests git outcomes for, since it's the
// largest set the Outcome filter could ever need to narrow (before that filter itself removes
// anything). Exported so that candidate list and the actual filter step can't drift apart.
export const preOutcomeFilteredSessions = computed<SessionSummaryCard[]>(() => {
  let sessions = rangedSessions.value
  const evIds = evidenceSessionIds.value
  if (evIds !== null) {
    sessions = sessions.filter(s => evIds.has(s.sessionId))
  } else {
    const text = sessionTextFilter.value.toLowerCase().trim()
    if (text) {
      // Matches prompt text, or a Trace ID pasted in either form: the raw underlying id
      // (traceId, or sessionId for sources with no separate trace id) and the normalized
      // display hash shown/copied from the trace's expanded detail (formatTraceIdHash) —
      // copying either one from anywhere in the app should find the trace here.
      sessions = sessions.filter(s =>
        (s.userRequest ?? '').toLowerCase().includes(text)
        || s.sessionId.toLowerCase().includes(text)
        || (s.traceId ?? '').toLowerCase().includes(text)
        || formatTraceIdHash(s.traceId || s.sessionId).includes(text)
      )
    }
  }
  const iFilter = initiatorFilter.value
  if (iFilter !== 'all') {
    sessions = sessions.filter(s => {
      const init = s.initiator ?? 'user'
      return iFilter === 'agent' ? (init === 'agent' || init === 'api') : init === iFilter
    })
  }
  return sessions
})

// Outcome-filtered + sorted view — used by Efficiency, Cost, Traces, Search, Insights
export const filteredSessions = computed<SessionSummaryCard[]>(() => {
  let sessions = preOutcomeFilteredSessions.value
  const oFilter = outcomeFilter.value
  if (oFilter !== 'all') {
    const outcomes = gitOutcomes.value
    sessions = sessions.filter(s => {
      const go = outcomes[s.sessionId]
      if (go === undefined) return false // not yet resolved — appears once its outcome loads
      return outcomeToFilterBucket(go?.overall ?? null) === oFilter
    })
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
      case 'turns':        cmp = b.turns - a.turns; break
      case 'prompt':       cmp = (a.userRequest ?? '').localeCompare(b.userRequest ?? ''); break
      case 'model':        cmp = (a.model ?? '').localeCompare(b.model ?? ''); break
      case 'source':       cmp = (a.source ?? '').localeCompare(b.source ?? ''); break
      case 'workspace':    cmp = a.workspace.localeCompare(b.workspace); break
      case 'outcome':      cmp = outcomeRank(gitOutcomes.value[b.sessionId]?.overall ?? null) - outcomeRank(gitOutcomes.value[a.sessionId]?.overall ?? null); break
      case 'signals':      cmp = signalsScore(b.loopSignals) - signalsScore(a.loopSignals); break
      case 'cost': {
        const costA = calcSessionCost(a).totalUsd
        const costB = calcSessionCost(b).totalUsd
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
    cursor:    sessions.some(s => s.source === 'cursor'),
  }
})
