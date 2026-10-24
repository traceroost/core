import { activeTab, alertsOpen, alertsPanelTab, displaySessions, focusedSessionId, type AlertsPanelTab } from './state'
import { useDialog, scrollBehavior } from './a11y'
import { Alerts, alertCardId, getTriggeredAlerts, type TriggeredAlert } from './tabs/Alerts'
import { Automation } from './tabs/Automation'

/**
 * The Alerts panel — a slide-in drawer opened from the header bell, in place of the old bell
 * popover plus the Alerts and Automation sections that used to sit at the bottom of Settings.
 * Three tabs: Active (what's firing now, with a way to the trace behind each), Configure (every
 * alert's switch and thresholds — Alerts.tsx) and Automation (Automation.tsx).
 */

const SEV_COLOR: Record<string, string> = {
  error:   'var(--vscode-errorForeground, #f44747)',
  warning: 'var(--vscode-editorWarning-foreground, #f6a623)',
  info:    'var(--vscode-editorInfo-foreground, #4fc3f7)',
}

const PANEL_TABS: Array<{ id: AlertsPanelTab; label: string }> = [
  { id: 'active',     label: 'Active' },
  { id: 'configure',  label: 'Configure' },
  { id: 'automation', label: 'Automation' },
]

/** Opens the Alerts panel on `tab`. */
export function openAlertsPanel(tab: AlertsPanelTab = 'active'): void {
  alertsPanelTab.value = tab
  alertsOpen.value = true
}

/** "View Alert" on a firing notification (#351): open the Configure tab, bring that alert's card
 *  into view and pulse its outline so it stands out among the other alerts. */
export function openAlertCard(alertId: string): void {
  openAlertsPanel('configure')
  setTimeout(() => {
    const el = document.getElementById(alertCardId(alertId))
    if (!el) return
    el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
    el.animate?.(
      [{ boxShadow: '0 0 0 2px var(--vscode-focusBorder, #4fc3f7)' }, { boxShadow: '0 0 0 2px transparent' }],
      { duration: 1600, delay: 300, easing: 'ease-out' },
    )
  }, 80)
}

function viewTrace(sessionId: string): void {
  // Close first, so the trace doesn't open underneath the panel, out of sight.
  alertsOpen.value = false
  focusedSessionId.value = sessionId
  activeTab.value = 'sessions'
}

function ActiveAlerts({ alerts }: { alerts: TriggeredAlert[] }) {
  if (alerts.length === 0) {
    return (
      <div style="padding:14px 12px;font-size:12px;color:var(--muted)">
        <div style="display:flex;align-items:center;gap:8px">
          <span aria-hidden="true" style="color:var(--vscode-charts-green, #81c784);font-size:14px">✓</span> All clear — no alerts triggered
        </div>
        <div style="margin-top:8px">
          Turn alerts on or off and set their thresholds under{' '}
          <button type="button" class="link-btn" onClick={() => { alertsPanelTab.value = 'configure' }}>Configure</button>.
        </div>
      </div>
    )
  }
  return (
    <ul style="list-style:none;margin:0;padding:0" aria-label="Triggered alerts">
      {alerts.map((a, i) => {
        const color = SEV_COLOR[a.severity] ?? SEV_COLOR.warning
        return (
          <li key={a.alertId + i} style={`padding:10px 12px;border-left:3px solid ${color};border-bottom:1px solid var(--border)`}>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
              <span aria-hidden="true" style={`display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0`} />
              <span style={`font-size:12px;font-weight:600;color:${color}`}>{a.label}</span>
              <span style="font-size:11px;color:var(--muted);text-transform:capitalize">{a.severity}</span>
            </div>
            {a.detail && <div style="font-size:12px;color:var(--muted);line-height:1.4">{a.detail}</div>}
            <div style="display:flex;gap:14px;margin-top:5px;font-size:12px">
              {a.sessionId && (
                <button type="button" class="link-btn" onClick={() => viewTrace(a.sessionId!)}>View trace →</button>
              )}
              <button type="button" class="link-btn" onClick={() => openAlertCard(a.alertId)}>Adjust threshold →</button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function AlertsPanel() {
  const open = alertsOpen.value
  const tab = alertsPanelTab.value
  const ref = useDialog<HTMLDivElement>(open, () => { alertsOpen.value = false })
  // Re-evaluated as traces arrive, like the bell's own badge.
  void displaySessions.value
  const alerts = open ? getTriggeredAlerts() : []

  // Arrow keys move between the tabs (WAI-ARIA tabs pattern, automatic activation) — the same
  // pattern as an expanded trace's sub-tabs (Sessions.tsx).
  function onTabKey(e: KeyboardEvent) {
    const ids = PANEL_TABS.map(t => t.id)
    const i = ids.indexOf(tab)
    const next = e.key === 'ArrowRight' ? ids[(i + 1) % ids.length]
      : e.key === 'ArrowLeft' ? ids[(i - 1 + ids.length) % ids.length]
      : e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[ids.length - 1] : null
    if (!next) return
    e.preventDefault()
    alertsPanelTab.value = next
    document.getElementById(`alerts-panel-tab-${next}`)?.focus()
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="alerts-panel-title"
      id="alerts-panel"
      inert={!open}
      aria-hidden={!open}
      style={`visibility:${open ? 'visible' : 'hidden'};position:fixed;top:0;right:0;bottom:0;width:min(440px,100%);background:var(--vscode-editor-background);border-left:1px solid var(--border);z-index:200;overflow-y:auto;transition:transform 0.2s ease;transform:${open ? 'translateX(0)' : 'translateX(100%)'};box-shadow:-4px 0 20px rgba(0,0,0,0.4)`}
    >
      <div style="position:sticky;top:0;background:var(--vscode-editor-background);z-index:1;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px">
          <h2 id="alerts-panel-title" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:0">Alerts</h2>
          <button
            onClick={() => { alertsOpen.value = false }}
            style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:0 4px;line-height:1"
            title="Close (Esc)"
            aria-label="Close alerts"
          >×</button>
        </div>
        <div role="tablist" aria-label="Alerts" style="display:flex;gap:0;padding:0 8px">
          {PANEL_TABS.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`alerts-panel-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="alerts-panel-body"
              tabIndex={tab === t.id ? 0 : -1}
              onKeyDown={onTabKey}
              onClick={() => { alertsPanelTab.value = t.id }}
              style={[
                'padding:4px 10px;font-size:12px;cursor:pointer;border:none;border-bottom:2px solid transparent;background:transparent;margin-bottom:-1px;',
                tab === t.id ? 'color:var(--fg);border-bottom-color:var(--accent);font-weight:600' : 'color:var(--muted)',
              ].join('')}
            >{t.id === 'active' && open ? `${t.label} (${alerts.length})` : t.label}</button>
          ))}
        </div>
      </div>
      <div id="alerts-panel-body" role="tabpanel" aria-labelledby={`alerts-panel-tab-${tab}`}>
        {open && tab === 'active' && <ActiveAlerts alerts={alerts} />}
        {open && tab === 'configure' && <div style="padding:12px 14px"><Alerts /></div>}
        {open && tab === 'automation' && <div style="padding:12px 14px"><Automation /></div>}
      </div>
    </div>
  )
}
