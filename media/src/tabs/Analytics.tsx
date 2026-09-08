import { useState } from 'preact/hooks'
import {
  filteredSessions, sessionSummary,
  sessionTimelines,
  CHART_MAX, vscode, goToHelp,
} from '../state'
import { getAgentColor, getAgentSourceLabel, formatMs, formatCompact } from '../utils'
import { buildDailyCostMap } from '../sessionMetrics'
import type { SessionSummaryCard } from '../types'
import type { PricingMode } from '../sessionMetrics'
import { PRICING_LAST_UPDATED } from '../pricing'

import { ContextGrowthChart, SessionTokenChart } from './SessionCharts'
import { CostBarChart, fmtUsd } from './Cost'
import { computeStats } from './Agents'

// ── Section heading helper ────────────────────────────────────────────────────

function SectionHead({ title, tip, first, helpAnchor }: { title: string; tip?: string; first?: boolean; helpAnchor?: string }) {
  return (
    <>
      {!first && <div style="border-top:1px solid var(--border);margin:16px 0 8px" />}
    <div style={`display:flex;align-items:center;gap:7px;margin:${first ? '8px' : '0'} 0 6px`}>
      <h3
        class={tip ? 'has-metric-tip' : undefined}
        style="font-size:12px;color:var(--muted);margin:0"
        data-tip={tip}
      >{title}</h3>
      {helpAnchor && (
        <button
          onClick={() => goToHelp(helpAnchor)}
          title="Learn more"
          style="display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:17px;height:17px;border-radius:50%;border:1px solid var(--border);background:none;cursor:pointer;color:var(--muted);font-size:11px;font-weight:600;padding:0;line-height:1"
        >?</button>
      )}
    </div>
    </>
  )
}

// ── Agent breakdown cards ─────────────────────────────────────────────────────

function AgentCard({ source, sessions }: { source: string; sessions: SessionSummaryCard[] }) {
  const s = computeStats(sessions)
  if (s.sessions === 0) return null
  const color = getAgentColor(source)
  const label = getAgentSourceLabel(source)
  const topTools = Object.entries(s.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 4)
  return (
    <div style={`background:var(--card-bg);border:1px solid var(--border);border-left:3px solid ${color};border-radius:6px;padding:12px 14px;flex:1;min-width:180px`}>
      <div style={`display:flex;align-items:center;gap:6px;margin-bottom:10px`}>
        <span style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}`} />
        <span style="font-weight:600;font-size:13px">{label}</span>
        <span style="font-size:11px;color:var(--muted);margin-left:auto">{s.sessions} trace{s.sessions !== 1 ? 's' : ''}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
        <div><span style="color:var(--muted)">LLM calls</span> <strong>{s.totalLlm}</strong></div>
        <div><span style="color:var(--muted)">Tool calls</span> <strong>{s.totalTools}</strong></div>
        <div><span style="color:var(--muted)">Input tokens</span> <strong>{formatCompact(s.totalInput)}</strong></div>
        <div><span style="color:var(--muted)">Output tokens</span> <strong>{formatCompact(s.totalOutput)}</strong></div>
        <div><span style="color:var(--muted)">Cache hit</span> <strong>{(s.cacheHitRate * 100).toFixed(0)}%</strong></div>
        <div><span style="color:var(--muted)">Avg dur</span> <strong>{formatMs(s.avgDuration)}</strong></div>
        {s.avgTtft > 0 && <div><span style="color:var(--muted)">Avg TTFT</span> <strong>{formatMs(s.avgTtft)}</strong></div>}
        {s.oneShotRate !== null && (
          <div data-tip="Files edited exactly once vs. files that needed a retry, across all traces in this view. Edit-pass count, not a signal the code actually worked.">
            <span style="color:var(--muted)">One-shot</span> <strong>{Math.round(s.oneShotRate * 100)}%</strong>
          </div>
        )}
      </div>
      {topTools.length > 0 && (
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:10px;color:var(--muted)">
          <div style="margin-bottom:3px;text-transform:uppercase;letter-spacing:.3px">Top tools</div>
          {topTools.map(([t, n]) => (
            <div key={t} style="display:flex;justify-content:space-between;margin-bottom:1px">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px">{t}</span>
              <span style="color:var(--fg);margin-left:6px;flex-shrink:0">{n}×</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main Analytics component ──────────────────────────────────────────────────

export function Analytics() {
  const [mode, setMode] = useState<PricingMode>('token')
  const [abbrevTokens, setAbbrevTokens] = useState(true)
  const [showZeroCost, setShowZeroCost] = useState(false)
  const sessions = filteredSessions.value
  const timelines = sessionTimelines.value
  const hasAny = (sessionSummary.value?.sessions?.length ?? 0) > 0

  if (sessions.length === 0) {
    return (
      <div id="analytics-content">
        <div class="empty-state">{hasAny ? 'No traces match the active filters.' : 'No traces recorded yet.'}</div>
      </div>
    )
  }

  const pricedSess = sessions.filter(s => s.source === 'copilot' || s.source === 'codex' || s.source === 'claude_code' || s.source === 'opencode')
  const copilotSess = sessions.filter(s => s.source === 'copilot')
  const claudeSess  = sessions.filter(s => s.source === 'claude_code')
  const codexSess   = sessions.filter(s => s.source === 'codex')

  // Charts need time-ordered sessions and must respect all active filters (text, initiator, source).
  // filteredSessions applies all filters but may be sorted by cost/model for the Sessions table,
  // so re-sort by time here. rangedSessions skips text + initiator — don't use it for charts.
  const timeOrdered = [...filteredSessions.value].sort((a, b) =>
    Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0')
  )
  const pricedChartSess = timeOrdered.filter(s => s.source === 'copilot' || s.source === 'codex' || s.source === 'claude_code' || s.source === 'opencode')

  // Most recent CHART_MAX sessions (newest-first slice, then reversed to oldest-first for charts)
  const chartSessions = timeOrdered.slice(0, CHART_MAX).reverse()

  // Load timelines for context growth chart
  chartSessions.forEach(sess => {
    if (!sessionTimelines.value[sess.sessionId] && vscode) {
      vscode.postMessage({ type: 'loadSessionDetail', sessionId: sess.sessionId })
    }
  })

  const disclaimer = (
    <div style="font-size:11px;background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:6px 10px;margin-bottom:8px;color:var(--muted)">
      Estimates only — not your actual bill. Rates last updated: {PRICING_LAST_UPDATED}
    </div>
  )

  // Multi-dimensional cost table: day → agent. Shared with the daily_cost alert in Alerts.tsx —
  // see buildDailyCostMap in sessionMetrics.ts, the single source of truth for day-grouped cost.
  const dayMap = buildDailyCostMap(pricedSess, mode)
  const dayRows = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const grand = dayRows.reduce((g, [, d]) => ({
    input: g.input + d.input, output: g.output + d.output,
    cacheCreate: g.cacheCreate + d.cacheCreate, cacheRead: g.cacheRead + d.cacheRead, cost: g.cost + d.cost,
  }), { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0 })
  const fmtModel = (m: string): string => {
    const s = m.trim().toLowerCase()
    // claude-{tier}-{major}-{minor}[-fast]  →  Sonnet 4.6 / Opus 4.7 fast
    const cl = s.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(-fast)?$/)
    if (cl) {
      const tier = cl[1][0].toUpperCase() + cl[1].slice(1)
      const ver  = cl[3] ? `${cl[2]}.${cl[3]}` : cl[2]
      return tier + ' ' + ver + (cl[4] ? ' fast' : '')
    }
    // gpt-X.Y-codex[-mini/-max]  →  Codex X.Y / Codex X.Y mini
    const codex = s.match(/^gpt-([\d.]+)-codex(-mini|-max|-nano)?$/)
    if (codex) return 'Codex ' + codex[1] + (codex[2] || '')
    if (s === 'codex-mini-latest') return 'Codex mini'
    // gpt-4o / gpt-5.1  →  GPT-4o / GPT-5.1
    if (s.startsWith('gpt-')) return 'GPT-' + m.trim().slice(4)
    // gemini-2.5-pro  →  Gemini 2.5 pro
    const gem = s.match(/^gemini-([\d.]+)-(pro|flash|ultra)/)
    if (gem) return 'Gemini ' + gem[1] + ' ' + gem[2]
    return m  // unknown: pass through
  }

  const fmtN = (n: number): string => {
    if (!abbrevTokens) return n.toLocaleString()
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.0+$/, '') + 'M'
    if (n >= 1_000)     return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0+$/, '') + 'K'
    return String(n)
  }

  return (
    <div id="analytics-content">

      {/* Estimated cost */}
      {pricedSess.length > 0 && (
        <>
          <SectionHead title="ESTIMATED COST" first helpAnchor="help-costs" />
          {disclaimer}

          {copilotSess.length > 0 && (
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-bottom:8px">
              <span style={'display:inline-block;width:6px;height:6px;border-radius:50%;background:' + getAgentColor('copilot')} />
              <span style="text-transform:uppercase;letter-spacing:.3px;font-size:10px">Copilot</span>
              <button
                class={'tab-mini' + (mode === 'token' ? ' active' : '')}
                onClick={() => setMode('token')}
              >Token-based</button>
              <button
                class={'tab-mini' + (mode === 'request-annual' ? ' active' : '')}
                onClick={() => setMode('request-annual')}
              >Annual request-based</button>
            </div>
          )}

          {/* Daily total legend above chart */}
          <div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted);margin-bottom:6px">
            <svg width="16" height="8" viewBox="0 0 16 8">
              <line x1="0" y1="4" x2="16" y2="4" stroke="var(--vscode-charts-green,#81c784)" stroke-width="1.5" stroke-dasharray="4 2" />
            </svg>
            Daily total (right axis)
          </div>

          <CostBarChart sessions={pricedChartSess} mode={mode} />

          {/* Multi-dimensional cost table: date → agent, scrollable */}
          {dayRows.length > 0 && (
            <div style="display:flex;justify-content:flex-end;align-items:center;gap:4px;margin-bottom:4px">
              <button
                onClick={() => setShowZeroCost(s => !s)}
                title={showZeroCost ? 'Hide $0.00 rows' : 'Show $0.00 rows (included/free models)'}
                style={`font-size:10px;padding:2px 8px;cursor:pointer;border:1px solid var(--border);border-radius:3px;background:${showZeroCost ? 'var(--hover)' : 'transparent'};color:var(--muted);white-space:nowrap`}
              >Show $0</button>
              <button
                onClick={() => setAbbrevTokens(a => !a)}
                title={abbrevTokens ? 'Switch to full numbers' : 'Switch to abbreviated numbers'}
                style="font-size:10px;padding:2px 8px;cursor:pointer;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--muted);white-space:nowrap"
              >{abbrevTokens ? '1.2M' : '1,234'}</button>
              <button
                onClick={() => {
                  const headers = ['Date','Agent','Model','Input Tokens','Output Tokens','Cache Create Tokens','Cache Read Tokens','Total Tokens','Cost (USD)']
                  const rows: string[][] = []
                  for (const [day, d] of dayRows) {
                    for (const [, ae] of d.agents) {
                      rows.push([
                        day,
                        ae.source,
                        [...ae.models].join('/'),
                        String(ae.input), String(ae.output),
                        String(ae.cacheCreate), String(ae.cacheRead),
                        String(ae.input + ae.output + ae.cacheCreate + ae.cacheRead),
                        ae.cost.toFixed(4),
                      ])
                    }
                  }
                  rows.push([
                    'TOTAL','','',
                    String(grand.input), String(grand.output),
                    String(grand.cacheCreate), String(grand.cacheRead),
                    String(grand.input + grand.output + grand.cacheCreate + grand.cacheRead),
                    grand.cost.toFixed(4),
                  ])
                  const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n')
                  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
                  const a = document.createElement('a')
                  a.href = url; a.download = 'traceroost-cost.csv'; a.click()
                  URL.revokeObjectURL(url)
                }}
                style="font-size:10px;padding:2px 8px;cursor:pointer;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--muted);white-space:nowrap"
              >↓ CSV</button>
            </div>
          )}
          {dayRows.length > 0 && (
            <div class="h-scroll-hint" style="margin-bottom:8px">
              <table style="border-collapse:collapse;font-size:10px;min-width:100%;white-space:nowrap">
                <thead>
                  <tr style="border-bottom:1px solid var(--border)">
                    {(['Date','Agent','Model','Input','Output','Cache Create','Cache Read','Total Tokens','Cost (USD)'] as const).map(h => (
                      <th key={h} style={`padding:3px 8px 3px ${h==='Date'?'0':'6px'};color:var(--muted);font-weight:500;text-align:${['Input','Output','Cache Create','Cache Read','Total Tokens','Cost (USD)'].includes(h)?'right':'left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dayRows.filter(([, d]) => showZeroCost || d.cost > 0).map(([day, d]) => {
                    const agents = [...d.agents.entries()]
                      .filter(([, ae]) => showZeroCost || ae.cost > 0)
                      .sort((a, b) => b[1].cost - a[1].cost)
                    const dayTotal = d.input + d.output + d.cacheCreate + d.cacheRead
                    return (
                      <>
                        {/* Day aggregate row */}
                        <tr key={day} style="border-bottom:1px solid var(--border);background:var(--hover)">
                          <td style="padding:3px 8px 3px 0;font-weight:600">{day}</td>
                          <td style="padding:3px 8px;color:var(--muted)">All</td>
                          <td style="padding:3px 8px" />
                          <td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums">{fmtN(d.input)}</td>
                          <td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums">{fmtN(d.output)}</td>
                          <td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums">{fmtN(d.cacheCreate)}</td>
                          <td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums">{fmtN(d.cacheRead)}</td>
                          <td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums">{fmtN(dayTotal)}</td>
                          <td style="padding:3px 8px;text-align:right;color:var(--vscode-charts-green,#81c784);font-weight:600">{fmtUsd(d.cost)}</td>
                        </tr>
                        {/* Per-agent rows */}
                        {agents.map(([src, ae]) => {
                          const agentTotal = ae.input + ae.output + ae.cacheCreate + ae.cacheRead
                          const modelFull  = [...ae.models].join(', ') || '—'
                          const modelShort = [...ae.models].map(fmtModel).join(', ') || '—'
                          return (
                            <tr key={day + src} style="border-bottom:1px solid var(--border)">
                              <td style="padding:3px 8px 3px 0" />
                              <td style="padding:3px 8px">
                                <span style={'display:inline-block;width:5px;height:5px;border-radius:50%;background:' + getAgentColor(src) + ';vertical-align:middle;margin-right:4px'} />
                                {getAgentSourceLabel(src)}
                              </td>
                              <td style="padding:3px 8px;color:var(--muted);font-size:9px;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={modelFull}>{modelShort}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{fmtN(ae.input)}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{fmtN(ae.output)}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{fmtN(ae.cacheCreate)}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{fmtN(ae.cacheRead)}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{fmtN(agentTotal)}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--vscode-charts-green,#81c784)">{fmtUsd(ae.cost)}</td>
                            </tr>
                          )
                        })}
                      </>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style="border-top:2px solid var(--border)">
                    <td style="padding:3px 8px 3px 0;font-weight:600">Total</td>
                    <td style="padding:3px 8px" />
                    <td style="padding:3px 8px" />
                    <td style="padding:3px 8px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">{fmtN(grand.input)}</td>
                    <td style="padding:3px 8px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">{fmtN(grand.output)}</td>
                    <td style="padding:3px 8px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">{fmtN(grand.cacheCreate)}</td>
                    <td style="padding:3px 8px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">{fmtN(grand.cacheRead)}</td>
                    <td style="padding:3px 8px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">{fmtN(grand.input+grand.output+grand.cacheCreate+grand.cacheRead)}</td>
                    <td style="padding:3px 8px;text-align:right;font-weight:600;color:var(--vscode-charts-green,#81c784)">{fmtUsd(grand.cost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}

      {/* Agent breakdown */}
      {(copilotSess.length > 0 || claudeSess.length > 0 || codexSess.length > 0) && (
        <>
          <SectionHead title="AGENT BREAKDOWN" />
          <div style="display:flex;gap:12px;flex-wrap:wrap">
            {copilotSess.length > 0 && <AgentCard source="copilot"    sessions={copilotSess} />}
            {claudeSess.length  > 0 && <AgentCard source="claude_code" sessions={claudeSess} />}
            {codexSess.length   > 0 && <AgentCard source="codex"      sessions={codexSess} />}
          </div>
        </>
      )}

      {/* Context growth */}
      <SectionHead title="CONTEXT GROWTH" first={pricedSess.length === 0} />
      <ContextGrowthChart sessions={chartSessions} timelines={timelines} />

      {/* Token usage per session */}
      <SectionHead title="TOKEN USAGE PER SESSION" />
      <div style="display:flex;gap:12px;margin-bottom:6px;font-size:10px;color:var(--muted)">
        <span><span style="display:inline-block;width:10px;height:3px;background:#FFB74D;border-radius:1px;vertical-align:middle" /> Input tokens</span>
        <span><span style="display:inline-block;width:10px;height:3px;background:#81C784;border-radius:1px;vertical-align:middle" /> Output tokens</span>
      </div>
      {/* Always pass newest-first (rangedSessions); chart reverses internally to oldest-first */}
      <SessionTokenChart sessions={timeOrdered} />

    </div>
  )
}
