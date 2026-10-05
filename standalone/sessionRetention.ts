/**
 * Retention for the standalone server's log-sourced traces — the counterpart of the editor's
 * `traceRoost.sessionRetentionDays` (which prunes its SQLite store). The server keeps every card
 * in memory (`logSessions`), each with its full timeline, so without a cutoff a long-running
 * service grows for as long as the agent logs on disk do. Configured by `sessionRetentionDays` in
 * `~/.traceroost/config.json` (src/serviceConfig.ts); applied in two places:
 *
 *   - the historical pass skips transcript files last modified before the cutoff
 *     (`LogReader.collectFileMeta({ minMtimeMs })`), and seeds their file state so the periodic
 *     scan doesn't read them either;
 *   - the daily tick drops cards whose `startTime` is before the cutoff (`pruneLogSessions`).
 */

const DAY_MS = 86_400_000

/** `days` ≤ 0 or non-finite means "keep everything" — the cutoff is then the epoch. */
export function retentionCutoffMs(days: number, now: number = Date.now()): number {
  if (!Number.isFinite(days) || days <= 0) return 0
  return now - days * DAY_MS
}

/** Removes every card whose `startTime` parses to before `cutoffMs` from `sessions`
 *  (a Map keyed by session id). Cards with no parseable start time are kept. Returns the keys removed. */
export function pruneLogSessions<T extends { startTime: string }>(sessions: Map<string, T>, cutoffMs: number): string[] {
  if (cutoffMs <= 0) return []
  const removed: string[] = []
  for (const [key, card] of sessions) {
    const ms = Date.parse(card.startTime)
    if (Number.isFinite(ms) && ms < cutoffMs) {
      sessions.delete(key)
      removed.push(key)
    }
  }
  return removed
}
