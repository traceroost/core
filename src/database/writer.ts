import * as vscode from 'vscode'
import type { SessionSummaryCard, TimelineEntry, EditDetail } from '../summarizers/summarizerTypes'
import { calcTokenCostUsd } from '../pricing'

// Strings below this length are kept inline in the DB row rather than written to a blob file.
const BLOB_MIN_LENGTH = 512

// Minimal sql.js surface needed for write operations.
interface WriteableDb {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
}

export class DatabaseWriter {
  private readonly pending = new Map<string, { card: SessionSummaryCard; workspace: string }>()
  private drainPromise: Promise<void> = Promise.resolve()
  private writing = false
  private _generation = 0  // incremented by clearAll() to abort in-flight drains
  private readonly vscodeFs: typeof vscode.workspace.fs

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
        const rows = this.db.exec(
          `SELECT data_source FROM sessions WHERE session_id = '${card.sessionId.replace(/'/g, "''")}'`
        )
        if (rows[0]?.values[0]?.[0] === 'otel') return
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
  }

  async drain(): Promise<void> {
    return this.drainPromise
  }

  /**
   * Writes import cards directly in one synchronous transaction, bypassing the
   * async enqueue/drain pipeline. Safe to call while a drain is in progress
   * because _writeOnce always commits its transaction before suspending at an
   * await point, so there is never an open transaction when we enter here.
   */
  importCards(cards: SessionSummaryCard[]): void {
    if (cards.length === 0) return
    this.db.run('BEGIN')
    try {
      for (const card of cards) {
        this._writeSessionRow(card, card.workspace)
      }
      this.db.run('COMMIT')
    } catch (err) {
      try { this.db.run('ROLLBACK') } catch { /* ignore */ }
      throw err
    }
  }

  clearAll(): void {
    // Increment generation so any _drain() currently awaiting _writeOnce() will
    // see the mismatch and abort before writing further sessions to the DB.
    this._generation++
    this.pending.clear()
    try {
      // Delete order respects FK constraints (child tables first).
      // CASCADE would handle it, but explicit order is clearer.
      this.db.run('DELETE FROM edit_details')
      this.db.run('DELETE FROM timeline_entries')
      this.db.run('DELETE FROM sessions')
    } catch (err) {
      this.log(`DatabaseWriter.clearAll error: ${err}`)
    }
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

  private async _writeOnce(card: SessionSummaryCard, workspace: string): Promise<void> {
    this.db.run('BEGIN')
    try {
      this._writeSessionRow(card, workspace)
      // Delete-then-reinsert: no stable PK on timeline_entries to upsert against.
      // CASCADE on the FK handles edit_details cleanup.
      this.db.run('DELETE FROM timeline_entries WHERE session_id = ?', [card.sessionId])

      for (let i = 0; i < card.timeline.length; i++) {
        const entry = card.timeline[i]
        this._writeTimelineEntry(card.sessionId, entry, i)
        const rows = this.db.exec('SELECT last_insert_rowid()')
        const entryId = rows[0]?.values[0]?.[0] as number ?? 0

        if (entry.editDetails) {
          for (const ed of entry.editDetails) {
            this._writeEditDetail(entryId, ed)
          }
        }
      }
      this.db.run('COMMIT')
    } catch (err) {
      try { this.db.run('ROLLBACK') } catch { /* ignore rollback errors */ }
      throw err
    }

    // Blob writes are async and intentionally outside the transaction.
    for (const entry of card.timeline) {
      await this._writeBlobsForEntry(entry)
    }
  }

  private _writeSessionRow(card: SessionSummaryCard, workspace: string): void {
    const costUsd = this._computeSessionCost(card)
    this.db.run(
      `INSERT OR REPLACE INTO sessions (
        session_id, trace_id, source, workspace, project_path, model,
        start_time, duration_ms, turns, input_tokens, output_tokens,
        cache_read_tokens, cache_create_tokens, cache_hit_rate,
        total_tool_calls, total_llm_calls, errors, outcome,
        is_sidechain, speed, user_request, tool_counts, loop_signals,
        files_read, files_changed, files_written, files_searched, files_changed_note, cost_usd,
        data_source, models, one_shot_stats, initiator
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
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
      ]
    )
  }

  /**
   * Sessions can span more than one model (a Task-tool subagent on a cheaper model,
   * a mid-session /model switch, etc.). Pricing the whole session's aggregate tokens
   * at one model's rate silently mis-bills whichever portion ran on a different model.
   * When timeline entries carry more than one distinct model, price each entry at its
   * own model and sum — otherwise this reduces to the old aggregate calculation
   * (also correctly applies Anthropic's >200K tiered surcharge per call rather than
   * to the session's cumulative total).
   */
  private _computeSessionCost(card: SessionSummaryCard): number {
    const llmEntries = card.timeline.filter(e => e.type === 'llm')
    const distinctModels = new Set(llmEntries.map(e => e.model).filter((m): m is string => Boolean(m)))

    if (distinctModels.size <= 1) {
      return calcTokenCostUsd(
        Math.max(0, card.inputTokens - card.cacheReadTokens - card.cacheCreateTokens),
        card.cacheReadTokens,
        card.cacheCreateTokens,
        card.outputTokens,
        card.model,
      )
    }

    return llmEntries.reduce((sum, entry) => {
      const cacheRead = entry.cacheReadTokens ?? 0
      const cacheCreate = entry.cacheCreateTokens ?? 0
      const rawInput = Math.max(0, (entry.inputTokens ?? 0) - cacheRead - cacheCreate)
      return sum + calcTokenCostUsd(rawInput, cacheRead, cacheCreate, entry.outputTokens ?? 0, entry.model || card.model)
    }, 0)
  }

  private _writeTimelineEntry(sessionId: string, entry: TimelineEntry, position: number): void {
    const hasBlob = [entry.responseText, entry.thinking, entry.toolInput, entry.fullResult]
      .some(v => v && v.length >= BLOB_MIN_LENGTH)

    this.db.run(
      `INSERT INTO timeline_entries (
        session_id, span_id, position, type, label, model,
        input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
        ttft, duration_ms, action, decision,
        is_error, error_message, timestamp, has_blob
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
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
    )
  }

  private _writeEditDetail(timelineEntryId: number, ed: EditDetail): void {
    const hasBlob = [ed.oldString, ed.newString, ed.content]
      .some(v => v && v.length >= BLOB_MIN_LENGTH)

    this.db.run(
      `INSERT INTO edit_details (timeline_entry_id, file_path, tool_name, has_blob)
       VALUES (?,?,?,?)`,
      [timelineEntryId, ed.filePath, ed.toolName ?? null, hasBlob ? 1 : 0]
    )
  }

  private async _writeBlobsForEntry(entry: TimelineEntry): Promise<void> {
    const entryFields: Array<[string | undefined, string]> = [
      [entry.responseText, `${entry.spanId}-response.txt`],
      [entry.thinking,     `${entry.spanId}-thinking.txt`],
      [entry.toolInput,    `${entry.spanId}-tool-input.txt`],
      [entry.fullResult,   `${entry.spanId}-full-result.txt`],
    ]
    for (const [value, filename] of entryFields) {
      if (value && value.length >= BLOB_MIN_LENGTH) {
        await this._writeBlob(filename, value)
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
            await this._writeBlob(filename, value)
          }
        }
      }
    }
  }

  private async _writeBlob(filename: string, content: string): Promise<void> {
    const fileUri = vscode.Uri.joinPath(this.storageUri, 'blobs', filename)
    try {
      await this.vscodeFs.stat(fileUri)
      return  // already exists; span content is immutable
    } catch {
      // file absent — proceed to write
    }
    try {
      await this.vscodeFs.writeFile(fileUri, Buffer.from(content, 'utf8'))
    } catch (err) {
      this.log(`DatabaseWriter: blob write failed for ${filename}: ${err}`)
    }
  }
}
