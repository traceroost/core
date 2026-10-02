/**
 * Subscription plan limits (Claude Pro/Max, ChatGPT plans) in the dashboard — the snapshot the
 * host sends as a `planUsage` message (src/planUsage/planUsageService.ts's PlanUsageSnapshot,
 * mirrored here because the webview bundle can't import host code), plus the pure rules that
 * decide what renders.
 *
 * The one rule every helper here enforces: no data, no UI. A provider, window, series, column or
 * chart with nothing behind it is absent — never an empty placeholder and never a 0% that isn't a
 * real reading. Only Claude Code and Codex write plan-limit data locally, so nothing here ever
 * appears for Copilot, Cursor or OpenCode.
 */

import { signal } from '@preact/signals'
import type { SessionSummaryCard } from './types'

export type LimitProvider = 'claude' | 'codex'
export type LimitWindowKind = 'five_hour' | 'weekly' | 'weekly_opus' | 'weekly_sonnet'

export interface LimitHit {
  provider: LimitProvider
  sessionId: string
  windowKind: LimitWindowKind
  hitAt: number
  resetsAt?: number
}

export interface MeterWindow {
  windowKind: LimitWindowKind
  usedPct: number
  resetsAt?: number
  observedAt: number
  resetSinceReading: boolean
}

export interface PlanMeter {
  provider: LimitProvider
  planType?: string
  observedAt: number
  approximate: boolean
  windows: MeterWindow[]
}

export interface SeriesPoint {
  t: number
  pct: number
  sessions?: Array<{ sessionId: string; pct: number }>
}

export interface LimitSeries {
  provider: LimitProvider
  windowKind: LimitWindowKind
  approximate: boolean
  points: SeriesPoint[]
}

export interface WindowRollup {
  provider: LimitProvider
  accountHash: string
  windowKind: LimitWindowKind
  windowEnd: number
  peakPct: number
  hit: boolean
  coverage: 'full' | 'partial'
}

/** A provider's latest plan status — see src/planUsage/limitReadings.ts's PlanStatus. */
export interface PlanStatus {
  provider: LimitProvider
  planType?: string
  observedAt: number
  noWindows: boolean
  hasCredits?: boolean
  unlimitedCredits?: boolean
  creditBalance?: string
  limitReached: boolean
  sessionId?: string
}

export interface SessionPlanUsage {
  fiveHourPct?: number
  weeklyPct?: number
  approximate: boolean
  hits?: LimitHit[]
}

export interface PlanUsageSnapshot {
  generatedAt: number
  meters: PlanMeter[]
  sessions: Record<string, SessionPlanUsage>
  series: { weekly: LimitSeries[]; fiveHour: LimitSeries[] }
  hits: LimitHit[]
  weeklyRollups: WindowRollup[]
  historyStartsAt: Partial<Record<LimitProvider, number>>
  /** Optional: a host older than this webview bundle doesn't send it. */
  planStatus?: PlanStatus[]
  weeklyPtsPerDollar: Partial<Record<LimitProvider, number>>
}

/** Null until the host sends one — and hosts without a database never do. */
export const planUsage = signal<PlanUsageSnapshot | null>(null)

export const PROVIDER_LABEL: Record<LimitProvider, string> = { claude: 'Claude', codex: 'Codex' }
export const PROVIDER_SOURCE: Record<LimitProvider, SessionSummaryCard['source']> = { claude: 'claude_code', codex: 'codex' }
export const WINDOW_LABEL: Record<LimitWindowKind, string> = { five_hour: '5-hour', weekly: 'Weekly', weekly_opus: 'Weekly (Opus)', weekly_sonnet: 'Weekly (Sonnet)' }
const WINDOW_SHORT: Partial<Record<LimitWindowKind, string>> = { five_hour: '5h', weekly: 'wk' }

export function isPrimaryWindow(k: LimitWindowKind): boolean {
  return k === 'five_hour' || k === 'weekly'
}

export function fmtPct(p: number): string {
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

export function planLabel(planType: string | undefined): string {
  return planType ? planType.charAt(0).toUpperCase() + planType.slice(1) : ''
}

/** Statuses to show as their own card: the provider reported no 5-hour or weekly window and has
 *  no meter (a ChatGPT Business Codex account, metered in credits). A provider with a meter
 *  already shows its plan there. */
export function windowlessPlans(s: PlanUsageSnapshot): PlanStatus[] {
  return (s.planStatus ?? []).filter(st => st.noWindows && !s.meters.some(m => m.provider === st.provider))
}

/** Whether the PLAN LIMITS section renders at all. */
export function hasPlanData(s: PlanUsageSnapshot | null): s is PlanUsageSnapshot {
  return !!s && (s.meters.length > 0 || s.series.weekly.length > 0 || s.series.fiveHour.length > 0 || s.hits.length > 0
    || windowlessPlans(s).length > 0)
}

/** "5h 12% · wk 3%" for the Traces column, "≈"-prefixed when approximate; null when there's no
 *  value to show (the cell stays blank). */
export function limitUsedLabel(u: SessionPlanUsage | undefined): string | null {
  if (!u) return null
  const bits: string[] = []
  if (u.fiveHourPct !== undefined) bits.push(`${WINDOW_SHORT.five_hour} ${fmtPct(u.fiveHourPct)}`)
  if (u.weeklyPct !== undefined) bits.push(`${WINDOW_SHORT.weekly} ${fmtPct(u.weeklyPct)}`)
  if (bits.length === 0) return null
  return (u.approximate ? '≈ ' : '') + bits.join(' · ')
}

/** The Traces table shows its "Plan limit used" column only when some session in view has a value or
 *  a hit. */
export function showLimitColumn(sessions: Pick<SessionSummaryCard, 'sessionId'>[], s: PlanUsageSnapshot | null): boolean {
  if (!s) return false
  return sessions.some(x => {
    const u = s.sessions[x.sessionId]
    return !!u && (limitUsedLabel(u) !== null || (u.hits?.length ?? 0) > 0)
  })
}

export type Chart1View = 'weekly' | 'five_hour'

/** The 5-hour view draws a line only for Codex — Claude's readings are too sparse to draw a
 *  sawtooth; its hits and blocked time still show. */
export function fiveHourLines(s: PlanUsageSnapshot): LimitSeries[] {
  return s.series.fiveHour.filter(x => x.provider === 'codex' && x.points.length > 0)
}

export function fiveHourHits(s: PlanUsageSnapshot): LimitHit[] {
  return s.hits.filter(h => h.windowKind === 'five_hour')
}

/** Which of chart 1's views have something to draw. The toggle shows only when both do. */
export function chart1Views(s: PlanUsageSnapshot): Chart1View[] {
  const views: Chart1View[] = []
  if (s.series.weekly.some(x => x.points.length > 0) || s.hits.some(h => h.windowKind === 'weekly')) views.push('weekly')
  if (fiveHourLines(s).length > 0 || fiveHourHits(s).length > 0) views.push('five_hour')
  return views
}

/** 5-hour first for users who keep hitting it (≥ 2 five-hour hits in the last 14 days — the
 *  snapshot's hits already cover exactly that span), weekly otherwise. */
export function defaultChart1View(s: PlanUsageSnapshot): Chart1View | null {
  const views = chart1Views(s)
  if (views.length === 0) return null
  if (views.includes('five_hour') && fiveHourHits(s).length >= 2) return 'five_hour'
  return views.includes('weekly') ? 'weekly' : views[0]
}

/** Chart 2 needs at least two completed weekly windows for some provider — one bar isn't a trend. */
export function chart2Rollups(s: PlanUsageSnapshot): WindowRollup[] {
  const byProvider = new Map<LimitProvider, WindowRollup[]>()
  for (const r of s.weeklyRollups) {
    if (r.windowKind !== 'weekly') continue
    byProvider.set(r.provider, [...(byProvider.get(r.provider) ?? []), r])
  }
  return [...byProvider.values()].filter(list => list.length >= 2).flat()
}

/** Converts an estimated dollar amount of waste into points of a provider's weekly limit, or
 *  undefined when there isn't enough history to say. */
export function weeklyPointsFor(s: PlanUsageSnapshot | null, provider: LimitProvider, usd: number): number | undefined {
  const ppd = s?.weeklyPtsPerDollar[provider]
  return ppd !== undefined && usd > 0 ? usd * ppd : undefined
}

export function providerOfSource(source: SessionSummaryCard['source']): LimitProvider | undefined {
  return source === 'claude_code' ? 'claude' : source === 'codex' ? 'codex' : undefined
}

/** The snapshot narrowed to one agent when the dashboard's agent filter selects one: Claude Code
 *  shows only Claude, Codex only Codex, and any other agent nothing at all. */
export function forAgentFilter(s: PlanUsageSnapshot | null, filter: string): PlanUsageSnapshot | null {
  if (!s || filter === 'all') return s
  const provider = providerOfSource(filter as SessionSummaryCard['source'])
  if (!provider) return null
  const keep = <T extends { provider: LimitProvider }>(xs: T[]) => xs.filter(x => x.provider === provider)
  return {
    ...s,
    meters: keep(s.meters),
    series: { weekly: keep(s.series.weekly), fiveHour: keep(s.series.fiveHour) },
    hits: keep(s.hits),
    weeklyRollups: keep(s.weeklyRollups),
    ...(s.planStatus ? { planStatus: keep(s.planStatus) } : {}),
  }
}
