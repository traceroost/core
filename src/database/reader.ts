import * as path from 'path'
import * as fs from 'fs'
import * as vscode from 'vscode'
import type { SessionSummaryCard, TimelineEntry, EditDetail } from '../summarizers/summarizerTypes'
import type { OneShotStats } from '../oneShotRate'
import { lookupRates, calcAggregateTokenCostUsd } from '../pricing'
import { sessionsVersion } from './sessionsVersion'
import { toUuid } from '../traceIdentity'
import { isSessionLanguage, languageFromRecord, type SessionLanguage, type SecondaryLanguage } from '../language'

/** Stored change-size counts — only non-negative integers come back; NULL (an older row, or a
 *  source with no edit contents) stays absent. */
function readEditStats(files: unknown, added: unknown, removed: unknown): { filesChangedCount?: number; linesAdded?: number; linesRemoved?: number } {
  const n = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
  const out: { filesChangedCount?: number; linesAdded?: number; linesRemoved?: number } = {}
  if (n(files) !== undefined) out.filesChangedCount = n(files)
  if (n(added) !== undefined) out.linesAdded = n(added)
  if (n(removed) !== undefined) out.linesRemoved = n(removed)
  return out
}

/** The stored language pair, validated against the allowlist — an absent (pre-language row) or
 *  unrecognised value reads as unknown (undefined), never as a free-text label. */
function readConversation(v: unknown): { conversationId?: string } {
  return typeof v === 'string' && v ? { conversationId: v } : {}
}

/** The stable-trace-identity columns (staged feature 11) — absent ones stay off the card. */
function readIdentity(derived: unknown, rank: unknown, subagents: unknown): Pick<SessionSummaryCard, 'derived' | 'sourceRank' | 'subagentCount'> {
  const out: Pick<SessionSummaryCard, 'derived' | 'sourceRank' | 'subagentCount'> = {}
  if (derived === 1) out.derived = true
  if (typeof rank === 'number' && rank > 0) out.sourceRank = rank
  if (typeof subagents === 'number' && subagents > 0) out.subagentCount = subagents
  return out
}

/** A row stored as `none` predates the non-code categories (docs, config, …) and is re-derived from
 *  its own file lists, so a trace whose log is gone is still categorised (see src/language.ts). */
function readLanguage(primary: unknown, secondary: unknown, files: () => { filesRead: string[]; filesChanged: string[] }): { language?: SessionLanguage; languageSecondary?: SecondaryLanguage | null } {
  if (!isSessionLanguage(primary)) return {}
  return languageFromRecord({ language: primary, languageSecondary: secondary }, primary === 'none' ? files() : {})
}

export interface DailyStatRow {
  day: string              // 'YYYY-MM-DD'
  totalTokens: number      // input + output (excludes cache tokens)
  cacheReadTokens: number
  cacheCreateTokens: number
  outputTokens: number
  costUsd: number
  sessionCount: number
}

export interface LifetimeStats {
  totalSessions: number
  totalTokens: number
  totalCostUsd: number
  oldestSessionMs: number
  newestSessionMs: number
}

/** Transport transparency stats for the Team panel — how many hashed traces this machine has
 *  actually sent, over a few windows. Sourced from `trace_sends` (see schema.ts). */
export interface TraceSendStats {
  last5Min: number
  lastHour: number
  allTime: number
}

export interface SearchQuery {
  text?: string
  source?: string
  model?: string
  since?: number
  until?: number
  minCostUsd?: number
  orderBy?: 'start_time' | 'cost_usd' | 'total_tokens' | 'duration_ms' | 'errors'
  orderDir?: 'ASC' | 'DESC'
  limit?: number
  offset?: number
}

export interface BurnRate {
  tokensPerMinute: number
  costPerHour: number
}

export interface Projection {
  totalTokens: number
  totalCostUsd: number
  remainingMinutes: number
  contextFillPct: number
}

interface ReadableDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
}

export class DatabaseReader {
  constructor(
    private readonly db: ReadableDb,
    private readonly storageUri: vscode.Uri,
  ) {}

  /** Changes whenever the `sessions` table this reader reads is written (see sessionsVersion.ts). */
  sessionsVersion(): number {
    return sessionsVersion(this.db)
  }

  // ── Stable trace identity (staged feature 11) ────────────────────────────────

  /** The wire keys (`session_id` as sent — toUuid of the local id, an identity for every minted
   *  key) of the traces this install holds that started in [fromMs, toMs], synthesized in-progress
   *  roots left out. The hook a trace-key
   *  manifest (feature 11 step 5) builds on — see traceIdentity.ts's traceKeysInWindow for the
   *  same over in-memory cards (the standalone server). */
  listTraceKeys(fromMs: number, toMs: number): string[] {
    const rows = this.db.exec(
      `SELECT session_id FROM sessions
        WHERE start_time >= ${Math.floor(fromMs)} AND start_time <= ${Math.floor(toMs)}
          AND session_id NOT LIKE 'synth-%'
        ORDER BY start_time ASC`,
    )
    return [...new Set((rows[0]?.values ?? []).map(r => toUuid(String(r[0]))))]
  }

  /** How many traces this install holds that started in [fromMs, toMs] — synthesized rows
   *  included — so 0 means it positively holds none there (the trace manifest's `confirm_empty`). */
  countTraces(fromMs: number, toMs: number): number {
    const rows = this.db.exec(
      `SELECT COUNT(*) FROM sessions
        WHERE start_time >= ${Math.floor(fromMs)} AND start_time <= ${Math.floor(toMs)}`,
    )
    return Number(rows[0]?.values[0]?.[0] ?? 0)
  }

  /** Start time of the oldest trace this install still holds evidence for (epoch ms), or null
   *  with none — the manifest window's lower bound (feature 11's localHorizon). */
  localHorizonMs(): number | null {
    const rows = this.db.exec(`SELECT MIN(start_time) FROM sessions WHERE start_time > 0 AND session_id NOT LIKE 'synth-%'`)
    const v = rows[0]?.values[0]?.[0]
    return typeof v === 'number' ? v : null
  }

  listSessions(filter?: {
    source?: 'copilot' | 'claude_code' | 'codex' | 'opencode' | 'cursor'
    since?: number
    limit?: number
  }): SessionSummaryCard[] {
    let sql = 'SELECT * FROM sessions'
    const conditions: string[] = ["session_id NOT LIKE 'synth-%'"]

    if (filter?.source) {
      conditions.push(`source = '${filter.source}'`)
    }
    if (filter?.since !== null && filter?.since !== undefined) {
      conditions.push(`start_time >= ${filter.since}`)
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ')
    }
    sql += ' ORDER BY start_time DESC'
    // `limit: Infinity` (sessionRepository.ts's "bypass the cap" convention, used by org reconcile
    // to see every retained session) means "no LIMIT clause" — `LIMIT Infinity` isn't valid SQL;
    // SQLite parses the bare word as an unresolved column reference ("no such column: Infinity").
    if (filter?.limit !== null && filter?.limit !== undefined && Number.isFinite(filter.limit)) {
      sql += ` LIMIT ${Math.max(0, Math.floor(filter.limit))}`
    }

    const results = this.db.exec(sql)
    if (!results[0]) return []

    const { columns, values } = results[0]
    const col = (row: unknown[], name: string) => row[columns.indexOf(name)]

    return values.map(row => {
      const startMs = col(row, 'start_time') as number
      return {
        sessionId:        col(row, 'session_id') as string,
        traceId:          col(row, 'trace_id') as string,
        source:           col(row, 'source') as 'copilot' | 'claude_code' | 'codex' | 'opencode' | 'cursor',
        dataSource:       ((col(row, 'data_source') as string | null) ?? 'otel') as 'otel' | 'log',
        workspace:        (col(row, 'workspace') as string) ?? '',
        projectPath:      (col(row, 'project_path') as string | null) ?? undefined,
        userRequest:      (col(row, 'user_request') as string) ?? '',
        model:            (col(row, 'model') as string) ?? '',
        models:           this._parseJson<string[]>(col(row, 'models') as string, []),
        turns:            (col(row, 'turns') as number) ?? 0,
        inputTokens:      (col(row, 'input_tokens') as number) ?? 0,
        outputTokens:     (col(row, 'output_tokens') as number) ?? 0,
        cacheReadTokens:  (col(row, 'cache_read_tokens') as number) ?? 0,
        cacheCreateTokens:(col(row, 'cache_create_tokens') as number) ?? 0,
        cacheHitRate:     (col(row, 'cache_hit_rate') as number) ?? 0,
        durationMs:       (col(row, 'duration_ms') as number) ?? 0,
        startTime:        startMs > 0 ? new Date(startMs).toISOString() : '',
        filesRead:        this._parseJson<string[]>(col(row, 'files_read') as string, []),
        filesSearched:    this._parseJson<string[]>(col(row, 'files_searched') as string, []),
        filesChanged:     this._parseJson<string[]>(col(row, 'files_changed') as string, []),
        filesWritten:     this._parseJson<string[]>(col(row, 'files_written') as string, []),
        filesChangedNote: (col(row, 'files_changed_note') as string | null) ?? undefined,
        toolCounts:       this._parseJson<Record<string, number>>(col(row, 'tool_counts') as string, {}),
        totalToolCalls:   (col(row, 'total_tool_calls') as number) ?? 0,
        totalLlmCalls:    (col(row, 'total_llm_calls') as number) ?? 0,
        errors:           (col(row, 'errors') as number) ?? 0,
        outcome:          (col(row, 'outcome') as 'text_response' | 'tool_calls' | 'unknown') ?? 'unknown',
        loopSignals:      this._parseJson(col(row, 'loop_signals') as string, []),
        oneShotStats:     this._parseJson<OneShotStats | undefined>(col(row, 'one_shot_stats') as string, undefined),
        initiator:        (col(row, 'initiator') as 'user' | 'agent' | 'api' | null) ?? undefined,
        ...readLanguage(col(row, 'language'), col(row, 'language_secondary'), () => ({
          filesRead: this._parseJson<string[]>(col(row, 'files_read') as string, []),
          filesChanged: this._parseJson<string[]>(col(row, 'files_changed') as string, []),
        })),
        ...readEditStats(col(row, 'files_changed_count'), col(row, 'lines_added'), col(row, 'lines_removed')),
        ...readIdentity(col(row, 'derived'), col(row, 'source_rank'), col(row, 'subagent_count')),
        ...readConversation(col(row, 'conversation_id')),
        timeline:         [],
        backgroundSpans:  [],
      } satisfies SessionSummaryCard
    })
  }

  loadSessionTimeline(sessionId: string): TimelineEntry[] {
    const entryResults = this.db.exec(
      `SELECT * FROM timeline_entries WHERE session_id = '${this._esc(sessionId)}' ORDER BY position ASC`
    )
    if (!entryResults[0]) return []

    const { columns: ec, values: ev } = entryResults[0]
    const ecol = (row: unknown[], name: string) => row[ec.indexOf(name)]

    const entryIds: number[] = []
    const entries: TimelineEntry[] = ev.map(row => {
      const id = ecol(row, 'id') as number
      entryIds.push(id)
      return {
        type:         ecol(row, 'type') as TimelineEntry['type'],
        spanId:       ecol(row, 'span_id') as string,
        label:        (ecol(row, 'label') as string) ?? '',
        model:        (ecol(row, 'model') as string | null) ?? undefined,
        inputTokens:       (ecol(row, 'input_tokens') as number | null) ?? undefined,
        outputTokens:      (ecol(row, 'output_tokens') as number | null) ?? undefined,
        cacheReadTokens:   (ecol(row, 'cache_read_tokens') as number | null) ?? undefined,
        cacheCreateTokens: (ecol(row, 'cache_create_tokens') as number | null) ?? undefined,
        ttft:         (ecol(row, 'ttft') as number | null) ?? undefined,
        durationMs:   (ecol(row, 'duration_ms') as number) ?? 0,
        action:       (ecol(row, 'action') as string | null) ?? undefined,
        decision:     (ecol(row, 'decision') as string | null) ?? undefined,
        isError:      ((ecol(row, 'is_error') as number) ?? 0) === 1,
        errorMessage: (ecol(row, 'error_message') as string | null) ?? undefined,
        timestamp:    (ecol(row, 'timestamp') as string) ?? '',
      } satisfies TimelineEntry
    })

    if (entryIds.length === 0) return entries

    // Load edit_details for all entries in one query using IN clause.
    const idList = entryIds.join(',')
    const editResults = this.db.exec(
      `SELECT * FROM edit_details WHERE timeline_entry_id IN (${idList}) ORDER BY timeline_entry_id, id ASC`
    )

    if (editResults[0]) {
      const { columns: dc, values: dv } = editResults[0]
      const dcol = (row: unknown[], name: string) => row[dc.indexOf(name)]

      const editsByEntry = new Map<number, EditDetail[]>()
      for (const row of dv) {
        const entryId = dcol(row, 'timeline_entry_id') as number
        if (!editsByEntry.has(entryId)) editsByEntry.set(entryId, [])
        editsByEntry.get(entryId)!.push({
          filePath: (dcol(row, 'file_path') as string) ?? '',
          toolName: (dcol(row, 'tool_name') as string | null) ?? undefined,
          // Blob string fields (oldString, newString) are omitted here — loaded via loadBlob.
        })
      }

      for (let i = 0; i < entries.length; i++) {
        const edits = editsByEntry.get(entryIds[i])
        if (edits) entries[i].editDetails = edits
      }
    }

    return entries
  }

  async loadBlob(
    spanId: string,
    field: 'response' | 'thinking' | 'tool-input' | 'full-result' | 'edit-old' | 'edit-new',
    editIndex?: number,
  ): Promise<string | null> {
    const filename = this._blobFilename(spanId, field, editIndex)
    const fileUri = vscode.Uri.joinPath(this.storageUri, 'blobs', filename)
    try {
      const data = await vscode.workspace.fs.readFile(fileUri)
      return Buffer.from(data).toString('utf8')
    } catch {
      return null
    }
  }

  queryDailyStats(options: { since: number; source?: string }): DailyStatRow[] {
    const sourceParam = options.source ?? null
    const sql = `
      SELECT
        date(start_time / 1000, 'unixepoch') AS day,
        SUM(input_tokens)        AS total_tokens,
        SUM(cache_read_tokens)   AS cache_read_tokens,
        SUM(cache_create_tokens) AS cache_create_tokens,
        SUM(output_tokens)       AS output_tokens,
        SUM(cost_usd)            AS cost_usd,
        COUNT(*)                 AS session_count
      FROM sessions
      WHERE start_time > ${options.since}
        AND is_sidechain = 0
        ${sourceParam !== null ? `AND source = '${this._esc(sourceParam)}'` : ''}
      GROUP BY day
      ORDER BY day ASC`

    const results = this.db.exec(sql)
    if (!results[0]) return []
    const { columns, values } = results[0]
    const col = (row: unknown[], name: string) => row[columns.indexOf(name)]
    return values.map(row => ({
      day:               col(row, 'day') as string,
      totalTokens:       (col(row, 'total_tokens') as number) ?? 0,
      cacheReadTokens:   (col(row, 'cache_read_tokens') as number) ?? 0,
      cacheCreateTokens: (col(row, 'cache_create_tokens') as number) ?? 0,
      outputTokens:      (col(row, 'output_tokens') as number) ?? 0,
      costUsd:           (col(row, 'cost_usd') as number) ?? 0,
      sessionCount:      (col(row, 'session_count') as number) ?? 0,
    }))
  }

  /** Returns hourly token + cost stats. `day` is 'YYYY-MM-DD HH' (UTC). */
  queryHourlyStats(options: { since: number; source?: string }): DailyStatRow[] {
    const sourceParam = options.source ?? null
    const sql = `
      SELECT
        strftime('%Y-%m-%d %H', start_time / 1000, 'unixepoch') AS day,
        SUM(input_tokens)        AS total_tokens,
        SUM(cache_read_tokens)   AS cache_read_tokens,
        SUM(cache_create_tokens) AS cache_create_tokens,
        SUM(output_tokens)       AS output_tokens,
        SUM(cost_usd)            AS cost_usd,
        COUNT(*)                 AS session_count
      FROM sessions
      WHERE start_time > ${options.since}
        AND is_sidechain = 0
        ${sourceParam !== null ? `AND source = '${this._esc(sourceParam)}'` : ''}
      GROUP BY day
      ORDER BY day ASC`

    const results = this.db.exec(sql)
    if (!results[0]) return []
    const { columns, values } = results[0]
    const col = (row: unknown[], name: string) => row[columns.indexOf(name)]
    return values.map(row => ({
      day:               col(row, 'day') as string,
      totalTokens:       (col(row, 'total_tokens') as number) ?? 0,
      cacheReadTokens:   (col(row, 'cache_read_tokens') as number) ?? 0,
      cacheCreateTokens: (col(row, 'cache_create_tokens') as number) ?? 0,
      outputTokens:      (col(row, 'output_tokens') as number) ?? 0,
      costUsd:           (col(row, 'cost_usd') as number) ?? 0,
      sessionCount:      (col(row, 'session_count') as number) ?? 0,
    }))
  }

  queryLifetimeStats(): LifetimeStats {
    const results = this.db.exec(`
      SELECT
        COUNT(*)         AS total_sessions,
        SUM(input_tokens + output_tokens) AS total_tokens,
        SUM(cost_usd)    AS total_cost_usd,
        MIN(start_time)  AS oldest_ms,
        MAX(start_time)  AS newest_ms
      FROM sessions
      WHERE is_sidechain = 0`)
    if (!results[0]?.values[0]) {
      return { totalSessions: 0, totalTokens: 0, totalCostUsd: 0, oldestSessionMs: 0, newestSessionMs: 0 }
    }
    const { columns, values } = results[0]
    const row = values[0]
    const col = (name: string) => row[columns.indexOf(name)]
    return {
      totalSessions:  (col('total_sessions') as number) ?? 0,
      totalTokens:    (col('total_tokens') as number) ?? 0,
      totalCostUsd:   (col('total_cost_usd') as number) ?? 0,
      oldestSessionMs:(col('oldest_ms') as number) ?? 0,
      newestSessionMs:(col('newest_ms') as number) ?? 0,
    }
  }

  /** Windowed + lifetime counts of hashed traces this machine has sent to the cloud, as of `now`.
   *  One row in `trace_sends` per drain batch, not per trace, so this sums `count` rather than
   *  counting rows. */
  queryTraceSendStats(now: number): TraceSendStats {
    const sumSince = (since: number): number => {
      const rows = this.db.exec(`SELECT COALESCE(SUM(count), 0) AS total FROM trace_sends WHERE sent_at >= ${since}`)
      return (rows[0]?.values[0]?.[0] as number) ?? 0
    }
    return {
      last5Min: sumSince(now - 5 * 60_000),
      lastHour: sumSince(now - 60 * 60_000),
      allTime:  sumSince(0),
    }
  }

  searchSessions(query: SearchQuery): { sessions: SessionSummaryCard[]; totalCount: number } {
    const conditions: string[] = ['is_sidechain = 0', "session_id NOT LIKE 'synth-%'"]
    // Matches prompt text, or a raw trace/session id pasted into the same box — the normalized
    // display hash (formatTraceIdHash, media/src/hash.ts) can't be matched here since it's a
    // pure client-side hash of whichever raw id a trace has; the webview's own client-side
    // filter (state.ts) is what handles that case for the interactive trace list.
    // The query arrives from the webview — every value is coerced before it reaches the SQL text:
    // strings are quote-escaped (and LIKE wildcards made literal), numbers must be finite.
    const finite = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    if (query.text) {
      const t = this._esc(String(query.text)).replace(/[\\%_]/g, c => '\\' + c)
      conditions.push(`(user_request LIKE '%${t}%' ESCAPE '\\' OR session_id LIKE '%${t}%' ESCAPE '\\' OR trace_id LIKE '%${t}%' ESCAPE '\\')`)
    }
    if (query.source)      conditions.push(`source = '${this._esc(String(query.source))}'`)
    if (query.model)       conditions.push(`model = '${this._esc(String(query.model))}'`)
    const since = finite(query.since)
    const until = finite(query.until)
    const minCostUsd = finite(query.minCostUsd)
    if (since !== null) conditions.push(`start_time >= ${since}`)
    if (until !== null) conditions.push(`start_time <= ${until}`)
    if (minCostUsd !== null) conditions.push(`cost_usd >= ${minCostUsd}`)

    const where = 'WHERE ' + conditions.join(' AND ')
    const allowedOrder = new Set(['start_time', 'cost_usd', 'total_tokens', 'duration_ms', 'errors'])
    const orderCol = (query.orderBy && allowedOrder.has(query.orderBy)) ? query.orderBy : 'start_time'
    // total_tokens is not a real column — compute it inline
    const orderExpr = orderCol === 'total_tokens' ? '(input_tokens + output_tokens)' : orderCol
    const dir = query.orderDir === 'ASC' ? 'ASC' : 'DESC'
    const limit = Math.min(Math.max(Math.trunc(finite(query.limit) ?? 50), 0), 10_000)
    const offset = Math.max(Math.trunc(finite(query.offset) ?? 0), 0)

    const countResults = this.db.exec(`SELECT COUNT(*) AS n FROM sessions ${where}`)
    const totalCount = (countResults[0]?.values[0]?.[0] as number) ?? 0

    const dataResults = this.db.exec(
      `SELECT * FROM sessions ${where} ORDER BY ${orderExpr} ${dir} LIMIT ${limit} OFFSET ${offset}`
    )
    if (!dataResults[0]) return { sessions: [], totalCount }

    const { columns, values } = dataResults[0]
    const col = (row: unknown[], name: string) => row[columns.indexOf(name)]
    const sessions = values.map(row => {
      const startMs = col(row, 'start_time') as number
      return {
        sessionId:        col(row, 'session_id') as string,
        traceId:          col(row, 'trace_id') as string,
        source:           col(row, 'source') as 'copilot' | 'claude_code' | 'codex' | 'opencode' | 'cursor',
        dataSource:       ((col(row, 'data_source') as string | null) ?? 'otel') as 'otel' | 'log',
        workspace:        (col(row, 'workspace') as string) ?? '',
        projectPath:      (col(row, 'project_path') as string | null) ?? undefined,
        userRequest:      (col(row, 'user_request') as string) ?? '',
        model:            (col(row, 'model') as string) ?? '',
        models:           this._parseJson<string[]>(col(row, 'models') as string, []),
        turns:            (col(row, 'turns') as number) ?? 0,
        inputTokens:      (col(row, 'input_tokens') as number) ?? 0,
        outputTokens:     (col(row, 'output_tokens') as number) ?? 0,
        cacheReadTokens:  (col(row, 'cache_read_tokens') as number) ?? 0,
        cacheCreateTokens:(col(row, 'cache_create_tokens') as number) ?? 0,
        cacheHitRate:     (col(row, 'cache_hit_rate') as number) ?? 0,
        durationMs:       (col(row, 'duration_ms') as number) ?? 0,
        startTime:        startMs > 0 ? new Date(startMs).toISOString() : '',
        filesRead:        this._parseJson<string[]>(col(row, 'files_read') as string, []),
        filesSearched:    this._parseJson<string[]>(col(row, 'files_searched') as string, []),
        filesChanged:     this._parseJson<string[]>(col(row, 'files_changed') as string, []),
        filesWritten:     this._parseJson<string[]>(col(row, 'files_written') as string, []),
        filesChangedNote: (col(row, 'files_changed_note') as string | null) ?? undefined,
        toolCounts:       this._parseJson<Record<string, number>>(col(row, 'tool_counts') as string, {}),
        totalToolCalls:   (col(row, 'total_tool_calls') as number) ?? 0,
        totalLlmCalls:    (col(row, 'total_llm_calls') as number) ?? 0,
        errors:           (col(row, 'errors') as number) ?? 0,
        outcome:          (col(row, 'outcome') as 'text_response' | 'tool_calls' | 'unknown') ?? 'unknown',
        loopSignals:      this._parseJson(col(row, 'loop_signals') as string, []),
        oneShotStats:     this._parseJson<OneShotStats | undefined>(col(row, 'one_shot_stats') as string, undefined),
        initiator:        (col(row, 'initiator') as 'user' | 'agent' | 'api' | null) ?? undefined,
        ...readLanguage(col(row, 'language'), col(row, 'language_secondary'), () => ({
          filesRead: this._parseJson<string[]>(col(row, 'files_read') as string, []),
          filesChanged: this._parseJson<string[]>(col(row, 'files_changed') as string, []),
        })),
        ...readEditStats(col(row, 'files_changed_count'), col(row, 'lines_added'), col(row, 'lines_removed')),
        ...readIdentity(col(row, 'derived'), col(row, 'source_rank'), col(row, 'subagent_count')),
        ...readConversation(col(row, 'conversation_id')),
        timeline:         [],
        backgroundSpans:  [],
      } satisfies SessionSummaryCard
    })
    return { sessions, totalCount }
  }

  queryBurnRate(sessionId: string): { burnRate: BurnRate; projection: Projection | null } | null {
    const results = this.db.exec(
      `SELECT te.timestamp, te.input_tokens, te.output_tokens,
              s.model, s.input_tokens AS session_input, s.output_tokens AS session_output,
              s.cache_read_tokens AS session_cache_read, s.cache_create_tokens AS session_cache_create
       FROM timeline_entries te
       JOIN sessions s ON s.session_id = te.session_id
       WHERE te.session_id = '${this._esc(sessionId)}'
         AND te.type = 'llm'
         AND te.timestamp != ''
       ORDER BY te.position ASC`
    )
    if (!results[0] || results[0].values.length < 2) return null

    const { columns, values } = results[0]
    const col = (row: unknown[], name: string) => row[columns.indexOf(name)]

    const firstTs = Date.parse(col(values[0], 'timestamp') as string)
    const lastTs  = Date.parse(col(values[values.length - 1], 'timestamp') as string)
    if (isNaN(firstTs) || isNaN(lastTs) || lastTs <= firstTs) return null

    const elapsedMinutes = (lastTs - firstTs) / 60_000
    const totalTokens = values.reduce((sum, row) => {
      return sum + ((col(row, 'input_tokens') as number) ?? 0) + ((col(row, 'output_tokens') as number) ?? 0)
    }, 0)
    const tokensPerMinute = totalTokens / elapsedMinutes

    const lastRow = values[values.length - 1]
    const model = (col(lastRow, 'model') as string) ?? ''
    const sessionInput       = (col(lastRow, 'session_input') as number) ?? 0
    const sessionOutput      = (col(lastRow, 'session_output') as number) ?? 0
    const sessionCacheRead   = (col(lastRow, 'session_cache_read') as number) ?? 0
    const sessionCacheCreate = (col(lastRow, 'session_cache_create') as number) ?? 0

    const sessionRawInput    = Math.max(0, sessionInput - sessionCacheRead - sessionCacheCreate)
    const sessionTotalTokens = sessionInput + sessionOutput
    const costPerToken = sessionTotalTokens > 0
      ? calcAggregateTokenCostUsd(sessionRawInput, sessionCacheRead, sessionCacheCreate, sessionOutput, model) / sessionTotalTokens
      : 0
    const costPerHour = tokensPerMinute * 60 * costPerToken

    const burnRate: BurnRate = { tokensPerMinute, costPerHour }

    const rates = lookupRates(model)
    if (!rates || rates.contextWindowTokens === 0 || tokensPerMinute === 0) {
      return { burnRate, projection: null }
    }

    const remainingTokens = Math.max(0, rates.contextWindowTokens - sessionTotalTokens)
    const remainingMinutes = remainingTokens / tokensPerMinute
    const projectedTotal = sessionTotalTokens + remainingTokens
    const scale = projectedTotal / sessionTotalTokens
    const projectedCost  = calcAggregateTokenCostUsd(
      Math.round(sessionRawInput    * scale),
      Math.round(sessionCacheRead   * scale),
      Math.round(sessionCacheCreate * scale),
      Math.round(sessionOutput      * scale),
      model,
    )
    const projection: Projection = {
      totalTokens:    projectedTotal,
      totalCostUsd:   projectedCost,
      remainingMinutes,
      contextFillPct: Math.min(100, (sessionTotalTokens / rates.contextWindowTokens) * 100),
    }
    return { burnRate, projection }
  }

  private _blobFilename(spanId: string, field: string, editIndex?: number): string {
    if (field === 'edit-old') return `${spanId}-${editIndex ?? 0}-old.txt`
    if (field === 'edit-new') return `${spanId}-${editIndex ?? 0}-new.txt`
    const suffixMap: Record<string, string> = {
      'response': 'response.txt',
      'thinking': 'thinking.txt',
      'tool-input': 'tool-input.txt',
      'full-result': 'full-result.txt',
    }
    return `${spanId}-${suffixMap[field] ?? field}`
  }

  private _parseJson<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback
    try { return JSON.parse(raw) as T } catch { return fallback }
  }

  private _esc(s: string): string {
    return s.replace(/'/g, "''")
  }
}

/**
 * Opens the DB file at storagePath using a fresh fs.readFileSync snapshot.
 * Used by non-collector windows for cross-window sync — safe for concurrent reads
 * since sql.js loads the entire file into memory.
 */
export function openReadonlySnapshot(
  storagePath: string,
  storageUri: vscode.Uri,
  extensionPath: string,
  sqlFactory?: { Database: new (data?: Buffer | Uint8Array) => unknown },
): DatabaseReader | null {
  const dbPath = path.join(storagePath, 'traceroost.db')
  try {
    // dist/sql-wasm.js exports the async initSqlJs() factory, not an initialized module, so
    // `new SQL.Database` on it always threw and this snapshot never opened. Callers pass the
    // already-initialized factory from openDatabase() (TraceRoostDb.sqlFactory).
    if (!sqlFactory) throw new Error(`sql.js is not initialized (${extensionPath})`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SQL = sqlFactory as any
    const fileBuffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(fileBuffer)
    return new DatabaseReader(db, storageUri)
  } catch (e) {
    console.warn('[TraceRoost] Could not open database:', e)
    return null
  }
}
