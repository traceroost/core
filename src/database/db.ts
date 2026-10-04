import * as fs from 'fs'
import * as path from 'path'
import { SCHEMA_SQL } from './schema'
import { dropStaleTraceStore, TRACE_STORE_REBUILT_MESSAGE } from './traceStore'

// Minimal sql.js surface we use — avoids pulling in @types/sql.js
// which has a transitive @types/emscripten dep that requires browser lib types.
interface SqlDatabase {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  prepare(sql: string): SqlStatement
  export(): Uint8Array
  close(): void
}
/** A sql.js prepared statement. Every statement is freed by `export()` (i.e. by every save), so
 *  hold one only for the length of a synchronous block — see DatabaseWriter. */
export interface SqlStatement {
  run(params?: unknown[]): void
  step(): boolean
  get(): unknown[]
  reset(): void
  free(): void
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
// saveSoon() coalesces save requests to at most one save per this many ms. Every save serializes
// and rewrites the whole database (well over 100 MB for a long history, ~0.4 s of blocked
// extension host each), and ingestion used to ask for one per OTLP payload and per 10 log files.
// Kept equal to the other windows' last-write poll interval so they don't see changes any later.
export const SAVE_COALESCE_MS = 2_000

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

  // True when the file held a store older than TRACE_STORE_VERSION: its trace tables were dropped
  // (traceStore.ts), and the caller reads the agent logs again from scratch.
  let rebuiltTraceStore = false
  if (fileBuffer) {
    try {
      db = new SQL.Database(fileBuffer)
      rebuiltTraceStore = dropStaleTraceStore(db)
      db.run(SCHEMA_SQL)
      applyMigrations(db)
    } catch (err) {
      try { db?.close() } catch { /* ignore */ }
      db = undefined
      rebuiltTraceStore = false
      loadError = String(err)
    }
  }
  if (!db) {
    db = new SQL.Database()
    dropStaleTraceStore(db)
    db.run(SCHEMA_SQL)
    applyMigrations(db)
  }
  if (loadError) {
    log(`TraceRoost: could not load ${dbPath} (${loadError}) — running without saving so the existing file is left untouched.`)
  }
  if (rebuiltTraceStore) log(`TraceRoost: ${TRACE_STORE_REBUILT_MESSAGE}`)

  ensureBlobsDir(storagePath)

  const tdb = new TraceRoostDb(db, SQL, dbPath, path.join(storagePath, BLOBS_DIR), loadedStat, loadError, log)
  tdb.rebuiltTraceStore = rebuiltTraceStore
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
  /** True when this open dropped a store older than TRACE_STORE_VERSION (traceStore.ts). */
  rebuiltTraceStore = false
  /** Minimum gap between two saves made through saveSoon(). Public so tests can shorten it. */
  saveCoalesceMs = SAVE_COALESCE_MS
  private lastSaveMs = 0
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private saveCallbacks: Array<(saved: boolean) => void> = []

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
    // sql.js's export() closes and reopens the connection, which resets per-connection pragmas —
    // without this, foreign keys (and every ON DELETE CASCADE the schema relies on: retention,
    // INSERT OR REPLACE of a session) silently stopped working after the first save.
    this.db.run('PRAGMA foreign_keys = ON')
    const tmpPath = `${this.dbPath}.${process.pid}.tmp`
    try {
      const fd = fs.openSync(tmpPath, 'w')
      try {
        // Straight from the exported bytes — Buffer.from(data) copied the whole database first.
        fs.writeSync(fd, data)
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
    this.lastSaveMs = Date.now()
    return true
  }

  /**
   * Asks for a save without doing it now: requests are coalesced so the database is written at
   * most once per `saveCoalesceMs` (the first request after a quiet period is saved on the next
   * macrotask). `onSaved` runs after the save that covers this request, with save()'s result —
   * use it for anything that must only happen once the data is on disk. dispose() flushes a
   * pending save.
   */
  saveSoon(onSaved?: (saved: boolean) => void): void {
    if (onSaved) this.saveCallbacks.push(onSaved)
    if (this.saveTimer) return
    const delay = Math.max(0, this.lastSaveMs + this.saveCoalesceMs - Date.now())
    this.saveTimer = setTimeout(() => this.flushSaveSoon(), delay)
  }

  private flushSaveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const callbacks = this.saveCallbacks
    this.saveCallbacks = []
    let saved = false
    try {
      saved = this.save()
    } catch (err) {
      this.log(`TraceRoost: database save failed: ${err}`)
    }
    for (const cb of callbacks) {
      try { cb(saved) } catch (err) { this.log(`TraceRoost: after-save callback failed: ${err}`) }
    }
  }

  /** Save and close. Added to context.subscriptions so VS Code calls it on deactivation. */
  dispose(): void {
    try {
      if (this.saveTimer || this.saveCallbacks.length > 0) this.flushSaveSoon()
      else this.save()
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
  // Each migration is guarded so re-running on an already-migrated DB is safe. Trace tables need
  // none: a store older than TRACE_STORE_VERSION has them dropped and recreated (traceStore.ts).

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
