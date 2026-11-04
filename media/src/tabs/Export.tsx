import { useEffect, useState } from 'preact/hooks'
import {
  filteredSessions, vscode, timeRange, rangedSearchResults, exportSearchResults,
  agentFilteredSessions, selectedAgentFilter, workspaceFilter, dataSourceFilter,
  sessionTextFilter, initiatorFilter, evidenceSessionIds, repoInfo, matchesRepoQuery,
  languageFilter, matchesLanguageFilter, exportOpen,
} from '../state'
import { useDialog } from '../a11y'
import { CloudNote } from './CloudNote'
import type { SessionSummaryCard } from '../types'

type ExportFormat = 'json' | 'csv' | 'markdown'
const FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'csv', label: 'CSV' },
  { value: 'markdown', label: 'Markdown' },
]

function send(type: string, sessionIds: string[], format: ExportFormat) {
  if (vscode) {
    vscode.postMessage({ type, sessionIds, format })
  } else {
    window.dispatchEvent(new MessageEvent('message', { data: { type, sessionIds, format } }))
  }
}

// Requests every session matching the current time range / agent / text filters, uncapped —
// time range, agent, and text are pushed into the DB query itself; the filters below aren't
// part of SearchQuery so they're re-applied client-side once results come back.
function requestFullExportSessions() {
  const range = timeRange.value
  const agent = selectedAgentFilter.value
  const text = sessionTextFilter.value.trim()
  const query = {
    since: range.since,
    until: range.until,
    source: agent !== 'all' ? agent : undefined,
    text: text || undefined,
    limit: 1_000_000,
    orderBy: 'start_time',
    orderDir: 'DESC',
  }
  if (vscode) {
    vscode.postMessage({ type: 'searchSessions', query, context: 'export' })
  } else {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'searchSessions', query, context: 'export' } }))
  }
}

// dataSourceFilter/languageFilter/workspaceFilter/initiatorFilter/evidenceSessionIds aren't part of the DB
// query above, so they're applied here against the uncapped result set.
function applyRemainingFilters(sessions: SessionSummaryCard[]): SessionSummaryCard[] {
  let result = sessions
  const dsFilter = dataSourceFilter.value
  if (dsFilter !== 'all') result = result.filter(s => (s.dataSource ?? 'otel') === dsFilter)
  const lang = languageFilter.value
  if (lang !== 'all') result = result.filter(s => matchesLanguageFilter(s, lang))
  // workspaceFilter is the toolbar's freeform repo search (empty = no filter, matching a
  // workspace's git-derived name/hash or its raw path — state.ts's matchesRepoQuery), not the
  // old 'all'-sentinel dropdown this used to check against.
  const wsFilter = workspaceFilter.value.trim()
  if (wsFilter !== '') {
    const info = repoInfo.value
    result = result.filter(s => matchesRepoQuery(s.workspace ?? '', wsFilter, info))
  }
  const iFilter = initiatorFilter.value
  if (iFilter !== 'all') {
    result = result.filter(s => {
      const init = s.initiator ?? 'user'
      return iFilter === 'agent' ? (init === 'agent' || init === 'api') : init === iFilter
    })
  }
  const evIds = evidenceSessionIds.value
  if (evIds !== null) result = result.filter(s => evIds.has(s.sessionId))
  return result
}

function FormatSelect({ value, onChange }: { value: ExportFormat; onChange: (f: ExportFormat) => void }) {
  return (
    <select
      value={value}
      onChange={e => onChange((e.target as HTMLSelectElement).value as ExportFormat)}
      class="export-format-select"
      aria-label="Export format"
    >
      {FORMAT_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
    </select>
  )
}

type ExportKind = 'redacted' | 'full'

// The Export drawer, opened from the Traces filter row's Export… button (App.tsx's
// FilterActionsBar) or the host's `switchTab` 'export'. It exports whatever the filters currently
// select, so it sits beside them instead of being a tab of its own. Redacted is the default: it's
// the one that's safe to hand to someone else.
export function ExportDialog() {
  const open = exportOpen.value
  const ref = useDialog<HTMLDivElement>(open, () => { exportOpen.value = false })
  const [kind, setKind] = useState<ExportKind>('redacted')
  const [format, setFormat] = useState<ExportFormat>('json')
  const [done, setDone] = useState(false)
  // Set while waiting on the uncapped fetch for a bounded time range; null the rest of the time.
  const [pending, setPending] = useState<{ redact: boolean; format: ExportFormat } | null>(null)

  const isAllTime = timeRange.value.preset === 'all'
  // Capped preview list — fine for the "All" time range (already uncapped there) and for the
  // on-screen count/empty-state check, but never used directly as the bounded-range export payload.
  const sessions = filteredSessions.value
  const empty = sessions.length === 0
  const trueTotal = isAllTime ? sessions.length : (rangedSearchResults.value?.totalCount ?? sessions.length)
  const scopeLabel = trueTotal === 1
    ? '1 trace matches your current filters'
    : `${trueTotal} traces match your current filters`

  const markDone = () => { setDone(true); setTimeout(() => setDone(false), 3000) }

  useEffect(() => {
    if (!pending) return
    const results = exportSearchResults.value
    if (!results) return  // still waiting on the response

    // Merge DB results with any in-memory sessions in range not yet persisted — same pattern
    // rangedSessions uses for on-screen display, so export and display never disagree.
    const range = timeRange.value
    const since = range.since ?? 0
    const until = range.until ?? Date.now()
    const dbIds = new Set(results.sessions.map(s => s.sessionId))
    const inMemoryInRange = agentFilteredSessions.value.filter(s => {
      if (dbIds.has(s.sessionId)) return false
      if (!s.startTime) return false
      const ms = new Date(s.startTime).getTime()
      return ms >= since && ms <= until
    })
    const finalSessions = applyRemainingFilters([...results.sessions, ...inMemoryInRange])
    send(pending.redact ? 'exportSessionDataRedacted' : 'exportSessionData', finalSessions.map(s => s.sessionId), pending.format)
    markDone()
    setPending(null)
    exportSearchResults.value = null
  }, [pending, exportSearchResults.value])

  const doExport = () => {
    const redact = kind === 'redacted'
    if (isAllTime) {
      send(redact ? 'exportSessionDataRedacted' : 'exportSessionData', sessions.map(s => s.sessionId), format)
      markDone()
      return
    }
    setPending({ redact, format })
    requestFullExportSessions()
  }

  const preparing = pending !== null
  const count = trueTotal === 1 ? '1 trace' : `${trueTotal} traces`

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-drawer-title"
      inert={!open}
      aria-hidden={!open}
      style={`visibility:${open ? 'visible' : 'hidden'};position:fixed;top:0;right:0;bottom:0;width:min(440px,100%);background:var(--vscode-editor-background);border-left:1px solid var(--border);z-index:200;overflow-y:auto;transition:transform 0.2s ease;transform:${open ? 'translateX(0)' : 'translateX(100%)'};box-shadow:-4px 0 20px rgba(0,0,0,0.4)`}
    >
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--vscode-editor-background);z-index:1">
        <h2 id="export-drawer-title" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:0">Export traces</h2>
        <button
          onClick={() => exportOpen.value = false}
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:0 4px;line-height:1"
          title="Close (Esc)"
          aria-label="Close export"
        >×</button>
      </div>

      <div id="export-content">
        <div class={'export-scope-box' + (empty ? ' export-scope-box-empty' : '')}>
          {empty ? 'No traces match your current filters — nothing to export' : scopeLabel}
        </div>

        <fieldset class="export-kind">
          <legend class="export-field-label">What to include</legend>
          <label class={'export-kind-option' + (kind === 'redacted' ? ' selected' : '')}>
            <input type="radio" name="export-kind" value="redacted" checked={kind === 'redacted'} onChange={() => setKind('redacted')} />
            <span>
              <span class="export-kind-title">Redacted</span>
              <span class="export-kind-desc">Prompt text and file paths replaced with <span class="export-redacted-label">[redacted]</span>. Safer to share.</span>
            </span>
          </label>
          <label class={'export-kind-option' + (kind === 'full' ? ' selected' : '')}>
            <input type="radio" name="export-kind" value="full" checked={kind === 'full'} onChange={() => setKind('full')} />
            <span>
              <span class="export-kind-title">Full</span>
              <span class="export-kind-desc">Includes prompt text and file paths. Keep private.</span>
            </span>
          </label>
        </fieldset>

        <div class="export-format-row">
          <span class="export-field-label">Format</span>
          <FormatSelect value={format} onChange={setFormat} />
        </div>
        <p class="export-hint">
          JSON can be imported back into TraceRoost. CSV is for spreadsheets, Markdown for a readable report.
        </p>

        <button
          class={'export-btn' + (done ? ' export-btn-done' : '')}
          onClick={doExport}
          disabled={empty || preparing}
        >
          {done ? '✓ Exported' : preparing ? 'Preparing…' : `Export ${count}`}
        </button>

        <div class="export-about">
          <p class="export-replay-desc">
            Every export has tokens, tools, cost, file changes and efficiency signals for each trace.
            A teammate can open a JSON export by dropping it on their TraceRoost dashboard,
            or with <strong>Import traces</strong> in ⚙ Settings.
          </p>
          <CloudNote kind="export" />
        </div>
      </div>
    </div>
  )
}
