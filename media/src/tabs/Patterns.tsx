import { useState, useRef, useEffect } from 'preact/hooks'
import { filteredSessions, activeTab, focusedSessionId, sessionTextFilter, currentWorkspace, vscode, availableWorkspaces, workspaceFilter } from '../state'
import { Instructions, instructionFiles } from './Instructions'
import { getAgentSourceLabel, formatSessionTime } from '../utils'
import { calcSessionCost } from '../sessionMetrics'
import { fmtUsd } from './Cost'
import type { SessionSummaryCard } from '../types'
import { getCostSavingActions, type CostSavingAction } from '../costSavingActions'
import { planUsage } from '../planUsage'
import { LOOP_SIGNAL_ICON_TYPE, SIGNAL_ICON, SIGNAL_SEVERITY_COLOR } from '../signalIcons'
import { SIGNAL_FORMULAS } from '../signalFormulas'
import { SectionNav, type NavSection } from '../SectionNav'

// ── Helpers ───────────────────────────────────────────────────────────────────

const AGENT_DOT_COLOR: Record<string, string> = {
  claude_code: '#FFB085',
  copilot:     '#00EAFF',
  codex:       '#F0FF42',
}
function agentDotColor(source: string): string { return AGENT_DOT_COLOR[source] ?? '#888' }

function sessionCost(s: SessionSummaryCard): number {
  return calcSessionCost(s).totalUsd
}

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p
}

const sectionHead = 'font-size:12px;color:var(--muted);margin:0 0 6px;text-transform:uppercase;letter-spacing:.3px'

// ── Efficiency Map ────────────────────────────────────────────────────────────

type MatchSort = 'time' | 'prompt' | 'cost' | 'turns' | 'cache'

function EfficiencyMap({ sessions }: { sessions: SessionSummaryCard[] }) {
  const filter = sessionTextFilter.value
  const [tooltip, setTooltip] = useState<{ x: number; y: number; s: SessionSummaryCard } | null>(null)
  const [sort, setSort] = useState<{ col: MatchSort; dir: 'asc' | 'desc' }>({ col: 'cost', dir: 'desc' })
  const [clicked, setClicked] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const points = sessions
    .filter(s => s.totalLlmCalls > 0)
    .map(s => ({
      s,
      cost: sessionCost(s),
      turns: s.totalLlmCalls,
      cacheHitRate: s.cacheHitRate ?? 0,
    }))

  if (points.length === 0) return <div class="empty-state" style="padding:20px">No traces with turn data yet.</div>

  const axisPoints = points

  const W = 560, H = 240, PAD = { top: 12, right: 16, bottom: 32, left: 52 }
  const cw = W - PAD.left - PAD.right
  const ch = H - PAD.top - PAD.bottom

  const maxCost  = Math.max(...axisPoints.map(p => p.cost), 0.01) * 1.15
  const maxTurns = Math.max(...axisPoints.map(p => p.turns), 1) * 1.15

  const xPos = (cost: number)  => PAD.left + (cost / maxCost) * cw
  const yPos = (turns: number) => PAD.top  + ch - (turns / maxTurns) * ch

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ v: f * maxCost, x: PAD.left + f * cw }))
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ v: Math.round(f * maxTurns), y: PAD.top + ch - f * ch }))

  const sortedMatches = (() => {
    const m = [...points]
    const d = sort.dir === 'asc' ? 1 : -1
    if (sort.col === 'time')   m.sort((a, b) => d * (new Date(a.s.startTime).getTime() - new Date(b.s.startTime).getTime()))
    if (sort.col === 'prompt') m.sort((a, b) => d * (a.s.userRequest ?? '').localeCompare(b.s.userRequest ?? ''))
    if (sort.col === 'cost')   m.sort((a, b) => d * (a.cost - b.cost))
    if (sort.col === 'turns')  m.sort((a, b) => d * (a.turns - b.turns))
    if (sort.col === 'cache')  m.sort((a, b) => d * (a.cacheHitRate - b.cacheHitRate))
    return m.slice(0, 10)
  })()

  const toggleSort = (col: MatchSort) =>
    setSort(s => s.col === col ? { col, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: 'desc' })

  const topMatchIds = new Set(sortedMatches.map(p => p.s.traceId))

  return (
    <div>
      <div style="margin-bottom:8px;padding:8px 10px;font-size:11px;color:var(--muted);line-height:1.6;background:var(--card-bg);border:1px solid var(--border);border-radius:4px">
        Each dot is one trace. <strong style="color:var(--fg)">Right</strong> = more expensive. <strong style="color:var(--fg)">Up</strong> = more model calls. <strong style="color:var(--fg)">Top-right</strong> dots cost the most and required the most back-and-forth — start there. <strong style="color:#81c784">Green</strong> = model reused cached context between calls (efficient). <strong style="color:#f44747">Red</strong> = model reprocessed everything from scratch on every call (wasteful).
      </div>
      <div style="margin-bottom:8px;display:flex;align-items:center;gap:8px">
        <span style="font-size:10px;color:var(--muted)">{points.length} trace{points.length !== 1 ? "s" : ""}{filter.trim() ? ' matching filter' : ''}</span>
        <span style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#81c784" /> cache ≥60%
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f6a623;margin-left:6px" /> 20–60%
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f44747;margin-left:6px" /> &lt;20%
        </span>
      </div>
      <div style="position:relative">
        <svg ref={svgRef} width={W} height={H} style="overflow:hidden;max-width:100%">
          <defs>
            <clipPath id="plot-area">
              <rect x={PAD.left} y={PAD.top} width={cw} height={ch} />
            </clipPath>
          </defs>
          {yTicks.map(t => (
            <line key={t.v} x1={PAD.left} y1={t.y} x2={PAD.left + cw} y2={t.y} stroke="var(--border)" stroke-width="1" />
          ))}
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + ch} stroke="var(--border)" stroke-width="1" />
          <line x1={PAD.left} y1={PAD.top + ch} x2={PAD.left + cw} y2={PAD.top + ch} stroke="var(--border)" stroke-width="1" />
          <text x={PAD.left + cw / 2} y={H - 2} text-anchor="middle" font-size="10" fill="var(--muted)">Estimated cost (USD)</text>
          <text x={10} y={PAD.top + ch / 2} text-anchor="middle" font-size="10" fill="var(--muted)"
            transform={`rotate(-90,10,${PAD.top + ch / 2})`}>LLM calls</text>
          {xTicks.map(t => (
            <g key={t.v}>
              <line x1={t.x} y1={PAD.top + ch} x2={t.x} y2={PAD.top + ch + 4} stroke="var(--border)" />
              <text x={t.x} y={PAD.top + ch + 14} text-anchor="middle" font-size="9" fill="var(--muted)">
                {t.v < 0.01 ? '$0' : `$${t.v.toFixed(2)}`}
              </text>
            </g>
          ))}
          {yTicks.map(t => (
            <g key={t.v}>
              <line x1={PAD.left - 4} y1={t.y} x2={PAD.left} y2={t.y} stroke="var(--border)" />
              <text x={PAD.left - 6} y={t.y + 4} text-anchor="end" font-size="9" fill="var(--muted)">{t.v}</text>
            </g>
          ))}
          <g clip-path="url(#plot-area)">
            {points.map((p, i) => {
              const inTop = topMatchIds.has(p.s.traceId)
              const cx = xPos(p.cost), cy = yPos(p.turns)
              const color = p.cacheHitRate >= 0.6 ? '#81c784' : p.cacheHitRate >= 0.2 ? '#f6a623' : '#f44747'
              return (
                <circle key={i} cx={cx} cy={cy} r={inTop ? 5 : 4}
                  fill={color} opacity={inTop ? 1 : 0.6} style="cursor:pointer"
                  stroke={clicked === p.s.traceId ? '#fff' : 'none'} stroke-width="2"
                  onMouseEnter={() => setTooltip({ x: cx, y: cy, s: p.s })}
                  onMouseLeave={() => setTooltip(null)}
                  onClick={() => {
                    const next = clicked === p.s.traceId ? null : p.s.traceId
                    setClicked(next)
                    if (next) { focusedSessionId.value = p.s.sessionId; activeTab.value = 'sessions' }
                  }}
                />
              )
            })}
          </g>
        </svg>
        {tooltip && (() => {
          const s = tooltip.s
          const left = tooltip.x > W * 0.6 ? tooltip.x - 220 : tooltip.x + 12
          const top  = tooltip.y > H * 0.6 ? tooltip.y - 90  : tooltip.y + 8
          return (
            <div style={`position:absolute;left:${left}px;top:${top}px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--border);border-radius:4px;padding:7px 10px;font-size:11px;pointer-events:none;z-index:10;max-width:210px`}>
              <div style="font-weight:600;color:var(--fg);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                {s.userRequest ? s.userRequest.slice(0, 60) + (s.userRequest.length > 60 ? '…' : '') : '—'}
              </div>
              <div style="color:var(--muted);font-size:10px;line-height:1.6">
                <div>{getAgentSourceLabel(s.source)} · {s.model?.split('-').slice(-2).join('-')}</div>
                <div>{s.startTime.slice(0, 10)} · {fmtUsd(sessionCost(s))} · {s.totalLlmCalls} turns</div>
                <div>cache hit rate: {Math.round((s.cacheHitRate ?? 0) * 100)}%</div>
              </div>
            </div>
          )
        })()}
      </div>

      {sortedMatches.length > 0 && <div style="margin-top:8px;font-size:10px;color:var(--muted)">Top {sortedMatches.length} traces</div>}
      {sortedMatches.length > 0 && (() => {
        const thStyle = (col: MatchSort) =>
          `padding:4px 8px 4px 0;color:${sort.col === col ? 'var(--fg)' : 'var(--muted)'};font-weight:500;white-space:nowrap;cursor:pointer;user-select:none;font-size:11px`
        const arrow = (col: MatchSort) => sort.col === col ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''
        return (
          <div class="h-scroll-hint" style="margin-top:12px">
            <table style="width:100%;border-collapse:collapse;font-size:11px">
              <thead>
                <tr style="border-bottom:1px solid var(--border)">
                  <th style={thStyle('time')}   onClick={() => toggleSort('time')}>Start Time{arrow('time')}</th>
                  <th style={thStyle('prompt')} onClick={() => toggleSort('prompt')}>Prompt{arrow('prompt')}</th>
                  <th style={`${thStyle('cost')};text-align:right`}  onClick={() => toggleSort('cost')}>Estimated cost{arrow('cost')}</th>
                  <th style={`${thStyle('turns')};text-align:right`} onClick={() => toggleSort('turns')}>Turns{arrow('turns')}</th>
                  <th style={`${thStyle('cache')};text-align:right`} onClick={() => toggleSort('cache')}>Cache hit{arrow('cache')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedMatches.map((p, i) => {
                  const isClicked = clicked === p.s.traceId
                  return (
                  <tr key={i} style={`border-bottom:1px solid var(--border);${isClicked ? 'background:rgba(79,195,247,0.08);box-shadow:inset 3px 0 0 var(--accent)' : ''}`}>
                    <td style="padding:4px 8px 4px 0;white-space:nowrap;font-size:10px;font-variant-numeric:tabular-nums">
                      <span style={`display:inline-block;width:7px;height:7px;border-radius:50%;background:${agentDotColor(p.s.source)};margin-right:5px;flex-shrink:0;vertical-align:middle`} title={getAgentSourceLabel(p.s.source)} />
                      <span style="color:var(--accent);cursor:pointer;text-decoration:underline;text-underline-offset:2px"
                        title="Open in Traces tab"
                        onClick={() => { activeTab.value = 'sessions'; focusedSessionId.value = p.s.sessionId }}
                      >{formatSessionTime(p.s)}</span>
                    </td>
                    <td style="padding:4px 8px 4px 0;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)">{p.s.userRequest?.slice(0, 80) ?? '—'}</td>
                    <td style="padding:4px 8px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums">{fmtUsd(p.cost)}</td>
                    <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">{p.turns}</td>
                    <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)">{Math.round(p.cacheHitRate * 100)}%</td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>
        )
      })()}
    </div>
  )
}

// ── Hot Files ─────────────────────────────────────────────────────────────────

function HotFiles({ sessions }: { sessions: SessionSummaryCard[] }) {
  const [mode, setMode] = useState<'read' | 'changed' | 'written' | 'both'>('read')

  const fileMap = new Map<string, { read: number; changed: number; written: number; sessionCount: number; lastSeen: string }>()
  for (const s of sessions) {
    const seen = new Set<string>()
    const files = mode === 'read'    ? (s.filesRead ?? [])
                : mode === 'changed' ? (s.filesChanged ?? [])
                : mode === 'written' ? (s.filesWritten ?? [])
                : [...(s.filesRead ?? []), ...(s.filesChanged ?? [])]
    for (const f of files) {
      if (!seen.has(f)) {
        seen.add(f)
        const e = fileMap.get(f) ?? { read: 0, changed: 0, written: 0, sessionCount: 0, lastSeen: '' }
        e.sessionCount++
        // Always track all counts regardless of mode so columns stay meaningful across modes
        if (s.filesRead?.includes(f)) e.read++
        if (s.filesChanged?.includes(f)) e.changed++
        if (s.filesWritten?.includes(f)) e.written++
        if (!e.lastSeen || s.startTime > e.lastSeen) e.lastSeen = s.startTime
        fileMap.set(f, e)
      }
    }
  }

  const rows = [...fileMap.entries()]
    .map(([file, v]) => ({ file, ...v }))
    .sort((a, b) => b.sessionCount - a.sessionCount)
    .slice(0, 10)

  if (rows.length === 0) return <div class="empty-state">No file access data yet.</div>

  const tip = mode === 'read'
    ? <><strong style="color:var(--fg)">Read-heavy files</strong> are loaded into the agent&apos;s context window every trace — the context window is the block of text sent to the model on each call, and every token in it costs money. Files read frequently mean the agent is spending tokens re-loading content it already needed last time. Documenting their purpose in your instructions file lets the agent orient itself without reading the whole file. Large files are especially costly — splitting them into smaller focused modules reduces how much fills the context window per trace.</>
    : mode === 'changed'
    ? <><strong style="color:var(--fg)">Frequently changed files</strong> are your highest-churn surface area — the agent reads them into its context window, edits them, then often re-reads them to verify. Add guidance in your instructions file: what conventions to follow, what tests to run after edits, and what parts should not be modified without a specific reason. Clear constraints reduce back-and-forth and prevent the agent from undoing its own prior work.</>
    : mode === 'written'
    ? <><strong style="color:var(--fg)">Written files</strong> are those the agent replaced wholesale — using the Write or create_file tool rather than an incremental edit. High trace counts here mean the agent repeatedly regenerated the same file from scratch. If a file appears in Written across many traces, consider whether its structure is stable enough to edit incrementally, or whether its repeated re-creation signals unclear or conflicting instructions.</>
    : <><strong style="color:var(--fg)">Hot files</strong> are loaded into the agent&apos;s context window most often across traces — every read costs tokens. Files with high Read counts are candidates for documentation in your instructions file so the agent doesn't need to re-read them raw. Files with high Changed counts are high-churn; add constraints and testing requirements. Large files that appear here are strong candidates for splitting into smaller focused modules to keep context window usage lean.</>

  return (
    <div>
      <div style="margin-bottom:10px;padding:8px 10px;font-size:11px;color:var(--muted);line-height:1.6;background:var(--card-bg);border:1px solid var(--border);border-radius:4px">
        {tip}
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:11px;color:var(--muted)">Show:</span>
        <button class={'tab-mini' + (mode === 'read'    ? ' active' : '')} onClick={() => setMode('read')}>Read</button>
        <button class={'tab-mini' + (mode === 'changed' ? ' active' : '')} onClick={() => setMode('changed')}>Changed</button>
        <button class={'tab-mini' + (mode === 'written' ? ' active' : '')} onClick={() => setMode('written')}>Written</button>
        <button class={'tab-mini' + (mode === 'both'    ? ' active' : '')} onClick={() => setMode('both')}>Both</button>
      </div>
      <div class="h-scroll-hint">
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead>
            <tr style="border-bottom:1px solid var(--border)">
              <th style="text-align:left;padding:4px 8px 4px 0;color:var(--muted);font-weight:500">File</th>
              <th style="text-align:right;padding:4px 8px;color:var(--muted);font-weight:500;white-space:nowrap">Traces</th>
              <th style="text-align:right;padding:4px 8px;color:var(--muted);font-weight:500;white-space:nowrap" title="Traces where the agent read this file">Read</th>
              <th style="text-align:right;padding:4px 8px;color:var(--muted);font-weight:500;white-space:nowrap" title="Traces where the agent modified this file">Changed</th>
              <th style="text-align:right;padding:4px 8px;color:var(--muted);font-weight:500;white-space:nowrap" title="Traces where the agent fully wrote or created this file">Written</th>
              <th style="text-align:right;padding:4px 8px;color:var(--muted);font-weight:500;white-space:nowrap">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.file} style="border-bottom:1px solid var(--border)">
                <td style="padding:4px 8px 4px 0;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={r.file}>
                  <span style="color:var(--muted);font-size:10px">{r.file.replace(basename(r.file), '')}</span>
                  <span style="color:var(--fg)">{basename(r.file)}</span>
                </td>
                <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">{r.sessionCount}</td>
                <td style="padding:4px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{r.read || '—'}</td>
                <td style="padding:4px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{r.changed || '—'}</td>
                <td style="padding:4px 8px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{r.written || '—'}</td>
                <td style="padding:4px 8px;text-align:right;color:var(--muted);white-space:nowrap;font-size:10px">{r.lastSeen ? r.lastSeen.slice(0, 10) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

// Same stroke-icon convention as ../signalIcons.tsx (24x24 viewBox, stroke-width 2, 13x13
// rendered) rather than emoji, for the two action kinds that aren't loop signals and so have no
// icon of their own in the traces table's Signals column. Path data adapted from Lucide
// (lucide.dev, ISC license): zap / file-text.
function IconZap({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
    </svg>
  )
}

function IconFileText({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  )
}

// Loop-signal actions draw the exact same glyph the traces table's Signals column uses for that
// pattern (same convention as Insights.tsx's InsightIcon) so "how to spend less" and the Signals
// column always agree on what a given struggle pattern looks like. Non-loop kinds get a plain
// neutral icon since they have no traces-table equivalent.
function ActionIcon({ a }: { a: CostSavingAction }) {
  if (a.kind === 'loop_signal') {
    const iconType = a.loopSignalType ? LOOP_SIGNAL_ICON_TYPE[a.loopSignalType] : undefined
    const Icon = iconType ? SIGNAL_ICON[iconType] : undefined
    if (Icon) return <Icon color={SIGNAL_SEVERITY_COLOR[a.loopSignalSeverity ?? 'warning']} />
  }
  if (a.kind === 'cache_rate') return <IconZap color="var(--fg)" />
  return <IconFileText color="var(--fg)" />
}

// Loop-signal rows get the same bold-heading-plus-"What to do" hover as the Signals column's own
// icon tooltip (Sessions.tsx's SignalsCell) — reusing SIGNAL_FORMULAS' short/tip fields rather than
// the full LOOP_SIGNAL_ACTIONS paragraph already shown inline below the icon. Other kinds (cache
// rate, hot file) have no per-signal formula to draw from, so they're left without a tooltip.
function actionTipFor(a: CostSavingAction): string | null {
  if (a.kind !== 'loop_signal' || !a.loopSignalType) return null
  const f = SIGNAL_FORMULAS[a.loopSignalType]
  if (!f) return null
  return `<b>${a.title}</b>\n${f.short}\n<b>What to do:</b> ${f.tip}`
}

/** Pulls loop-signal actions, hot-file suggestions, and cache hit rate — each already computed
 *  elsewhere in this tab or in Insights — into one ranked "do these things to spend less" list.
 *  See .staged-issues/value-prop-and-cost-savings.md, Step 1. */
/** Suggests narrowing to one repo via the header's REPO filter: instruction-file suggestions are
 *  only as specific as the traces behind them. Gone once a repo is chosen, when there's only one
 *  repo (the filter isn't shown), or when this window's open folder already scopes them. */
function RepoFilterHint() {
  if (workspaceFilter.value.trim() !== '' || availableWorkspaces.value.length < 2 || currentWorkspace.value !== null) return null
  const focusRepo = () => {
    const el = document.getElementById('tr-filter-repo') as HTMLInputElement | null
    if (!el) return
    el.scrollIntoView({ block: 'nearest' })
    el.focus()
  }
  return (
    <div style="display:flex;align-items:center;gap:8px;margin:0 0 10px;padding:6px 10px;font-size:11px;color:var(--muted);background:var(--card-bg);border:1px solid var(--border);border-radius:4px">
      <span style="flex:1">Tip: pick a repo in <strong style="color:var(--fg)">Repo</strong> in the header above for suggestions tailored to that repo's instruction file.</span>
      <button onClick={focusRepo}
        style="padding:2px 8px;font-size:10px;border-radius:3px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);white-space:nowrap">Choose repo ↑</button>
    </div>
  )
}

function fmtPts(p: number): string {
  return p < 1 ? '<1 pt' : `${Math.round(p)} pt${Math.round(p) === 1 ? '' : 's'}`
}

function SaveMoneyCard({ actions }: { actions: CostSavingAction[] }) {
  const [expanded, setExpanded] = useState(false)
  const workspace = currentWorkspace.value

  useEffect(() => {
    if (workspace !== null && vscode) {
      vscode.postMessage({ type: 'getInstructionFiles', workspace })
    }
  }, [workspace])

  if (actions.length === 0) return null

  const shown = expanded ? actions : actions.slice(0, 3)

  return (
    <section id="advisor-save-money">
      <h3 style={sectionHead}>{actions.some(a => a.limitPts !== undefined) ? 'How to use less of your limit' : 'How to spend less'}</h3>
      <div style="display:flex;flex-direction:column;gap:10px">
        {shown.map(a => {
          const tip = actionTipFor(a)
          return (
            <div key={a.id} style="display:flex;gap:8px;align-items:flex-start;font-size:12px">
              <span
                style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;flex-shrink:0;margin-top:2px"
                {...(tip ? { title: tip, 'data-tip-html': true } : {})}
              >
                <ActionIcon a={a} />
              </span>
              <div>
                <div style="font-weight:600">
                  {a.title}
                  {a.limitPts !== undefined
                    ? <span style="font-weight:400;color:var(--muted);margin-left:6px" title="Estimated waste converted into points of your weekly plan limit, from how much of the window your past sessions used per dollar of work">≈ {fmtPts(a.limitPts)} of weekly limit</span>
                    : a.estimatedUsd !== undefined
                      ? <span style="font-weight:400;color:var(--muted);margin-left:6px">≈ ${a.estimatedUsd.toFixed(2)}</span>
                      : null}
                </div>
                <div style="color:var(--muted);margin:2px 0">{a.evidence}</div>
                <div>{a.action}</div>
              </div>
            </div>
          )
        })}
      </div>
      {actions.length > 3 && (
        <button
          class="btn-link"
          style="margin-top:8px;font-size:11px"
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? 'Show fewer' : `Show ${actions.length - 3} more`}
        </button>
      )}
    </section>
  )
}

export function Patterns() {
  const sessions = filteredSessions.value

  if (sessions.length === 0) {
    return <div class="empty-state">No traces recorded yet — patterns will appear once you have trace history.</div>
  }

  const divider = <div style="border-top:1px solid var(--border);margin:16px 0 8px" />
  const existingText = instructionFiles.value.map(f => f.content).join('\n')
  const actions = getCostSavingActions(sessions, existingText, planUsage.value)
  const navSections: NavSection[] = [
    ...(actions.length > 0 ? [{ id: 'advisor-save-money', label: 'How to spend less' }] : []),
    { id: 'advisor-instructions', label: 'Instructions file' },
    { id: 'advisor-efficiency-map', label: 'Efficiency map' },
    { id: 'advisor-hot-files', label: 'Hot files' },
  ]

  return (
    <div id="patterns-content" style="padding-top:8px">
    <SectionNav label="Advisor sections" sections={navSections}>
      <SaveMoneyCard actions={actions} />

      {actions.length > 0 && divider}

      <section id="advisor-instructions">
        <h3 style={sectionHead}>Instructions File</h3>
        <RepoFilterHint />
        <Instructions />
      </section>

      {divider}

      <section id="advisor-efficiency-map">
        <h3 style={sectionHead}>Efficiency Map</h3>
        <EfficiencyMap sessions={sessions} />
      </section>

      {divider}

      <section id="advisor-hot-files">
        <h3 style={sectionHead}>Hot Files</h3>
        <HotFiles sessions={sessions} />
      </section>
    </SectionNav>
    </div>
  )
}
