import type { SessionSummaryCard } from '../types'
import { dayKeyUtc } from '../sessionMetrics'
import { dayBins } from './outcomeTrend'

/**
 * "Code changes" over time (Analytics) — agent-authored change size per day (or week), summed
 * from each trace's filesChangedCount / linesAdded / linesRemoved (src/editStats.ts). These are
 * the lines the agent's own edit/write tool calls added and removed, NOT git commit stats.
 *
 * A trace is counted only when it recorded line counts. Traces stored before change-size tracking
 * (no filesChangedCount) and traces whose agent records no edit contents (lines undefined, shown
 * "?" in the Traces table) are left out of every sum — never counted as 0 — and reported as
 * `excluded` so the chart can say so. Same bins as Outcome & token spend (dayBins).
 */
export type CodeChangeBin = {
  /** First day in the bin, YYYY-MM-DD (UTC). */
  start: string
  /** Last day in the bin, inclusive. */
  end: string
  added: number
  removed: number
  /** Distinct files changed per trace, summed across the bin's traces. */
  files: number
  /** Traces counted in this bin (those with line data). */
  traces: number
}

export type CodeChangeTrend = {
  bins: CodeChangeBin[]
  unit: 'day' | 'week'
  total: { added: number; removed: number; files: number; traces: number }
  /** Traces in view with no recorded line counts — not counted anywhere above. */
  excluded: number
}

export function hasLineData(s: SessionSummaryCard): boolean {
  return s.linesAdded !== undefined && s.linesRemoved !== undefined
}

/** `sessions` is the already-filtered set the neighbouring charts use (filteredSessions). */
export function buildCodeChangeBins(sessions: SessionSummaryCard[]): CodeChangeTrend {
  const total = { added: 0, removed: 0, files: 0, traces: 0 }
  let excluded = 0
  const counted: Array<{ s: SessionSummaryCard; day: string }> = []
  for (const s of sessions) {
    if (!hasLineData(s)) { excluded += 1; continue }
    const day = dayKeyUtc(s.startTime)
    // An undatable trace can't be placed on the axis — same rule as buildTrendBins.
    if (day !== 'unknown') counted.push({ s, day })
  }
  if (counted.length === 0) return { bins: [], unit: 'day', total, excluded }

  const layout = dayBins(counted.map(c => c.day))
  const bins: CodeChangeBin[] = layout.bins.map(b => ({ ...b, added: 0, removed: 0, files: 0, traces: 0 }))
  const index = new Map(bins.map(b => [b.start, b]))
  for (const { s, day } of counted) {
    const bin = index.get(layout.binOf(day))
    if (!bin) continue
    const added = s.linesAdded ?? 0
    const removed = s.linesRemoved ?? 0
    const files = s.filesChangedCount ?? 0
    bin.added += added; bin.removed += removed; bin.files += files; bin.traces += 1
    total.added += added; total.removed += removed; total.files += files; total.traces += 1
  }
  return { bins, unit: layout.unit, total, excluded }
}
