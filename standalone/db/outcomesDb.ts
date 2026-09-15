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
