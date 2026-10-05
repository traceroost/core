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
import { dropStaleTraceStore } from '../../src/database/traceStore'
import { writeFileAtomic, quarantineCorruptFile } from '../../src/fsAtomic'

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
  /** True when the file held a store older than TRACE_STORE_VERSION and its trace tables were
   *  dropped (src/database/traceStore.ts). */
  rebuiltTraceStore: boolean
}

/** Returns null (never throws) when sql.js can't be loaded — the caller falls back to computing
 *  turnover uncached, same as it already does today. */
export async function openOutcomesDb(dataDir: string, log: (msg: string) => void = () => {}): Promise<OutcomesDb | null> {
  try {
    const sqlJsDir = path.dirname(require.resolve('sql.js'))
    const initSqlJs = require('sql.js') as InitSqlJs
    const SQL = await initSqlJs({ locateFile: (file: string) => path.join(sqlJsDir, file) })

    const dbPath = path.join(dataDir, DB_FILENAME)
    let db: SqlDatabase
    let bytes: Buffer | null = null
    try { bytes = fs.readFileSync(dbPath) } catch { /* no file yet — fresh database */ }
    if (bytes) {
      try {
        db = new SQL.Database(bytes)
        // A torn file can still "open": make sure it answers a query before trusting it.
        db.exec('PRAGMA schema_version')
      } catch (err) {
        // Keep the unreadable file aside rather than letting the first save overwrite it — it holds
        // plan-limit readings, Claude join decisions and revisions that can't be re-derived.
        const aside = quarantineCorruptFile(dbPath)
        log(`[TraceRoost] ${dbPath} could not be opened (${err instanceof Error ? err.message : String(err)})${aside ? ` — moved it to ${aside}` : ''}; starting a fresh outcomes cache.`)
        db = new SQL.Database()
      }
    } else {
      db = new SQL.Database()
    }
    const rebuiltTraceStore = dropStaleTraceStore(db)
    db.run(OUTCOMES_SCHEMA_SQL)

    return {
      raw: db,
      save: () => {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
        // Owner-only (it caches per-trace data) and atomic: a crash mid-write used to leave a
        // truncated file that the next start silently replaced with an empty database.
        writeFileAtomic(dbPath, db.export(), { mode: 0o600 })
      },
      rebuiltTraceStore,
    }
  } catch {
    return null
  }
}
