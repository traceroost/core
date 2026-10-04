/**
 * A small, dedicated SQLite database for the standalone server's Outcomes-tab caching (AL 05/06)
 * — commit attribution, cohort turnover, and the per-file blame cache. Everything else the
 * standalone server persists is JSON (spans.json et al.); this is SQLite only because the VS
 * Code extension's caching layer (src/database/*Repository.ts) already speaks it, and the schema
 * carries the same privacy posture (counts and hashes only — see OUTCOMES_SCHEMA_SQL).
 */

import * as fs from 'fs'
import * as path from 'path'
import { OUTCOMES_SCHEMA_SQL } from '../../src/database/schema'

interface SqlDatabase {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  export(): Uint8Array
  close(): void
}
interface SqlJsStatic {
  Database: new (data?: Buffer | Uint8Array) => SqlDatabase
}
type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>

const DB_FILENAME = 'outcomes-cache.db'

export interface OutcomesDb {
  /** Direct access for the Attribution/Turnover/FileBlame repositories — same WriteableDb shape
   *  those already expect from the VS Code extension's TraceRoostDb.raw. */
  raw: SqlDatabase
  /** Flush the in-memory database to disk. */
  save(): void
}

/** Returns null (never throws) when sql.js can't be loaded — the caller falls back to computing
 *  turnover uncached, same as it already does today. */
export async function openOutcomesDb(dataDir: string): Promise<OutcomesDb | null> {
  try {
    const sqlJsDir = path.dirname(require.resolve('sql.js'))
    const initSqlJs = require('sql.js') as InitSqlJs
    const SQL = await initSqlJs({ locateFile: (file: string) => path.join(sqlJsDir, file) })

    const dbPath = path.join(dataDir, DB_FILENAME)
    let db: SqlDatabase
    try {
      db = new SQL.Database(fs.readFileSync(dbPath))
    } catch {
      db = new SQL.Database()
    }
    db.run(OUTCOMES_SCHEMA_SQL)
    applyOutcomesMigrations(db)

    return {
      raw: db,
      save: () => {
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(dbPath, Buffer.from(db.export()))
      },
    }
  } catch {
    return null
  }
}

// trace_revision.payload_hash (staged feature 10's content-hash generalization) -- `CREATE TABLE
// IF NOT EXISTS` in OUTCOMES_SCHEMA_SQL never adds a column to an already-existing table, so a
// pre-existing outcomes-cache.db (created before this column existed) needs this same guarded
// ALTER TABLE db.ts's applyMigrations() runs for the editor's traceroost.db.
function applyOutcomesMigrations(db: SqlDatabase): void {
  const cols = db.exec('PRAGMA table_info(trace_revision)')
  if (!cols[0]) return
  const colNames = cols[0].values.map(row => row[1] as string)
  if (!colNames.includes('payload_hash')) {
    db.run('ALTER TABLE trace_revision ADD COLUMN payload_hash TEXT')
  }
  // trace_revision.source_rank (staged feature 11) -- same reason.
  if (!colNames.includes('source_rank')) {
    db.run('ALTER TABLE trace_revision ADD COLUMN source_rank INTEGER')
  }
}
