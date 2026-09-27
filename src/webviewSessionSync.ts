import type { SessionSummaryCard } from './summarizers/summarizerTypes'

/**
 * Tracks what the dashboard webview already holds so `DashboardPanel.update()` can post only what
 * changed. The panel re-posts on a 10s interval and on every repository change (throttled to
 * 300ms while an agent is streaming spans), and each post used to carry the whole session list —
 * ~1KB per session, so ~23MB at the 20k `MAX_SESSIONS_TO_WEBVIEW` cap — to be serialized by the
 * host, deserialized by the webview, and fed back through every computed signal and chart even when
 * nothing had changed.
 *
 * The wire contract is additive: a full `sessionSummary` is still what the first post (and any
 * resync) sends and what the standalone server always sends. Every post from here also carries
 * `base` → `rev`: the revision of host-side state it assumes the webview already holds, and the
 * one it brings it to (equal when nothing changed). The webview asks for a full resync
 * (`requestFullUpdate`) whenever `base` isn't its own revision — a reloaded webview, a dropped
 * message — so it can never silently drift.
 */
export interface SessionDelta {
  /** Cards that are new, or differ from the copy the webview already holds. */
  upserts: SessionSummaryCard[]
  /** Full id order, only when it differs from what the webview already holds. */
  order?: string[]
  efficiency: unknown
}

export interface SessionSyncPost {
  base: number
  rev: number
  sessionSummary?: { sessions: SessionSummaryCard[]; backgroundSpans: never[]; efficiency: unknown } | null
  sessionDelta?: SessionDelta
  analyticsData?: unknown
  burnRate?: unknown
}

/** Structural equality over JSON-shaped data. Errs only toward "different" (`undefined` vs. a
 *  missing key, NaN) — which costs a redundant resend, never a missed update. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

type Posted =
  | null                                                  // unknown — next post is a full one
  | 'empty'                                               // webview holds `sessionSummary: null`
  | { byId: Map<string, SessionSummaryCard>; order: string[] }

export class WebviewSessionSync {
  private rev = 0
  private posted: Posted = null
  private analyticsJson: string | null = null
  private burnRateJson: string | null = null

  /** Forget everything the webview is known to hold, so the next `next()` posts in full. */
  reset(): void {
    this.posted = null
    this.analyticsJson = null
    this.burnRateJson = null
  }

  /** Records sessions embedded directly in the webview's initial HTML, and returns the revision
   *  to embed alongside them. */
  seed(sessions: SessionSummaryCard[]): number {
    this.reset()
    this.posted = sessions.length === 0 ? 'empty' : WebviewSessionSync.snapshot(sessions)
    return this.rev
  }

  /** The session/analytics/burn-rate part of the next `update` post. Omitted fields mean "unchanged
   *  since the last post" — the webview's `update` handler already treats each as optional. */
  next(
    sessions: SessionSummaryCard[],
    efficiency: () => unknown,
    analyticsData: unknown,
    burnRate: unknown,
  ): SessionSyncPost {
    const base = this.rev
    const post: Omit<SessionSyncPost, 'base' | 'rev'> = {}

    const prev = this.posted
    if (sessions.length === 0) {
      if (prev !== 'empty') { post.sessionSummary = null; this.posted = 'empty' }
    } else {
      const next = WebviewSessionSync.snapshot(sessions)
      if (prev === null || prev === 'empty' || next === null) {
        post.sessionSummary = { sessions, backgroundSpans: [], efficiency: efficiency() }
      } else {
        const upserts = sessions.filter(s => !jsonEqual(prev.byId.get(s.sessionId), s))
        const sameOrder = next.order.length === prev.order.length && next.order.every((id, i) => id === prev.order[i])
        if (upserts.length > 0 || !sameOrder) {
          post.sessionDelta = { upserts, ...(sameOrder ? {} : { order: next.order }), efficiency: efficiency() }
        }
      }
      // A duplicate sessionId can't be expressed as a delta — keep posting in full until it's gone.
      this.posted = next
    }

    const analyticsJson = JSON.stringify(analyticsData)
    if (analyticsJson !== this.analyticsJson) { post.analyticsData = analyticsData; this.analyticsJson = analyticsJson }
    const burnRateJson = JSON.stringify(burnRate)
    if (burnRateJson !== this.burnRateJson) { post.burnRate = burnRate; this.burnRateJson = burnRateJson }

    if (Object.keys(post).length > 0) this.rev++
    return { base, rev: this.rev, ...post }
  }

  // Shallow copies, so a card object the repository hands back again and mutates in place still
  // compares against what was actually posted.
  private static snapshot(sessions: SessionSummaryCard[]): { byId: Map<string, SessionSummaryCard>; order: string[] } | null {
    const byId = new Map<string, SessionSummaryCard>()
    const order: string[] = []
    for (const s of sessions) {
      if (byId.has(s.sessionId)) return null
      byId.set(s.sessionId, { ...s })
      order.push(s.sessionId)
    }
    return byId.size === 0 ? null : { byId, order }
  }
}
