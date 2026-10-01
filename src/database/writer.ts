import * as crypto from 'crypto'
import * as vscode from 'vscode'
import type { SessionSummaryCard, TimelineEntry, EditDetail } from '../summarizers/summarizerTypes'
import { calcSessionCostUsd } from '../pricing'
import { bumpSessionsVersion } from './sessionsVersion'

// Strings below this length are kept inline in the DB row rather than written to a blob file.
const BLOB_MIN_LENGTH = 512

// Slack when matching a Claude log card's [start, end] against OTEL interactions' ranges: the
// interaction span starts a beat before the transcript's first line is written.
const CLAUDE_OVERLAP_SLACK_MS = 60_000

// Minimal sql.js surface needed for write operations.
interface WriteableDb {
  run(sql: string, params?: unknown[]): void
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>
  prepare(sql: string): PreparedStatement
}
interface PreparedStatement {
  run(params?: unknown[]): void
  step(): boolean
  get(): unknown[]
  reset(): void
  free(): void
}

const INSERT_SESSION_SQL = `INSERT OR REPLACE INTO sessions (
        session_id, trace_id, source, workspace, project_path, model,
        start_time, duration_ms, turns, input_tokens, output_tokens,
        cache_read_tokens, cache_create_tokens, cache_hit_rate,
        total_tool_calls, total_llm_calls, errors, outcome,
        is_sidechain, speed, user_request, tool_counts, loop_signals,
        files_read, files_changed, files_written, files_searched, files_changed_note, cost_usd,
        data_source, models, one_shot_stats, initiator, conversation_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

// sessions.created_at's column default (schema.ts) — what every INSERT OR REPLACE of a row sets.
const CREATED_AT_NOW_SQL = "CAST(strftime('%s', 'now') AS INTEGER) * 1000"

const INSERT_TIMELINE_SQL = `INSERT INTO timeline_entries (
        session_id, span_id, position, type, label, model,
        input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
        ttft, duration_ms, action, decision,
        is_error, error_message, timestamp, has_blob
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

const INSERT_EDIT_SQL = `INSERT INTO edit_details (timeline_entry_id, file_path, tool_name, has_blob)
       VALUES (?,?,?,?)`

/**
 * Prepares each distinct statement once for the length of one synchronous write transaction —
 * compiling the SQL again for every timeline row was most of the cost of a write. Statements
 * must not outlive the synchronous block: sql.js frees them all on export() (every save).
 */
class StatementCache {
  private readonly stmts = new Map<string, PreparedStatement>()
  constructor(private readonly db: WriteableDb) {}
  get(sql: string): PreparedStatement {
    let stmt = this.stmts.get(sql)
    if (!stmt) {
      stmt = this.db.prepare(sql)
      this.stmts.set(sql, stmt)
    }
    return stmt
  }
  run(sql: string, params: unknown[]): void {
    this.get(sql).run(params)
  }
  lastInsertRowId(): number {
    const stmt = this.get('SELECT last_insert_rowid()')
    try {
      stmt.step()
      return (stmt.get()[0] as number) ?? 0
    } finally {
      stmt.reset()
    }
  }
  freeAll(): void {
    for (const stmt of this.stmts.values()) {
      try { stmt.free() } catch { /* already freed */ }
    }
    this.stmts.clear()
  }
}

/**
 * The Claude Code session a card belongs to — the shared key between the two ways a Claude
 * session is ingested. Claude's OTEL cards are one per interaction (sessionId = interaction
 * spanId) and carry Claude Code's `session.id`; its log cards are one per transcript (or per
 * gap-split segment, `<id>#<n>`), whose lines carry the same id as `sessionId` (and whose file
 * name is that id, for a main transcript). The two never share a session_id, so without this
 * both were stored and every Claude session was counted twice.
 */
export function claudeConversationKey(card: SessionSummaryCard): string | null {
  if (card.source !== 'claude_code') return null
  if (card.claudeSessionId) return card.claudeSessionId
  return card.dataSource === 'log' ? card.sessionId.replace(/#\d+$/, '') : null
}

export class DatabaseWriter {
  private readonly pending = new Map<string, { card: SessionSummaryCard; workspace: string }>()
  private drainPromise: Promise<void> = Promise.resolve()
  private writing = false
  private _generation = 0  // incremented by clearAll() to abort in-flight drains
  private readonly vscodeFs: typeof vscode.workspace.fs
  // sessionId → fingerprint of every value the last complete _writeOnce of that session put in
  // the database (session row, timeline rows, edit rows) — see _writeOnce. The 30 s log tick
  // re-parses a growing transcript whole and hands back every gap-split segment of it, nearly all
  // unchanged; this is what lets those be skipped instead of deleted and reinserted row by row.
  private readonly writtenFingerprints = new Map<string, string>()

  constructor(
    private readonly db: WriteableDb,
    private readonly storageUri: vscode.Uri,
    private readonly log: (msg: string) => void,
    vscodeFs?: typeof vscode.workspace.fs,
  ) {
    this.vscodeFs = vscodeFs ?? vscode.workspace.fs
  }

  /**
   * `workspace` is a fallback (typically the currently-open VS Code folder), not a source of
   * truth — it has no relation to where the session's agent actually ran. Prefer whatever the
   * summarizer already resolved onto `card.workspace` (e.g. a real `cwd` OTEL attribute, or an
   * inferred path from touched files) and only fall back to the VS Code folder when the
   * summarizer came up empty (Copilot's OTEL path always does; Claude's file-path heuristic
   * sometimes does). Previously this unconditionally overwrote `card.workspace`, silently
   * discarding a correct summarizer-derived value in favor of whatever folder happened to be
   * open in that window — the main cause of inconsistent repo names across OTEL sessions.
   */
  enqueue(card: SessionSummaryCard, workspace: string): void {
    // OTEL always wins: if this is a log-sourced card and an OTEL record already
    // exists for the same session, skip it so we never downgrade richer data.
    if (card.dataSource === 'log') {
      try {
        const rows = this.db.exec('SELECT data_source FROM sessions WHERE session_id = ?', [card.sessionId])
        if (rows[0]?.values[0]?.[0] === 'otel') return
        // Same rule for Claude, whose OTEL and log cards are keyed differently — skip a log
        // segment when OTEL interactions of the same conversation fall inside its time range.
        if (this._claudeOtelCovers(card)) return
      } catch { /* non-fatal — proceed to enqueue */ }
    }
    const resolvedWorkspace = card.workspace || workspace
    card.workspace = resolvedWorkspace
    this.pending.set(card.sessionId, { card, workspace: resolvedWorkspace })
    if (!this.writing) {
      this.drainPromise = this._drain()
    }
  }

  /** Removes any synthetic placeholder session (session_id LIKE 'synth-%') for the given traceId. */
  deleteSynthSession(traceId: string): void {
    try {
      this.db.run(
        `DELETE FROM sessions WHERE trace_id = ? AND session_id LIKE 'synth-%'`,
        [traceId],
      )
    } catch { /* ignore — non-fatal */ }
    bumpSessionsVersion(this.db)
  }

  async drain(): Promise<void> {
    return this.drainPromise
  }

  /** Records that `count` hashed traces were just successfully sent to the cloud (one row per
   *  forwarding drain batch — see the Cloud upload sender's `recordSent`, reached via
   *  cloudBridge.ts). Backs the Team panel's transport transparency stats
   *  (`DatabaseReader.queryTraceSendStats`). */
  recordTraceSent(count: number, at: number): void {
    if (count <= 0) return
    this.db.run('INSERT INTO trace_sends (sent_at, count) VALUES (?, ?)', [at, count])
  }

  /**
   * Writes import cards directly in one synchronous transaction, bypassing the
   * async enqueue/drain pipeline. Safe to call while a drain is in progress
   * because _writeOnce always commits its transaction before suspending at an
   * await point, so there is never an open transaction when we enter here.
   */
  importCards(cards: SessionSummaryCard[]): void {
    if (cards.length === 0) return
    const stmts = new StatementCache(this.db)
    this.db.run('BEGIN')
    try {
      for (const card of cards) {
        this.writtenFingerprints.delete(card.sessionId)
        this._writeSessionRow(stmts, card, card.workspace)
      }
      stmts.freeAll()
      this.db.run('COMMIT')
    } catch (err) {
      stmts.freeAll()
      try { this.db.run('ROLLBACK') } catch { /* ignore */ }
      throw err
    } finally {
      bumpSessionsVersion(this.db)
    }
  }

  clearAll(): void {
    // Increment generation so any _drain() currently awaiting _writeOnce() will
    // see the mismatch and abort before writing further sessions to the DB.
    this._generation++
    this.pending.clear()
    this.writtenFingerprints.clear()
    try {
      // Delete order respects FK constraints (child tables first).
      // CASCADE would handle it, but explicit order is clearer.
      this.db.run('DELETE FROM edit_details')
      this.db.run('DELETE FROM timeline_entries')
      this.db.run('DELETE FROM sessions')
    } catch (err) {
      this.log(`DatabaseWriter.clearAll error: ${err}`)
    }
    bumpSessionsVersion(this.db)
  }

  dispose(): void {
    void this.drain()
  }

  private async _drain(): Promise<void> {
    this.writing = true
    const gen = this._generation
    while (this.pending.size > 0) {
      if (this._generation !== gen) break  // clearAll() was called — abort
      const batch = [...this.pending.entries()]
      this.pending.clear()
      for (const [, { card, workspace }] of batch) {
        if (this._generation !== gen) break  // abort between writes too
        await this._writeOnce(card, workspace).catch(err => {
          this.log(`DatabaseWriter write error for session ${card.sessionId}: ${err}`)
        })
      }
    }
    this.writing = false
  }

  /** True when an OTEL row of the same Claude session overlaps this log card's time range. */
  private _claudeOtelCovers(card: SessionSummaryCard): boolean {
    const key = claudeConversationKey(card)
    const startMs = Date.parse(card.startTime)
    if (!key || !startMs) return false
    const endMs = startMs + (card.durationMs || 0)
    const rows = this.db.exec(
      `SELECT 1 FROM sessions
        WHERE conversation_id = ? AND source = 'claude_code' AND data_source = 'otel'
          AND start_time <= ? AND start_time + duration_ms >= ? LIMIT 1`,
      [key, endMs + CLAUDE_OVERLAP_SLACK_MS, startMs - CLAUDE_OVERLAP_SLACK_MS],
    )
    return (rows[0]?.values.length ?? 0) > 0
  }

  /**
   * The reverse of _claudeOtelCovers, for when the log card was stored first: an OTEL Claude
   * interaction replaces the log card(s) of its session whose time range overlaps it. Rows
   * stored before conversation_id existed are matched by transcript id (session_id `<id>`
   * or `<id>#<n>`).
   */
  private _deleteClaudeLogRowsCoveredBy(card: SessionSummaryCard): void {
    const key = claudeConversationKey(card)
    const startMs = Date.parse(card.startTime)
    if (!key || !startMs || card.dataSource !== 'otel') return
    const endMs = startMs + (card.durationMs || 0)
    this.db.run(
      `DELETE FROM sessions
        WHERE source = 'claude_code' AND data_source = 'log'
          AND (conversation_id = ? OR session_id = ? OR session_id LIKE ? ESCAPE '\\')
          AND start_time <= ? AND start_time + duration_ms >= ?`,
      [key, key, key.replace(/[\\%_]/g, m => '\\' + m) + '#%',
        endMs + CLAUDE_OVERLAP_SLACK_MS, startMs - CLAUDE_OVERLAP_SLACK_MS],
    )
  }

  /**
   * An OTEL card is re-summarized from the in-memory span window on every update. If that window
   * ever lost part of a run (the store's hard memory cap), the new card would have fewer calls
   * than the row already stored — never let it replace that richer row.
   */
  private _isDowngradeOfStoredOtelRow(card: SessionSummaryCard): boolean {
    if (card.dataSource !== 'otel') return false
    const rows = this.db.exec(
      `SELECT total_llm_calls + total_tool_calls FROM sessions WHERE session_id = ? AND data_source = 'otel'`,
      [card.sessionId],
    )
    const stored = Number(rows[0]?.values[0]?.[0] ?? -1)
    return stored > card.totalLlmCalls + card.totalToolCalls
  }

  private async _writeOnce(card: SessionSummaryCard, workspace: string): Promise<void> {
    if (this._isDowngradeOfStoredOtelRow(card)) {
      this.log(`DatabaseWriter: kept stored session ${card.sessionId} — incoming card has fewer calls`)
      return
    }
    // Everything the rows below will hold, computed up front: if it's exactly what this writer
    // last wrote for this session, and that row is still there (nothing but this writer rewrites
    // a session's rows; a delete — retention, an OTEL card covering a log row — removes them
    // outright), rewriting would only reproduce the same rows, so skip it. Blob files are
    // write-once per span id, and a fingerprint is only recorded once they were all written.
    const sessionParams = this._sessionRowParams(card, workspace)
    const timelineParams = card.timeline.map((entry, i) => this._timelineEntryParams(card.sessionId, entry, i))
    const editParams = card.timeline.map(entry => entry.editDetails?.map(ed => this._editDetailParams(ed)))
    const fingerprint = crypto.createHash('sha1')
      .update(JSON.stringify([sessionParams, timelineParams, editParams]))
      .digest('base64')
    const unchanged = this.writtenFingerprints.get(card.sessionId) === fingerprint && this._sessionRowExists(card.sessionId)
    this.writtenFingerprints.delete(card.sessionId)

    const stmts = new StatementCache(this.db)
    this.db.run('BEGIN')
    try {
      this._deleteClaudeLogRowsCoveredBy(card)
      if (unchanged) {
        // The one value a rewrite would still have changed: REPLACE re-applies the column default.
        this.db.run(`UPDATE sessions SET created_at = ${CREATED_AT_NOW_SQL} WHERE session_id = ?`, [card.sessionId])
      } else {
        stmts.run(INSERT_SESSION_SQL, sessionParams)
        // Delete-then-reinsert: no stable PK on timeline_entries to upsert against.
        // CASCADE on the FK handles edit_details cleanup.
        this.db.run('DELETE FROM timeline_entries WHERE session_id = ?', [card.sessionId])

        for (let i = 0; i < card.timeline.length; i++) {
          stmts.run(INSERT_TIMELINE_SQL, timelineParams[i])
          const edits = editParams[i]
          if (edits) {
            const entryId = stmts.lastInsertRowId()
            for (const params of edits) {
              stmts.run(INSERT_EDIT_SQL, [entryId, ...params])
            }
          }
        }
      }
      stmts.freeAll()
      this.db.run('COMMIT')
    } catch (err) {
      stmts.freeAll()
      try { this.db.run('ROLLBACK') } catch { /* ignore rollback errors */ }
      throw err
    } finally {
      bumpSessionsVersion(this.db)
    }
    if (unchanged) {
      this.writtenFingerprints.set(card.sessionId, fingerprint)
      return
    }

    // Blob writes are async and intentionally outside the transaction.
    let blobsWritten = true
    for (const entry of card.timeline) {
      if (!await this._writeBlobsForEntry(entry)) blobsWritten = false
    }
    if (blobsWritten) this.writtenFingerprints.set(card.sessionId, fingerprint)
  }

  private _sessionRowExists(sessionId: string): boolean {
    const rows = this.db.exec('SELECT 1 FROM sessions WHERE session_id = ?', [sessionId])
    return (rows[0]?.values.length ?? 0) > 0
  }

  private _writeSessionRow(stmts: StatementCache, card: SessionSummaryCard, workspace: string): void {
    stmts.run(INSERT_SESSION_SQL, this._sessionRowParams(card, workspace))
  }

  private _sessionRowParams(card: SessionSummaryCard, workspace: string): unknown[] {
    const costUsd = this._computeSessionCost(card)
    return [
      card.sessionId,
      card.traceId,
      card.source,
      workspace,
      null,           // project_path — not yet on SessionSummaryCard
      card.model,
      Date.parse(card.startTime) || 0,
      card.durationMs,
      card.turns,
      card.inputTokens,
      card.outputTokens,
      card.cacheReadTokens,
      card.cacheCreateTokens,
      card.cacheHitRate,
      card.totalToolCalls,
      card.totalLlmCalls,
      card.errors,
      card.outcome,
      0,              // is_sidechain — not yet on SessionSummaryCard
      null,           // speed — not yet on SessionSummaryCard
      card.userRequest,
      JSON.stringify(card.toolCounts),
      JSON.stringify(card.loopSignals),
      JSON.stringify(card.filesRead),
      JSON.stringify(card.filesChanged),
      JSON.stringify((card.filesWritten ?? []).slice(0, 50)),
      JSON.stringify(card.filesSearched),
      card.filesChangedNote ?? null,
      costUsd,
      card.dataSource,
      JSON.stringify(card.models ?? (card.model ? [card.model] : [])),
      JSON.stringify(card.oneShotStats ?? {}),
      card.initiator ?? null,
      claudeConversationKey(card),
    ]
  }

  /**
   * Sessions can span more than one model (a Task-tool subagent on a cheaper model,
   * a mid-session /model switch, etc.), and long-context surcharges are per API call —
   * so whenever the timeline carries per-call tokens, each call is priced at its own
   * model (tier included) and summed. Only without per-call data does this fall back to
   * the aggregate totals at flat rates. Shared with the webview via calcSessionCostUsd.
   */
  private _computeSessionCost(card: SessionSummaryCard): number {
    return calcSessionCostUsd(card)
  }

  private _timelineEntryParams(sessionId: string, entry: TimelineEntry, position: number): unknown[] {
    const hasBlob = [entry.responseText, entry.thinking, entry.toolInput, entry.fullResult]
      .some(v => v && v.length >= BLOB_MIN_LENGTH)

    return [
      sessionId,
      entry.spanId,
      position,
      entry.type,
      entry.label,
      entry.model ?? null,
      entry.inputTokens ?? null,
      entry.outputTokens ?? null,
      entry.cacheReadTokens ?? null,
      entry.cacheCreateTokens ?? null,
      entry.ttft ?? null,
      entry.durationMs,
      entry.action ?? null,
      entry.decision ?? null,
      entry.isError ? 1 : 0,
      entry.errorMessage ?? null,
      entry.timestamp,
      hasBlob ? 1 : 0,
    ]
  }

  /** INSERT_EDIT_SQL's parameters after the leading timeline_entry_id. */
  private _editDetailParams(ed: EditDetail): unknown[] {
    const hasBlob = [ed.oldString, ed.newString, ed.content]
      .some(v => v && v.length >= BLOB_MIN_LENGTH)
    return [ed.filePath, ed.toolName ?? null, hasBlob ? 1 : 0]
  }

  /** False when any blob write failed (already logged). */
  private async _writeBlobsForEntry(entry: TimelineEntry): Promise<boolean> {
    let ok = true
    const entryFields: Array<[string | undefined, string]> = [
      [entry.responseText, `${entry.spanId}-response.txt`],
      [entry.thinking,     `${entry.spanId}-thinking.txt`],
      [entry.toolInput,    `${entry.spanId}-tool-input.txt`],
      [entry.fullResult,   `${entry.spanId}-full-result.txt`],
    ]
    for (const [value, filename] of entryFields) {
      if (value && value.length >= BLOB_MIN_LENGTH) {
        if (!await this._writeBlob(filename, value)) ok = false
      }
    }

    if (entry.editDetails) {
      for (let i = 0; i < entry.editDetails.length; i++) {
        const ed = entry.editDetails[i]
        const editId = `${entry.spanId}-${i}`
        const edFields: Array<[string | undefined, string]> = [
          [ed.oldString,              `${editId}-old.txt`],
          [ed.newString ?? ed.content, `${editId}-new.txt`],
        ]
        for (const [value, filename] of edFields) {
          if (value && value.length >= BLOB_MIN_LENGTH) {
            if (!await this._writeBlob(filename, value)) ok = false
          }
        }
      }
    }
    return ok
  }

  /** False when the write failed (logged here). */
  private async _writeBlob(filename: string, content: string): Promise<boolean> {
    const fileUri = vscode.Uri.joinPath(this.storageUri, 'blobs', filename)
    try {
      await this.vscodeFs.stat(fileUri)
      return true  // already exists; span content is immutable
    } catch {
      // file absent — proceed to write
    }
    try {
      await this.vscodeFs.writeFile(fileUri, Buffer.from(content, 'utf8'))
      return true
    } catch (err) {
      this.log(`DatabaseWriter: blob write failed for ${filename}: ${err}`)
      return false
    }
  }
}
