import type { SessionSummaryCard, GitOutcome, FileOutcome } from '../types'
import { dayKeyUtc } from '../sessionMetrics'

/**
 * Day/week binning for "Outcome & token spend over time" — the cloud-first design
 * (analytics/outcome-trend.ts in the cloud repo) ported to core's local git-outcome model.
 * Narrowed to the three buckets local classification actually produces (see OUTCOME_META,
 * Sessions.tsx) — there's no reverted/in-progress/unknown concept locally, only what `git`
 * itself can tell about the working tree right now.
 *
 * Stack order, baseline up: landed work (merged, then committed) sits on the baseline;
 * uncommitted work sits on top, so the "not yet landed" slice is the one the eye lands on first.
 */
export const TREND_OUTCOMES: FileOutcome[] = ['merged', 'committed', 'abandoned']

/** Literal, not OUTCOME_META's colors (Sessions.tsx) — deliberately matches cloud's
 *  TREND_COLOR (analytics/outcome-trend.ts in the cloud repo) exactly, so this one chart looks
 *  identical in both apps regardless of either app's own theme palette. OUTCOME_META's colors
 *  stay untouched for every other consumer (badges, filter pills). */
export const TREND_COLOR: Record<FileOutcome, string> = {
  merged: '#3fb950',
  committed: '#58a6ff',
  abandoned: '#f6a623',
  ambiguous: 'var(--muted)',
}

export type Measure = { sessions: number; tokens: number }
export type TrendBin = {
  /** First day in the bin, YYYY-MM-DD (UTC). */
  start: string
  /** Last day in the bin, inclusive. Equal to `start` for daily bins. */
  end: string
  byOutcome: Record<FileOutcome, Measure>
  total: Measure
}

/** Past this many days a daily bar is too thin to read — switch to weekly bins. Matches cloud's
 *  own threshold (WEEKLY_AFTER_DAYS, analytics/outcome-trend.ts). */
export const WEEKLY_AFTER_DAYS = 56

const DAY_MS = 86_400_000
const fromDay = (day: string) => Date.parse(day + 'T00:00:00.000Z')
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function emptyByOutcome(): Record<FileOutcome, Measure> {
  return {
    merged: { sessions: 0, tokens: 0 },
    committed: { sessions: 0, tokens: 0 },
    abandoned: { sessions: 0, tokens: 0 },
    ambiguous: { sessions: 0, tokens: 0 },
  }
}

/**
 * Turns sessions with a resolved outcome into a dense, gap-free run of bins covering their own
 * date span. A session with no entry in `outcomes` yet (not requested, or still resolving) or a
 * `null`/`'ambiguous'` entry is omitted from every bin — never counted as zero — same rule the
 * chart this replaces used (buildOutcomeTokenBuckets, SessionCharts.tsx), so the chart shows what's
 * resolved so far and grows as `requestGitOutcomesFor` fills in the rest.
 */
export function buildTrendBins(
  sessions: SessionSummaryCard[],
  outcomes: Record<string, GitOutcome | null | undefined>,
): { bins: TrendBin[]; unit: 'day' | 'week' } {
  const counted: Array<{ s: SessionSummaryCard; outcome: FileOutcome }> = []
  for (const s of sessions) {
    const go = outcomes[s.sessionId]
    if (go && (TREND_OUTCOMES as string[]).includes(go.overall)) counted.push({ s, outcome: go.overall })
  }
  if (counted.length === 0) return { bins: [], unit: 'day' }

  const days = counted.map(({ s }) => dayKeyUtc(s.startTime))
  const first = days.reduce((m, d) => (d < m ? d : m), days[0])
  const last = days.reduce((m, d) => (d > m ? d : m), days[0])
  const startMs = fromDay(first)
  const endMs = fromDay(last)

  const spanDays = Math.round((endMs - startMs) / DAY_MS) + 1
  const unit: 'day' | 'week' = spanDays > WEEKLY_AFTER_DAYS ? 'week' : 'day'

  // Snap the first bin back to its Monday so every weekly bin is a whole calendar week.
  const binStart = (ms: number) => {
    if (unit === 'day') return ms
    const dow = (new Date(ms).getUTCDay() + 6) % 7 // Monday = 0
    return ms - dow * DAY_MS
  }
  const step = unit === 'day' ? DAY_MS : 7 * DAY_MS

  const bins: TrendBin[] = []
  const index = new Map<string, TrendBin>()
  for (let ms = binStart(startMs); ms <= endMs; ms += step) {
    const bin: TrendBin = {
      start: toDay(ms),
      end: toDay(Math.min(ms + step - DAY_MS, endMs)),
      byOutcome: emptyByOutcome(),
      total: { sessions: 0, tokens: 0 },
    }
    bins.push(bin)
    index.set(bin.start, bin)
  }

  for (const { s, outcome } of counted) {
    const bin = index.get(toDay(binStart(fromDay(dayKeyUtc(s.startTime)))))
    if (!bin) continue
    const tokens = (s.inputTokens ?? 0) + (s.outputTokens ?? 0)
    const m = bin.byOutcome[outcome]
    m.sessions += 1
    m.tokens += tokens
    bin.total.sessions += 1
    bin.total.tokens += tokens
  }

  return { bins, unit }
}

/** Range totals per outcome plus the landed/uncommitted split the card's headline reports. */
export function summarize(bins: TrendBin[]) {
  const byOutcome = emptyByOutcome()
  const total: Measure = { sessions: 0, tokens: 0 }
  for (const b of bins) {
    for (const o of TREND_OUTCOMES) {
      byOutcome[o].sessions += b.byOutcome[o].sessions
      byOutcome[o].tokens += b.byOutcome[o].tokens
    }
    total.sessions += b.total.sessions
    total.tokens += b.total.tokens
  }
  const landed = byOutcome.merged.tokens + byOutcome.committed.tokens
  return {
    byOutcome,
    total,
    landedShare: total.tokens > 0 ? landed / total.tokens : 0,
    uncommittedShare: total.tokens > 0 ? byOutcome.abandoned.tokens / total.tokens : 0,
  }
}

/** Largest 1/2/2.5/5 × 10^n step giving at most `ticks` intervals up to `max`. Matches cloud's
 *  niceMax (analytics/outcome-trend.ts) exactly, for the same reason: nice round axis labels. */
export function niceMax(max: number, ticks = 4): { max: number; step: number } {
  if (max <= 0) return { max: 1, step: 1 }
  const raw = max / ticks
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!
  return { max: Math.ceil(max / step) * step, step }
}
