/**
 * Subscription plan-limit readings (Claude Pro/Max, ChatGPT plans) — how much of the 5-hour and
 * weekly windows was used, and when a limit was hit. Read only from files the agent CLIs already
 * write; never from a credential store or a provider endpoint. See
 * .staged-features/subscription-limit-usage.md for the full design.
 *
 * This module holds the shared types and the Codex rollout parser. Codex appends a `token_count`
 * event on every turn, and each one carries the account's rate limits as the server reported them:
 *
 *   payload.rate_limits = {
 *     primary:   { used_percent: 23.0, window_minutes: 300,   resets_at: 1790052354 },
 *     secondary: { used_percent: 38.0, window_minutes: 10080, resets_at: 1790178910 },
 *     plan_type: 'plus', rate_limit_reached_type: null, ...
 *   }
 *
 * Every field is treated as optional: older rollouts carry only `primary`, or no `rate_limits`.
 */

export type LimitProvider = 'claude' | 'codex'
export type LimitWindowKind = 'five_hour' | 'weekly' | 'weekly_opus' | 'weekly_sonnet'
export type LimitReadingSource = 'codex_rollout' | 'claude_cache'

export interface LimitReading {
  provider: LimitProvider
  windowKind: LimitWindowKind
  /** 0–100. */
  usedPct: number
  /** Epoch ms; undefined when the source didn't say. */
  resetsAt?: number
  /** Epoch ms — when the provider reported this value (Codex: the event's timestamp). */
  observedAt: number
  source: LimitReadingSource
  /** Set for readings that came from a session's own log (Codex); unset for account-wide
   *  snapshots (Claude's cache). */
  sessionId?: string
  /** Codex `plan_type` ('plus', 'pro', ...). */
  planType?: string
}

export interface LimitHit {
  provider: LimitProvider
  sessionId: string
  windowKind: LimitWindowKind
  /** Epoch ms. */
  hitAt: number
  /** Epoch ms; undefined when the source didn't say. */
  resetsAt?: number
}

const WINDOW_MINUTES_TO_KIND: Record<number, LimitWindowKind> = {
  300: 'five_hour',
  10080: 'weekly',
}

interface CodexWindow {
  key: string
  kind: LimitWindowKind
  usedPct: number
  resetsAt?: number
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Windows are classified by `window_minutes`, not by key name — `primary`/`secondary` are
 *  positional, and a window with an unrecognized length is skipped rather than guessed at. */
function codexWindows(rateLimits: Record<string, unknown>): CodexWindow[] {
  const windows: CodexWindow[] = []
  for (const [key, value] of Object.entries(rateLimits)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const w = value as Record<string, unknown>
    const usedPct = finiteNumber(w['used_percent'])
    const minutes = finiteNumber(w['window_minutes'])
    const kind = minutes === undefined ? undefined : WINDOW_MINUTES_TO_KIND[minutes]
    if (usedPct === undefined || !kind) continue
    const resetsAtSec = finiteNumber(w['resets_at'])
    windows.push({ key, kind, usedPct: Math.min(100, Math.max(0, usedPct)), resetsAt: resetsAtSec === undefined ? undefined : resetsAtSec * 1000 })
  }
  return windows
}

/** Which window a non-null `rate_limit_reached_type` refers to. Never observed non-null in real
 *  data yet, so this is deliberately forgiving: the value naming a window key wins, then a window
 *  at 100%, then the fullest window. */
function reachedWindow(reached: unknown, windows: CodexWindow[]): CodexWindow | undefined {
  if (windows.length === 0) return undefined
  if (typeof reached === 'string') {
    const byKey = windows.find(w => w.key === reached)
    if (byKey) return byKey
  }
  return windows.find(w => w.usedPct >= 100)
    ?? windows.reduce((a, b) => (b.usedPct > a.usedPct ? b : a))
}

/**
 * Accumulates one Codex session's readings from its `token_count` events, in file order.
 *
 * Codex repeats the same reading on every turn, so only readings that differ from the previous one
 * for the same window are kept, plus the last one seen per window (so "as of" reflects the latest
 * turn, not the last change). That's lossless for a step series and keeps a long session to a few
 * rows. A limit hit is recorded once per run of consecutive "reached" events, not once per turn.
 */
export class CodexLimitCollector {
  private readonly readings: LimitReading[] = []
  private readonly lastByKind = new Map<LimitWindowKind, { reading: LimitReading; kept: boolean }>()
  private readonly hits: LimitHit[] = []
  private reachedRun = false

  constructor(private readonly sessionId: string) {}

  /** `payload` is a `token_count` event's payload; `timestamp` is the event's ISO timestamp. */
  add(payload: Record<string, unknown>, timestamp: string | undefined): void {
    const rateLimits = payload['rate_limits']
    if (!rateLimits || typeof rateLimits !== 'object' || Array.isArray(rateLimits)) return
    const observedAt = timestamp ? Date.parse(timestamp) : NaN
    if (!Number.isFinite(observedAt)) return

    const rl = rateLimits as Record<string, unknown>
    const planType = typeof rl['plan_type'] === 'string' ? rl['plan_type'] : undefined
    const windows = codexWindows(rl)

    for (const w of windows) {
      const reading: LimitReading = {
        provider: 'codex', windowKind: w.kind, usedPct: w.usedPct, resetsAt: w.resetsAt,
        observedAt, source: 'codex_rollout', sessionId: this.sessionId, planType,
      }
      const prev = this.lastByKind.get(w.kind)
      const changed = !prev || prev.reading.usedPct !== reading.usedPct || prev.reading.resetsAt !== reading.resetsAt
      if (changed) this.readings.push(reading)
      this.lastByKind.set(w.kind, { reading, kept: changed })
    }

    const reached = rl['rate_limit_reached_type']
    if (reached !== null && reached !== undefined && reached !== false) {
      const w = reachedWindow(reached, windows)
      if (w && !this.reachedRun) {
        this.hits.push({ provider: 'codex', sessionId: this.sessionId, windowKind: w.kind, hitAt: observedAt, resetsAt: w.resetsAt })
      }
      this.reachedRun = true
    } else {
      this.reachedRun = false
    }
  }

  /** Readings in observation order, including each window's final reading. */
  readingsOut(): LimitReading[] {
    const tail = [...this.lastByKind.values()].filter(e => !e.kept).map(e => e.reading)
    return [...this.readings, ...tail].sort((a, b) => a.observedAt - b.observedAt)
  }

  hitsOut(): LimitHit[] {
    return [...this.hits]
  }
}

const CLAUDE_RATE_LIMIT_TYPE_TO_KIND: Record<string, LimitWindowKind> = {
  five_hour: 'five_hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly_opus',
  seven_day_sonnet: 'weekly_sonnet',
}

/** The model Claude Code puts on assistant entries it writes itself (limit refusals, API errors)
 *  — not an LLM call, so it must never count as a turn, a model, or usage. */
export const CLAUDE_SYNTHETIC_MODEL = '<synthetic>'

/**
 * A Claude Code session-log entry recording a plan-limit refusal, or null. Claude Code writes a
 * synthetic assistant entry with a structured `quotaLimits` object when a request is refused:
 *
 *   { type: 'assistant', timestamp, message: { model: '<synthetic>', ... },
 *     error: 'rate_limit', apiErrorStatus: 429,
 *     quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1789516200, ... } }
 *
 * Detected by the structured object only — never by the message text, whose wording varies by
 * version. A `quotaLimits` without a rejection (a status other than 'rejected' and no
 * `error: 'rate_limit'`) is not a hit.
 */
export function claudeLimitHit(entry: Record<string, unknown>, sessionId: string): LimitHit | null {
  const q = entry['quotaLimits']
  if (!q || typeof q !== 'object' || Array.isArray(q)) return null
  const quota = q as Record<string, unknown>
  if (quota['status'] !== 'rejected' && entry['error'] !== 'rate_limit') return null
  const kind = typeof quota['rateLimitType'] === 'string' ? CLAUDE_RATE_LIMIT_TYPE_TO_KIND[quota['rateLimitType']] : undefined
  if (!kind) return null
  const hitAt = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : NaN
  if (!Number.isFinite(hitAt)) return null
  const resetsAtSec = finiteNumber(quota['resetsAt'])
  return { provider: 'claude', sessionId, windowKind: kind, hitAt, resetsAt: resetsAtSec === undefined ? undefined : resetsAtSec * 1000 }
}

/** Collapses repeated refusals for the same window reset into one hit — a user retrying three
 *  times against the same wall is one hit, not three. Keeps the earliest. */
export function dedupeHits(hits: LimitHit[]): LimitHit[] {
  const seen = new Set<string>()
  const out: LimitHit[] = []
  for (const h of [...hits].sort((a, b) => a.hitAt - b.hitAt)) {
    const key = `${h.provider}|${h.sessionId}|${h.windowKind}|${h.resetsAt ?? h.hitAt}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h)
  }
  return out
}
