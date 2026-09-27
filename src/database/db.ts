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
// Held by the one extension host (VS Code window) allowed to write traceroost.db — see
// TraceRoostDb's doc comment. Contains the owner's pid.
const OWNER_LOCK_SUFFIX = '.owner'

/**
 * Opens (or creates) the TraceRoost SQLite database at storagePath/traceroost.db
 * and applies the schema. The extensionPath is needed to locate the sql.js
 * WASM binary, which is copied to dist/ during the build.
 */
export async function openDatabase(
  storagePath: string,
  extensionPath: string,
  log: (msg: string) => void = () => { /* silent */ },
): Promise<TraceRoostDb> {
  // sql.js is loaded dynamically to keep it out of the main extension bundle.
  // Require by path so the packaged extension can resolve it from dist/.
  const initSqlJs = require(path.join(extensionPath, 'dist', 'sql-wasm.js')) as InitSqlJs
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(extensionPath, 'dist', file),
  })
  return openDatabaseWith(SQL, storagePath, log)
}

/** openDatabase() with an already-initialized sql.js — split out so tests can supply their own. */
export function openDatabaseWith(
  SQL: SqlJsStatic,
  storagePath: string,
  log: (msg: string) => void = () => { /* silent */ },
): TraceRoostDb {
  const dbPath = path.join(storagePath, DB_FILENAME)
  let db: SqlDatabase | undefined
  // Set when an existing database file couldn't be loaded. The window then runs on an empty
  // in-memory database with saving disabled: falling back to an empty DB *and* saving it (the
  // old behavior) silently replaced the user's whole history with nothing on the next save.
  let loadError: string | undefined

  let fileBuffer: Buffer | undefined
  try {
    fileBuffer = fs.readFileSync(dbPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') loadError = String(err)
  }
  const loadedStat = statOrNull(dbPath)

  if (fileBuffer) {
    try {
      db = new SQL.Database(fileBuffer)
      db.run(SCHEMA_SQL)
      applyMigrations(db)
    } catch (err) {
      try { db?.close() } catch { /* ignore */ }
      db = undefined
      loadError = String(err)
    }
  }
  if (!db) {
    db = new SQL.Database()
    db.run(SCHEMA_SQL)
    applyMigrations(db)
  }
  if (loadError) {
    log(`TraceRoost: could not load ${dbPath} (${loadError}) — running without saving so the existing file is left untouched.`)
  }

  ensureBlobsDir(storagePath)

  const tdb = new TraceRoostDb(db, SQL, dbPath, path.join(storagePath, BLOBS_DIR), loadedStat, loadError, log)
  tdb.tryAcquireOwnership()
  return tdb
}

type FileStamp = { mtimeMs: number; size: number } | null

function statOrNull(p: string): FileStamp {
  try {
    const st = fs.statSync(p)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  if (a === null || b === null) return a === b
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Every VS Code window runs its own extension host, and each one loads traceroost.db into its own
 * in-memory sql.js copy. Saving is a whole-file export, so two windows saving diverging copies
 * used to clobber each other (whichever saved last erased the other's writes). Writes are now
 * single-owner: the first host to create `traceroost.db.owner` (holding its pid) owns saving for
 * its lifetime; every other window is read-only on disk — `save()` is a no-op there, and it keeps
 * refreshing its view from the owner's saves through the existing last-write signal. A lock whose
 * pid is no longer running is stolen. A read-only window only ever takes over ownership if the file
 * on disk is still byte-for-byte the one it loaded (same mtime and size) — otherwise its in-memory
 * copy is stale and saving it would roll back someone else's writes.
 *
 * Saves themselves are atomic (write a sibling temp file, fsync, rename over the original), so a
 * crash mid-save or a concurrent reader (openReadonlySnapshot) never sees a torn file.
 */
export class TraceRoostDb {
  private owner = false
  private lastStamp: FileStamp

  constructor(
    private readonly db: SqlDatabase,
    readonly sqlFactory: SqlJsStatic,
    private readonly dbPath: string,
    readonly blobsDir: string,
    loadedStat: FileStamp = null,
    /** Why the existing database file couldn't be loaded, if it couldn't; saving is disabled. */
    readonly loadError?: string,
    private readonly log: (msg: string) => void = () => { /* silent */ },
  ) {
    this.lastStamp = loadedStat
  }

  /** True when this host owns writes to the database file. */
  get isOwner(): boolean {
    return this.owner
  }

  private get lockPath(): string {
    return this.dbPath + OWNER_LOCK_SUFFIX
  }

  /** Tries to become the database file's single writer. Returns whether this host now owns it. */
  tryAcquireOwnership(): boolean {
    if (this.owner) return true
    if (this.loadError) return false
    // Our in-memory copy must still match the disk file, or saving it would lose newer writes.
    if (!sameStamp(this.lastStamp, statOrNull(this.dbPath))) return false
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx')
        try { fs.writeSync(fd, String(process.pid)) } finally { fs.closeSync(fd) }
        this.owner = true
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          this.log(`TraceRoost: could not create ${this.lockPath}: ${err}`)
          return false
        }
      }
      let holder = NaN
      try { holder = parseInt(fs.readFileSync(this.lockPath, 'utf8'), 10) } catch { /* vanished */ }
      if (holder === process.pid) { this.owner = true; return true }
      if (isProcessAlive(holder)) return false
      // Abandoned by a host that exited without cleaning up — take it over.
      try { fs.rmSync(this.lockPath, { force: true }) } catch { /* retry anyway */ }
    }
    return false
  }

  /**
   * Flush the in-memory database to disk. Called periodically and on deactivate. Returns false
   * (and writes nothing) when this host isn't the database's owner — see the class comment.
   */
  save(): boolean {
    if (!this.owner && !this.tryAcquireOwnership()) return false
    const data = this.db.export()
    const tmpPath = `${this.dbPath}.${process.pid}.tmp`
    try {
      const fd = fs.openSync(tmpPath, 'w')
      try {
        fs.writeSync(fd, Buffer.from(data))
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmpPath, this.dbPath)
    } catch (err) {
      try { fs.rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
      throw err
    }
    this.lastStamp = statOrNull(this.dbPath)
    return true
  }

  /** Save and close. Added to context.subscriptions so VS Code calls it on deactivation. */
  dispose(): void {
    try {
      this.save()
    } finally {
      this.db.close()
      if (this.owner) {
        this.owner = false
        try {
          if (parseInt(fs.readFileSync(this.lockPath, 'utf8'), 10) === process.pid) {
            fs.rmSync(this.lockPath, { force: true })
          }
        } catch { /* already gone */ }
      }
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
  if (!colNames.includes('initiator')) {
    db.run('ALTER TABLE sessions ADD COLUMN initiator TEXT')
  }
  // The agent's own conversation id (Claude Code's session.id / transcript id) — lets the writer
  // drop a Claude log card that OTEL already covers. See DatabaseWriter.enqueue.
  if (!colNames.includes('conversation_id')) {
    db.run('ALTER TABLE sessions ADD COLUMN conversation_id TEXT')
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON sessions (conversation_id)')

  // timeline_entries cache token columns
  const teCols = db.exec('PRAGMA table_info(timeline_entries)')
  const teColNames = teCols[0]?.values.map(row => row[1] as string) ?? []
  if (!teColNames.includes('cache_read_tokens')) {
    db.run('ALTER TABLE timeline_entries ADD COLUMN cache_read_tokens INTEGER')
  }
  if (!teColNames.includes('cache_create_tokens')) {
    db.run('ALTER TABLE timeline_entries ADD COLUMN cache_create_tokens INTEGER')
  }

  // trace_revision.payload_hash (staged feature 10's content-hash generalization) -- see
  // schema.ts's doc comment on the table.
  const trCols = db.exec('PRAGMA table_info(trace_revision)')
  if (trCols[0]) {
    const trColNames = trCols[0].values.map(row => row[1] as string)
    if (!trColNames.includes('payload_hash')) {
      db.run('ALTER TABLE trace_revision ADD COLUMN payload_hash TEXT')
    }
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
