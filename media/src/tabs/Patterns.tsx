import { useState, useRef } from 'preact/hooks'
import { filteredSessions, activeTab, focusedSessionId, sessionTextFilter } from '../state'
import { Instructions } from './Instructions'
import { getAgentSourceLabel, formatSessionTime } from '../utils'
import { calcSessionCost } from '../sessionMetrics'
import { fmtUsd } from './Cost'
import type { SessionSummaryCard } from '../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

const AGENT_DOT_COLOR: Record<string, string> = {
  claude_code: '#FFB085',
  copilot:     '#00EAFF',
  codex:       '#F0FF42',
}
function agentDotColor(source: string): string { return AGENT_DOT_COLOR[source] ?? '#888' }

function sessionCost(s: SessionSummaryCard): number {
  return calcSessionCost(s, s.source === 'copilot' ? 'token' : 'token').totalUsd
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
          <text x={PAD.left + cw / 2} y={H - 2} text-anchor="middle" font-size="10" fill="var(--muted)">Cost (USD)</text>
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
                  <th style={thStyle('time')}   onClick={() => toggleSort('time')}>Time{arrow('time')}</th>
                  <th style={thStyle('prompt')} onClick={() => toggleSort('prompt')}>Prompt{arrow('prompt')}</th>
                  <th style={`${thStyle('cost')};text-align:right`}  onClick={() => toggleSort('cost')}>Cost{arrow('cost')}</th>
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

// ── CLAUDE.md Tips ────────────────────────────────────────────────────────────

function ClaudeMdTips({ sessions }: { sessions: SessionSummaryCard[] }) {
  const [copied, setCopied] = useState<string | null>(null)
  const total = sessions.length || 1

  const fileMap = new Map<string, number>()
  for (const s of sessions) {
    const seen = new Set([...(s.filesRead ?? []), ...(s.filesChanged ?? [])])
    for (const f of seen) fileMap.set(f, (fileMap.get(f) ?? 0) + 1)
  }
  const hotFiles = [...fileMap.entries()]
    .filter(([, n]) => n / total >= 0.4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([file, n]) => ({ file, pct: Math.round(n / total * 100) }))

  const sigMap = new Map<string, number>()
  for (const s of sessions) {
    for (const sig of s.loopSignals ?? []) sigMap.set(sig.type, (sigMap.get(sig.type) ?? 0) + 1)
  }
  const freqSignals = [...sigMap.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])

  const refactorSess = sessions.filter(s => /refactor|clean up|improve/i.test(s.userRequest ?? ''))
  const scopedSess   = sessions.filter(s => /in\s+(src|file|function|the)\b/i.test(s.userRequest ?? ''))
  const refactorAvg  = refactorSess.length > 1 ? refactorSess.reduce((a, s) => a + sessionCost(s), 0) / refactorSess.length : 0
  const scopedAvg    = scopedSess.length > 1   ? scopedSess.reduce((a, s) => a + sessionCost(s), 0)   / scopedSess.length   : 0

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 2000) })
  }

  const suggestions: Array<{ key: string; text: string; copy: string }> = []

  for (const { file, pct } of hotFiles) {
    suggestions.push({
      key: file,
      text: `"${basename(file)}" appears in ${pct}% of traces — add a reference so the agent finds it without searching.`,
      copy: `# ${basename(file)} (${file})`,
    })
  }

  if (freqSignals.length > 0) {
    const [type, count] = freqSignals[0]
    const label = type === 'exact_tool_repeat' ? 'tool call loops'
      : type === 'runaway_steps' ? 'runaway turn counts'
      : type.replace(/_/g, ' ')
    suggestions.push({
      key: 'signals',
      text: `"${label}" appeared in ${count} traces — add scope guidance to prevent open-ended tasks.`,
      copy: `# Scope guidance\nKeep tasks narrowly scoped. Name specific files and functions. Define a stopping condition.`,
    })
  }

  if (refactorAvg > 0 && scopedAvg > 0 && refactorAvg > scopedAvg * 1.5) {
    suggestions.push({
      key: 'refactor',
      text: `Prompts with "refactor"/"clean up" average ${fmtUsd(refactorAvg)} vs ${fmtUsd(scopedAvg)} for scoped prompts — ${Math.round(refactorAvg / scopedAvg)}× more expensive.`,
      copy: `# Prefer scoped prompts\nAvoid "refactor" or "clean up" without explicit scope. Specify files, functions, and what done looks like.`,
    })
  }

  if (suggestions.length === 0) {
    return <div class="empty-state" style="padding:20px">No strong recommendations yet — patterns will emerge with more traces.</div>
  }

  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      {suggestions.map(s => (
        <div key={s.key} style="background:var(--card-bg);border:1px solid var(--border);border-radius:5px;padding:10px 12px;display:flex;align-items:flex-start;gap:10px">
          <div style="flex:1;font-size:12px;color:var(--muted);line-height:1.5">{s.text}</div>
          <button onClick={() => copy(s.copy, s.key)}
            style="flex-shrink:0;font-size:10px;padding:3px 9px;border-radius:3px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);white-space:nowrap">
            {copied === s.key ? '✓ Copied' : 'Copy line'}
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Cost Trend ────────────────────────────────────────────────────────────────

function CostTrend({ sessions }: { sessions: SessionSummaryCard[] }) {
  const dayMap = new Map<string, { cost: number; n: number }>()
  for (const s of sessions) {
    if (!s.startTime) continue
    const day = s.startTime.slice(0, 10)
    const e = dayMap.get(day) ?? { cost: 0, n: 0 }
    e.cost += sessionCost(s); e.n++
    dayMap.set(day, e)
  }
  const days = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  if (days.length < 2) return (
    <div class="empty-state" style="padding:20px">Not enough data — trend appears after 2+ days of traces.</div>
  )

  const W = 560, H = 140, PAD = { top: 12, right: 16, bottom: 28, left: 52 }
  const cw = W - PAD.left - PAD.right
  const ch = H - PAD.top - PAD.bottom

  const maxCost = Math.max(...days.map(([, v]) => v.cost), 0.01)
  const xPos = (i: number)    => PAD.left + (i / (days.length - 1)) * cw
  const yPos = (cost: number) => PAD.top  + ch - (cost / maxCost) * ch

  const points = days.map(([, v], i) => ({ x: xPos(i), y: yPos(v.cost), cost: v.cost }))
  const polyline = points.map(p => `${p.x},${p.y}`).join(' ')

  return (
    <svg width={W} height={H} style="overflow:visible;max-width:100%;display:block">
      {[0, 0.5, 1].map(f => {
        const y = PAD.top + ch - f * ch
        return <line key={f} x1={PAD.left} y1={y} x2={PAD.left + cw} y2={y} stroke="var(--border)" stroke-width="1" />
      })}
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + ch} stroke="var(--border)" />
      <line x1={PAD.left} y1={PAD.top + ch} x2={PAD.left + cw} y2={PAD.top + ch} stroke="var(--border)" />
      <text x={PAD.left - 4} y={PAD.top + 4} text-anchor="end" font-size="9" fill="var(--muted)">{fmtUsd(maxCost)}</text>
      <text x={PAD.left - 4} y={PAD.top + ch / 2 + 4} text-anchor="end" font-size="9" fill="var(--muted)">{fmtUsd(maxCost / 2)}</text>
      <text x={PAD.left - 4} y={PAD.top + ch + 4} text-anchor="end" font-size="9" fill="var(--muted)">$0</text>
      <text x={PAD.left} y={PAD.top + ch + 16} text-anchor="start" font-size="9" fill="var(--muted)">{days[0][0].slice(5)}</text>
      <text x={PAD.left + cw} y={PAD.top + ch + 16} text-anchor="end" font-size="9" fill="var(--muted)">{days[days.length - 1][0].slice(5)}</text>
      <polygon
        points={`${PAD.left},${PAD.top + ch} ${polyline} ${PAD.left + cw},${PAD.top + ch}`}
        fill="rgba(79,195,247,0.1)"
      />
      <polyline points={polyline} fill="none" stroke="var(--accent)" stroke-width="1.5" />
      {points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={3} fill="var(--accent)" />)}
    </svg>
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

export function Patterns() {
  const sessions = filteredSessions.value

  if (sessions.length === 0) {
    return <div class="empty-state">No traces recorded yet — patterns will appear once you have trace history.</div>
  }

  const divider = <div style="border-top:1px solid var(--border);margin:16px 0 8px" />

  return (
    <div id="patterns-content" style="padding-top:8px">
      <section>
        <h3 style={sectionHead}>Instructions File</h3>
        <Instructions />
      </section>

      {divider}

      <section>
        <h3 style={sectionHead}>Efficiency Map</h3>
        <EfficiencyMap sessions={sessions} />
      </section>

      {divider}

      <section>
        <h3 style={sectionHead}>Hot Files</h3>
        <HotFiles sessions={sessions} />
      </section>
    </div>
  )
}
