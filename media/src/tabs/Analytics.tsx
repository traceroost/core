import { useEffect, useState } from 'preact/hooks'
import {
  filteredSessions, sessionSummary,
  sessionTimelines,
  requestGitOutcomesFor,
  CHART_MAX, vscode, goToHelp,
} from '../state'
import { getAgentColor, getAgentSourceLabel, formatMs, formatCompact } from '../utils'
import { buildDailyCostMap } from '../sessionMetrics'
import type { SessionSummaryCard } from '../types'
import { PRICING_LAST_UPDATED } from '../pricing'

import { ContextGrowthChart, SessionTokenChart, OutcomeTrendChart, buildOutcomeTokenBuckets } from './SessionCharts'
import { CostBarChart, fmtUsd } from './Cost'
import { computeStats } from './Agents'
import { SectionNav, type NavSection } from '../SectionNav'
import { buildTrendBins, summarize, TREND_OUTCOMES, TREND_COLOR } from './outcomeTrend'
import { OUTCOME_META } from './Sessions'
import { gitOutcomes, selectedAgentFilter } from '../state'
import { planUsage, hasPlanData, forAgentFilter, PROVIDER_LABEL } from '../planUsage'
import { PlanLimitsSection } from './PlanLimits'

// ── Section heading helper ────────────────────────────────────────────────────

function SectionHead({ id, title, tip, first, helpAnchor }: { id: string; title: string; tip?: string; first?: boolean; helpAnchor?: string }) {
  return (
    <>
      {!first && <div style="border-top:1px solid var(--border);margin:16px 0 8px" />}
    <div id={id} style={`display:flex;align-items:center;gap:7px;margin:${first ? '8px' : '0'} 0 6px`}>
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
  const [abbrevTokens, setAbbrevTokens] = useState(true)
  const [showZeroCost, setShowZeroCost] = useState(false)
  const sessions = filteredSessions.value
  const timelines = sessionTimelines.value
  const hasAny = (sessionSummary.value?.sessions?.length ?? 0) > 0

  // Outcome vs. tokens (below) needs every filtered session's git outcome resolved, not just
  // whichever happen to already be cached from a visit to the Sessions tab — mirrors how
  // Sessions.tsx itself triggers requests as its own rows render.
  useEffect(() => { requestGitOutcomesFor(sessions) }, [sessions])

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
  const dayMap = buildDailyCostMap(pricedSess)
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

  const hasAgentBreakdown = copilotSess.length > 0 || claudeSess.length > 0 || codexSess.length > 0

  // Outcome & token spend over time — same binning `requestGitOutcomesFor` above keeps filling in,
  // so this grows as outcomes resolve rather than waiting for all of them up front.
  const trend = buildTrendBins(sessions, gitOutcomes.value)
  const trendSummary = summarize(trend.bins)
  const outcomeBuckets = buildOutcomeTokenBuckets(sessions, gitOutcomes.value)
  const medianByOutcome = new Map(outcomeBuckets.map(b => [b.outcome, b.medianTokens]))
  const pct = (n: number) => `${Math.round(n * 100)}%`

  const plan = forAgentFilter(planUsage.value, selectedAgentFilter.value)
  const hasPlan = hasPlanData(plan)

  const navSections: NavSection[] = [
    ...(hasPlan ? [{ id: 'analytics-plan-limits', label: 'Plan limits' }] : []),
    ...(hasAgentBreakdown ? [{ id: 'analytics-agent-breakdown', label: 'Agent breakdown' }] : []),
    ...(trend.bins.length > 0 ? [{ id: 'analytics-outcome-tokens', label: 'Outcome & token spend' }] : []),
    ...(pricedSess.length > 0 ? [{ id: 'analytics-cost', label: 'Estimated cost' }] : []),
    { id: 'analytics-token-usage', label: 'Token usage' },
    { id: 'analytics-context-growth', label: 'Context growth' },
  ]

  return (
    <div id="analytics-content">
    <SectionNav label="Analytics sections" sections={navSections}>

      {/* Subscription plan limits — Claude Code and Codex only, and only when they've written any. */}
      {hasPlan && (
        <>
          <SectionHead id="analytics-plan-limits" title="PLAN LIMITS" first helpAnchor="help-plan-limits"
            tip="How much of your Claude or ChatGPT plan's 5-hour and weekly windows you've used, read from files Claude Code and Codex write themselves. No credentials are read and nothing is sent anywhere." />
          <PlanLimitsSection snapshot={plan} />
        </>
      )}

      {/* Agent breakdown */}
      {hasAgentBreakdown && (
        <>
          <SectionHead id="analytics-agent-breakdown" title="AGENT BREAKDOWN" first={!hasPlan} />
          <div style="display:flex;gap:12px;flex-wrap:wrap">
            {copilotSess.length > 0 && <AgentCard source="copilot"    sessions={copilotSess} />}
            {claudeSess.length  > 0 && <AgentCard source="claude_code" sessions={claudeSess} />}
            {codexSess.length   > 0 && <AgentCard source="codex"      sessions={codexSess} />}
          </div>
        </>
      )}

      {/* Outcome & token spend over time — see .staged-issues (cloud repo) for the design this
          ports; analytics-outcome-tokens used to be a single median-per-outcome bar chart
          (buildOutcomeTokenBuckets still feeds this section's median column). */}
      {trend.bins.length > 0 && (
        <>
          <SectionHead id="analytics-outcome-tokens" title="OUTCOME &amp; TOKEN SPEND OVER TIME" first={!hasPlan && !hasAgentBreakdown}
            tip="Tokens and traces per day (or week), stacked by what happened to the work locally per git — merged, committed, or still uncommitted. Traces with no changed files, or outside a git repo, aren't counted." />
          <p style="font-size:12px;margin:0 0 4px">
            <strong>{formatCompact(trendSummary.total.tokens)}</strong> tokens across{' '}
            <strong>{trendSummary.total.sessions.toLocaleString()}</strong> trace{trendSummary.total.sessions === 1 ? '' : 's'} —{' '}
            <strong>{pct(trendSummary.landedShare)}</strong> went to work that's merged or committed,{' '}
            <strong>{pct(trendSummary.uncommittedShare)}</strong> to work still uncommitted.
          </p>
          <p style="font-size:11px;color:var(--muted);margin:0 0 8px">
            Tokens are input + output, excluding cache reads. Only traces with a merged,
            committed, or uncommitted outcome are counted.
            {trend.unit === 'week' ? ' Grouped by week (Monday start, UTC).' : ''}
          </p>
          <div style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--muted);margin-bottom:8px">
            {TREND_OUTCOMES.filter(o => trendSummary.byOutcome[o].sessions > 0).map(o => (
              <span key={o} style="display:inline-flex;align-items:center;gap:4px">
                <span style={`display:inline-block;width:8px;height:8px;border-radius:2px;background:${TREND_COLOR[o]}`} />
                {OUTCOME_META[o]!.label}
              </span>
            ))}
          </div>
          <OutcomeTrendChart bins={trend.bins} unit={trend.unit}
            hitMarkers={(plan?.hits ?? []).map(h => ({ t: h.hitAt, label: `${PROVIDER_LABEL[h.provider]} ${h.windowKind === 'five_hour' ? '5-hour' : 'weekly'} limit hit` }))} />
          <div class="h-scroll-hint" style="margin-top:10px">
            <table style="font-size:11px;width:100%;border-collapse:collapse">
              <thead>
                <tr style="color:var(--muted);border-bottom:1px solid var(--vscode-panel-border)">
                  <th style="text-align:left;font-weight:400;padding:3px 8px 3px 0">Outcome</th>
                  <th style="text-align:right;font-weight:400;padding:3px 8px">Traces</th>
                  <th style="text-align:right;font-weight:400;padding:3px 8px">Tokens</th>
                  <th style="text-align:right;font-weight:400;padding:3px 8px">Share of tokens</th>
                  <th style="text-align:right;font-weight:400;padding:3px 0 3px 8px">Median / trace</th>
                </tr>
              </thead>
              <tbody>
                {TREND_OUTCOMES.filter(o => trendSummary.byOutcome[o].sessions > 0).map(o => {
                  const m = trendSummary.byOutcome[o]
                  const meta = OUTCOME_META[o]!
                  const median = medianByOutcome.get(o)
                  return (
                    <tr key={o} style="border-top:1px solid var(--vscode-panel-border)">
                      <td style="padding:3px 8px 3px 0">
                        <span style={`display:inline-block;width:8px;height:8px;border-radius:2px;background:${TREND_COLOR[o]};margin-right:6px`} />
                        {meta.label}
                      </td>
                      <td style="padding:3px 8px;text-align:right">{m.sessions.toLocaleString()}</td>
                      <td style="padding:3px 8px;text-align:right">{formatCompact(m.tokens)}</td>
                      <td style="padding:3px 8px;text-align:right;color:var(--muted)">{trendSummary.total.tokens > 0 ? pct(m.tokens / trendSummary.total.tokens) : '—'}</td>
                      <td style="padding:3px 0 3px 8px;text-align:right">{median !== undefined ? formatCompact(median) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Estimated cost */}
      {pricedSess.length > 0 && (
        <>
          <SectionHead id="analytics-cost" title="ESTIMATED COST" first={!hasPlan && !hasAgentBreakdown && trend.bins.length === 0} helpAnchor="help-costs" />
          {disclaimer}

          {copilotSess.length > 0 && (
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-bottom:8px">
              <span style={'display:inline-block;width:6px;height:6px;border-radius:50%;background:' + getAgentColor('copilot')} />
              <span style="text-transform:uppercase;letter-spacing:.3px;font-size:10px">Copilot — Token-based</span>
            </div>
          )}

          {/* Daily total legend above chart */}
          <div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted);margin-bottom:6px">
            <svg width="16" height="8" viewBox="0 0 16 8">
              <line x1="0" y1="4" x2="16" y2="4" stroke="var(--vscode-charts-green,#81c784)" stroke-width="1.5" stroke-dasharray="4 2" />
            </svg>
            Daily total (right axis)
          </div>

          <CostBarChart sessions={pricedChartSess} />

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
                  const headers = ['Date','Agent','Model','Input Tokens','Output Tokens','Cache Create Tokens','Cache Read Tokens','Total Tokens','Estimated Cost (USD)']
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
                    {(['Date','Agent','Model','Input','Output','Cache Create','Cache Read','Total Tokens','Estimated Cost (USD)'] as const).map(h => (
                      <th key={h} style={`padding:3px 8px 3px ${h==='Date'?'0':'6px'};color:var(--muted);font-weight:500;text-align:${['Input','Output','Cache Create','Cache Read','Total Tokens','Estimated Cost (USD)'].includes(h)?'right':'left'}`}>{h}</th>
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

      {/* Token usage per session */}
      <SectionHead id="analytics-token-usage" title="TOKEN USAGE PER TRACE" />
      <div style="display:flex;gap:12px;margin-bottom:6px;font-size:10px;color:var(--muted)">
        <span><span style="display:inline-block;width:10px;height:3px;background:#FFB74D;border-radius:1px;vertical-align:middle" /> Input tokens</span>
        <span><span style="display:inline-block;width:10px;height:3px;background:#81C784;border-radius:1px;vertical-align:middle" /> Output tokens</span>
      </div>
      {/* Always pass newest-first (rangedSessions); chart reverses internally to oldest-first */}
      <SessionTokenChart sessions={timeOrdered} />

      {/* Context growth */}
      <SectionHead id="analytics-context-growth" title="CONTEXT GROWTH" />
      <ContextGrowthChart sessions={chartSessions} timelines={timelines} />

    </SectionNav>
    </div>
  )
}
