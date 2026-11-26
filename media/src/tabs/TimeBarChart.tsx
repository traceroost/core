import { useState } from 'preact/hooks'
import { niceMax } from './outcomeTrend'

// The stacked bars-over-time chart Analytics › Cost draws twice (estimated cost per day by
// agent; tokens per day, input and output). One y-axis with a title, a real time axis (one slot per
// day or week bin, empty bins included), "Nov 3" dates, a hover tooltip per bin. The chart
// standard both products share: one measure per axis, colours named in a legend drawn from the
// same values. Same geometry and look as OutcomeTrendChart (SessionCharts.tsx).

const W = 600
const PAD = { top: 18, right: 12, bottom: 16, left: 52 }
const PLOT_H = 110
const MUTED = 'var(--vscode-descriptionForeground,#888)'
const GRID = 'var(--vscode-panel-border,#333)'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function shortDate(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`
}
export function binLabel(bin: { start: string; end: string }, unit: 'day' | 'week'): string {
  return unit === 'day' || bin.start === bin.end ? shortDate(bin.start) : `${shortDate(bin.start)} to ${shortDate(bin.end)}`
}

export interface StackSeries { key: string; label: string; color: string }
export interface StackBin { start: string; end: string; values: Record<string, number>; note?: string }

export function TimeBarChart({ bins, unit, series, yTitle, format, ariaLabel, testId }: {
  bins: StackBin[]
  unit: 'day' | 'week'
  /** Bottom of the stack first. */
  series: StackSeries[]
  yTitle: string
  format: (v: number) => string
  ariaLabel: string
  testId?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (bins.length === 0) return null
  const chartW = W - PAD.left - PAD.right
  const slotW = chartW / bins.length
  const barW = Math.max(1, Math.min(20, slotW * 0.7))
  const H = PAD.top + PLOT_H + PAD.bottom
  const total = (b: StackBin) => series.reduce((t, s) => t + (b.values[s.key] ?? 0), 0)
  const scale = niceMax(Math.max(...bins.map(total), 0))
  const labelEvery = Math.max(1, Math.ceil(bins.length / Math.max(1, Math.floor(chartW / 70))))
  const ticks: number[] = []
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) ticks.push(v)
  const hovered = hover !== null ? bins[hover] : null

  return (
    <div style="position:relative" data-testid={testId}>
      <svg viewBox={`0 0 ${W} ${H}`} style={`width:100%;max-width:${Math.round(W * 1.4)}px;height:auto;display:block`}
        role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        <text x={PAD.left} y={PAD.top - 6} font-size="10" fill={MUTED}>{yTitle}</text>
        {ticks.map(v => {
          const y = PAD.top + PLOT_H - (v / scale.max) * PLOT_H
          return (
            <g key={v}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke={GRID} stroke-width="0.5" />
              <text x={PAD.left - 6} y={y} text-anchor="end" dominant-baseline="middle" font-size="10" fill={MUTED}>{format(v)}</text>
            </g>
          )
        })}
        {bins.map((b, i) => {
          const x = PAD.left + (i + 0.5) * slotW - barW / 2
          let y = PAD.top + PLOT_H
          return (
            <g key={b.start} onMouseEnter={() => setHover(i)}>
              {hover === i && <rect x={PAD.left + i * slotW} y={PAD.top} width={slotW} height={PLOT_H} fill="var(--fg,#ccc)" opacity="0.05" />}
              {series.filter(s => (b.values[s.key] ?? 0) > 0).map((s, si) => {
                const h = ((b.values[s.key] ?? 0) / scale.max) * PLOT_H
                y -= h
                return <rect key={s.key} x={x} y={y} width={barW} height={Math.max(1, h - (si > 0 ? 1 : 0))} fill={s.color} opacity={hover === i ? 1 : 0.88} />
              })}
              <rect x={PAD.left + i * slotW} y={PAD.top} width={slotW} height={PLOT_H} fill="transparent" />
              {(i % labelEvery === 0 || i === bins.length - 1) && (
                <text x={Math.min(PAD.left + (i + 0.5) * slotW, W - 20)} y={PAD.top + PLOT_H + 12} text-anchor="middle" font-size="10" fill={MUTED}>{shortDate(b.start)}</text>
              )}
            </g>
          )
        })}
      </svg>
      {hovered && (
        <div role="status" style={`position:absolute;top:${PAD.top}px;${hover !== null && hover / bins.length > 0.6 ? 'right' : 'left'}:8px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-panel-border,#333);border-radius:4px;padding:8px 10px;font-size:11px;line-height:1.7;pointer-events:none;z-index:10;white-space:nowrap`}>
          <div style="font-weight:600;margin-bottom:2px">{binLabel(hovered, unit)}</div>
          {[...series].reverse().filter(s => (hovered.values[s.key] ?? 0) > 0).map(s => (
            <div key={s.key}>
              <span style={`display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:6px`} />
              {s.label}: <strong>{format(hovered.values[s.key] ?? 0)}</strong>
            </div>
          ))}
          <div style="margin-top:4px;padding-top:4px;border-top:1px solid var(--vscode-panel-border,#333);color:var(--muted)">
            Total: <strong style="color:var(--fg)">{format(total(hovered))}</strong>{hovered.note ? ` · ${hovered.note}` : ''}
          </div>
        </div>
      )}
    </div>
  )
}

/** The legend above a TimeBarChart: one filled square per series, from the same colours. */
export function TimeBarLegend({ series, extra }: { series: StackSeries[]; extra?: string }) {
  return (
    <div style="display:flex;align-items:center;gap:4px 12px;flex-wrap:wrap;font-size:var(--fs-xs);color:var(--muted);margin-bottom:6px">
      {series.map(s => (
        <span key={s.key} style="display:inline-flex;align-items:center;gap:4px">
          <span aria-hidden="true" style={`display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color}`} />
          {s.label}
        </span>
      ))}
      {extra && <span>{extra}</span>}
    </div>
  )
}
