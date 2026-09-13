import { useEffect, useState } from 'preact/hooks'
import {
  filteredSessions, vscode, timeRange, rangedSearchResults, exportSearchResults,
  agentFilteredSessions, selectedAgentFilter, workspaceFilter, dataSourceFilter,
  sessionTextFilter, initiatorFilter, evidenceSessionIds,
} from '../state'
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

// dataSourceFilter/workspaceFilter/initiatorFilter/evidenceSessionIds aren't part of the DB
// query above, so they're applied here against the uncapped result set.
function applyRemainingFilters(sessions: SessionSummaryCard[]): SessionSummaryCard[] {
  let result = sessions
  const dsFilter = dataSourceFilter.value
  if (dsFilter !== 'all') result = result.filter(s => (s.dataSource ?? 'otel') === dsFilter)
  const wsFilter = workspaceFilter.value
  if (wsFilter !== 'all') result = result.filter(s => (s.workspace ?? '') === wsFilter)
  const iFilter = initiatorFilter.value
  if (iFilter !== 'all') result = result.filter(s => (s.initiator ?? 'user') === iFilter)
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

export function Export() {
  const [rawDone, setRawDone] = useState(false)
  const [redactedDone, setRedactedDone] = useState(false)
  const [rawFormat, setRawFormat] = useState<ExportFormat>('json')
  const [redactedFormat, setRedactedFormat] = useState<ExportFormat>('json')
  // Set while waiting on the uncapped fetch for a bounded time range; null the rest of the time.
  const [pending, setPending] = useState<{ redact: boolean; format: ExportFormat } | null>(null)

  const isAllTime = timeRange.value.preset === 'all'
  // Capped preview list — fine for the "All" time range (already uncapped there) and for the
  // on-screen count/empty-state check, but never used directly as the bounded-range export payload.
  const sessions = filteredSessions.value
  const empty = sessions.length === 0
  const trueTotal = isAllTime ? sessions.length : (rangedSearchResults.value?.totalCount ?? sessions.length)
  const scopeLabel = `${trueTotal} trace${trueTotal === 1 ? '' : 's'} matching your current filters`

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

    if (pending.redact) { setRedactedDone(true); setTimeout(() => setRedactedDone(false), 3000) }
    else { setRawDone(true); setTimeout(() => setRawDone(false), 3000) }
    setPending(null)
    exportSearchResults.value = null
  }, [pending, exportSearchResults.value])

  const doExport = () => {
    if (isAllTime) {
      send('exportSessionData', sessions.map(s => s.sessionId), rawFormat)
      setRawDone(true)
      setTimeout(() => setRawDone(false), 3000)
      return
    }
    setPending({ redact: false, format: rawFormat })
    requestFullExportSessions()
  }

  const doRedacted = () => {
    if (isAllTime) {
      send('exportSessionDataRedacted', sessions.map(s => s.sessionId), redactedFormat)
      setRedactedDone(true)
      setTimeout(() => setRedactedDone(false), 3000)
      return
    }
    setPending({ redact: true, format: redactedFormat })
    requestFullExportSessions()
  }

  const preparingRaw = pending !== null && !pending.redact
  const preparingRedacted = pending !== null && pending.redact

  return (
    <div id="export-content" style="padding-top:8px">

      <div class="export-cards">

        <div class="export-card">
          <div class="export-card-header">
            <span class="export-card-title">Export Trace Data</span>
            <span class="export-card-badge export-badge-raw">Full</span>
          </div>
          <p class="export-card-desc">
            Includes prompt text, token counts, tool usage, file changes, cost estimates, and
            efficiency signals. JSON is the format the Import tab reads back in; CSV and Markdown
            are for spreadsheets and shareable reports.
          </p>
          <ul class="export-card-includes">
            <li>Prompt text (userRequest)</li>
            <li>Token counts, cache stats, model names</li>
            <li>Tool call counts and file paths changed</li>
            <li>Duration, errors, outcome, loop signals</li>
          </ul>
          <div class="export-card-warning">Keep private — includes prompt text.</div>
          <div class="export-card-scope">{empty ? 'No traces match your current filters' : scopeLabel}</div>
          <div class="export-card-actions">
            <FormatSelect value={rawFormat} onChange={setRawFormat} />
            <button
              class={'export-btn' + (rawDone ? ' export-btn-done' : '')}
              onClick={doExport}
              disabled={empty || preparingRaw}
            >
              {rawDone ? '✓ Exported' : preparingRaw ? 'Preparing…' : 'Export Trace Data'}
            </button>
          </div>
        </div>

        <div class="export-card export-card-redacted">
          <div class="export-card-header">
            <span class="export-card-title">Export Trace Data (Redacted)</span>
            <span class="export-card-badge export-badge-redacted">Safer to share</span>
          </div>
          <p class="export-card-desc">
            Same export with prompt text and file paths replaced. Safe to attach to bug reports
            or share with teammates for cost and efficiency analysis.
          </p>
          <ul class="export-card-includes">
            <li><span class="export-redacted-label">[redacted]</span> Prompt text</li>
            <li><span class="export-redacted-label">[redacted]</span> File names and paths</li>
            <li>✓ Token counts, cache stats, model names</li>
            <li>✓ Tool call counts (no paths)</li>
            <li>✓ Duration, errors, outcome, loop signals</li>
          </ul>
          <div class="export-card-safe">Safer to share — no prompt text or file paths.</div>
          <div class="export-card-scope">{empty ? 'No traces match your current filters' : scopeLabel}</div>
          <div class="export-card-actions">
            <FormatSelect value={redactedFormat} onChange={setRedactedFormat} />
            <button
              class={'export-btn export-btn-secondary' + (redactedDone ? ' export-btn-done' : '')}
              onClick={doRedacted}
              disabled={empty || preparingRedacted}
            >
              {redactedDone ? '✓ Exported' : preparingRedacted ? 'Preparing…' : 'Export Trace Data (Redacted)'}
            </button>
          </div>
        </div>

      </div>

      <div class="export-replay-box">
        <div class="export-replay-title">About trace data exports</div>
        <p class="export-replay-desc">
          These exports contain aggregated trace summaries — token counts, tool usage,
          cost estimates, file changes, and efficiency signals. They are useful for
          cost analysis, sharing with teammates, and offline review. Use the <strong>Import</strong> tab to bring exported files back into TraceRoost on any machine.
        </p>
      </div>
    </div>
  )
}
