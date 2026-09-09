import * as fs from 'fs'
import * as path from 'path'
import { SCHEMA_SQL } from './schema'

// Minimal sql.js surface we use — avoids pulling in @types/sql.js
// which has a transitive @types/emscripten dep that requires browser lib types.
interface SqlDatabase {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  export(): Uint8Array
  close(): void
}
export interface SqlJsStatic {
  Database: new (data?: Buffer | Uint8Array) => SqlDatabase
}
type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>

const DB_FILENAME = 'traceroost.db'
const BLOBS_DIR = 'blobs'

/**
 * Opens (or creates) the TraceRoost SQLite database at storagePath/traceroost.db
 * and applies the schema. The extensionPath is needed to locate the sql.js
 * WASM binary, which is copied to dist/ during the build.
 */
export async function openDatabase(storagePath: string, extensionPath: string): Promise<TraceRoostDb> {
  // sql.js is loaded dynamically to keep it out of the main extension bundle.
  // Require by path so the packaged extension can resolve it from dist/.
  const initSqlJs = require(path.join(extensionPath, 'dist', 'sql-wasm.js')) as InitSqlJs
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(extensionPath, 'dist', file),
  })

  const dbPath = path.join(storagePath, DB_FILENAME)
  let db: SqlDatabase

  try {
    const fileBuffer = fs.readFileSync(dbPath)
    db = new SQL.Database(fileBuffer)
  } catch {
    db = new SQL.Database()
  }

  db.run(SCHEMA_SQL)
  applyMigrations(db)

  ensureBlobsDir(storagePath)

  return new TraceRoostDb(db, SQL, dbPath, path.join(storagePath, BLOBS_DIR))
}

export class TraceRoostDb {
  constructor(
    private readonly db: SqlDatabase,
    readonly sqlFactory: SqlJsStatic,
    private readonly dbPath: string,
    readonly blobsDir: string,
  ) {}

  /** Flush the in-memory database to disk. Called periodically and on deactivate. */
  save(): void {
    const data = this.db.export()
    fs.writeFileSync(this.dbPath, Buffer.from(data))
  }

  /** Save and close. Added to context.subscriptions so VS Code calls it on deactivation. */
  dispose(): void {
    try {
      this.save()
    } finally {
      this.db.close()
    }
  }

  /** Direct access for query/write operations added in later phases. */
  get raw(): SqlDatabase {
    return this.db
  }
}

function applyMigrations(db: SqlDatabase): void {
  // Each migration is guarded so re-running on an already-migrated DB is safe.
  const cols = db.exec('PRAGMA table_info(sessions)')
  const colNames = cols[0]?.values.map(row => row[1] as string) ?? []
  if (!colNames.includes('cost_usd')) {
    db.run('ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0')
  }
  if (!colNames.includes('data_source')) {
    db.run("ALTER TABLE sessions ADD COLUMN data_source TEXT NOT NULL DEFAULT 'otel'")
  }
  if (!colNames.includes('files_written')) {
    db.run("ALTER TABLE sessions ADD COLUMN files_written TEXT NOT NULL DEFAULT '[]'")
  }
  if (!colNames.includes('models')) {
    db.run("ALTER TABLE sessions ADD COLUMN models TEXT NOT NULL DEFAULT '[]'")
  }
  if (!colNames.includes('one_shot_stats')) {
    db.run("ALTER TABLE sessions ADD COLUMN one_shot_stats TEXT NOT NULL DEFAULT '{}'")
  }

  // timeline_entries cache token columns
  const teCols = db.exec('PRAGMA table_info(timeline_entries)')
  const teColNames = teCols[0]?.values.map(row => row[1] as string) ?? []
  if (!teColNames.includes('cache_read_tokens')) {
    db.run('ALTER TABLE timeline_entries ADD COLUMN cache_read_tokens INTEGER')
  }
  if (!teColNames.includes('cache_create_tokens')) {
    db.run('ALTER TABLE timeline_entries ADD COLUMN cache_create_tokens INTEGER')
  }

  // instruction_applied table (feat-instruction-advisor)
  const appliedCols = db.exec('PRAGMA table_info(instruction_applied)')
  if (!appliedCols[0]) {
    db.run(`CREATE TABLE IF NOT EXISTS instruction_applied (
      id                     TEXT PRIMARY KEY,
      workspace              TEXT NOT NULL,
      category               TEXT NOT NULL,
      title                  TEXT NOT NULL,
      suggested_text         TEXT NOT NULL DEFAULT '',
      applied_to             TEXT NOT NULL DEFAULT '',
      applied_text           TEXT NOT NULL DEFAULT '',
      applied_at             TEXT NOT NULL,
      baseline_cost_avg      REAL NOT NULL DEFAULT 0,
      baseline_turns_avg     REAL NOT NULL DEFAULT 0,
      baseline_error_rate    REAL NOT NULL DEFAULT 0,
      baseline_loop_rate     REAL NOT NULL DEFAULT 0,
      baseline_insufficient  INTEGER NOT NULL DEFAULT 0
    )`)
    db.run('CREATE INDEX IF NOT EXISTS idx_instruction_applied_workspace ON instruction_applied (workspace)')
  }

  // instruction_dismissed table (feat-instruction-advisor)
  const dismissedCols = db.exec('PRAGMA table_info(instruction_dismissed)')
  if (!dismissedCols[0]) {
    db.run(`CREATE TABLE IF NOT EXISTS instruction_dismissed (
      id           TEXT NOT NULL,
      workspace    TEXT NOT NULL,
      dismissed_at TEXT NOT NULL,
      PRIMARY KEY (id, workspace)
    )`)
    db.run('CREATE INDEX IF NOT EXISTS idx_instruction_dismissed_workspace ON instruction_dismissed (workspace)')
  }
}

function ensureBlobsDir(storagePath: string): void {
  const dir = path.join(storagePath, BLOBS_DIR)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
