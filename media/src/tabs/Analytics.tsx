import { useEffect, useState } from 'preact/hooks'
import {
  filteredSessions, sessionSummary,
  sessionTimelines,
  requestGitOutcomesFor,
  CHART_MAX, requestSessionTimeline, goToHelp,
} from '../state'
import { getAgentColorVar, getAgentSourceLabel, formatMs, formatCompact } from '../utils'
import { buildDailyCostMap } from '../sessionMetrics'
import type { SessionSummaryCard } from '../types'
import { PRICING_LAST_UPDATED } from '../pricing'

import { ContextGrowthChart, OutcomeTrendChart, CodeChangesChart, CHANGE_COLOR, buildOutcomeTokenBuckets } from './SessionCharts'
import { buildCodeChangeBins } from './codeChanges'
import { fmtUsd } from './Cost'
import { TimeBarChart, TimeBarLegend, type StackSeries, type StackBin } from './TimeBarChart'
import { buildDayBins, periodTotals, costHeadline } from '../costTrend'
import { computeStats } from './Agents'
import { ViewNav, ViewHeader, ViewSection, ViewEmpty, type ViewNavItem } from '../ViewNav'
import { EfficiencyMap, HotFiles } from './Efficiency'
import { advisorPendingCount } from './Patterns'
import { buildTrendBins, summarize, TREND_OUTCOMES, TREND_COLOR } from './outcomeTrend'
import { OUTCOME_META } from './Sessions'
import { gitOutcomes, selectedAgentFilter, timeRange, previousPeriodSessions, analyticsView, setAnalyticsView, goToAdvisor, type AnalyticsView } from '../state'
import { planUsage, hasPlanData, forAgentFilter, PROVIDER_LABEL } from '../planUsage'
import { PlanLimitsSection } from './PlanLimits'
import { NoTracesYet } from './GettingStarted'
import { buildLanguageBreakdown, LANGUAGE_NOT_REPORTED_LABEL, type CodeChangeTotals, type LanguageBreakdownRow } from './languageBreakdown'
import { languageLabel } from '../language'
import { CloudNote } from './CloudNote'

// ── Agents: side-by-side comparison ─────────────────────────────────────────

const BREAKDOWN_SOURCES = ['copilot', 'claude_code', 'codex', 'opencode', 'cursor', 'antigravity'] as const

/** One column per agent with traces in view, one row per measure, so agents read across a row
 *  instead of between cards. Cursor CLI records no token counts at all (Antigravity none without
 *  its conversation database), so those cells read as missing, never as 0 / 0%. */
function AgentComparison({ breakdown }: { breakdown: Array<{ source: string; sessions: SessionSummaryCard[] }> }) {
  const cols = breakdown.map(b => {
    const s = computeStats(b.sessions)
    const hasTokens = s.totalInput > 0 || s.totalOutput > 0 || s.totalCache > 0
    // Agent-authored change size (src/editStats.ts), summed over traces that recorded line counts.
    const withLines = b.sessions.filter(x => x.linesAdded !== undefined && x.linesRemoved !== undefined)
    const linesAdded = withLines.reduce((n, x) => n + (x.linesAdded ?? 0), 0)
    const linesRemoved = withLines.reduce((n, x) => n + (x.linesRemoved ?? 0), 0)
    const topTools = Object.entries(s.toolCounts).sort((x, y) => y[1] - x[1]).slice(0, 3)
    return { source: b.source, s, hasTokens, linesKnown: withLines.length > 0, linesAdded, linesRemoved, topTools }
  })
  type Col = typeof cols[number]
  const rows: Array<{ label: string; tip?: string; cell: (c: Col) => string }> = [
    { label: 'Traces', cell: c => c.s.sessions.toLocaleString() },
    { label: 'Turns', cell: c => c.s.totalLlm.toLocaleString() },
    { label: 'Tool calls', cell: c => c.s.totalTools.toLocaleString() },
    { label: 'Input tokens', cell: c => c.hasTokens ? formatCompact(c.s.totalInput) : '—' },
    { label: 'Output tokens', cell: c => c.hasTokens ? formatCompact(c.s.totalOutput) : '—' },
    { label: 'Cache hit', cell: c => c.hasTokens ? `${(c.s.cacheHitRate * 100).toFixed(0)}%` : '—' },
    { label: 'Avg duration', cell: c => formatMs(c.s.avgDuration) },
    { label: 'Avg TTFT', cell: c => c.s.avgTtft > 0 ? formatMs(c.s.avgTtft) : '—' },
    { label: 'Lines +/−', tip: "Lines the agent's own edit/write tool calls added and removed, not git stats", cell: c => c.linesKnown ? `+${formatCompact(c.linesAdded)} / −${formatCompact(c.linesRemoved)}` : '—' },
    { label: 'One-shot', tip: 'Files edited exactly once vs. files that needed a retry, across all traces in this view. Edit-pass count, not a signal the code actually worked.', cell: c => c.s.oneShotRate !== null ? `${Math.round(c.s.oneShotRate * 100)}%` : '—' },
    { label: 'Top tools', cell: c => c.topTools.length > 0 ? c.topTools.map(([t, n]) => `${t} ${n}×`).join(', ') : '—' },
  ]
  return (
    <div class="h-scroll-hint" role="region" aria-label="Agent comparison" tabIndex={0}>
      <table data-testid="agent-comparison" style="border-collapse:collapse;font-size:12px;min-width:100%">
        <thead>
          <tr>
            <th scope="col" style="text-align:left;padding:6px 12px 6px 0;color:var(--muted);font-weight:500">Measure</th>
            {cols.map(c => (
              <th key={c.source} scope="col" data-agent-card={c.source}
                style={`text-align:right;padding:6px 10px;font-weight:600;white-space:nowrap;border-top:3px solid ${getAgentColorVar(c.source)}`}>
                {getAgentSourceLabel(c.source)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label} style="border-top:1px solid var(--border)">
              <th scope="row" style="text-align:left;padding:5px 12px 5px 0;color:var(--muted);font-weight:400;white-space:nowrap" data-tip={r.tip}>{r.label}</th>
              {cols.map(c => (
                <td key={c.source} data-agent={c.source}
                  style={`text-align:right;padding:5px 10px;font-variant-numeric:tabular-nums;${r.label === 'Top tools' ? 'font-size:var(--fs-xs);color:var(--muted);max-width:200px;white-space:normal' : 'white-space:nowrap'}`}>
                  {r.cell(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main Analytics component ──────────────────────────────────────────────────

/** By language's "lines the agent changed" line: files and +/− lines summed over the traces that
 *  recorded them, and how many of the traces in view that was (cloud's CodeChangesSummary). */
function LanguageCodeChangesSummary({ totals }: { totals: CodeChangeTotals }) {
  if (totals.sessionsReported === 0) {
    return (
      <p data-testid="language-code-changes" style="font-size:12px;color:var(--muted);margin:0 0 10px">
        No trace in view recorded files or lines changed. Traces stored before change tracking, and agents that don't record edit contents, have none.
      </p>
    )
  }
  const stat = (value: string, label: string, color?: string) => (
    <div>
      <div style={`font-size:20px;font-weight:600${color ? `;color:${color}` : ''}`}>{value}</div>
      <div style="color:var(--muted)">{label}</div>
    </div>
  )
  const notReported = totals.sessions - totals.sessionsReported
  return (
    <div data-testid="language-code-changes" style="display:flex;flex-wrap:wrap;gap:16px;font-size:12px;margin:0 0 10px">
      {stat(totals.filesChanged.toLocaleString(), 'files changed')}
      {stat(`+${totals.linesAdded.toLocaleString()}`, 'lines added', CHANGE_COLOR.added)}
      {stat(`−${totals.linesRemoved.toLocaleString()}`, 'lines removed', CHANGE_COLOR.removed)}
      <div style="align-self:flex-end;color:var(--muted)">
        from {totals.sessionsReported.toLocaleString()} of {totals.sessions.toLocaleString()} trace{totals.sessions === 1 ? '' : 's'}
        {notReported > 0 && ` (${notReported.toLocaleString()} recorded no change data)`}
      </div>
    </div>
  )
}

/** Traces, cost, tokens and lines per primary language (cloud's LanguageBreakdownTable). */
function LanguageBreakdownTable({ rows }: { rows: LanguageBreakdownRow[] }) {
  const max = Math.max(...rows.map(r => r.sessions), 1)
  const th = (label: string, last = false) => <th scope="col" style={`text-align:left;font-weight:600;padding:0 ${last ? 0 : 8}px 4px 0`}>{label}</th>
  return (
    <div class="h-scroll-hint" role="region" aria-label="Traces by language" tabIndex={0}>
      <table data-testid="language-breakdown" style="font-size:12px;width:100%;border-collapse:collapse">
        <thead>
          <tr style="color:var(--muted);font-size:11px">
            {th('Language')}{th('Traces')}{th('Est cost')}{th('Tokens')}{th('Lines +/−', true)}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.language ?? 'not-reported'} style="border-top:1px solid var(--border)">
              <td style="padding:6px 8px 6px 0;white-space:nowrap">
                <div>{r.language === null ? LANGUAGE_NOT_REPORTED_LABEL : languageLabel(r.language)}</div>
                <div aria-hidden="true" style={`height:4px;margin-top:3px;width:${Math.max(2, r.sessions / max * 100)}%;max-width:120px;border-radius:999px;background:${r.language === null ? 'var(--border)' : 'var(--accent)'}`} />
              </td>
              <td style="padding:6px 8px 6px 0">{r.sessions.toLocaleString()}</td>
              <td style="padding:6px 8px 6px 0">{fmtUsd(r.costUsd)}</td>
              <td style="padding:6px 8px 6px 0;color:var(--muted)">{formatCompact(r.tokens)}</td>
              <td style="padding:6px 0;white-space:nowrap">
                {r.sessionsReported === 0
                  ? <span style="color:var(--muted)">—</span>
                  : <><span style={`color:${CHANGE_COLOR.added}`}>+{r.linesAdded.toLocaleString()}</span>{' '}<span style={`color:${CHANGE_COLOR.removed}`}>−{r.linesRemoved.toLocaleString()}</span></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Analytics() {
  const [abbrevTokens, setAbbrevTokens] = useState(true)
  const [showZeroCost, setShowZeroCost] = useState(false)
  const sessions = filteredSessions.value
  const timelines = sessionTimelines.value
  const hasAny = (sessionSummary.value?.sessions?.length ?? 0) > 0

  // Output's outcome chart needs every filtered session's git outcome resolved, not just whichever
  // happen to already be cached from a visit to the Sessions tab — mirrors how Sessions.tsx itself
  // triggers requests as its own rows render. Only while that view is open.
  const outputOpen = analyticsView.value === 'output'
  useEffect(() => { if (outputOpen) requestGitOutcomesFor(sessions) }, [sessions, outputOpen])

  if (sessions.length === 0) {
    return (
      <div id="analytics-content">
        <div class="empty-state">{hasAny ? 'No traces match the active filters.' : <NoTracesYet />}</div>
      </div>
    )
  }

  const pricedSess = sessions.filter(s => s.source === 'copilot' || s.source === 'codex' || s.source === 'claude_code' || s.source === 'opencode')
  const copilotSess = sessions.filter(s => s.source === 'copilot')
  // One Agents column per source with traces in view, in the agent filter's order.
  const breakdown = BREAKDOWN_SOURCES
    .map(source => ({ source, sessions: sessions.filter(s => s.source === source) }))
    .filter(b => b.sessions.length > 0)

  // Charts need time-ordered sessions and must respect all active filters (text, initiator, source).
  // filteredSessions applies all filters but may be sorted by cost/model for the Sessions table,
  // so re-sort by time here. rangedSessions skips text + initiator — don't use it for charts.
  const timeOrdered = [...filteredSessions.value].sort((a, b) =>
    Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0')
  )

  // Most recent CHART_MAX sessions (newest-first slice, then reversed to oldest-first for charts)
  const chartSessions = timeOrdered.slice(0, CHART_MAX).reverse()

  // Load timelines for the context growth chart, only while the Efficiency view shows it.
  if (analyticsView.value === 'efficiency') {
    chartSessions.forEach(sess => {
      if (!sessionTimelines.value[sess.sessionId]) requestSessionTimeline(sess.sessionId)
    })
  }

  const disclaimer = (
    <div style="font-size:11px;background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:6px 10px;margin-bottom:8px;color:var(--muted)">
      Estimates only, not your actual bill. Rates last updated: {PRICING_LAST_UPDATED}
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

  // By-language cut — only once some trace in view actually carries a language (older stored
  // rows don't), otherwise it would be one "—" row.
  const languageBreakdown = buildLanguageBreakdown(sessions)
  const hasLanguageBreakdown = languageBreakdown.rows.some(r => r.language !== null)

  // Outcome & token spend over time — same binning `requestGitOutcomesFor` above keeps filling in,
  // so this grows as outcomes resolve rather than waiting for all of them up front.
  const trend = buildTrendBins(sessions, gitOutcomes.value)
  const trendSummary = summarize(trend.bins)
  const outcomeBuckets = buildOutcomeTokenBuckets(sessions, gitOutcomes.value)
  const medianByOutcome = new Map(outcomeBuckets.map(b => [b.outcome, b.medianTokens]))
  const pct = (n: number) => `${Math.round(n * 100)}%`
  // Code changes over time — agent-authored lines/files (src/editStats.ts), same filtered set.
  const changes = buildCodeChangeBins(sessions)

  const plan = forAgentFilter(planUsage.value, selectedAgentFilter.value)
  const hasPlan = hasPlanData(plan)

  // Multi-dimensional cost table: date → agent, scrollable.
  const costTable = (
    <>
          {/* Multi-dimensional cost table: date → agent, scrollable */}
            <div style="display:flex;justify-content:flex-end;align-items:center;gap:4px;margin-bottom:4px">
              <button
                onClick={() => setShowZeroCost(s => !s)}
                title={showZeroCost ? 'Hide $0.00 rows' : 'Show $0.00 rows (included/free models)'}
                style={`font-size:var(--fs-xs);padding:2px 8px;cursor:pointer;border:1px solid var(--border);border-radius:3px;background:${showZeroCost ? 'var(--hover)' : 'transparent'};color:var(--muted);white-space:nowrap`}
              >Show $0</button>
              <button
                onClick={() => setAbbrevTokens(a => !a)}
                title={abbrevTokens ? 'Switch to full numbers' : 'Switch to abbreviated numbers'}
                style="font-size:var(--fs-xs);padding:2px 8px;cursor:pointer;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--muted);white-space:nowrap"
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
                style="font-size:var(--fs-xs);padding:2px 8px;cursor:pointer;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--muted);white-space:nowrap"
              >↓ CSV</button>
            </div>
            <div class="h-scroll-hint" style="margin-bottom:8px">
              <table style="border-collapse:collapse;font-size:var(--fs-xs);min-width:100%;white-space:nowrap">
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
                          <td style="padding:3px 8px;text-align:right;color:var(--fg);font-weight:600">{fmtUsd(d.cost)}</td>
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
                                <span style={'display:inline-block;width:5px;height:5px;border-radius:50%;background:' + getAgentColorVar(src) + ';vertical-align:middle;margin-right:4px'} />
                                {getAgentSourceLabel(src)}
                              </td>
                              <td style="padding:3px 8px;color:var(--muted);font-size:var(--fs-xs);max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={modelFull}>{modelShort}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{fmtN(ae.input)}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{fmtN(ae.output)}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{fmtN(ae.cacheCreate)}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{fmtN(ae.cacheRead)}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{fmtN(agentTotal)}</td>
                              <td style="padding:3px 8px;text-align:right;color:var(--fg)">{fmtUsd(ae.cost)}</td>
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
                    <td style="padding:3px 8px;text-align:right;font-weight:600;color:var(--fg)">{fmtUsd(grand.cost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
    </>
  )

  const view = analyticsView.value
  const help = (anchor: string) => goToHelp(anchor)
  const pendingRecs = advisorPendingCount.value

  const items: ViewNavItem<AnalyticsView>[] = [
    { id: 'cost',       label: 'Cost & limits', hint: 'Spend and plan windows' },
    { id: 'output',     label: 'Output',        hint: 'Outcomes, code changes, languages' },
    { id: 'efficiency', label: 'Efficiency',    hint: 'Wasted turns, hot files, context' },
    { id: 'agents',     label: 'Agents',        hint: 'Side-by-side comparison' },
  ]

  // ── Cost & limits ──
  const planSection = (
    <ViewSection id="analytics-plan-limits" title="Plan limits" helpAnchor="help-plan-limits" onHelp={help}
      tip="How much of your Claude or ChatGPT plan's 5-hour and weekly windows you've used, read from files Claude Code and Codex write themselves. No credentials are read and nothing is sent anywhere.">
      {hasPlan
        ? <PlanLimitsSection snapshot={plan} />
        : <ViewEmpty>{selectedAgentFilter.value !== 'all' && hasPlanData(planUsage.value)
            ? 'Plan limits come from Claude Code and Codex subscription plans. Choose All, Claude or Codex in the agent filter to see them.'
            : 'No plan usage recorded yet. Claude Code and Codex write it while you work on a subscription plan; usage through an API key has no plan limit.'}</ViewEmpty>}
    </ViewSection>
  )
  // ── Cost and tokens per day (one axis each, a real time axis; costTrend.ts) ──
  const days = buildDayBins(sessions)
  const costSeries: StackSeries[] = BREAKDOWN_SOURCES
    .filter(src => days.bins.some(b => (b.costBySource[src] ?? 0) > 0))
    .map(src => ({ key: src, label: getAgentSourceLabel(src) + (src === 'copilot' && copilotSess.length > 0 ? ' (token-based)' : ''), color: getAgentColorVar(src) }))
  const costBins: StackBin[] = days.bins.map(b => ({ start: b.start, end: b.end, values: b.costBySource, note: `${b.pricedTraces} trace${b.pricedTraces === 1 ? '' : 's'}` }))
  const current = periodTotals(sessions)
  const prev = previousPeriodSessions.value
  const headline = costHeadline(timeRange.value, current, prev ? periodTotals(prev) : null, fmtUsd)
  const unpriced = sessions.length - current.pricedTraces
  const usdTick = (v: number) => (v === 0 ? '$0' : fmtUsd(v))
  const tokenSeries: StackSeries[] = [
    { key: 'in', label: 'Input tokens', color: 'var(--accent)' },
    { key: 'out', label: 'Output tokens', color: 'color-mix(in srgb, var(--accent) 45%, var(--bg))' },
  ]
  const tokenBins: StackBin[] = days.bins.map(b => ({ start: b.start, end: b.end, values: { in: b.tokensIn, out: b.tokensOut }, note: `${b.traces} trace${b.traces === 1 ? '' : 's'}` }))
  const hasTokens = days.bins.some(b => b.tokensIn + b.tokensOut > 0)

  const costSection = (
    <ViewSection id="analytics-cost" title={`Estimated cost per ${days.unit}`} helpAnchor="help-costs" onHelp={help}>
      {pricedSess.length === 0 || current.pricedTraces === 0 ? (
        <ViewEmpty>No trace in view can be priced. Cost is estimated for Copilot, Claude Code, Codex and OpenCode traces from their token counts.</ViewEmpty>
      ) : (
        <>
          <p data-testid="cost-headline" style="font-size:12px;margin:0 0 6px"><strong>{headline}</strong></p>
          {disclaimer}
          <div data-testid="cost-chart-legend"><TimeBarLegend series={costSeries} /></div>
          <TimeBarChart testId="cost-chart" bins={costBins} unit={days.unit} series={costSeries}
            yTitle={`Estimated cost (USD) per ${days.unit}`} format={usdTick}
            ariaLabel={`Estimated cost per ${days.unit}, stacked by agent: ${headline}`} />
          {(unpriced > 0 || days.unit === 'week') && (
            <p style="font-size:11px;color:var(--muted);margin:6px 0 0">
              {unpriced > 0 && `${unpriced.toLocaleString()} trace${unpriced === 1 ? '' : 's'} with an unrecognised model ${unpriced === 1 ? 'is' : 'are'} not in the cost.`}
              {days.unit === 'week' ? `${unpriced > 0 ? ' ' : ''}Grouped by week (Monday start, UTC).` : ''}
            </p>
          )}
          {dayRows.length > 0 && <div style="margin-top:10px">{costTable}</div>}
        </>
      )}
    </ViewSection>
  )
  const tokenSection = (
    <ViewSection id="analytics-token-usage" title={`Tokens per ${days.unit}`}>
      {!hasTokens ? (
        <ViewEmpty>No trace in view recorded token counts.</ViewEmpty>
      ) : (
        <>
          <TimeBarLegend series={tokenSeries} />
          <TimeBarChart testId="token-chart" bins={tokenBins} unit={days.unit} series={tokenSeries}
            yTitle={`Tokens (input + output) per ${days.unit}`} format={formatCompact}
            ariaLabel={`Tokens per ${days.unit}, input and output stacked.`} />
        </>
      )}
    </ViewSection>
  )

  // ── Output ──
  const outcomeSection = (
    <ViewSection id="analytics-outcome-tokens" title="Outcome & token spend over time"
      tip="Tokens and traces per day (or week), stacked by what happened to the work locally per git: merged, committed, or still uncommitted. Traces with no changed files, or outside a git repo, aren't counted.">
      {trend.bins.length === 0 ? (
        <ViewEmpty>No trace in view has a git outcome yet. Only traces that changed files inside a git repo count here, and their outcomes fill in as git is checked.</ViewEmpty>
      ) : (
        <>
          <p style="font-size:12px;margin:0 0 4px">
            <strong>{formatCompact(trendSummary.total.tokens)}</strong> tokens across{' '}
            <strong>{trendSummary.total.sessions.toLocaleString()}</strong> trace{trendSummary.total.sessions === 1 ? '' : 's'};{' '}
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
    </ViewSection>
  )
  const codeChangesSection = (
    <ViewSection id="analytics-code-changes" title="Code changes over time" helpAnchor="help-code-changes" onHelp={help}
      tip="Lines the agent's own edit/write tool calls added and removed, and files it changed, per day (or week). Agent-authored edits, not git commit stats.">
      {changes.total.traces > 0 && (
        <>
          <p style="font-size:12px;margin:0 0 4px">
            <strong style={`color:${CHANGE_COLOR.added}`}>+{formatCompact(changes.total.added)}</strong> /{' '}
            <strong style={`color:${CHANGE_COLOR.removed}`}>−{formatCompact(changes.total.removed)}</strong> lines across{' '}
            <strong>{changes.total.files.toLocaleString()}</strong> file{changes.total.files === 1 ? '' : 's'} changed in{' '}
            <strong>{changes.total.traces.toLocaleString()}</strong> trace{changes.total.traces === 1 ? '' : 's'}.
          </p>
          <div style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--muted);margin-bottom:8px">
            <span style="display:inline-flex;align-items:center;gap:4px"><span style={`display:inline-block;width:8px;height:8px;border-radius:2px;background:${CHANGE_COLOR.added}`} />Lines added</span>
            <span style="display:inline-flex;align-items:center;gap:4px"><span style={`display:inline-block;width:8px;height:8px;border-radius:2px;background:${CHANGE_COLOR.removed}`} />Lines removed</span>
            <span style="display:inline-flex;align-items:center;gap:4px">
              <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" stroke={CHANGE_COLOR.files} stroke-width="1.5" stroke-dasharray="4 2" /></svg>
              Files changed (right axis)
            </span>
          </div>
        </>
      )}
      <CodeChangesChart trend={changes} />
      {(changes.excluded > 0 || changes.unit === 'week') && (
        <p data-testid="code-changes-note" style="font-size:11px;color:var(--muted);margin:6px 0 0">
          {changes.excluded > 0 && `${changes.excluded.toLocaleString()} trace${changes.excluded === 1 ? '' : 's'} without change data not counted (stored before change tracking, or the agent doesn't record edit contents).`}
          {changes.unit === 'week' ? `${changes.excluded > 0 ? ' ' : ''}Grouped by week (Monday start, UTC).` : ''}
        </p>
      )}
    </ViewSection>
  )
  // By language — traces grouped by primary language (media/src/language.ts), in the cloud
  // dashboard's "By language" format: intro, lines-changed summary, then the table.
  const languageSection = (
    <ViewSection id="analytics-language-breakdown" title="By language" helpAnchor="help-language" onHelp={help}
      tip="Traces grouped by primary language: the most common code language among the files the agent read or changed. A trace with no code is grouped by the kind of file it touched (Docs, Config, Data, Assets); 'No files' means it touched none.">
      {hasLanguageBreakdown ? (
        <>
          <p style="font-size:11px;color:var(--muted);margin:0 0 8px">
            Each trace's main programming language and the lines its agent added and removed.
          </p>
          <LanguageCodeChangesSummary totals={languageBreakdown.totals} />
          <LanguageBreakdownTable rows={languageBreakdown.rows} />
        </>
      ) : (
        <ViewEmpty>No trace in view recorded a language. Traces stored before language tracking have none.</ViewEmpty>
      )}
    </ViewSection>
  )

  // ── Efficiency ──
  const efficiencyView = (
    <>
      <div class="view-crosslink">
        <span>{pendingRecs > 0
          ? `${pendingRecs} recommendation${pendingRecs === 1 ? '' : 's'} in Advisor ${pendingRecs === 1 ? 'is' : 'are'} built from what this view shows.`
          : 'Recommendations in Advisor are built from what this view shows.'}</span>
        <button type="button" class="link-btn" onClick={() => goToAdvisor('recommendations')}>Open Recommendations</button>
      </div>
      <ViewSection id="analytics-efficiency-map" title="Cost vs back-and-forth">
        <EfficiencyMap sessions={sessions} />
      </ViewSection>
      <ViewSection id="analytics-hot-files" title="Hot files">
        <HotFiles sessions={sessions} />
      </ViewSection>
      <ViewSection id="analytics-context-growth" title="Context growth">
        <ContextGrowthChart sessions={chartSessions} timelines={timelines} />
      </ViewSection>
    </>
  )

  return (
    <div id="analytics-content">
      <ViewNav label="Analytics views" title="Analytics" items={items} active={view} onSelect={setAnalyticsView}>
        {view === 'cost' && (
          <div data-view-panel="cost">
            <ViewHeader title="Cost & limits" question="How much am I spending, and how close am I to my plan limits?" />
            {hasPlan && planSection}
            {costSection}
            {tokenSection}
            {!hasPlan && planSection}
          </div>
        )}
        {view === 'output' && (
          <div data-view-panel="output">
            <ViewHeader title="Output" question="What did the tokens buy: work that landed, code changed, and in which languages?" />
            {outcomeSection}
            {codeChangesSection}
            {languageSection}
          </div>
        )}
        {view === 'efficiency' && (
          <div data-view-panel="efficiency">
            <ViewHeader title="Efficiency" question="Where is effort being wasted: costly back-and-forth, files re-read every time, context that keeps growing?" />
            {efficiencyView}
          </div>
        )}
        {view === 'agents' && (
          <div data-view-panel="agents">
            <ViewHeader title="Agents" question="How do my agents compare on the same kind of work?" />
            <ViewSection id="analytics-agent-breakdown" title="Agent comparison">
              <AgentComparison breakdown={breakdown} />
            </ViewSection>
          </div>
        )}
        <CloudNote kind="analytics" />
      </ViewNav>
    </div>
  )
}
