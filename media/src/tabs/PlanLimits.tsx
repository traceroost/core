/**
 * Analytics' PLAN LIMITS section — subscription 5-hour / weekly windows for Claude Code and Codex.
 * See media/src/planUsage.ts for the data and the "no data, no UI" rules this renders by; every
 * piece below is absent (not empty) when there's nothing behind it.
 */

import { useState } from 'preact/hooks'
import { activeTab, evidenceSessionIds, evidenceSessionLabel, evidenceSessionPrompt } from '../state'
import { getAgentColor } from '../utils'
import { appliedSuggestions } from './Instructions'
import {
  planUsage, limitUsedLabel,
  PROVIDER_LABEL, PROVIDER_SOURCE, WINDOW_LABEL, chart1Views, chart2Rollups, defaultChart1View, fiveHourHits,
  fiveHourLines, fmtPct, isPrimaryWindow, planLabel,
  type Chart1View, type LimitHit, type LimitProvider, type LimitSeries, type PlanMeter, type PlanUsageSnapshot,
  type SeriesPoint, type WindowRollup,
} from '../planUsage'

const DAY = 86_400_000
const W = 600
const PAD = { top: 16, right: 64, bottom: 18, left: 36 }
const PLOT_H = 120
const MUTED = 'var(--vscode-descriptionForeground,#888)'
const GRID = 'var(--vscode-panel-border,#333)'
const CRITICAL = 'var(--vscode-charts-red,#f44747)'
const TOOLTIP_STYLE = 'position:absolute;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-panel-border,#333);border-radius:4px;padding:6px 9px;font-size:11px;line-height:1.6;pointer-events:none;z-index:10;white-space:nowrap'

function colorOf(p: LimitProvider): string {
  return getAgentColor(PROVIDER_SOURCE[p])
}

function fmtWhen(ms: number): string {
  const d = new Date(ms)
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function fmtAge(ms: number, now: number): string {
  const mins = Math.max(0, Math.round((now - ms) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.round(mins / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function fmtIn(ms: number, now: number): string {
  const mins = Math.max(0, Math.round((ms - now) / 60_000))
  if (mins < 60) return `in ${mins}m`
  const h = Math.floor(mins / 60)
  return h < 24 ? `in ${h}h ${mins % 60}m` : fmtWhen(ms)
}

/** Opens the Traces tab filtered to these sessions — same evidence view the Advisor uses. */
export function showLimitTraces(ids: string[], label: string): void {
  if (ids.length === 0) return
  evidenceSessionIds.value = new Set(ids)
  evidenceSessionLabel.value = label
  evidenceSessionPrompt.value = null
  activeTab.value = 'sessions'
}

// ── Meters ────────────────────────────────────────────────────────────────────

function MeterBar({ pct }: { pct: number }) {
  const color = pct >= 90 ? CRITICAL : pct >= 75 ? 'var(--vscode-charts-yellow,#f6a623)' : 'var(--vscode-charts-blue,#4fc3f7)'
  return (
    <span style="flex:1;min-width:80px;height:6px;border-radius:3px;background:rgba(128,128,128,.25);overflow:hidden;display:inline-block">
      <span style={`display:block;height:100%;width:${Math.min(100, Math.max(0, pct))}%;background:${color};border-radius:3px`} />
    </span>
  )
}

function MeterCard({ meter, now }: { meter: PlanMeter; now: number }) {
  const primary = meter.windows.filter(w => isPrimaryWindow(w.windowKind))
  const perModel = meter.windows.filter(w => !isPrimaryWindow(w.windowKind))
  const stale = primary.some(w => w.resetsAt !== undefined && now - meter.observedAt > (w.windowKind === 'five_hour' ? 5 * 3_600_000 : 7 * DAY))
  return (
    <div class="card" style="flex:1;min-width:240px;padding:10px 12px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12px">
        <span style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${colorOf(meter.provider)}`} />
        <strong>{PROVIDER_LABEL[meter.provider]}</strong>
        {meter.planType && <span style="color:var(--muted)">{planLabel(meter.planType)}</span>}
        <span style="flex:1" />
        <span style={`font-size:10px;color:var(--muted);${stale ? 'opacity:.6' : ''}`}
          title={meter.provider === 'claude' ? "Claude Code's own cached reading, refreshed whenever Claude Code fetches it" : 'From the latest Codex turn'}>
          as of {fmtAge(meter.observedAt, now)}
        </span>
      </div>
      {primary.map(w => (
        <div key={w.windowKind} style="display:flex;align-items:center;gap:8px;font-size:11px;margin-top:4px">
          <span style="width:48px;color:var(--muted)">{WINDOW_LABEL[w.windowKind]}</span>
          <MeterBar pct={w.usedPct} />
          <span style="min-width:34px;text-align:right;font-variant-numeric:tabular-nums"><strong>{w.resetSinceReading ? '—' : fmtPct(w.usedPct)}</strong></span>
          <span style="min-width:96px;color:var(--muted);font-size:10px">
            {w.resetSinceReading ? 'reset since reading' : w.resetsAt ? `resets ${fmtIn(w.resetsAt, now)}` : ''}
          </span>
        </div>
      ))}
      {perModel.length > 0 && (
        <div style="font-size:10px;color:var(--muted);margin-top:6px">
          {perModel.map(w => `${WINDOW_LABEL[w.windowKind]} ${w.resetSinceReading ? 'reset' : fmtPct(w.usedPct)}`).join(' · ')}
        </div>
      )}
    </div>
  )
}

// ── Chart 1: "Where did my week go?" (weekly | 5-hour) ────────────────────────

function valueAt(points: SeriesPoint[], t: number): SeriesPoint | undefined {
  let found: SeriesPoint | undefined
  for (const p of points) { if (p.t <= t) found = p; else break }
  return found
}

function LimitLineChart({ view, snapshot, now }: { view: Chart1View; snapshot: PlanUsageSnapshot; now: number }) {
  const [hoverT, setHoverT] = useState<number | null>(null)
  const since = now - (view === 'weekly' ? 14 : 7) * DAY
  const series: LimitSeries[] = view === 'weekly' ? snapshot.series.weekly.filter(s => s.points.length > 0) : fiveHourLines(snapshot)
  const hits: LimitHit[] = view === 'weekly' ? snapshot.hits.filter(h => h.windowKind === 'weekly') : fiveHourHits(snapshot)
  const chartW = W - PAD.left - PAD.right
  const H = PAD.top + PLOT_H + PAD.bottom
  const x = (t: number) => PAD.left + ((Math.max(since, Math.min(now, t)) - since) / (now - since)) * chartW
  const y = (pct: number) => PAD.top + PLOT_H - (Math.min(100, Math.max(0, pct)) / 100) * PLOT_H

  const stepPath = (pts: SeriesPoint[]) => {
    const visible = pts.filter(p => p.t >= since)
    if (visible.length === 0) return ''
    let d = `M${x(visible[0].t)},${y(visible[0].pct)}`
    for (let i = 1; i < visible.length; i++) d += ` H${x(visible[i].t)} V${y(visible[i].pct)}`
    return d + ` H${x(Math.min(now, visible[visible.length - 1].t + (view === 'weekly' ? 6 : 1) * 3_600_000))}`
  }

  const resets: Array<{ t: number; provider: LimitProvider }> = []
  for (const s of series) {
    for (let i = 1; i < s.points.length; i++) {
      if (s.points[i].pct < s.points[i - 1].pct && s.points[i].t >= since) resets.push({ t: s.points[i].t, provider: s.provider })
    }
  }

  const dayTicks: number[] = []
  const firstMidnight = new Date(since); firstMidnight.setHours(24, 0, 0, 0)
  const tickEvery = view === 'weekly' ? 2 : 1
  for (let t = firstMidnight.getTime(), i = 0; t < now; t += DAY, i++) if (i % tickEvery === 0) dayTicks.push(t)

  const hover = hoverT !== null ? hoverT : null
  const hoverRows = hover !== null
    ? series.map(s => ({ s, p: valueAt(s.points, hover) })).filter(r => r.p)
    : []
  const nearestRise = hover !== null
    ? series.flatMap(s => s.points.filter(p => p.sessions?.length).map(p => ({ s, p })))
      .filter(r => Math.abs(r.p.t - hover) < (now - since) / 60)
      .sort((a, b) => Math.abs(a.p.t - hover) - Math.abs(b.p.t - hover))[0]
    : undefined
  const nearHits = hover !== null ? hits.filter(h => Math.abs(h.hitAt - hover) < (now - since) / 60) : []

  const onMove = (e: MouseEvent) => {
    const svg = e.currentTarget as SVGSVGElement
    const rect = svg.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    if (px < PAD.left || px > W - PAD.right) { setHoverT(null); return }
    setHoverT(since + ((px - PAD.left) / chartW) * (now - since))
  }

  const risesTip = nearestRise?.p.sessions ?? []
  const tipLeft = hover !== null && (hover - since) / (now - since) > 0.6

  return (
    <div style="position:relative">
      <svg viewBox={`0 0 ${W} ${H}`} style={`width:100%;height:auto;display:block;${risesTip.length ? 'cursor:pointer' : ''}`}
        role="img" aria-label={`${view === 'weekly' ? 'Weekly' : '5-hour'} plan window usage over the last ${view === 'weekly' ? 14 : 7} days`}
        onMouseMove={onMove} onMouseLeave={() => setHoverT(null)}
        onClick={() => { if (risesTip.length) showLimitTraces(risesTip.map(r => r.sessionId), 'that used this plan window') }}
      >
        {[0, 25, 50, 75, 100].map(v => (
          <g key={v}>
            <line x1={PAD.left} y1={y(v)} x2={W - PAD.right} y2={y(v)} stroke={GRID} stroke-width="0.5" />
            <text x={PAD.left - 6} y={y(v)} text-anchor="end" dominant-baseline="middle" font-size="9" fill={MUTED}>{v}%</text>
          </g>
        ))}
        {dayTicks.map(t => (
          <text key={t} x={x(t)} y={PAD.top + PLOT_H + 12} text-anchor="middle" font-size="9" fill={MUTED}>{fmtDay(t)}</text>
        ))}

        {/* Blocked time: hit → reset (5-hour view only; a weekly block would cover most of the chart). */}
        {view === 'five_hour' && hits.map(h => (
          <rect key={`b${h.provider}${h.hitAt}`} x={x(h.hitAt)} y={PAD.top} width={Math.max(2, x(h.resetsAt ?? h.hitAt) - x(h.hitAt))}
            height={PLOT_H} fill={CRITICAL} opacity="0.12" />
        ))}

        {resets.map(r => (
          <line key={`r${r.provider}${r.t}`} x1={x(r.t)} y1={PAD.top} x2={x(r.t)} y2={PAD.top + PLOT_H}
            stroke={MUTED} stroke-width="1" stroke-dasharray="2 3" opacity="0.6" />
        ))}

        {series.map(s => (
          <g key={s.provider}>
            <path d={stepPath(s.points)} fill="none" stroke={colorOf(s.provider)} stroke-width="2"
              stroke-dasharray={s.approximate ? '5 3' : undefined} stroke-linejoin="round" />
            {s.approximate && s.points.filter(p => p.t >= since).map(p => (
              <circle key={p.t} cx={x(p.t)} cy={y(p.pct)} r="4" fill={colorOf(s.provider)} stroke="var(--bg,#1e1e1e)" stroke-width="2" />
            ))}
          </g>
        ))}

        {/* Direct labels at each line's end, nudged apart so two agents at similar values don't collide. */}
        {(() => {
          const labels = series
            .map(s => ({ s, last: s.points[s.points.length - 1] }))
            .filter(l => l.last && l.last.t >= since)
            .map(l => ({ provider: l.s.provider, text: `${PROVIDER_LABEL[l.s.provider]} ${fmtPct(l.last.pct)}`, x: x(l.last.t), y: y(l.last.pct) }))
            .sort((a, b) => a.y - b.y)
          for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 12) labels[i].y = labels[i - 1].y + 12
          return labels.map(l => {
            const right = l.x > W - PAD.right - 60
            return (
              <text key={l.provider} x={right ? W - PAD.right + 4 : l.x + 6} y={l.y} dominant-baseline="middle" font-size="9" fill="var(--fg,#ccc)">{l.text}</text>
            )
          })
        })()}

        {hits.map(h => (
          <g key={`h${h.provider}${h.hitAt}`}>
            <line x1={x(h.hitAt)} y1={PAD.top} x2={x(h.hitAt)} y2={PAD.top + PLOT_H} stroke={CRITICAL} stroke-width="1.5" />
            <path d={`M${x(h.hitAt) - 5},${PAD.top - 9} L${x(h.hitAt) + 5},${PAD.top - 9} L${x(h.hitAt)},${PAD.top - 2} Z`} fill={CRITICAL} />
          </g>
        ))}

        {hover !== null && (
          <line x1={x(hover)} y1={PAD.top} x2={x(hover)} y2={PAD.top + PLOT_H} stroke="var(--fg,#ccc)" stroke-width="1" opacity="0.4" />
        )}
      </svg>

      {hover !== null && (hoverRows.length > 0 || nearHits.length > 0) && (
        <div style={`${TOOLTIP_STYLE};top:${PAD.top}px;${tipLeft ? 'left' : 'right'}:${tipLeft ? 44 : 64}px`}>
          <div style="color:var(--muted)">{fmtWhen(hover)}</div>
          {hoverRows.map(({ s, p }) => (
            <div key={s.provider}>
              <span style={`display:inline-block;width:10px;height:2px;background:${colorOf(s.provider)};vertical-align:middle;margin-right:6px`} />
              <strong>{s.approximate ? '≈ ' : ''}{fmtPct(p!.pct)}</strong> <span style="color:var(--muted)">{PROVIDER_LABEL[s.provider]}</span>
            </div>
          ))}
          {nearHits.map(h => (
            <div key={h.hitAt} style={`color:${CRITICAL}`}>
              Limit hit ({PROVIDER_LABEL[h.provider]}){h.resetsAt ? ` · blocked ${Math.round((h.resetsAt - h.hitAt) / 60_000)} min` : ''}
            </div>
          ))}
          {risesTip.length > 0 && (
            <div style="margin-top:3px;color:var(--muted)">
              Rise of {nearestRise!.s.approximate ? '≈ ' : ''}{fmtPct(risesTip.reduce((a, r) => a + r.pct, 0))} from {risesTip.length} trace{risesTip.length === 1 ? '' : 's'} — click to open
            </div>
          )}
        </div>
      )}

      {series.length >= 2 && (
        <div style="display:flex;gap:12px;font-size:11px;color:var(--muted);margin-top:4px">
          {series.map(s => (
            <span key={s.provider} style="display:inline-flex;align-items:center;gap:5px">
              <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke={colorOf(s.provider)} stroke-width="2" stroke-dasharray={s.approximate ? '5 3' : undefined} /></svg>
              {PROVIDER_LABEL[s.provider]}{s.approximate ? ' (approximate)' : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Chart 2: "Did my fixes work?" ─────────────────────────────────────────────

/** Local midnight on the Monday starting the week that `ms` falls in. */
function weekOf(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

function WeeklyPeaksChart({ rollups }: { rollups: WindowRollup[] }) {
  const [hover, setHover] = useState<string | null>(null)
  const providers = [...new Set(rollups.map(r => r.provider))].sort()
  // One slot per calendar week: Claude's and Codex's windows reset at different moments, so
  // grouping by exact end time would split a week into two half-empty slots.
  const ends = [...new Set(rollups.map(r => weekOf(r.windowEnd)))].sort((a, b) => a - b)
  const inSlot = (r: WindowRollup, end: number) => weekOf(r.windowEnd) === end
  const applied = appliedSuggestions.value
  const chartW = W - PAD.left - PAD.right
  const H = PAD.top + PLOT_H + PAD.bottom
  const slotW = chartW / ends.length
  const barW = Math.max(4, Math.min(22, (slotW * 0.7) / providers.length))
  const y = (pct: number) => PAD.top + PLOT_H - (Math.min(100, Math.max(0, pct)) / 100) * PLOT_H
  const hovered = hover ? rollups.find(r => `${r.provider}${r.windowEnd}` === hover) : undefined
  const appliedIn = (slot: number) => applied.filter(a => weekOf(a.appliedAtMs) === slot)

  return (
    <div style="position:relative">
      <svg viewBox={`0 0 ${W} ${H}`} style="width:100%;height:auto;display:block" role="img"
        aria-label="Peak weekly plan usage per week" onMouseLeave={() => setHover(null)}>
        <defs>
          <pattern id="plan-partial" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" fill="transparent" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--fg,#ccc)" stroke-width="1.5" opacity="0.35" />
          </pattern>
        </defs>
        {[0, 25, 50, 75, 100].map(v => (
          <g key={v}>
            <line x1={PAD.left} y1={y(v)} x2={W - PAD.right} y2={y(v)} stroke={GRID} stroke-width="0.5" />
            <text x={PAD.left - 6} y={y(v)} text-anchor="end" dominant-baseline="middle" font-size="9" fill={MUTED}>{v}%</text>
          </g>
        ))}
        {ends.map((end, i) => {
          const cx = PAD.left + (i + 0.5) * slotW
          const fixes = appliedIn(end)
          return (
            <g key={end}>
              {fixes.length > 0 && (
                <g>
                  <line x1={cx - slotW / 2} y1={PAD.top} x2={cx - slotW / 2} y2={PAD.top + PLOT_H} stroke="var(--accent,#4fc3f7)" stroke-width="1" stroke-dasharray="3 2" />
                  <path d={`M${cx - slotW / 2},${PAD.top - 10} l4,4 l-4,4 l-4,-4 Z`} fill="var(--accent,#4fc3f7)">
                    <title>{fixes.map(f => `Applied: ${f.title}`).join('\n')}</title>
                  </path>
                </g>
              )}
              {providers.map((p, pi) => {
                const r = rollups.find(x => x.provider === p && inSlot(x, end))
                if (!r) return null
                const bx = cx - (providers.length * barW) / 2 + pi * barW + 1
                const top = y(r.peakPct)
                const key = `${r.provider}${r.windowEnd}`
                return (
                  <g key={p} onMouseEnter={() => setHover(key)}>
                    <rect x={bx} y={top} width={barW - 2} height={Math.max(1, PAD.top + PLOT_H - top)} rx="2"
                      fill={colorOf(p)} opacity={hover === key ? 1 : 0.85} />
                    {r.coverage === 'partial' && <rect x={bx} y={top} width={barW - 2} height={Math.max(1, PAD.top + PLOT_H - top)} fill="url(#plan-partial)" />}
                    {r.hit && <circle cx={bx + (barW - 2) / 2} cy={top - 6} r="3" fill={CRITICAL} />}
                    <rect x={bx - 2} y={PAD.top} width={barW + 2} height={PLOT_H} fill="transparent" />
                  </g>
                )
              })}
              {(ends.length <= 8 || i % 2 === 0 || i === ends.length - 1) && (
                <text x={cx} y={PAD.top + PLOT_H + 12} text-anchor="middle" font-size="9" fill={MUTED}>Wk of {fmtDay(end)}</text>
              )}
            </g>
          )
        })}
      </svg>
      {hovered && (
        <div style={`${TOOLTIP_STYLE};top:${PAD.top}px;right:64px`}>
          <div style="color:var(--muted)">Window ending {fmtWhen(hovered.windowEnd)}</div>
          <div>
            <span style={`display:inline-block;width:10px;height:2px;background:${colorOf(hovered.provider)};vertical-align:middle;margin-right:6px`} />
            <strong>{hovered.coverage === 'partial' ? '≥ ' : ''}{fmtPct(hovered.peakPct)}</strong> <span style="color:var(--muted)">{PROVIDER_LABEL[hovered.provider]} peak</span>
          </div>
          {hovered.hit && <div style={`color:${CRITICAL}`}>Limit hit this week</div>}
          {hovered.coverage === 'partial' && <div style="color:var(--muted)">Readings didn't cover the whole week — a lower bound</div>}
          {appliedIn(weekOf(hovered.windowEnd)).map(a => <div key={a.id} style="color:var(--muted)">Applied: {a.title}</div>)}
        </div>
      )}
      <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--muted);margin-top:4px">
        {providers.length >= 2 && providers.map(p => (
          <span key={p} style="display:inline-flex;align-items:center;gap:5px">
            <span style={`display:inline-block;width:8px;height:8px;border-radius:2px;background:${colorOf(p)}`} />{PROVIDER_LABEL[p]}
          </span>
        ))}
        {rollups.some(r => r.coverage === 'partial') && <span>Hatched: lower bound (partial readings)</span>}
        {rollups.some(r => r.hit) && <span><span style={`color:${CRITICAL}`}>●</span> limit hit</span>}
        {applied.some(a => ends.includes(weekOf(a.appliedAtMs))) && <span><span style="color:var(--accent,#4fc3f7)">◆</span> instruction change applied</span>}
      </div>
    </div>
  )
}

// ── Section ───────────────────────────────────────────────────────────────────

/** Where each agent's history comes from, for agents whose history starts inside the chart's range
 *  — so a line that begins mid-chart reads as "not collected yet", not "no usage". */
function HistoryNote({ notes }: { notes: Array<[LimitProvider, number]> }) {
  const how: Record<LimitProvider, string> = {
    claude: 'Claude Code keeps only its latest reading, so TraceRoost records a new one each time it changes while TraceRoost is running. The longer it runs, the more history you get.',
    codex: 'Read back from the Codex session logs on this machine, as far as they go.',
  }
  return (
    <div style="margin:0 0 8px;padding:6px 10px;font-size:11px;color:var(--muted);background:var(--card-bg);border:1px solid var(--border);border-radius:4px;line-height:1.5">
      {notes.map(([p, t]) => (
        <div key={p} style="display:flex;gap:6px;align-items:baseline">
          <span style={`display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${colorOf(p)}`} />
          <span><strong style="color:var(--fg)">{PROVIDER_LABEL[p]} history starts {fmtDay(t)}.</strong> {how[p]}</span>
        </div>
      ))}
    </div>
  )
}

const VIEW_KEY = 'traceroost.planLimitsView'

function readViewPref(): Chart1View | null {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'weekly' || v === 'five_hour' ? v : null
  } catch { return null }
}

export function PlanLimitsSection({ snapshot }: { snapshot: PlanUsageSnapshot }) {
  const now = Date.now()
  const views = chart1Views(snapshot)
  const [pref, setPref] = useState<Chart1View | null>(readViewPref)
  const view = pref && views.includes(pref) ? pref : defaultChart1View(snapshot)
  const rollups = chart2Rollups(snapshot)
  const choose = (v: Chart1View) => {
    setPref(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* per-viewer convenience only */ }
  }
  const since = now - (view === 'five_hour' ? 7 : 14) * DAY
  const historyNotes = (Object.entries(snapshot.historyStartsAt) as Array<[LimitProvider, number]>)
    .filter(([p, t]) => t > since && (view === 'weekly' ? snapshot.series.weekly : fiveHourLines(snapshot)).some(s => s.provider === p))

  return (
    <>
      {snapshot.meters.length > 0 && (
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px">
          {snapshot.meters.map(m => <MeterCard key={m.provider} meter={m} now={now} />)}
        </div>
      )}

      {view && (
        <>
          <div style="display:flex;align-items:center;gap:8px;margin:6px 0 4px">
            <span style="font-size:12px"><strong>Where did my {view === 'weekly' ? 'week' : '5-hour windows'} go?</strong></span>
            <span style="flex:1" />
            {views.length > 1 && (
              <div role="tablist" aria-label="Plan window" style="display:inline-flex;border:1px solid var(--border);border-radius:4px;overflow:hidden">
                {views.map(v => (
                  <button key={v} role="tab" aria-selected={v === view} onClick={() => choose(v)}
                    style={`font-size:10px;padding:2px 8px;border:none;cursor:pointer;background:${v === view ? 'var(--hover)' : 'transparent'};color:${v === view ? 'var(--fg)' : 'var(--muted)'}`}>
                    {v === 'weekly' ? 'Weekly' : '5-hour'}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p style="font-size:11px;color:var(--muted);margin:0 0 6px">
            {view === 'weekly'
              ? 'How full the weekly window was over the last two weeks.'
              : 'The 5-hour window over the last week — how fast each one filled and when it blocked you (shaded).'}
            {view === 'five_hour' && snapshot.meters.some(m => m.provider === 'claude') && fiveHourLines(snapshot).every(s => s.provider !== 'claude')
              ? " Claude's 5-hour readings are too sparse to draw; its limit hits still show." : ''}
          </p>
          {historyNotes.length > 0 && <HistoryNote notes={historyNotes} />}
          <LimitLineChart view={view} snapshot={snapshot} now={now} />
        </>
      )}

      {rollups.length > 0 && (
        <>
          <div style="font-size:12px;margin:14px 0 4px"><strong>Did my fixes work?</strong></div>
          <p style="font-size:11px;color:var(--muted);margin:0 0 6px">
            Peak weekly usage per week. Markers show when an instruction-file suggestion was applied — a lower peak after one is the saving.
          </p>
          <WeeklyPeaksChart rollups={rollups} />
        </>
      )}
    </>
  )
}

// ── Traces table + trace detail ───────────────────────────────────────────────

/** The Traces table's "Limit used" cell — blank (not 0%, not —) when the session has no value. */
export function LimitUsedCell({ sessionId }: { sessionId: string }) {
  const u = planUsage.value?.sessions[sessionId]
  const label = limitUsedLabel(u)
  const hits = u?.hits ?? []
  if (!label && hits.length === 0) return null
  const tip = [
    label ? `Share of your plan window this trace used${u?.approximate ? ' (approximate: estimated from occasional readings, or shared with traces running at the same time)' : ''}` : '',
    ...hits.map(h => `${WINDOW_LABEL[h.windowKind]} limit hit ${fmtWhen(h.hitAt)}`),
  ].filter(Boolean).join('\n')
  return (
    <span title={tip} style="white-space:nowrap">
      {hits.length > 0 && <span style={`color:${CRITICAL};margin-right:4px`} aria-label="Limit hit">⛔</span>}
      {label}
    </span>
  )
}

/** Banner at the top of a trace's detail when it was blocked by a plan limit. */
export function LimitHitBanner({ sessionId }: { sessionId: string }) {
  const u = planUsage.value?.sessions[sessionId]
  const hits = u?.hits ?? []
  if (hits.length === 0) return null
  const h = hits[hits.length - 1]
  const blockedMin = h.resetsAt !== undefined ? Math.max(0, Math.round((h.resetsAt - h.hitAt) / 60_000)) : undefined
  const window = h.windowKind === 'five_hour' ? 'fiveHourPct' : h.windowKind === 'weekly' ? 'weeklyPct' : undefined
  const used = window ? u?.[window] : undefined
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    <div role="status" style={`margin:8px;padding:8px 10px;border:1px solid ${CRITICAL};border-radius:4px;font-size:11px;line-height:1.6`}>
      <div style={`font-weight:600;color:${CRITICAL}`}>
        ⛔ {blockedMin !== undefined ? `Blocked ${blockedMin} min by` : 'Hit'} the {PROVIDER_LABEL[h.provider]} {WINDOW_LABEL[h.windowKind].toLowerCase()} limit
      </div>
      <div style="color:var(--muted)">
        Hit at {clock(h.hitAt)}{h.resetsAt ? ` · reset at ${clock(h.resetsAt)}` : ''}
        {used !== undefined ? ` · this trace used ${u?.approximate ? '≈ ' : ''}${fmtPct(used)} of the window before the block` : ''}
        {hits.length > 1 ? ` · ${hits.length} limit hits in this trace` : ''}
      </div>
      <button onClick={() => { activeTab.value = 'patterns' }}
        style="margin-top:4px;padding:2px 8px;font-size:10px;border-radius:3px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--fg)">
        See how to use less of your limit →
      </button>
    </div>
  )
}
