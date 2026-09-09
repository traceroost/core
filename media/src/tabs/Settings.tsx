import { useEffect, useState } from 'preact/hooks'
import { enableOtelIngestion, enableLogIngestion, otlpPort, vscode, otelReconfigureResult, type OtelReconfigureResult, themePreference, setThemePreference, type ThemePreference, sessionsPageSize, setSessionsPageSize, SESSIONS_PAGE_SIZE_OPTIONS } from '../state'

function sendConfig(key: string, value: boolean) {
  if (vscode) {
    vscode.postMessage({ type: 'setVsCodeConfig', key, value })
  }
}

const CLEAR_ALL_CONFIRM_TEXT = 'Clear all TraceRoost data? OTEL trace data is deleted permanently. TraceRoost log cache is cleared and will be rebuilt from your local agent log files (the log files themselves are not deleted).'

export function sendConfirmClear() {
  if (vscode) {
    vscode.postMessage({ type: 'confirmClear' })
  } else {
    if (!confirm(CLEAR_ALL_CONFIRM_TEXT)) return
    fetch('/action', { method: 'POST', body: JSON.stringify({ type: 'clearAll' }),
      headers: { 'Content-Type': 'application/json' } })
  }
}

function ToggleRow({ label, description, checked, onChange }: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--fg)">{label}</div>
        {description && <div style="font-size:11px;color:var(--muted);margin-top:2px">{description}</div>}
      </div>
      <label class="toggle-switch" style="margin:0">
        <input type="checkbox" checked={checked} onChange={() => onChange(!checked)} />
        <span class="toggle-track"><span class="toggle-thumb" /></span>
        <span class={'toggle-label' + (checked ? ' on' : '')}>{checked ? 'Enabled' : 'Disabled'}</span>
      </label>
    </div>
  )
}

// Matches the stroke-icon style already used for the settings/bell/refresh icons in App.tsx
// (24x24 viewBox, stroke-width 2, currentColor) rather than introducing a second icon convention.
function IconMonitor() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

function IconMoon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function IconSun() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="22" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="2" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="22" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  )
}

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; Icon: () => preact.JSX.Element }> = [
  { value: 'system', label: 'System', Icon: IconMonitor },
  { value: 'dark', label: 'Dark', Icon: IconMoon },
  { value: 'light', label: 'Light', Icon: IconSun },
]

// Standalone only — the VS Code webview always follows the IDE's own theme (VS Code already has
// its own system/dark/light/high-contrast picker), so this is never rendered there. See
// .staged-issues/theme-toggle.md.
export function ThemeToggle() {
  const current = themePreference.value

  return (
    <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
      <div style="font-size:12px;font-weight:600;color:var(--fg);margin-bottom:6px">Appearance</div>
      <div style="display:flex;gap:4px">
        {THEME_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setThemePreference(opt.value)}
            aria-pressed={current === opt.value}
            style={`flex:1;display:flex;align-items:center;justify-content:center;gap:5px;padding:5px 8px;font-size:11px;cursor:pointer;border:1px solid var(--border);border-radius:3px;background:${current === opt.value ? 'var(--accent)' : 'transparent'};color:${current === opt.value ? '#fff' : 'var(--fg)'}`}
          >
            <opt.Icon />
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// Both VS Code and standalone — unlike theme, there's no IDE-native equivalent to defer to. See
// .staged-issues/session-list-scaling.md for why this exists: the Sessions table rendered every
// matching session as its own component with no cap, and the most common view ("All" time) had no
// limit applied at all.
export function SessionsPageSizeControl() {
  const current = sessionsPageSize.value

  return (
    <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
      <div style="font-size:12px;font-weight:600;color:var(--fg);margin-bottom:2px">Sessions per page</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:6px">How many traces the Traces tab renders at once, with paging for the rest.</div>
      <select
        value={current}
        onChange={e => setSessionsPageSize(Number((e.target as HTMLSelectElement).value))}
        style="width:100%;padding:4px 6px;font-size:12px;border:1px solid var(--border);border-radius:3px;background:var(--vscode-dropdown-background,var(--card-bg));color:var(--fg)"
      >
        {SESSIONS_PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n} per page</option>)}
      </select>
    </div>
  )
}

// Compact version for the paging rows (filter bar + table footer) so the page
// size is changeable without opening Settings. Same signal as the control above.
export function PageSizeSelect() {
  return (
    <select
      value={sessionsPageSize.value}
      onChange={e => setSessionsPageSize(Number((e.target as HTMLSelectElement).value))}
      title="Traces per page"
      style="padding:1px 4px;font-size:11px;border:1px solid var(--border);border-radius:3px;background:var(--vscode-dropdown-background,var(--card-bg));color:var(--fg);cursor:pointer"
    >
      {SESSIONS_PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}/page</option>)}
    </select>
  )
}

export function IngestionToggles() {
  const otelOn = enableOtelIngestion.value
  const logOn = enableLogIngestion.value
  const port = otlpPort.value

  return (
    <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
      <div style="font-size:12px;font-weight:600;color:var(--fg);margin-bottom:6px">Data Ingestion</div>
      <ToggleRow
        label="Accept OTEL spans"
        description={`Server stays running on port ${port}; turning this off silently drops incoming data.`}
        checked={otelOn}
        onChange={v => sendConfig('enableOtelIngestion', v)}
      />
      <ToggleRow
        label="Read trace logs"
        description="Scans local Claude Code, Codex, and Copilot log files."
        checked={logOn}
        onChange={v => sendConfig('enableLogIngestion', v)}
      />
      <div style="padding-top:10px;margin-top:4px;border-top:1px solid var(--border)">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px">Permanently deletes all stored traces. Log-sourced traces rebuild from local log files on next scan.</div>
        <button
          onClick={sendConfirmClear}
          style="padding:3px 10px;font-size:11px;cursor:pointer;border:1px solid var(--vscode-testing-iconFailed,#f44);border-radius:3px;background:transparent;color:var(--vscode-testing-iconFailed,#f44)"
        >
          Clear All Data
        </button>
      </div>
    </div>
  )
}

function summarizeReconfigure(result: OtelReconfigureResult): string {
  if ('error' in result) return `Failed: ${result.error}`
  const labels: Record<string, string> = { claudeCode: 'Claude Code', codex: 'Codex', copilot: 'Copilot' }
  const changed = Object.entries(result).filter(([, r]) => r.changed).map(([k]) => labels[k])
  const errors = Object.entries(result).filter(([, r]) => r.error).map(([k, r]) => `${labels[k]} (${r.error})`)
  if (errors.length > 0) return `Failed: ${errors.join(', ')}`
  if (changed.length === 0) return 'Already up to date — no changes needed.'
  return `Configured: ${changed.join(', ')}. Restart the agent(s) to start streaming traces.`
}

export function OtelReconfigureButton() {
  const [running, setRunning] = useState(false)
  const result = otelReconfigureResult.value

  function run() {
    setRunning(true)
    otelReconfigureResult.value = null
    if (vscode) {
      vscode.postMessage({ type: 'reconfigureOtel' })
    } else {
      fetch('/action', { method: 'POST', body: JSON.stringify({ type: 'reconfigureOtel' }),
        headers: { 'Content-Type': 'application/json' } })
        .then(r => r.json())
        .then(results => { otelReconfigureResult.value = results })
        .catch(e => { otelReconfigureResult.value = { error: String(e) } })
        .finally(() => setRunning(false))
    }
  }

  useEffect(() => {
    if (result) setRunning(false)
  }, [result])

  return (
    <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
      <div style="font-size:12px;font-weight:600;color:var(--fg);margin-bottom:4px">Configure OTEL</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
        Re-applies TraceRoost's OTEL settings to Claude Code, Codex, and Copilot. TraceRoost already does this automatically on startup — use this if you changed one of those agent's telemetry settings yourself and want to point it back at TraceRoost.
      </div>
      <button
        onClick={run}
        disabled={running}
        style="padding:3px 10px;font-size:11px;cursor:pointer;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--fg)"
      >
        {running ? 'Configuring…' : 'Configure OTEL'}
      </button>
      {result && <div style="font-size:11px;color:var(--muted);margin-top:6px">{summarizeReconfigure(result)}</div>}
    </div>
  )
}

export function McpToggle() {
  const w = window as unknown as Record<string, unknown>
  const [enabled, setEnabled] = useState(typeof w.__MCP_ENABLED__ === 'boolean' ? w.__MCP_ENABLED__ as boolean : true)
  const port = typeof w.__MCP_PORT__ === 'number' ? w.__MCP_PORT__ as number : 4316

  function toggle() {
    const next = !enabled
    setEnabled(next)
    sendConfig('enableMcpServer', next)
  }

  return (
    <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;color:var(--fg)">MCP Server</span>
        <label class="toggle-switch" style="margin:0">
          <input type="checkbox" checked={enabled} onChange={toggle} />
          <span class="toggle-track"><span class="toggle-thumb" /></span>
          <span class={'toggle-label' + (enabled ? ' on' : '')}>{enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>
      {enabled && (
        <div style="font-size:11px;color:var(--muted)">
          Listening at <code style="font-size:10px;background:var(--card-bg);padding:1px 4px;border-radius:3px">http://localhost:{port}/mcp</code>
        </div>
      )}
      <div style="font-size:10px;color:var(--muted);margin-top:4px">Restart to apply changes.</div>
    </div>
  )
}
