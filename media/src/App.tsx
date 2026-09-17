import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  sessionSummary, toolCalls,
  selectedAgentFilter, initiatorFilter, dataSourceFilter, sessionLimit, activeTab,
  sessionTimelines, blobCache, gitOutcomes, outcomeFilter, preOutcomeFilteredSessions, requestGitOutcomesFor,
  repoInfo,
  dailyStats, lifetimeStats, burnRateData, searchResults, rangedSearchResults, exportSearchResults,
  timeRange, makeTimeRange, TIME_PRESETS, CHART_MAX,
  vscode, displaySessions, rangedSessions,
  sessionTextFilter, filteredSessions, evidenceSessionIds, evidenceSessionLabel, evidenceSessionPrompt,
  sessionSortKey, sessionSortDir,
  workspaceFilter,
  enableOtelIngestion, enableLogIngestion, otlpPort, otelReconfigureResult, type OtelReconfigureResult,
  sessionsPage, getSessionsPagination,
} from './state'
import type { TimelineEntry, AgentFilter, InitiatorFilter, DataSourceFilter, OutcomeFilter, DailyStatRow, LifetimeStats, BurnRate, Projection, SessionSummaryCard, GitOutcome } from './types'
import { Wordmark } from './Wordmark'
import { DATA_SOURCE_COLORS, INITIATOR_COLORS } from './utils'

// Tab components
import { Sessions } from './tabs/Sessions'
import { Analytics } from './tabs/Analytics'
import { Alerts, computeAlertCount, getTriggeredAlerts, checkAlerts, type TriggeredAlert } from './tabs/Alerts'
import { Export } from './tabs/Export'
import { Import } from './tabs/Import'
import { Help } from './tabs/Help'
import { Pricing } from './tabs/Pricing'
import { Patterns } from './tabs/Patterns'
import { Automation, checkAutomations } from './tabs/Automation'
import { instructionFiles, appliedSuggestions, dismissedIds } from './tabs/Instructions'
import { IngestionToggles, McpToggle, OtelReconfigureButton, ThemeToggle, SessionsPageSizeControl, PageSizeSelect } from './tabs/Settings'
import { TeamButton, TeamPanel, teamStatus, teamPayloadPreview, teamBusy, teamOpen, requestTeamStatus, teamReconcileResult, teamReconcileBusy } from './cloud/panels/TeamPanel'
import { Outcomes, outcomesReport, outcomesLoading, outcomesProgress } from './cloud/tabs/Outcomes'


// Standalone opens with the left activity sidebar collapsed by default, since it
// duplicates content already visible in the main dashboard. VS Code's native
// sidebar (toggled via workbench commands, not this panel) defaults to open.
const sidebarOpen = signal(window.__STANDALONE__ !== true)
const configOpen = signal(false)
const bellOpen = signal(false)

// `id` stays 'sessions' — it's an internal routing key, not shown anywhere. The
// user-facing vocabulary is "Trace" (one prompt-to-response cycle); see the
// glossary in Help.tsx.
const TABS = [
  { id: 'sessions',   label: 'Traces',     title: 'Trace list with expand-in-place detail — waterfall, files, cost, and flagged issues for each trace.' },
  { id: 'analytics',  label: 'Analytics',  title: 'Aggregate charts and metrics: token/cost trends, agent comparison, tool distribution, and active insights.' },
  { id: 'outcomes',   label: 'Outcomes',   title: 'AI code turnover for your own commits — how much agent-written code you merged is still there weeks later. Local, no account.' },
  { id: 'patterns',   label: 'Advisor',    title: 'Cross-trace behavioral patterns, efficiency map, hot files, and instruction file recommendations.' },
  { id: 'export',     label: 'Export',     title: 'Export raw or redacted trace data as JSON files.' },
  { id: 'import',     label: 'Import',     title: 'Import trace data from a TraceRoost export file.' },
]

function ActivePanel() {
  const tab = normalizeTabId(activeTab.value)
  switch (tab) {
    case 'sessions':  return <Sessions />
    case 'analytics': return <Analytics />
    case 'outcomes':  return <Outcomes />
    case 'patterns':  return <Patterns />
    case 'export':    return <Export />
    case 'import':    return <Import />
    case 'help':      return <Help />
    case 'pricing':   return <Pricing />
    default:          return null
  }
}

function normalizeTabId(tab: string): string {
  return tab
}

function CollapsibleSection({ title, children }: { title: string; children: any }) {
  const [open, setOpen] = useState(true)
  return (
    <div style="border-bottom:1px solid var(--border)">
      <button
        onClick={() => setOpen(o => !o)}
        style="display:flex;align-items:center;gap:6px;width:100%;padding:10px 14px;background:none;border:none;cursor:pointer;text-align:left;color:var(--fg)"
      >
        <span style={`color:var(--muted);font-size:9px;display:inline-block;transition:transform 0.15s;transform:rotate(${open ? 90 : 0}deg)`}>▶</span>
        <span style="font-size:12px;font-weight:600">{title}</span>
      </button>
      {open && (
        <div style="padding:0 14px 14px">
          {children}
        </div>
      )}
    </div>
  )
}

function ConfigPanel() {
  const open = configOpen.value

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') configOpen.value = false }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div
      inert={!open}
      aria-hidden={!open}
      style={`visibility:${open ? 'visible' : 'hidden'};position:fixed;top:0;right:0;bottom:0;width:min(440px,100%);background:var(--vscode-editor-background);border-left:1px solid var(--border);z-index:200;overflow-y:auto;transition:transform 0.2s ease;transform:${open ? 'translateX(0)' : 'translateX(100%)'};box-shadow:-4px 0 20px rgba(0,0,0,0.4)`}
    >
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--vscode-editor-background);z-index:1">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">Settings</span>
        <button
          onClick={() => configOpen.value = false}
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:0 4px;line-height:1"
          title="Close (Esc)"
        >×</button>
      </div>
      {window.__STANDALONE__ === true && <ThemeToggle />}
      <SessionsPageSizeControl />
      <IngestionToggles />
      <OtelReconfigureButton />
      <McpToggle />
      <CollapsibleSection title="Alerts">
        <Alerts />
      </CollapsibleSection>
      <CollapsibleSection title="Automation">
        <Automation />
      </CollapsibleSection>
    </div>
  )
}


const SEV_COLOR: Record<string, string> = {
  error:   '#f44747',
  warning: '#f6a623',
  info:    '#4fc3f7',
}

function IconBell() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function IconGear() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

// Fixed 12x12 so a status icon appearing/disappearing next to it never reflows neighboring
// controls — used by OutcomeFilterBar while git outcomes are still resolving.
function IconSpinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" style="display:block;animation:tr-spin 0.8s linear infinite">
      <path d="M21 12a9 9 0 1 1-9-9" />
    </svg>
  )
}

function IconHelp() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" stroke-width="3" />
    </svg>
  )
}

function IconDollar() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <circle cx="12" cy="12" r="10" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
      <path d="M12 6v12" />
    </svg>
  )
}

function AlertStatusCard({ alerts }: { alerts: TriggeredAlert[] }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') bellOpen.value = false }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      {/* Backdrop — click outside to close */}
      <div style="position:fixed;inset:0;z-index:199" onClick={() => bellOpen.value = false} />
      <div style="position:fixed;top:35px;right:8px;width:min(400px,calc(100vw - 16px));background:var(--vscode-editor-background);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,0.5);z-index:200;overflow:hidden">
        <div style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--muted)">
          Active Alerts
        </div>
        {alerts.length === 0 ? (
          <div style="padding:14px 12px;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:8px">
            <span style="color:#81c784;font-size:14px">✓</span> All clear — no alerts triggered
          </div>
        ) : (
          <div>
            {alerts.map((a, i) => {
              const color = SEV_COLOR[a.severity] ?? '#f6a623'
              return (
                <div key={i} style={`padding:10px 12px;border-left:3px solid ${color};${i > 0 ? 'border-top:1px solid var(--border)' : ''}`}>
                  <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
                    <span style={`display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0`} />
                    <span style={`font-size:12px;font-weight:600;color:${color}`}>{a.label}</span>
                  </div>
                  {a.detail && <div style="font-size:11px;color:var(--muted);line-height:1.4">{a.detail}</div>}
                </div>
              )
            })}
          </div>
        )}
        <div style="padding:8px 12px;border-top:1px solid var(--border)">
          <button
            style="font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;padding:0"
            onClick={() => { bellOpen.value = false; configOpen.value = true }}
          >Configure alerts →</button>
        </div>
      </div>
    </>
  )
}

function BellButton() {
  void displaySessions.value
  const count = computeAlertCount()
  const open = bellOpen.value
  return (
    <div style="position:relative;display:flex;align-items:center">
      <button
        class={'icon-btn' + (open ? ' active' : '')}
        title={count > 0 ? `${count} alert${count > 1 ? 's' : ''} triggered` : 'Alerts — none triggered'}
        onClick={() => { bellOpen.value = !bellOpen.value }}
      ><IconBell /></button>
      {count > 0 && <span class="alert-badge">{count}</span>}
      {open && <AlertStatusCard alerts={getTriggeredAlerts()} />}
    </div>
  )
}

function GearButton() {
  const active = configOpen.value
  return (
    <button
      class={'icon-btn' + (active ? ' active' : '')}
      title="Settings — Alerts & Automation"
      onClick={() => { configOpen.value = !configOpen.value }}
    ><IconGear /></button>
  )
}

function HelpButton() {
  const isActive = normalizeTabId(activeTab.value) === 'help'
  return (
    <button
      class={'icon-btn' + (isActive ? ' active' : '')}
      title="Help"
      onClick={() => { activeTab.value = 'help' }}
    ><IconHelp /></button>
  )
}

function PricingButton() {
  const isActive = normalizeTabId(activeTab.value) === 'pricing'
  return (
    <button
      class={'icon-btn' + (isActive ? ' active' : '')}
      title="Pricing — full rate table TraceRoost uses to estimate cost"
      onClick={() => { activeTab.value = 'pricing' }}
    ><IconDollar /></button>
  )
}

export function App() {
  // Global smart tooltip for [data-tip] elements
  useEffect(() => {
    let tipEl: HTMLDivElement | null = null
    function show(e: MouseEvent) {
      const target = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement | null
      if (!target) return
      const text = target.getAttribute('data-tip')
      if (!text) return
      if (!tipEl) {
        tipEl = document.createElement('div')
        tipEl.className = 'metric-tooltip'
        document.body.appendChild(tipEl)
      }
      tipEl.textContent = text
      tipEl.style.display = 'block'
      const rect = target.getBoundingClientRect()
      const tipW = 220, tipH = tipEl.offsetHeight || 60
      let left = rect.left + rect.width / 2 - tipW / 2
      let top = rect.bottom + 6
      // Keep within viewport horizontally
      if (left < 4) left = 4
      if (left + tipW > window.innerWidth - 4) left = window.innerWidth - tipW - 4
      // If overflowing bottom, show above
      if (top + tipH > window.innerHeight - 4) top = rect.top - tipH - 6
      tipEl.style.left = left + 'px'
      tipEl.style.top = top + 'px'
    }
    function hide() { if (tipEl) tipEl.style.display = 'none' }
    document.addEventListener('mouseover', show)
    document.addEventListener('mouseout', hide)
    return () => {
      document.removeEventListener('mouseover', show)
      document.removeEventListener('mouseout', hide)
      if (tipEl) { tipEl.remove(); tipEl = null }
    }
  }, [])

  // Handle messages from the extension host
  useEffect(() => {
    let initialLoadDone = false
    const handler = (e: MessageEvent) => {
      const msg = e.data as {
        type: string
        summary?: { toolCalls?: Record<string, number> }
        sessionSummary?: typeof sessionSummary.value
        tab?: string
        agentFilter?: AgentFilter
        sessionLimit?: number
        sessionId?: string
        timeline?: TimelineEntry[]
        outcome?: GitOutcome | null
        workspace?: string
        name?: string | null
        hash?: string | null
        spanId?: string
        field?: string
        content?: string | null
        analyticsData?: { dailyStats: DailyStatRow[]; lifetimeStats: LifetimeStats }
        burnRate?: { sessionId: string; burnRate: BurnRate; projection: Projection | null } | null
        sessions?: SessionSummaryCard[]
        totalCount?: number
        offset?: number
        enableOtelIngestion?: boolean
        enableLogIngestion?: boolean
        otlpPort?: number
        results?: OtelReconfigureResult
      }
      if (msg.type === 'update') {
        if (msg.enableOtelIngestion !== undefined) enableOtelIngestion.value = msg.enableOtelIngestion
        if (msg.enableLogIngestion !== undefined) enableLogIngestion.value = msg.enableLogIngestion
        if (msg.otlpPort !== undefined) otlpPort.value = msg.otlpPort
        if (msg.summary?.toolCalls) toolCalls.value = msg.summary.toolCalls
        if (msg.sessionSummary !== undefined) sessionSummary.value = msg.sessionSummary
        if (msg.analyticsData) {
          dailyStats.value = msg.analyticsData.dailyStats
          lifetimeStats.value = msg.analyticsData.lifetimeStats
        }
        if (msg.burnRate !== undefined) {
          burnRateData.value = msg.burnRate ?? null
        }
        if (!initialLoadDone) {
          initialLoadDone = true
          setTimeout(() => {
            checkAutomations(sessionSummary.value?.sessions ?? displaySessions.value)
            checkAlerts()
          }, 0)
        } else {
          setTimeout(() => {
            const triggers = checkAutomations(displaySessions.value)
            for (const t of triggers) {
              vscode?.postMessage({ type: 'automation', ...t })
            }
            const alertNotifications = checkAlerts()
            for (const a of alertNotifications) {
              vscode?.postMessage({ type: 'alert', label: a.label, detail: a.detail, severity: a.severity })
            }
          }, 0)
        }
      } else if (msg.type === 'sessionDetail' && msg.sessionId) {
        sessionTimelines.value = { ...sessionTimelines.value, [msg.sessionId]: msg.timeline ?? [] }
      } else if (msg.type === 'gitOutcome' && msg.sessionId) {
        gitOutcomes.value = { ...gitOutcomes.value, [msg.sessionId]: msg.outcome ?? null }
      } else if (msg.type === 'repoHash' && msg.workspace !== undefined) {
        const entry = (msg.name && msg.hash) ? { name: msg.name, hash: msg.hash } : null
        repoInfo.value = { ...repoInfo.value, [msg.workspace]: entry }
      } else if (msg.type === 'blobContent' && msg.spanId && msg.field) {
        const key = `${msg.spanId}:${msg.field}`
        if (msg.content != null) {
          blobCache.value = { ...blobCache.value, [key]: msg.content }
        }
      } else if (msg.type === 'switchTab' && msg.tab) {
        const tab = normalizeTabId(msg.tab)
        if (tab === 'alerts' || tab === 'automation' || tab === 'settings-automation') {
          configOpen.value = true
        } else {
          activeTab.value = tab
        }
      } else if (msg.type === 'setFilter') {
        if (msg.agentFilter !== undefined) {
          selectedAgentFilter.value = msg.agentFilter
          const sel = document.getElementById('agent-filter') as HTMLSelectElement
          if (sel) sel.value = msg.agentFilter
        }
        if (msg.sessionLimit !== undefined) {
          const limit = Number(msg.sessionLimit)
          sessionLimit.value = limit
          const sel = document.getElementById('session-limit') as HTMLSelectElement
          if (sel) sel.value = String(limit)
        }
      } else if (msg.type === 'instructionFiles' && Array.isArray((msg as unknown as {files?: unknown}).files)) {
        instructionFiles.value = (msg as unknown as {files: typeof instructionFiles.value}).files
      } else if (msg.type === 'appliedSuggestions' && Array.isArray((msg as unknown as {records?: unknown}).records)) {
        appliedSuggestions.value = (msg as unknown as {records: typeof appliedSuggestions.value}).records
      } else if (msg.type === 'dismissedSuggestions' && Array.isArray((msg as unknown as {ids?: unknown}).ids)) {
        dismissedIds.value = new Set((msg as unknown as {ids: string[]}).ids)
      } else if (msg.type === 'reconfigureOtelResult' && msg.results) {
        otelReconfigureResult.value = msg.results
      } else if (msg.type === 'teamStatus') {
        teamStatus.value = (msg as unknown as { status: typeof teamStatus.value }).status
        teamBusy.value = null
      } else if (msg.type === 'teamPayloadPreview') {
        teamPayloadPreview.value = (msg as unknown as { preview: typeof teamPayloadPreview.value }).preview
      } else if (msg.type === 'teamActionResult') {
        teamBusy.value = null
        requestTeamStatus()
      } else if (msg.type === 'teamReconcileResult') {
        teamReconcileBusy.value = false
        teamReconcileResult.value = { queued: (msg as unknown as { queued: number }).queued }
      } else if (msg.type === 'outcomesProgress') {
        outcomesProgress.value = (msg as unknown as { progress: typeof outcomesProgress.value }).progress
      } else if (msg.type === 'outcomesReport') {
        outcomesLoading.value = false
        outcomesProgress.value = null
        outcomesReport.value = (msg as unknown as { report: typeof outcomesReport.value }).report
      } else if (msg.type === 'instructionApplied') {
        // Re-request applied list after successful apply — handled by appliedSuggestions message
      } else if (msg.type === 'searchResults' && msg.sessions != null) {
        const data = {
          sessions: msg.sessions,
          totalCount: msg.totalCount ?? 0,
          offset: msg.offset ?? 0,
        }
        const context = (msg as { context?: string }).context
        if (context === 'timeRange') {
          rangedSearchResults.value = data
        } else if (context === 'export') {
          exportSearchResults.value = data
        } else {
          searchResults.value = data
        }
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  // Ask once, on mount, so the tab-bar state dot is honest immediately. This is answered from
  // local data only — an unlinked install makes no request as a result of this.
  useEffect(() => { requestTeamStatus() }, [])
  void teamOpen.value

  const tab = normalizeTabId(activeTab.value)
  const showFilterBars = tab !== 'help' && tab !== 'pricing'

  return (
    <>
      <div class="tabs">
        <span class="tr-wordmark" title="TraceRoost">
          <Wordmark size={15} />
        </span>
        <button
          class="sidebar-toggle-btn"
          title={sidebarOpen.value ? 'Close TraceRoost sidebar' : 'Open TraceRoost sidebar'}
          onClick={() => {
            const opening = !sidebarOpen.value
            sidebarOpen.value = opening
            if (vscode) {
              vscode.postMessage({ type: opening ? 'openSidebar' : 'closeSidebar' })
            } else {
              window.dispatchEvent(new CustomEvent('traceroost:sidebar', { detail: { open: opening } }))
            }
          }}
        >
          {sidebarOpen.value ? '◄' : '►'}
        </button>
        {TABS.map(t => <Tab key={t.id} id={t.id} label={t.label} />)}
        <div style="margin-left:auto;display:flex;align-items:center;border-left:1px solid var(--border);padding-left:2px">
          <TeamButton />
          <BellButton />
          <GearButton />
          <PricingButton />
          <HelpButton />
        </div>
      </div>

      {showFilterBars && <TimeRangePicker />}
      {showFilterBars && <SearchFilterBar />}
      {showFilterBars && <OutcomeFilterBar />}
      <div class="panel active h-scroll-hint">
        <ActivePanel />
      </div>

      <ConfigPanel />
      <TeamPanel />
    </>
  )
}

// `color` is the pill's identity color — its border in both states, fed to the shared `.tr-pill`
// class (pills.css) as `--tr-pill-color`. 'all' and 'opencode' use var(--fg) rather than a
// literal white for their neutral "pop" look, which used to be invisible (white border on a
// white page) in light mode.
const AGENT_FILTER_OPTIONS: Array<{ value: AgentFilter; label: string; color: string }> = [
  { value: 'all',        label: 'All',      color: 'var(--fg)' },
  { value: 'copilot',    label: 'Copilot',  color: 'var(--agent-copilot,#00EAFF)' },
  { value: 'claude_code',label: 'Claude',   color: 'var(--agent-claude,#FFB085)' },
  { value: 'codex',      label: 'Codex',    color: 'var(--agent-codex,#F0FF42)' },
  { value: 'opencode',   label: 'OpenCode', color: 'var(--fg)' },
]

function TimeRangePicker({ hideAgentFilter = false }: { hideAgentFilter?: boolean }) {
  const range = timeRange.value
  const agent = selectedAgentFilter.value
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const responseTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const tab = normalizeTabId(activeTab.value)
  const showReset = tab !== 'help'
  // Pagination only makes sense for the Sessions tab's own table — every other tab sharing this
  // row has no notion of "pages." Mirrors the bottom footer's own controls in Sessions.tsx exactly
  // (same styling, same sessionsPage signal) so the two never disagree.
  const showPaging = tab === 'sessions'
  const sessionCount = filteredSessions.value.length
  const { page: sessPage, totalPages: sessTotalPages } = showPaging ? getSessionsPagination(sessionCount) : { page: 0, totalPages: 1 }

  const isFiltered = sessionTextFilter.value !== '' ||
    evidenceSessionIds.value !== null ||
    selectedAgentFilter.value !== 'all' ||
    initiatorFilter.value !== 'all' ||
    dataSourceFilter.value !== 'all' ||
    workspaceFilter.value !== '' ||
    outcomeFilter.value !== 'all' ||
    sessionLimit.value !== 25 ||
    timeRange.value.preset !== 'all' ||
    sessionSortKey.value !== 'start_time' ||
    sessionSortDir.value !== 'desc'

  function resetFilters() {
    sessionTextFilter.value = ''
    evidenceSessionIds.value = null
    evidenceSessionPrompt.value = null
    selectedAgentFilter.value = 'all'
    initiatorFilter.value = 'all'
    dataSourceFilter.value = 'all'
    workspaceFilter.value = ''
    outcomeFilter.value = 'all'
    sessionLimit.value = 25
    timeRange.value = { preset: 'all' }
    sessionSortKey.value = 'start_time'
    sessionSortDir.value = 'desc'
  }

  function fireSearch(r: typeof timeRange.value) {
    if (r.preset === 'all') {
      rangedSearchResults.value = null
      setLoading(false)
      setSearchError(null)
      if (responseTimeout.current) clearTimeout(responseTimeout.current)
      return
    }
    const ext = vscode
    if (!ext) {
      setSearchError('Extension offline — time range filtering unavailable')
      setLoading(false)
      return
    }
    setLoading(true)
    setSearchError(null)
    if (debounce.current) clearTimeout(debounce.current)
    if (responseTimeout.current) clearTimeout(responseTimeout.current)
    debounce.current = setTimeout(() => {
      ext.postMessage({
        type: 'searchSessions',
        query: { since: r.since, until: r.until, limit: CHART_MAX, orderBy: 'start_time', orderDir: 'DESC' },
        context: 'timeRange',
      })
      responseTimeout.current = setTimeout(() => {
        setLoading(false)
        setSearchError('No response from extension')
      }, 5000)
    }, 120)
  }

  function selectPreset(id: typeof range.preset) {
    const r = makeTimeRange(id)
    timeRange.value = r
    fireSearch(r)
  }

  // Clear loading indicator and timeout when results arrive
  useEffect(() => {
    if (rangedSearchResults.value !== null) {
      setLoading(false)
      setSearchError(null)
      if (responseTimeout.current) { clearTimeout(responseTimeout.current); responseTimeout.current = null }
    }
  }, [rangedSearchResults.value])

  const isActive = range.preset !== 'all'
  // For "All" time: use full unfiltered in-memory list (no limit, no agent filter)
  // so pills reflect every agent that has ever recorded a session in memory.
  // For bounded presets: use rangedSessions which merges DB history with in-memory.
  const baseSessions = isActive ? rangedSessions.value : (sessionSummary.value?.sessions ?? [])
  const presentSources = new Set(baseSessions.map(s => s.source))

  return (
    <div class="time-range-bar" role="group" aria-label="Time and agent filters" style="display:flex;align-items:center;gap:0;padding:0 8px 6px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0">
      {/* Time presets */}
      <span style="font-size:10px;color:var(--muted);margin-right:6px;white-space:nowrap;text-transform:uppercase;letter-spacing:.3px">Time</span>
      <div style="display:flex;gap:1px">
        {TIME_PRESETS.map(p => (
          <button
            key={p.id}
            class="tr-time-pill"
            aria-pressed={range.preset === p.id}
            onClick={() => selectPreset(p.id)}
            title={p.ms ? `Last ${p.label}` : 'All recorded traces'}
          >{p.label}</button>
        ))}
      </div>

      {/* Agent filter — hidden on tabs that don't need it */}
      {!hideAgentFilter && (
        <div style="display:flex;gap:3px;align-items:center;margin-left:10px">
          <span style="font-size:10px;color:var(--muted);margin-right:4px;white-space:nowrap;text-transform:uppercase;letter-spacing:.3px">Agent</span>
          {AGENT_FILTER_OPTIONS.map(o => (
            <button
              key={o.value}
              class="tr-pill"
              aria-pressed={agent === o.value}
              onClick={() => { selectedAgentFilter.value = o.value }}
              style={`--tr-pill-color:${o.color}`}
            >{o.label}</button>
          ))}
        </div>
      )}

      {/* Status/Reset/paging all stay grouped together and right-aligned — margin-left:auto on
          the wrapper (not the individual controls) pulls the whole row against whatever's
          before it. Reset sits right next to PageSizeSelect (the "page size" control) rather
          than off on its own. */}
      <span style="margin-left:auto;display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted);white-space:nowrap">
        <span role="status" class="range-status" title={searchError ?? undefined}>
          {searchError ? `⚠ ${searchError}` : ''}
        </span>

        {loading && (
          <span style="display:inline-flex;color:var(--accent)" role="status" aria-label="Refreshing" title="Refreshing this time range">
            <IconSpinner />
          </span>
        )}

        {showReset && (
          <button
            class="tr-reset-btn"
            disabled={!isFiltered}
            onClick={resetFilters}
            style={
              isFiltered
                ? 'border:1px solid var(--accent);background:color-mix(in srgb, var(--accent) 14%, transparent);color:var(--accent)'
                : 'border:1px solid var(--vscode-panel-border);background:transparent;color:var(--muted)'
            }
          >Reset</button>
        )}

        {/* Trace paging — same controls, same styling, same signal as the table's own footer in
            Sessions.tsx, just also reachable without scrolling down first. Keep the controls
            mounted for short and empty results so the toolbar remains steady. */}
        {showPaging && (
          <>
            <PageSizeSelect />
            <button
              onClick={() => sessionsPage.value = Math.max(0, sessPage - 1)}
              disabled={sessPage === 0}
              style={`padding:2px 8px;font-size:11px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--fg);cursor:${sessPage === 0 ? 'default' : 'pointer'};opacity:${sessPage === 0 ? 0.4 : 1}`}
            >‹ Prev</button>
            <span style="display:inline-block;min-width:11ch;text-align:center;font-variant-numeric:tabular-nums">Page {sessPage + 1} of {sessTotalPages}</span>
            <button
              onClick={() => sessionsPage.value = Math.min(sessTotalPages - 1, sessPage + 1)}
              disabled={sessPage >= sessTotalPages - 1}
              style={`padding:2px 8px;font-size:11px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--fg);cursor:${sessPage >= sessTotalPages - 1 ? 'default' : 'pointer'};opacity:${sessPage >= sessTotalPages - 1 ? 0.4 : 1}`}
            >Next ›</button>
          </>
        )}
      </span>
    </div>
  )
}

const DATA_SOURCE_FILTER_OPTIONS: Array<{ value: DataSourceFilter; label: string; color: string }> = [
  { value: 'all',  label: 'All',  color: DATA_SOURCE_COLORS.all },
  { value: 'otel', label: 'OTEL', color: DATA_SOURCE_COLORS.otel },
  { value: 'log',  label: 'Log',  color: DATA_SOURCE_COLORS.log },
]

const INITIATOR_FILTER_OPTIONS: Array<{ value: InitiatorFilter; label: string; color: string }> = [
  { value: 'all',   label: 'All',   color: INITIATOR_COLORS.all },
  { value: 'user',  label: 'User',  color: INITIATOR_COLORS.user },
  { value: 'agent', label: 'Agent', color: INITIATOR_COLORS.agent },
]

// Mirrors traceroost-cloud's own `FilterPills` (src/app/(protected)/[org]/traces/traces-table.tsx)
// almost line for line — both render the shared `.tr-pill` class from pills.css.
function FilterPills<T extends string>({ options, value, onChange }: {
  options: Array<{ value: T; label: string; color: string; title?: string }>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div style="display:flex;gap:3px">
      {options.map(o => (
        <button
          key={o.value}
          class="tr-pill"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          style={`--tr-pill-color:${o.color}`}
          title={o.title}
        >{o.label}</button>
      ))}
    </div>
  )
}

const OUTCOME_FILTER_OPTIONS: Array<{ value: OutcomeFilter; label: string; color: string; title: string }> = [
  { value: 'all',       label: 'All',       color: 'var(--fg)',      title: 'Show all traces' },
  { value: 'merged',    label: 'Merged',    color: 'var(--tr-merged)', title: "Changed files were committed and are still there, per this repo's git history" },
  { value: 'reverted',  label: 'Reverted',  color: 'var(--error)',   title: 'Changed files are back to their pre-trace content, per git history' },
  { value: 'abandoned', label: 'Abandoned', color: '#f6a623',        title: 'Changed files are still sitting uncommitted' },
  { value: 'unknown',   label: 'Unknown',   color: 'var(--muted)',   title: 'Git outcome not yet determined, or not applicable (no repo, or no files changed)' },
]

// The local-git equivalent of traceroost-cloud's own Outcome filter (same TracesTable this
// mirrors). Every other pill row on this bar filters on data every session already carries; this
// one doesn't — classifySessionOutcome (src/gitOutcome.ts) shells out to git per changed file, so
// it's normally computed lazily, one session at a time, only once that session's Files view opens
// (see SessionDetail in Sessions.tsx). Turning this filter on needs it for every candidate session
// up front instead, so it requests git outcomes for the current candidate set here — capped and
// staggered by requestGitOutcomesFor (state.ts) rather than firing everything at once.
//
// Source and From share this row (after Outcome) rather than SearchFilterBar below — this is now
// the one row that holds every pill-style filter; SearchFilterBar is left with only the "viewing
// evidence for a suggestion" banner, since Project and Prompt became inline table-header controls
// (see Sessions.tsx's RepoDropdown and its Prompt header cell).
function OutcomeFilterBar() {
  const filter = outcomeFilter.value
  const candidates = preOutcomeFilteredSessions.value
  const outcomes = gitOutcomes.value
  const dsFilter = dataSourceFilter.value
  const iFilter = initiatorFilter.value

  useEffect(() => {
    if (filter === 'all') return
    requestGitOutcomesFor(candidates)
  }, [filter, candidates])

  const pendingCount = filter === 'all' ? 0 : candidates.filter(s => outcomes[s.sessionId] === undefined).length

  return (
    <div class="search-filter-controls" role="group" aria-label="Trace filters" style="display:flex;align-items:center;gap:5px;padding:4px 8px 6px;flex-wrap:wrap;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0">
      <span style="font-size:10px;color:var(--muted);white-space:nowrap;text-transform:uppercase;letter-spacing:.3px">Outcome</span>
      <FilterPills
        options={OUTCOME_FILTER_OPTIONS}
        value={filter}
        onChange={v => { outcomeFilter.value = v }}
      />
      {/* Fixed-size slot, always present, so the icon popping in/out while outcomes resolve never
          shifts Source/From/the trace count next to it. */}
      <span
        style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex-shrink:0;color:var(--muted)"
        role={pendingCount > 0 ? 'status' : undefined}
        aria-label={pendingCount > 0 ? `Resolving ${pendingCount} outcome${pendingCount !== 1 ? 's' : ''} from git` : undefined}
        title={pendingCount > 0 ? `Resolving ${pendingCount} outcome${pendingCount !== 1 ? 's' : ''} from git…` : undefined}
      >
        {pendingCount > 0 && <IconSpinner />}
      </span>
      <span style="font-size:10px;color:var(--muted);white-space:nowrap;text-transform:uppercase;letter-spacing:.3px;margin-left:8px">Source</span>
      <FilterPills
        options={DATA_SOURCE_FILTER_OPTIONS.map(o => ({ ...o, title: o.value === 'all' ? 'Show all data sources' : o.value === 'otel' ? 'OpenTelemetry traces only' : 'Log-file traces only' }))}
        value={dsFilter}
        onChange={v => { dataSourceFilter.value = v }}
      />
      <span style="font-size:10px;color:var(--muted);white-space:nowrap;text-transform:uppercase;letter-spacing:.3px">From</span>
      <FilterPills
        options={INITIATOR_FILTER_OPTIONS.map(o => ({ ...o, title: o.value === 'all' ? 'Show all traces' : o.value === 'user' ? 'Human-typed prompts only' : 'Agent-spawned sub-tasks and non-interactive claude -p calls' }))}
        value={iFilter}
        onChange={v => { initiatorFilter.value = v }}
      />
      <span role="status" style="margin-left:auto;min-width:10ch;text-align:right;font-variant-numeric:tabular-nums;font-size:10px;color:var(--muted);white-space:nowrap;padding-right:2px">{filteredSessions.value.length} trace{filteredSessions.value.length !== 1 ? 's' : ''}</span>
    </div>
  )
}

// Only the evidence-view banner remains here — Project (now Repo) and the trace-text filter moved
// into the trace table's own column headers (Sessions.tsx), and Outcome/Source/From live together
// on OutcomeFilterBar above.
function SearchFilterBar() {
  const evIds = evidenceSessionIds.value
  if (evIds === null) return null

  return (
    <div style="display:flex;align-items:center;gap:6px;padding:4px 8px;background:#4fc3f711;border-bottom:1px solid #4fc3f733;flex-shrink:0">
      <span style="font-size:10px;color:#4fc3f7;white-space:nowrap;flex-shrink:0">Showing {evIds.size} trace{evIds.size !== 1 ? 's' : ''} {evidenceSessionLabel.value}</span>
      {evidenceSessionPrompt.value && (
        <span
          style="font-size:10px;color:#4fc3f7;opacity:0.75;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0"
          title={evidenceSessionPrompt.value}
        >— "{evidenceSessionPrompt.value}"</span>
      )}
      <button
        onClick={() => { evidenceSessionIds.value = null; evidenceSessionPrompt.value = null }}
        style="margin-left:auto;flex-shrink:0;background:none;border:1px solid #4fc3f766;border-radius:3px;color:#4fc3f7;cursor:pointer;font-size:10px;padding:2px 8px;white-space:nowrap"
      >Show all traces</button>
    </div>
  )
}

// Each Tab reads activeTab.value independently so the active class stays correct
// regardless of what caused (or didn't cause) the parent component to re-render.
function Tab({ id, label }: { id: string; label: string; title?: string }) {
  const isActive = normalizeTabId(activeTab.value) === id
  return (
    <button
      class={'tab' + (isActive ? ' active' : '')}
      data-tab={id}
      aria-current={isActive ? 'page' : undefined}
      onClick={() => { activeTab.value = id }}
    >
      {label}
    </button>
  )
}
