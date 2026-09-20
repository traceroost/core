import * as fs from 'fs'
import * as vscode from 'vscode'
import { SessionStore } from './sessionStore'
import { DatabaseReader, type DailyStatRow, type LifetimeStats, type SearchQuery, type BurnRate, type Projection, type TraceSendStats } from './database/reader'
import { DatabaseWriter } from './database/writer'
import { summarizeSpans } from './spanSummarizer'
import type { SessionSummaryCard, TimelineEntry } from './summarizers/summarizerTypes'

export type { DailyStatRow, LifetimeStats, SearchQuery, BurnRate, Projection, TraceSendStats }

/**
 * Ceiling on how many sessions `listSessions()` ever returns when no caller-supplied `limit` is
 * given — the unfiltered call `repository?.listSessions()` in extension.ts posts whole to the
 * webview. Search/Export already has real DB-level `LIMIT`/`OFFSET` (`DatabaseReader.
 * searchSessions()`) as an escape hatch for "give me everything"; this list doesn't, and
 * `docs/decisions/0001-session-list-pagination.md` explicitly declines to add DB-level pagination
 * here for now (a stress test at 7,300 sessions found no real cost problem at that size). This cap
 * is the backstop regardless of that finding — a known, tested ceiling, the same shape as
 * `spanStore.ts`'s `DEFAULT_MAX_SPANS`, so an unusually large history degrades to "most recent N
 * sessions" instead of risking V8's ~512MB max string length on the webview `postMessage` payload.
 * See .staged-issues/scalability.md, risk #5.
 */
export const MAX_SESSIONS_TO_WEBVIEW = 20_000

/**
 * For OTEL sessions missing workspace: look for a log session of the same source
 * that started within the same minute and borrow its workspace. Uses 1-minute
 * buckets keyed by source+bucket; if two log sessions in the same bucket have
 * different workspaces the entry is marked ambiguous and skipped.
 */
export function resolveWorkspacesFromLogs(sessions: SessionSummaryCard[]): void {
  // null sentinel = ambiguous (two different workspaces in the same bucket)
  const wsMap = new Map<string, string | null>()
  for (const s of sessions) {
    if (!s.workspace || s.dataSource !== 'log') { continue }
    const t = Date.parse(s.startTime)
    if (!t) { continue }
    const bucket = Math.floor(t / 60000)
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const key = `${s.source}:${b}`
      const existing = wsMap.get(key)
      if (existing === undefined) {
        wsMap.set(key, s.workspace)
      } else if (existing !== s.workspace) {
        wsMap.set(key, null)
      }
    }
  }
  for (const s of sessions) {
    if (s.workspace || s.dataSource !== 'otel') { continue }
    const t = Date.parse(s.startTime)
    if (!t) { continue }
    const bucket = Math.floor(t / 60000)
    const ws = wsMap.get(`${s.source}:${bucket}`)
    if (ws) { s.workspace = ws }
  }
}

/**
 * Merges historical sessions from SQLite with live sessions from the in-memory
 * span window. Live sessions always win on conflict (same sessionId) — they are
 * fresher. Result is sorted by startTime DESC.
 */
export function mergeSessions(
  dbSessions: SessionSummaryCard[],
  liveSessions: SessionSummaryCard[],
): SessionSummaryCard[] {
  const liveIds = new Set(liveSessions.map(s => s.sessionId))
  return [
    ...liveSessions,
    ...dbSessions.filter(s => !liveIds.has(s.sessionId)),
  ].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
}

/**
 * Single access point for session data throughout the extension.
 * Combines DatabaseReader (historical), DatabaseWriter (persistence),
 * and SessionStore (live span window).
 */
export class SessionRepository {
  constructor(
    private readonly reader: DatabaseReader,
    private readonly writer: DatabaseWriter,
    private readonly store: SessionStore,
    private readonly log: (msg: string) => void = () => { /* silent */ },
  ) {}

  /** Returns merged session list: live window + historical DB, sorted newest-first.
   *  Capped at `MAX_SESSIONS_TO_WEBVIEW` when the caller doesn't supply its own `limit` — see that
   *  constant's doc comment. Pass `limit: Infinity` to bypass the cap entirely (used by team
   *  reconcile, which must see every local session, not just the most recent N). */
  listSessions(filter?: {
    source?: 'copilot' | 'claude_code' | 'codex' | 'opencode' | 'cursor'
    limit?: number
  }): SessionSummaryCard[] {
    const dbSessions = this.reader.listSessions(filter)
    const liveSpans = this.store.getSpans()
    const liveSessions = liveSpans.length > 0 ? summarizeSpans(liveSpans).sessions : []
    const merged = mergeSessions(dbSessions, liveSessions)
    resolveWorkspacesFromLogs(merged)
    const effectiveLimit = filter?.limit ?? MAX_SESSIONS_TO_WEBVIEW
    if (merged.length > effectiveLimit) {
      if (filter?.limit === undefined) {
        this.log(`[TraceRoost] Session list (${merged.length}) exceeds the ${MAX_SESSIONS_TO_WEBVIEW}-session safety cap — returning the most recent ${MAX_SESSIONS_TO_WEBVIEW} only.`)
      }
      return merged.slice(0, effectiveLimit)
    }
    return merged
  }

  /** Returns full timeline entries for one session (no blob content). */
  loadSessionTimeline(sessionId: string): TimelineEntry[] {
    return this.reader.loadSessionTimeline(sessionId)
  }

  /** Reads one blob file. Returns null if not found. */
  async loadBlob(
    spanId: string,
    field: 'response' | 'thinking' | 'tool-input' | 'full-result' | 'edit-old' | 'edit-new',
    editIndex?: number,
  ): Promise<string | null> {
    return this.reader.loadBlob(spanId, field, editIndex)
  }

  /** Returns daily token + cost stats for the last N days, optionally filtered by source. */
  queryDailyStats(options: { since: number; source?: string }): DailyStatRow[] {
    return this.reader.queryDailyStats(options)
  }

  /** Returns hourly token + cost stats. `day` key is 'YYYY-MM-DD HH' (UTC). */
  queryHourlyStats(options: { since: number; source?: string }): DailyStatRow[] {
    return this.reader.queryHourlyStats(options)
  }

  /** Returns lifetime aggregate stats across all non-sidechain sessions. */
  queryLifetimeStats(): LifetimeStats {
    return this.reader.queryLifetimeStats()
  }

  /** Full-text + filter session search with pagination. */
  searchSessions(query: SearchQuery): { sessions: SessionSummaryCard[]; totalCount: number } {
    return this.reader.searchSessions(query)
  }

  /** Burn rate for an active session. Returns null if < 2 LLM entries with timestamps. */
  queryBurnRate(sessionId: string): { burnRate: BurnRate; projection: Projection | null } | null {
    return this.reader.queryBurnRate(sessionId)
  }

  /** Windowed + lifetime "hashed traces sent" transport stats for the Team panel. */
  queryTraceSendStats(now: number): TraceSendStats {
    return this.reader.queryTraceSendStats(now)
  }

  /** Records a successful forwarding drain of `count` traces, for the transport stats above. */
  recordTraceSent(count: number, at: number): void {
    this.writer.recordTraceSent(count, at)
  }

  /** Returns storage size stats for the DB file and blobs directory. */
  getStorageStats(dbPath: string, blobsDir: string): { dbBytes: number; blobBytes: number; blobCount: number } {
    let dbBytes = 0
    let blobBytes = 0
    let blobCount = 0
    try { dbBytes = fs.statSync(dbPath).size } catch { /* ok */ }
    try {
      const files = fs.readdirSync(blobsDir)
      for (const f of files) {
        try {
          blobBytes += fs.statSync(`${blobsDir}/${f}`).size
          blobCount++
        } catch { /* ok */ }
      }
    } catch { /* ok */ }
    return { dbBytes, blobBytes, blobCount }
  }

  /** Enqueues a session write — thin delegation to DatabaseWriter. */
  enqueue(card: SessionSummaryCard, workspace: string): void {
    this.writer.enqueue(card, workspace)
  }

  /** Waits for all pending DB writes to complete. */
  async drain(): Promise<void> {
    return this.writer.drain()
  }

  /** Writes import cards directly in one transaction, bypassing the async drain. */
  importCards(cards: SessionSummaryCard[]): void {
    this.writer.importCards(cards)
  }

  /** Clears all three SQLite tables. */
  clearAll(): void {
    this.writer.clearAll()
  }

  /** Exposes the raw SessionStore for callers that still need it (e.g. status bar). */
  get store_(): SessionStore {
    return this.store
  }

  /** Exposes onUpdate from the underlying store. */
  onUpdate(fn: (traceId?: string) => void): { dispose(): void } {
    return this.store.onUpdate(fn)
  }

  /** Clears the in-memory span window. */
  clearStore(): void {
    this.store.clear()
  }

  /** Saves the DB to disk (called after each drain for cross-window sync). */
  saveDb(save: () => void): void {
    save()
  }

  /** Deletes all blob files under storageUri/blobs/. Returns count deleted. */
  async clearBlobs(storageUri: vscode.Uri): Promise<number> {
    const blobsUri = vscode.Uri.joinPath(storageUri, 'blobs')
    let count = 0
    try {
      const entries = await vscode.workspace.fs.readDirectory(blobsUri)
      await Promise.all(
        entries
          .filter(([, type]) => type === vscode.FileType.File)
          .map(async ([name]) => {
            try {
              await vscode.workspace.fs.delete(vscode.Uri.joinPath(blobsUri, name))
              count++
            } catch { /* ignore individual delete failures */ }
          })
      )
    } catch { /* blobs dir absent — nothing to clear */ }
    return count
  }
}
