/**
 * One-time local re-key for stable trace identity (staged feature 11 — see traceIdentity.ts).
 *
 * Before it, a stored trace's id was whatever the source happened to name it: a Claude OTEL
 * interaction's span id, a Codex OTEL prompt span id, a transcript's file name (`<id>` or the n-th
 * 30-minute-gap segment `<id>#n`). This moves every row it can onto its canonical key, from the
 * evidence already stored on the row:
 *
 *   - Claude OTEL rows: Claude Code's session id (conversation_id) + start time → the transcript
 *     join (claudeTurnJoin.ts) → the turn's key; no transcript left → the derived interaction key
 *     `claude:interaction:<session.id>:<start ms>`, marked derived. Both are computable from the
 *     row, so every such row is re-keyed.
 *   - Codex OTEL rows: the turn id in trace_id (`codex:<thread>:<turn>`) → traceKey('codex', turn).
 *   - Copilot OTEL rows and Codex rows with no turn id keep their own exact OTEL key: unchanged.
 *   - Log rows can't be split into turns from the row alone. They are marked `legacy` here; the
 *     log reader re-reads every transcript once (LOG_FILE_STATE_VERSION 3) and each per-turn card
 *     retires the legacy row it replaces and aliases its id (DatabaseWriter._retireSuperseded).
 *     Whatever is still `legacy` afterwards had no transcript left to re-read and keeps its id.
 *
 * Every re-keyed row's old id — and that id's wire uuid, which is what the cloud holds — is
 * aliased to its new key (trace_aliases), so deep links to an old id still resolve. Per-session
 * caches move with the row (timeline, git outcome and its cache key, plan-limit rows);
 * trace_revision stays under the old wire id, which is the cloud row it describes.
 *
 * Idempotent and safe to interrupt: it runs in one transaction and records itself in
 * trace_key_migration; the database file is only written by a later save, so an interrupted run
 * leaves the file as it was and simply runs again. Re-running over migrated rows is a no-op —
 * they already carry minted keys.
 */

import { ClaudeTurnJoiner } from '../claudeTurnJoin'
import { traceKey, toUuid, isMintedKey, sourceRankOf } from '../traceIdentity'
import { bumpSessionsVersion } from './sessionsVersion'

interface Db {
  run(sql: string, params?: unknown[]): void
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>
}

export const TRACE_KEY_MIGRATION_VERSION = 1

export interface TraceKeyMigrationResult {
  rekeyed: number
  derived: number
  legacy: number
}

const CODEX_TURN_RE = /^codex:[^:]+:(.+)$/

export function migrateTraceKeys(
  db: Db,
  opts: { findTranscripts?: (claudeSessionId: string) => string[] } = {},
): TraceKeyMigrationResult | null {
  const done = db.exec('SELECT version FROM trace_key_migration WHERE id = 1')
  if (Number(done[0]?.values[0]?.[0] ?? 0) >= TRACE_KEY_MIGRATION_VERSION) return null

  const result: TraceKeyMigrationResult = { rekeyed: 0, derived: 0, legacy: 0 }
  // Hold 0: nothing more will be written to these transcripts for a stored interaction.
  const joiner = new ClaudeTurnJoiner({ findTranscripts: opts.findTranscripts, holdMs: 0 })
  db.run('BEGIN')
  try {
    const rows = db.exec(
      `SELECT session_id, trace_id, source, data_source, conversation_id, start_time FROM sessions
        WHERE session_id NOT LIKE 'synth-%' ORDER BY start_time ASC`,
    )
    for (const [sessionId, traceId, source, dataSource, conversationId, startTime] of (rows[0]?.values ?? []) as
      Array<[string, string, string, string, string | null, number]>) {
      if (isMintedKey(sessionId)) continue
      if (dataSource === 'log') {
        db.run('UPDATE sessions SET legacy = 1 WHERE session_id = ?', [sessionId])
        result.legacy++
        continue
      }
      let newId = ''
      let derived = false
      if (source === 'claude_code') {
        if (!conversationId || !(startTime > 0)) {
          db.run('UPDATE sessions SET legacy = 1 WHERE session_id = ?', [sessionId])
          result.legacy++
          continue
        }
        const joined = joiner.resolve({ interactionId: sessionId, claudeSessionId: conversationId, startMs: startTime })
        if (joined.status === 'pending') continue
        newId = joined.key
        derived = joined.status === 'derived' || joined.derived
      } else if (source === 'codex') {
        const m = CODEX_TURN_RE.exec(traceId ?? '')
        if (!m || m[1].startsWith('prompt-')) continue
        newId = traceKey('codex', m[1])
      } else {
        continue
      }
      if (rekeyRow(db, sessionId, newId, derived)) {
        result.rekeyed++
        if (derived) result.derived++
      }
    }
    db.run(
      'INSERT OR REPLACE INTO trace_key_migration (id, version, done_at) VALUES (1, ?, ?)',
      [TRACE_KEY_MIGRATION_VERSION, Date.now()],
    )
    db.run('COMMIT')
  } catch (err) {
    try { db.run('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
  bumpSessionsVersion(db)
  return result
}

/**
 * Moves one stored trace from `oldId` to `newId` (inside the caller's transaction): its row, its
 * timeline, its per-session caches, plus an alias for the old id and its wire uuid. When `newId`
 * already has a row, source precedence decides which row's content stays (traceIdentity.ts).
 * Returns false when there was nothing to move.
 */
export function rekeyRow(db: Db, oldId: string, newId: string, derived: boolean): boolean {
  if (!newId || oldId === newId) return false
  const read = (id: string) => {
    const r = db.exec('SELECT source_rank, data_source, total_llm_calls, input_tokens, output_tokens FROM sessions WHERE session_id = ?', [id])[0]?.values[0]
    return r ? sourceRankOf({ sourceRank: (r[0] as number | null) ?? undefined, dataSource: r[1] === 'log' ? 'log' : 'otel', totalLlmCalls: Number(r[2] ?? 0), inputTokens: Number(r[3] ?? 0), outputTokens: Number(r[4] ?? 0) }) : null
  }
  const oldRank = read(oldId)
  if (oldRank === null) return false
  const newRank = read(newId)
  if (newRank !== null && newRank > oldRank) {
    // The canonical row already holds better evidence: the old row only leaves an alias behind.
    db.run('DELETE FROM sessions WHERE session_id = ?', [oldId])
  } else {
    if (newRank !== null) db.run('DELETE FROM sessions WHERE session_id = ?', [newId])
    const cols = (db.exec('PRAGMA table_info(sessions)')[0]?.values ?? []).map(r => String(r[1])).filter(c => c !== 'session_id')
    const list = cols.join(', ')
    // A copy under the new id, then the children, then the old row — the FK has no ON UPDATE.
    db.run(`INSERT INTO sessions (session_id, ${list}) SELECT ?, ${list} FROM sessions WHERE session_id = ?`, [newId, oldId])
    db.run('UPDATE sessions SET derived = ?, legacy = 0 WHERE session_id = ?', [derived ? 1 : 0, newId])
    db.run('UPDATE timeline_entries SET session_id = ? WHERE session_id = ?', [newId, oldId])
    db.run('DELETE FROM sessions WHERE session_id = ?', [oldId])
  }
  for (const table of ['git_outcome', 'git_outcome_key']) {
    db.run(`DELETE FROM ${table} WHERE session_id = ? AND EXISTS (SELECT 1 FROM ${table} WHERE session_id = ?)`, [oldId, newId])
    db.run(`UPDATE ${table} SET session_id = ? WHERE session_id = ?`, [newId, oldId])
  }
  for (const table of ['limit_hits', 'limit_readings', 'limit_plan_status']) {
    try { db.run(`UPDATE OR IGNORE ${table} SET session_id = ? WHERE session_id = ?`, [newId, oldId]) } catch { /* table absent */ }
  }
  for (const id of new Set([oldId, toUuid(oldId)])) {
    if (id !== newId) db.run('INSERT OR REPLACE INTO trace_aliases (old_id, new_id) VALUES (?, ?)', [id, newId])
  }
  return true
}
