/**
 * Host-independent plan-limit pipeline — the one thing both the VS Code extension and the
 * standalone server call. Stores what the log parsers found (Codex readings, limit hits from both
 * agents), polls Claude Code's cached reading, keeps window rollups current, and builds the
 * snapshot the dashboard, sidebar, alerts and MCP server render.
 *
 * Everything returned follows "no data, no UI": a provider, window, session or chart with nothing
 * behind it is absent from the snapshot, never present as zero.
 */

import type { LogSessionResult } from '../logReader'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'
import { calcSessionCostUsd } from '../pricing'
import type { LimitHit, LimitProvider, LimitWindowKind, PlanStatus } from './limitReadings'
import { LimitRepository, type WindowRollup } from './limitRepository'
import { claudeConfigPath, readClaudeCachedUsage } from './claudeCache'
import {
  attributeIntervals, codexPace, currentMeters, limitSeries, pointsPerDollar, projectPace, sessionConsumption,
  windowRollups, type LimitSeries, type MeterWindow, type PaceProjection, type PlanMeter, type SessionLimitUsage,
  type SessionSpan,
} from './consumption'

const DAY = 86_400_000
/** How far back readings are considered when attributing usage to sessions. */
const ATTRIBUTION_LOOKBACK_MS = 30 * DAY
/** A hit belongs to a session of the same agent active within this long of it. */
const HIT_SESSION_SLACK_MS = 2 * 60_000

type WriteableDb = ConstructorParameters<typeof LimitRepository>[0]

export interface SessionPlanUsage extends SessionLimitUsage {
  hits?: LimitHit[]
}

export interface PlanUsageSnapshot {
  generatedAt: number
  meters: PlanMeter[]
  sessions: Record<string, SessionPlanUsage>
  /** Weekly window, last 14 days; 5-hour window, last 7 days. */
  series: { weekly: LimitSeries[]; fiveHour: LimitSeries[] }
  /** Limit hits in the last 14 days, attributed to the session they happened in where known. */
  hits: LimitHit[]
  /** Completed weekly windows, most recent 12 per provider. */
  weeklyRollups: WindowRollup[]
  /** First stored reading per provider — charts say "history starts" rather than showing zeros. */
  historyStartsAt: Partial<Record<LimitProvider, number>>
  /** Each provider's latest plan status (last 30 days). The dashboard shows it for a provider
   *  that has no meter because its plan reports no 5-hour or weekly window. */
  planStatus: PlanStatus[]
  /** Weekly-window points per dollar of estimated cost — turns a waste estimate in dollars into
   *  points of the weekly limit. Absent until there's enough history to be meaningful. */
  weeklyPtsPerDollar: Partial<Record<LimitProvider, number>>
}

export interface LivePlanLimit {
  provider: LimitProvider
  planType?: string
  approximate: boolean
  observedAt: number
  windows: MeterWindow[]
  thisTrace?: { fiveHourPct?: number; weeklyPct?: number }
  pace?: PaceProjection
  blocked?: { windowKind: LimitWindowKind; resetsAt?: number }
  severity: 'normal' | 'warn' | 'blocked'
}

export function providerOf(source: SessionSummaryCard['source']): LimitProvider | undefined {
  return source === 'claude_code' ? 'claude' : source === 'codex' ? 'codex' : undefined
}

export function toSessionSpan(card: SessionSummaryCard): SessionSpan | undefined {
  const provider = providerOf(card.source)
  const startMs = Date.parse(card.startTime)
  if (!provider || !Number.isFinite(startMs)) return undefined
  let costUsd = 0
  try { costUsd = calcSessionCostUsd(card) } catch { /* unknown model → weight by tokens */ }
  return {
    sessionId: card.sessionId,
    provider,
    startMs,
    endMs: startMs + Math.max(0, card.durationMs || 0),
    costUsd,
    tokens: card.inputTokens + card.outputTokens + card.cacheCreateTokens + card.cacheReadTokens * 0.1,
  }
}

let current: PlanUsageService | undefined

/** The process's service, once its host has a database to back it (undefined before that, and
 *  for the lifetime of a host with no database — everything plan-related then stays hidden). */
export function getPlanUsageService(): PlanUsageService | undefined {
  return current
}

export function setPlanUsageService(svc: PlanUsageService | undefined): void {
  current = svc
}

export class PlanUsageService {
  private readonly repo: LimitRepository
  private claudeMtimeMs: number | undefined
  private lastClaudeFetchedAt: number | undefined

  constructor(
    db: WriteableDb,
    private readonly opts: { claudeConfigPath?: string; now?: () => number; log?: (m: string) => void } = {},
  ) {
    this.repo = new LimitRepository(db)
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  /** Stores the readings and hits carried by freshly parsed log results. Returns true when any
   *  result carried limit data. */
  ingest(results: LogSessionResult[]): boolean {
    let any = false
    for (const r of results) {
      if (r.limitReadings?.length) { this.repo.insertReadings(r.limitReadings); any = true }
      if (r.limitHits?.length) { this.repo.insertHits(r.limitHits); any = true }
      if (r.planStatus) { this.repo.upsertPlanStatus(r.planStatus); any = true }
    }
    if (any) this.refreshRollups()
    return any
  }

  /** Reads Claude Code's cached reading (only when the file changed) and stores it when it's a new
   *  fetch. Returns true when a new reading was stored. Never throws. */
  pollClaudeCache(): boolean {
    try {
      const res = readClaudeCachedUsage(this.opts.claudeConfigPath ?? claudeConfigPath(), this.claudeMtimeMs)
      if (!res) return false
      this.claudeMtimeMs = res.mtimeMs
      const usage = res.usage
      if (!usage || usage.fetchedAt === this.lastClaudeFetchedAt) return false
      this.lastClaudeFetchedAt = usage.fetchedAt
      this.repo.insertReadings(usage.readings, usage.accountHash)
      this.refreshRollups()
      return true
    } catch (err) {
      this.opts.log?.(`[TraceRoost] Plan usage: Claude cache read skipped (${(err as Error).message})`)
      return false
    }
  }

  /** Current meters only — cheap enough for the sidebar's every-5s refresh. */
  meters(): PlanMeter[] {
    const now = this.now()
    return currentMeters(this.repo.readingsSince(now - ATTRIBUTION_LOOKBACK_MS), now)
  }

  /** Readings and hits follow trace retention; rollups are kept a year. */
  runRetention(retentionDays: number): void {
    try { this.repo.deleteOlderThan(retentionDays, this.now()) } catch { /* best-effort */ }
  }

  private refreshRollups(): void {
    const now = this.now()
    const since = now - ATTRIBUTION_LOOKBACK_MS
    this.repo.upsertRollups(windowRollups(this.repo.readingsSince(since), this.repo.hitsSince(since - 7 * DAY), now))
  }

  /** Attributes each hit to a displayed session: its own id when that card is in view, else the
   *  same agent's session that was active at the time (an OTEL card may have replaced the log one). */
  private attributeHits(hits: LimitHit[], spans: SessionSpan[]): LimitHit[] {
    const ids = new Set(spans.map(s => s.sessionId))
    return hits.map(h => {
      if (ids.has(h.sessionId)) return h
      const match = spans.find(s => s.provider === h.provider && h.hitAt >= s.startMs - HIT_SESSION_SLACK_MS && h.hitAt <= s.endMs + HIT_SESSION_SLACK_MS)
      return match ? { ...h, sessionId: match.sessionId } : h
    })
  }

  snapshot(cards: SessionSummaryCard[]): PlanUsageSnapshot {
    const now = this.now()
    const spans = cards.map(toSessionSpan).filter((s): s is SessionSpan => !!s)
    const readings = this.repo.readingsSince(now - ATTRIBUTION_LOOKBACK_MS)
    const intervals = attributeIntervals(readings, spans)
    const consumption = sessionConsumption(intervals)
    const hits = this.attributeHits(this.repo.hitsSince(now - 14 * DAY), spans)

    const sessions: Record<string, SessionPlanUsage> = {}
    for (const [id, u] of consumption) sessions[id] = { ...u }
    for (const h of hits) {
      const entry = sessions[h.sessionId] ?? (sessions[h.sessionId] = { approximate: false })
      ;(entry.hits ??= []).push(h)
    }

    const weeklyRollups: WindowRollup[] = []
    for (const provider of ['claude', 'codex'] as LimitProvider[]) {
      weeklyRollups.push(...this.repo.rollups('weekly', now - 365 * DAY).filter(r => r.provider === provider).slice(-12))
    }

    const historyStartsAt: PlanUsageSnapshot['historyStartsAt'] = {}
    const weeklyPtsPerDollar: PlanUsageSnapshot['weeklyPtsPerDollar'] = {}
    for (const provider of ['claude', 'codex'] as LimitProvider[]) {
      const first = this.repo.firstReadingAt(provider)
      if (first !== undefined) historyStartsAt[provider] = first
      for (const windowKind of ['five_hour', 'weekly'] as LimitWindowKind[]) {
        const ppd = pointsPerDollar(intervals, provider, windowKind)
        if (ppd === undefined) continue
        this.cachedPpd.set(`${provider}|${windowKind}`, ppd)
        if (windowKind === 'weekly') weeklyPtsPerDollar[provider] = ppd
      }
    }

    return {
      generatedAt: now,
      meters: currentMeters(readings, now),
      sessions,
      series: {
        weekly: limitSeries(readings, intervals, 'weekly', now - 14 * DAY),
        fiveHour: limitSeries(readings, intervals, 'five_hour', now - 7 * DAY),
      },
      hits,
      weeklyRollups,
      historyStartsAt,
      planStatus: this.repo.planStatuses(now - ATTRIBUTION_LOOKBACK_MS),
      weeklyPtsPerDollar,
    }
  }

  /** The sidebar's live Plan limit card for the session currently running, or undefined when its
   *  agent has no plan-limit data. */
  liveCard(card: SessionSummaryCard | undefined, burnRate: { costPerHour: number } | null | undefined): LivePlanLimit | undefined {
    if (!card) return undefined
    const provider = providerOf(card.source)
    if (!provider) return undefined
    const now = this.now()
    const readings = this.repo.readingsSince(now - ATTRIBUTION_LOOKBACK_MS)
    const meter = currentMeters(readings, now).find(m => m.provider === provider)
    if (!meter) return undefined
    const windows = meter.windows.filter(w => w.windowKind === 'five_hour' || w.windowKind === 'weekly')
    if (windows.length === 0) return undefined

    const span = toSessionSpan(card)
    const intervals = span ? attributeIntervals(readings, [span]) : []
    const own = span ? sessionConsumption(intervals).get(span.sessionId) : undefined
    const thisTrace = own && (own.fiveHourPct !== undefined || own.weeklyPct !== undefined)
      ? { fiveHourPct: own.fiveHourPct, weeklyPct: own.weeklyPct }
      : undefined

    const fiveHour = windows.find(w => w.windowKind === 'five_hour')
    let ptsPerMinute: number | undefined
    if (provider === 'codex') {
      ptsPerMinute = codexPace(readings, undefined, now)
    } else if (burnRate && burnRate.costPerHour > 0) {
      const ppd = pointsPerDollar(intervals, 'claude', 'five_hour') ?? this.historicalPointsPerDollar('claude', 'five_hour')
      if (ppd !== undefined) ptsPerMinute = (burnRate.costPerHour / 60) * ppd
    }
    const pace = fiveHour ? projectPace(fiveHour.usedPct, ptsPerMinute, fiveHour.resetsAt, now) : undefined

    const activeHit = this.repo.hitsSince(now - 8 * DAY)
      .filter(h => h.provider === provider && h.resetsAt !== undefined && h.resetsAt > now)
      .sort((a, b) => b.hitAt - a.hitAt)[0]
    const blocked = activeHit ? { windowKind: activeHit.windowKind, resetsAt: activeHit.resetsAt } : undefined

    const warn = windows.some(w => w.usedPct >= 75) || pace?.minutesToLimit !== undefined
    return {
      provider,
      planType: meter.planType,
      approximate: meter.approximate,
      observedAt: meter.observedAt,
      windows,
      thisTrace,
      pace,
      blocked,
      severity: blocked ? 'blocked' : warn ? 'warn' : 'normal',
    }
  }

  /** Pts-per-dollar from the last snapshot() pass, so the live card has a Claude pace figure
   *  between snapshots (the live session alone rarely has enough intervals). */
  private readonly cachedPpd = new Map<string, number>()
  private historicalPointsPerDollar(provider: LimitProvider, windowKind: LimitWindowKind): number | undefined {
    return this.cachedPpd.get(`${provider}|${windowKind}`)
  }
}
