/**
 * Analytics › Cost & limits' two over-time charts and its headline: estimated cost per day stacked
 * by agent, and tokens (input + output) per day, on a real time axis (dense UTC day bins, whole
 * Monday weeks past 56 days: the same `dayBins` the Output charts use), each on ONE y-axis. The
 * headline compares the range with the same-length period just before it. Pure, so it's testable
 * without the webview; cloud's Analytics › Cost follows the same rules and wording.
 */

import type { SessionSummaryCard } from './types'
import { calcSessionCost } from './sessionMetrics'
import { dayBins } from './tabs/outcomeTrend'

export interface DayBin {
  /** First day in the bin, YYYY-MM-DD (UTC); `end` is the last, inclusive. */
  start: string
  end: string
  /** Estimated cost per agent (`source`), priced traces only. */
  costBySource: Record<string, number>
  cost: number
  /** Traces in the bin with a recognised model (the ones the cost covers). */
  pricedTraces: number
  tokensIn: number
  tokensOut: number
  traces: number
}

const dayOf = (s: SessionSummaryCard): string | null => {
  const ms = s.startTime ? Date.parse(s.startTime) : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * Dense day (or week) bins holding cost by agent and tokens. With a bounded time filter (`range`
 * has `since`) the bins cover the whole range, to `until` or today, so days before the first trace
 * and after the last show as empty days, as on cloud's Cost charts; with no lower bound (All) they
 * cover the traces' own span.
 */
export function buildDayBins(
  sessions: SessionSummaryCard[],
  range?: { since?: number; until?: number },
  now: number = Date.now(),
): { bins: DayBin[]; unit: 'day' | 'week' } {
  const dated = sessions.map(s => ({ s, day: dayOf(s) })).filter((x): x is { s: SessionSummaryCard; day: string } => x.day !== null)
  if (dated.length === 0) return { bins: [], unit: 'day' }
  const ends = range?.since !== undefined ? [isoDay(range.since), isoDay(range.until ?? now)] : []
  const layout = dayBins([...dated.map(x => x.day), ...ends])
  const bins: DayBin[] = layout.bins.map(b => ({ ...b, costBySource: {}, cost: 0, pricedTraces: 0, tokensIn: 0, tokensOut: 0, traces: 0 }))
  const index = new Map(bins.map(b => [b.start, b]))
  for (const { s, day } of dated) {
    const bin = index.get(layout.binOf(day))
    if (!bin) continue
    bin.traces++
    bin.tokensIn += s.inputTokens ?? 0
    bin.tokensOut += s.outputTokens ?? 0
    const c = calcSessionCost(s)
    if (c.modelUnknown) continue
    bin.pricedTraces++
    bin.cost += c.totalUsd
    bin.costBySource[s.source] = (bin.costBySource[s.source] ?? 0) + c.totalUsd
  }
  return { bins, unit: layout.unit }
}

export interface PeriodTotals { cost: number; pricedTraces: number }

export function periodTotals(sessions: SessionSummaryCard[]): PeriodTotals {
  let cost = 0, pricedTraces = 0
  for (const s of sessions) {
    const c = calcSessionCost(s)
    if (c.modelUnknown) continue
    cost += c.totalUsd
    pricedTraces++
  }
  return { cost, pricedTraces }
}

/** Under this relative change, "about the same" (the same 5% band Results uses). */
const FLAT = 0.05

/** "up 18%", "down 4%", "about the same"; null when there's nothing to compare against. */
export function describeChange(current: number, previous: number): string | null {
  if (!(previous > 0)) return null
  const d = (current - previous) / previous
  if (Math.abs(d) < FLAT) return 'about the same'
  return `${d > 0 ? 'up' : 'down'} ${Math.round(Math.abs(d) * 100)}%`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDay = (ms: number) => { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${d.getDate()}` }

/** How the headline names the range: "the last 7 days", or "Nov 1 to Nov 14" for a custom one. */
export function periodLabel(range: { preset: string; since?: number; until?: number }): string {
  const fixed: Record<string, string> = { '1h': 'the last hour', '6h': 'the last 6 hours', '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days' }
  if (fixed[range.preset]) return fixed[range.preset]
  if (range.since !== undefined) return `${shortDay(range.since)} to ${shortDay(range.until ?? Date.now())}`
  return 'all traces'
}

/** The same-length window before the range, named the way the headline reads ("the 7 days before"). */
export function previousLabel(range: { preset: string; since?: number; until?: number }): string {
  const fixed: Record<string, string> = { '1h': 'the hour before', '6h': 'the 6 hours before', '24h': 'the 24 hours before', '7d': 'the 7 days before', '30d': 'the 30 days before' }
  if (fixed[range.preset]) return fixed[range.preset]
  if (range.since === undefined) return ''
  const days = Math.max(1, Math.round(((range.until ?? Date.now()) - range.since) / 86_400_000))
  return `the ${days} day${days === 1 ? '' : 's'} before`
}

/**
 * The Cost headline, e.g. "$1,234.00 over the last 30 days; up 18% from the 30 days before
 * ($1,046.00). $2.10 per trace, down 4%." With no lower bound (All) there's no previous period;
 * with no previous data (`previous` null, or nothing priced in it) the comparison is left out rather
 * than printed as a misleading percentage.
 */
export function costHeadline(
  range: { preset: string; since?: number; until?: number },
  current: PeriodTotals,
  previous: PeriodTotals | null,
  fmt: (usd: number) => string,
): string {
  const perTrace = current.pricedTraces > 0 ? current.cost / current.pricedTraces : 0
  if (range.since === undefined) {
    return `${fmt(current.cost)} across all traces. ${fmt(perTrace)} per trace.`
  }
  const head = `${fmt(current.cost)} over ${periodLabel(range)}`
  const change = previous ? describeChange(current.cost, previous.cost) : null
  if (!previous || !change) return `${head}. ${fmt(perTrace)} per trace.`
  const prevPer = previous.pricedTraces > 0 ? previous.cost / previous.pricedTraces : 0
  const perChange = describeChange(perTrace, prevPer)
  return `${head}; ${change} from ${previousLabel(range)} (${fmt(previous.cost)}). ${fmt(perTrace)} per trace${perChange ? `, ${perChange}` : ''}.`
}
