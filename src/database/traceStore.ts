/**
 * The local trace store's version, kept in SQLite's `PRAGMA user_version` (0 on every database
 * written before it existed). A store older than TRACE_STORE_VERSION holds traces under keys this
 * build no longer mints, so it is not migrated: its trace tables are dropped, the schema recreates
 * them empty, and the agent logs are read again from scratch (LOG_FILE_STATE_VERSION). What isn't
 * trace data stays: applied/dismissed instruction suggestions, the per-file blame and turnover
 * caches, plan-limit readings and window rollups, the revision counter and the send stats.
 *
 * Shared by the editor's traceroost.db (db.ts) and the standalone server's outcomes-cache.db
 * (standalone/db/outcomesDb.ts), which holds a subset of the same tables.
 *
 *   1: stable trace identity (traceIdentity.ts): one agent turn, one key.
 *   2: a key a log file stops producing is removed (LogReader.takeRetiredKeys); stores written
 *      before still hold such keys. Claude join decisions persist (claude_join).
 */

interface Db {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ values: unknown[][] }>
}

export const TRACE_STORE_VERSION = 2

/** Every table keyed by a trace's key, or holding one — children before their parent
 *  (timeline_entries cascades from sessions, edit_details from timeline_entries). */
export const TRACE_TABLES = [
  'edit_details', 'timeline_entries', 'sessions',
  'git_outcome', 'git_outcome_key', 'trace_revision', 'commit_attribution', 'limit_hits', 'claude_join',
] as const

/**
 * Drops the trace tables of a store older than TRACE_STORE_VERSION and stamps the current version;
 * the caller runs its schema afterwards (CREATE TABLE IF NOT EXISTS), which recreates them empty.
 * Returns true when an existing store was dropped — false for a current store (left untouched)
 * and for a brand-new database, which is only stamped.
 */
export function dropStaleTraceStore(db: Db): boolean {
  const version = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0)
  if (version >= TRACE_STORE_VERSION) return false
  const tables = new Set((db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values ?? []).map(r => String(r[0])))
  const stale = TRACE_TABLES.filter(t => tables.has(t))
  db.run('BEGIN')
  try {
    for (const t of stale) db.run(`DROP TABLE ${t}`)
    db.run(`PRAGMA user_version = ${TRACE_STORE_VERSION}`)
    db.run('COMMIT')
  } catch (err) {
    try { db.run('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
  return stale.length > 0
}

/** The one line a host logs (after its own prefix) when dropStaleTraceStore rebuilt its store. */
export const TRACE_STORE_REBUILT_MESSAGE =
  'The local trace store predated this build\'s trace keys (one agent turn, one key) — rebuilt it; agent logs are read again from scratch.'
