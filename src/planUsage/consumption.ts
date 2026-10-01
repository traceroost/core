/**
 * Pure functions over stored plan-limit readings: per-session consumption, window rollups, current
 * meters, chart series and the live pace projection. No I/O — planUsageService.ts feeds these.
 *
 * Readings are account-wide: two sessions running at once both move the same window. So every
 * rise between two consecutive readings of a window is shared across the sessions of that provider
 * active in that interval, weighted by their cost (tokens when cost is unknown) and how much of each
 * session fell inside the interval. Claude's readings are sparse snapshots, so its values are always
 * approximate; Codex's are per turn, so a session running alone gets an exact figure.
 */

import type { LimitHit, LimitProvider, LimitWindowKind } from './limitReadings'
import type { StoredReading, WindowRollup } from './limitRepository'

const HOUR = 3_600_000
export const WINDOW_MS: Record<LimitWindowKind, number> = {
  five_hour: 5 * HOUR,
  weekly: 7 * 24 * HOUR,
  weekly_opus: 7 * 24 * HOUR,
  weekly_sonnet: 7 * 24 * HOUR,
}

/** The two windows every per-session figure, chart and alert is built on. The per-model weekly
 *  windows stay as numbers in the meter only. */
export const PRIMARY_WINDOWS: LimitWindowKind[] = ['five_hour', 'weekly']

export interface SessionSpan {
  sessionId: string
  provider: LimitProvider
  startMs: number
  endMs: number
  /** Estimated cost in USD; 0 when unknown. */
  costUsd: number
  /** Fallback weight when cost is unknown. */
  tokens: number
}

export interface SessionLimitUsage {
  fiveHourPct?: number
  weeklyPct?: number
  /** True for Claude (sparse snapshots) and for any share of a rise split between sessions. */
  approximate: boolean
}

export interface AttributedInterval {
  provider: LimitProvider
  accountHash: string
  windowKind: LimitWindowKind
  startMs: number
  endMs: number
  deltaPct: number
  /** Each session's share of deltaPct, largest first. */
  shares: Array<{ sessionId: string; pct: number }>
  /** Sum of the overlapping sessions' cost inside the interval — for pts-per-dollar. */
  costUsd: number
}

function groupKey(r: StoredReading): string {
  return `${r.provider}|${r.accountHash}|${r.windowKind}`
}

function groupReadings(readings: StoredReading[]): Map<string, StoredReading[]> {
  const groups = new Map<string, StoredReading[]>()
  for (const r of readings) {
    const k = groupKey(r)
    const list = groups.get(k)
    if (list) list.push(r)
    else groups.set(k, [r])
  }
  for (const list of groups.values()) list.sort((a, b) => a.observedAt - b.observedAt)
  return groups
}

/** Whether the window reset between two consecutive readings: usage dropped, the reading before's
 *  reset time has passed, or the gap is longer than the window itself. Detected this way — not by
 *  `resets_at` changing — because resets_at can drift slightly between readings of one window. */
export function isReset(prev: StoredReading, next: StoredReading): boolean {
  return next.usedPct < prev.usedPct
    || (prev.resetsAt !== undefined && next.observedAt >= prev.resetsAt)
    || next.observedAt - prev.observedAt > WINDOW_MS[next.windowKind]
}

/** Each consecutive pair of readings as an interval, with its rise shared across sessions. */
export function attributeIntervals(readings: StoredReading[], sessions: SessionSpan[]): AttributedInterval[] {
  const out: AttributedInterval[] = []
  const byProvider = new Map<LimitProvider, SessionSpan[]>()
  for (const s of sessions) {
    const list = byProvider.get(s.provider)
    if (list) list.push(s)
    else byProvider.set(s.provider, [s])
  }

  for (const list of groupReadings(readings).values()) {
    const { provider, accountHash, windowKind } = list[0]
    if (!PRIMARY_WINDOWS.includes(windowKind)) continue
    const candidates = byProvider.get(provider) ?? []
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], next = list[i]
      const reset = isReset(prev, next)
      const deltaPct = reset ? next.usedPct : next.usedPct - prev.usedPct
      const windowStart = (next.resetsAt ?? next.observedAt) - WINDOW_MS[windowKind]
      const startMs = reset ? Math.max(prev.observedAt, windowStart) : prev.observedAt
      const endMs = next.observedAt
      if (endMs <= startMs) continue

      let weights: Array<{ sessionId: string; w: number; cost: number }> = []
      for (const s of candidates) {
        const sStart = s.startMs, sEnd = Math.max(s.endMs, s.startMs + 1)
        const overlap = Math.min(endMs, sEnd) - Math.max(startMs, sStart)
        if (overlap <= 0) continue
        const frac = overlap / (sEnd - sStart)
        weights.push({ sessionId: s.sessionId, w: (s.costUsd > 0 ? s.costUsd : s.tokens * 1e-6) * frac, cost: s.costUsd * frac })
      }
      if (weights.length === 0 && next.sessionId) weights = [{ sessionId: next.sessionId, w: 1, cost: 0 }]
      if (weights.length === 0) continue
      const total = weights.reduce((sum, x) => sum + x.w, 0)
      const shares = weights
        .map(x => ({ sessionId: x.sessionId, pct: total > 0 ? (deltaPct * x.w) / total : deltaPct / weights.length }))
        .sort((a, b) => b.pct - a.pct)
      out.push({ provider, accountHash, windowKind, startMs, endMs, deltaPct, shares, costUsd: weights.reduce((sum, x) => sum + x.cost, 0) })
    }
  }
  return out
}

/** Per-session share of each primary window. A session with no interval touching it gets no entry —
 *  "no data" is absence, never zero. */
export function sessionConsumption(intervals: AttributedInterval[]): Map<string, SessionLimitUsage> {
  const out = new Map<string, SessionLimitUsage>()
  for (const iv of intervals) {
    for (const share of iv.shares) {
      const u = out.get(share.sessionId) ?? { approximate: false }
      if (iv.windowKind === 'five_hour') u.fiveHourPct = (u.fiveHourPct ?? 0) + share.pct
      else if (iv.windowKind === 'weekly') u.weeklyPct = (u.weeklyPct ?? 0) + share.pct
      if (iv.provider === 'claude' || iv.shares.length > 1) u.approximate = true
      out.set(share.sessionId, u)
    }
  }
  return out
}

/** Window points per dollar of estimated cost, per provider and window, from intervals where usage
 *  rose and cost is known. Undefined until there are `minIntervals` such intervals — too few and
 *  the ratio is noise. */
export function pointsPerDollar(
  intervals: AttributedInterval[],
  provider: LimitProvider,
  windowKind: LimitWindowKind,
  minIntervals = 3,
): number | undefined {
  const usable = intervals.filter(iv => iv.provider === provider && iv.windowKind === windowKind && iv.deltaPct > 0 && iv.costUsd > 0)
  if (usable.length < minIntervals) return undefined
  const pts = usable.reduce((s, iv) => s + iv.deltaPct, 0)
  const cost = usable.reduce((s, iv) => s + iv.costUsd, 0)
  return cost > 0 ? pts / cost : undefined
}

/**
 * One rollup per window that has ended: the highest reading seen in it and whether a limit was hit.
 * Codex reports on every turn, so its windows are 'full'; a Claude window is 'full' only when a
 * reading landed in the last 10% of it — otherwise its peak is a lower bound.
 */
export function windowRollups(readings: StoredReading[], hits: LimitHit[], now: number): WindowRollup[] {
  const out: WindowRollup[] = []
  for (const list of groupReadings(readings).values()) {
    const { provider, accountHash, windowKind } = list[0]
    const windowMs = WINDOW_MS[windowKind]
    let last = list[0]
    let peak = list[0].usedPct
    const close = (endReading: StoredReading, fallbackEnd: number) => {
      const windowEnd = endReading.resetsAt ?? fallbackEnd
      const hit = hits.some(h => h.provider === provider && h.windowKind === windowKind && h.hitAt > windowEnd - windowMs && h.hitAt <= windowEnd)
      const coverage: WindowRollup['coverage'] = provider === 'codex' || windowEnd - last.observedAt <= windowMs * 0.1 ? 'full' : 'partial'
      out.push({ provider, accountHash, windowKind, windowEnd, peakPct: peak, hit, coverage })
    }
    for (let i = 1; i < list.length; i++) {
      const r = list[i]
      if (isReset(last, r)) {
        close(last, r.observedAt)
        peak = r.usedPct
      } else {
        peak = Math.max(peak, r.usedPct)
      }
      last = r
    }
    if (last.resetsAt !== undefined && last.resetsAt <= now) close(last, last.resetsAt)
  }
  return out
}

export interface MeterWindow {
  windowKind: LimitWindowKind
  usedPct: number
  resetsAt?: number
  observedAt: number
  /** The window reset after this reading was taken, so usage restarted from zero since. */
  resetSinceReading: boolean
}

export interface PlanMeter {
  provider: LimitProvider
  planType?: string
  /** Epoch ms of the newest reading behind this meter. */
  observedAt: number
  approximate: boolean
  windows: MeterWindow[]
}

const WINDOW_ORDER: LimitWindowKind[] = ['five_hour', 'weekly', 'weekly_opus', 'weekly_sonnet']

/** The latest reading per provider and window. A provider with no readings gets no meter. */
export function currentMeters(readings: StoredReading[], now: number): PlanMeter[] {
  const latest = new Map<string, StoredReading>()
  for (const r of readings) {
    const k = `${r.provider}|${r.windowKind}`
    const cur = latest.get(k)
    if (!cur || r.observedAt >= cur.observedAt) latest.set(k, r)
  }
  const meters: PlanMeter[] = []
  for (const provider of ['claude', 'codex'] as LimitProvider[]) {
    const windows: MeterWindow[] = []
    let observedAt = 0
    let planType: string | undefined
    for (const kind of WINDOW_ORDER) {
      const r = latest.get(`${provider}|${kind}`)
      if (!r) continue
      const resetSinceReading = r.resetsAt !== undefined && r.resetsAt <= now
      windows.push({ windowKind: kind, usedPct: resetSinceReading ? 0 : r.usedPct, resetsAt: resetSinceReading ? undefined : r.resetsAt, observedAt: r.observedAt, resetSinceReading })
      observedAt = Math.max(observedAt, r.observedAt)
      planType ??= r.planType
    }
    if (windows.length > 0) meters.push({ provider, planType, observedAt, approximate: provider === 'claude', windows })
  }
  return meters
}

export interface SeriesPoint {
  t: number
  pct: number
  /** Sessions that drove the rise ending at this point, largest share first (top 3). */
  sessions?: Array<{ sessionId: string; pct: number }>
}

export interface LimitSeries {
  provider: LimitProvider
  windowKind: LimitWindowKind
  approximate: boolean
  points: SeriesPoint[]
}

/** Step series per provider for one window, from `sinceMs`. Providers with no points get no series. */
export function limitSeries(
  readings: StoredReading[],
  intervals: AttributedInterval[],
  windowKind: LimitWindowKind,
  sinceMs: number,
): LimitSeries[] {
  const risesByEnd = new Map<string, AttributedInterval>()
  for (const iv of intervals) {
    if (iv.windowKind === windowKind && iv.deltaPct > 0) risesByEnd.set(`${iv.provider}|${iv.endMs}`, iv)
  }
  const out: LimitSeries[] = []
  for (const provider of ['claude', 'codex'] as LimitProvider[]) {
    const points: SeriesPoint[] = readings
      .filter(r => r.provider === provider && r.windowKind === windowKind && r.observedAt >= sinceMs)
      .sort((a, b) => a.observedAt - b.observedAt)
      .map(r => {
        const rise = risesByEnd.get(`${provider}|${r.observedAt}`)
        return rise ? { t: r.observedAt, pct: r.usedPct, sessions: rise.shares.slice(0, 3) } : { t: r.observedAt, pct: r.usedPct }
      })
    if (points.length > 0) out.push({ provider, windowKind, approximate: provider === 'claude', points })
  }
  return out
}

export interface PaceProjection {
  /** Minutes until the window reaches 100% at the current pace; set only when that lands before
   *  the reset. */
  minutesToLimit?: number
  /** Projected usage at the reset, capped at 100 — set when the limit would not be reached. */
  pctAtReset?: number
}

/** Projects the current pace (points per minute) forward to the window's reset. Undefined when the
 *  pace isn't positive or the reset time is unknown. */
export function projectPace(currentPct: number, ptsPerMinute: number | undefined, resetsAt: number | undefined, now: number): PaceProjection | undefined {
  if (ptsPerMinute === undefined || !(ptsPerMinute > 0) || resetsAt === undefined || resetsAt <= now) return undefined
  const minutesToReset = (resetsAt - now) / 60_000
  const minutesToLimit = (100 - currentPct) / ptsPerMinute
  if (minutesToLimit <= minutesToReset) return { minutesToLimit: Math.max(0, minutesToLimit) }
  return { pctAtReset: Math.min(100, currentPct + ptsPerMinute * minutesToReset) }
}

/** Codex pace: the slope of the account's 5-hour readings (or one session's, given its id) over the last `lookbackMs`. Needs at
 *  least two readings at distinct times with no reset between them. */
export function codexPace(readings: StoredReading[], sessionId: string | undefined, now: number, lookbackMs = 10 * 60_000): number | undefined {
  const recent = readings
    .filter(r => r.provider === 'codex' && r.windowKind === 'five_hour' && (sessionId === undefined || r.sessionId === sessionId) && r.observedAt >= now - lookbackMs)
    .sort((a, b) => a.observedAt - b.observedAt)
  if (recent.length < 2) return undefined
  for (let i = 1; i < recent.length; i++) if (isReset(recent[i - 1], recent[i])) return undefined
  const first = recent[0], last = recent[recent.length - 1]
  const minutes = (last.observedAt - first.observedAt) / 60_000
  if (minutes <= 0) return undefined
  return (last.usedPct - first.usedPct) / minutes
}
