import { useState } from 'preact/hooks'
import { configOpen, selectedAgentFilter } from '../state'
import {
  adapterHealth, bannerVersions, dismissAgentBanner, dismissedAgentBanners, STATUS_LABEL,
  type AgentHealthRow, type AgentReport, type AgentStatus, type VersionHealth,
} from '../agentHealth'

// Settings → Agents and the agent banner on the Traces tab: what adapter health
// (src/adapters/health.ts) says about each agent's data. "Report this" shows the whole issue body
// first; the link opens GitHub's new-issue form in the browser with it filled in. Nothing is sent
// from here.

const STATUS_COLOR: Record<AgentStatus, string> = {
  'ok': 'var(--vscode-testing-iconPassed,#3fb950)',
  'unrecognized': 'var(--vscode-editorWarning-foreground,#cca700)',
  'no-data': 'var(--muted)',
  'not-verified': 'var(--muted)',
}

function ago(ms: number | null): string {
  if (ms === null) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function lastData(row: AgentHealthRow): number | null {
  const both = [row.lastFilesMs, row.lastOtlpMs].filter((x): x is number => x !== null)
  return both.length ? Math.max(...both) : null
}

function unknownSummary(v: VersionHealth): string {
  const names = Object.entries(v.unknownNames).sort((a, b) => b[1] - a[1])
  const shown = names.slice(0, 3).map(([n]) => n).join(', ')
  return `${v.unknown} record${v.unknown === 1 ? '' : 's'}: ${shown}${names.length > 3 ? `, +${names.length - 3} more` : ''}`
}

/** The issue body, in full, and the link that opens it on GitHub. */
export function ReportPreview({ report, onClose }: { report: AgentReport; onClose: () => void }) {
  return (
    <div style="margin-top:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:var(--hover)">
      <div style="font-size:11px;color:var(--muted);margin-bottom:6px">
        This is everything the issue will contain — key names, value types and counts, no values from your logs. GitHub opens with it filled in; you can edit it or not file it.
      </div>
      <pre style="max-height:220px;overflow:auto;font-size:10px;white-space:pre-wrap;margin:0 0 8px 0" aria-label="Issue body">{report.body}</pre>
      <a href={report.url} target="_blank" rel="noopener noreferrer" style="font-size:11px;margin-right:12px">Open the issue on GitHub</a>
      <button type="button" class="link-btn" onClick={onClose}>Close</button>
    </div>
  )
}

function AgentRow({ row }: { row: AgentHealthRow }) {
  const [open, setOpen] = useState<string | null>(null)
  const problem = row.versions.filter(v => v.unknown > 0)
  return (
    <div style="padding:6px 0;border-top:1px solid var(--border)">
      <div style="display:flex;align-items:baseline;gap:8px;font-size:11px">
        <span style="font-weight:600;color:var(--fg);min-width:110px">{row.label}</span>
        <span style="color:var(--muted);min-width:90px" title="Newest agent version seen">{row.versionSeen ?? '—'}</span>
        <span style="color:var(--muted);min-width:60px" title="Last data from local logs or OTel">{ago(lastData(row))}</span>
        <span style={`margin-left:auto;color:${STATUS_COLOR[row.status]}`}
          title={row.status === 'not-verified' ? (row.lastVerifiedVersion ? `Newer than ${row.lastVerifiedVersion}, the last version TraceRoost was tested against. Nothing unrecognized seen.` : 'No real capture of this agent is in TraceRoost\'s tests yet. Nothing unrecognized seen.') : undefined}>
          {STATUS_LABEL[row.status]}
        </span>
      </div>
      {problem.map(v => (
        <div key={v.version} style="font-size:11px;color:var(--muted);margin:4px 0 0 8px">
          {v.version}: {unknownSummary(v)}{' '}
          {v.report && <button type="button" class="link-btn" aria-expanded={open === v.version} onClick={() => setOpen(open === v.version ? null : v.version)}>Report this</button>}
          {open === v.version && v.report && <ReportPreview report={v.report} onClose={() => setOpen(null)} />}
        </div>
      ))}
    </div>
  )
}

/** Settings → Agents: one row per agent. */
export function AgentsSettings() {
  const rows = adapterHealth.value
  if (!rows) return null
  return (
    <div style="padding:12px 16px;border-bottom:1px solid var(--border)" id="settings-agents">
      <div style="font-size:12px;font-weight:600;color:var(--fg);margin-bottom:4px">Agents</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:6px">
        Whether TraceRoost recognizes what each agent writes. <em>Unrecognized data</em> usually means a new agent version changed its format, so its numbers may be incomplete.
      </div>
      {rows.map(r => <AgentRow key={r.key} row={r} />)}
    </div>
  )
}

/** Above the traces table, per agent version past the threshold, until dismissed. */
export function AgentHealthBanner() {
  const items = bannerVersions(adapterHealth.value, selectedAgentFilter.value, dismissedAgentBanners.value)
  const [open, setOpen] = useState<string | null>(null)
  if (items.length === 0) return null
  return (
    <div>
      {items.map(({ row, version }) => {
        const id = `${row.key}@${version.version}`
        return (
          <div key={id} role="status" style="margin:0 0 8px 0;padding:7px 10px;border-radius:4px;border-left:3px solid var(--vscode-editorWarning-foreground,#cca700);background:var(--hover);font-size:11px;color:var(--muted);line-height:1.5">
            <span style="color:var(--vscode-editorWarning-foreground,#cca700);font-weight:600">{row.label} {version.version}: unrecognized data</span>
            {' — '}TraceRoost doesn&apos;t recognize part of what this version writes ({unknownSummary(version)}), so its traces may be missing or incomplete.{' '}
            <button type="button" class="link-btn" onClick={() => { configOpen.value = true; setTimeout(() => document.getElementById('settings-agents')?.scrollIntoView({ block: 'start' }), 80) }}>Details</button>
            {version.report && <>{' · '}<button type="button" class="link-btn" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>Report this</button></>}
            {' · '}<button type="button" class="link-btn" onClick={() => dismissAgentBanner(row.key, version.version)}>Dismiss</button>
            {open === id && version.report && <ReportPreview report={version.report} onClose={() => setOpen(null)} />}
          </div>
        )
      })}
    </div>
  )
}
