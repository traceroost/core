import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openDatabaseWith, type SqlJsStatic } from '../../database/db'
import { OUTCOMES_SCHEMA_SQL, SCHEMA_SQL } from '../../database/schema'
import { dropStaleTraceStore, TRACE_STORE_REBUILT_MESSAGE, TRACE_STORE_VERSION, TRACE_TABLES } from '../../database/traceStore'

// Opening a traceroost.db written by an older release. A store older than TRACE_STORE_VERSION
// holds traces under keys this build no longer mints, so its trace tables are dropped and rebuilt
// (the agent logs are then read again from scratch); everything that isn't trace data stays. If
// any step threw, openDatabaseWith would fall back to an empty read-only database — the user would
// see no history — so the upgrade path is pinned end to end here.

async function loadSqlJs(): Promise<SqlJsStatic> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<SqlJsStatic>
  return initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
}

type Raw = { run(sql: string, params?: unknown[]): void; exec(sql: string): Array<{ values: unknown[][] }> }

function columns(raw: Raw, table: string): string[] {
  return raw.exec(`PRAGMA table_info(${table})`)[0]?.values.map(r => r[1] as string) ?? []
}

function count(raw: Raw, table: string): number {
  return Number(raw.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0])
}

function userVersion(raw: Raw): number {
  return Number(raw.exec('PRAGMA user_version')[0].values[0][0])
}

/** One row in every trace table, keyed by `sid`. */
function seedTraceRows(db: Raw, sid: string): void {
  db.run(`INSERT INTO sessions (session_id, trace_id, source, workspace, start_time) VALUES (?, 't', 'codex', '/w', 1)`, [sid])
  db.run(`INSERT INTO timeline_entries (session_id, span_id, position, type) VALUES (?, 'span-1', 0, 'llm')`, [sid])
  db.run(`INSERT INTO edit_details (timeline_entry_id, file_path) VALUES (1, 'a.ts')`)
  db.run(`INSERT INTO git_outcome (session_id, repo_root, head_sha, overall) VALUES (?, '/r', 'h', 'productive')`, [sid])
  db.run(`INSERT INTO git_outcome_key (session_id, repo_root, head_sha, trunk_sha, rel_paths_hash, file_sha, cache_key) VALUES (?, '/r', 'h', 't', 'p', 'f', 'k')`, [sid])
  db.run(`INSERT INTO trace_revision (session_id, revision, fingerprint, checked_at, changed_at) VALUES (?, 7, 'fp', 1, 1)`, [sid])
  db.run(`INSERT INTO commit_attribution (repo_root, sha, authored_at, session_ids) VALUES ('/r', 'c1', '2026-01-01', ?)`, [JSON.stringify([sid])])
  db.run(`INSERT INTO limit_hits (provider, session_id, window_kind, hit_at) VALUES ('codex', ?, 'five_hour', 1)`, [sid])
  db.run(`INSERT INTO claude_join (interaction_id, turn_key, status, decided_at) VALUES ('span-1', ?, 'joined', 1)`, [sid])
}

/** What survives a rebuild: settings-like and cache rows that aren't keyed by a trace. */
const KEPT_TABLES = [
  'instruction_applied', 'instruction_dismissed', 'trace_sends', 'trace_revision_counter', 'file_blame',
  'cohort_turnover', 'limit_readings', 'limit_plan_status', 'limit_window_rollups',
]

function seedKeptRows(db: Raw): void {
  db.run(`INSERT INTO instruction_applied (id, workspace, category, title, applied_at) VALUES ('s1', '/w', 'c', 'Use pnpm', '2026-01-01')`)
  db.run(`INSERT INTO instruction_dismissed (id, workspace, dismissed_at) VALUES ('s2', '/w', '2026-01-01')`)
  db.run(`INSERT INTO trace_sends (sent_at, count) VALUES (1, 3)`)
  db.run(`INSERT INTO trace_revision_counter (id, next) VALUES (1, 8)`)
  db.run(`INSERT INTO file_blame (repo_root, file_path, blob_sha, origins_json) VALUES ('/r', 'a.ts', 'b', '{}')`)
  db.run(`INSERT INTO cohort_turnover (repo_root, head_sha, report_json) VALUES ('/r', 'h', '{}')`)
  db.run(`INSERT INTO limit_readings (provider, window_kind, used_pct, observed_at, source) VALUES ('claude', 'five_hour', 40, 1, 'claude_cache')`)
  db.run(`INSERT INTO limit_plan_status (provider, observed_at, no_windows) VALUES ('codex', 1, 1)`)
  db.run(`INSERT INTO limit_window_rollups (provider, window_kind, window_end, peak_pct, coverage) VALUES ('claude', 'five_hour', 1, 80, 'full')`)
}

suite('TraceRoostDb — opening a store from an older release', () => {
  let SQL: SqlJsStatic
  let dir: string
  suiteSetup(async () => { SQL = await loadSqlJs() })
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-dbup-')) })
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  function writeDb(build: (db: Raw) => void): void {
    const db = new SQL.Database()
    build(db)
    fs.writeFileSync(path.join(dir, 'traceroost.db'), Buffer.from(db.export()))
    db.close()
  }

  test('a store older than TRACE_STORE_VERSION is dropped and rebuilt; non-trace data is kept', () => {
    writeDb(db => {
      db.run(SCHEMA_SQL)
      // A column only an older release had — gone once the table is rebuilt from the schema.
      db.run('ALTER TABLE sessions ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0')
      seedTraceRows(db, 'old-file-id#1')
      seedKeptRows(db)
      assert.strictEqual(userVersion(db), 0)
    })
    const logs: string[] = []
    const tdb = openDatabaseWith(SQL, dir, m => logs.push(m))
    try {
      assert.strictEqual(tdb.loadError, undefined, `load failed: ${logs.join('\n')}`)
      assert.ok(tdb.isOwner, 'a rebuilt DB is saved normally, not opened read-only')
      assert.strictEqual(tdb.rebuiltTraceStore, true)
      assert.deepStrictEqual(logs.filter(l => l.includes(TRACE_STORE_REBUILT_MESSAGE)).length, 1, 'one log line')
      for (const t of TRACE_TABLES) assert.strictEqual(count(tdb.raw, t), 0, t)
      for (const t of KEPT_TABLES) assert.strictEqual(count(tdb.raw, t), 1, t)
      assert.strictEqual(tdb.raw.exec('SELECT next FROM trace_revision_counter')[0].values[0][0], 8, 'revisions keep counting up')
      assert.ok(!columns(tdb.raw, 'sessions').includes('legacy'))
      assert.ok(columns(tdb.raw, 'sessions').includes('source_rank'))
      assert.strictEqual(userVersion(tdb.raw), TRACE_STORE_VERSION)
      seedTraceRows(tdb.raw, 'new-key')
      tdb.save()
    } finally {
      tdb.dispose()
    }

    // Re-opening the now-current file changes nothing.
    const again = openDatabaseWith(SQL, dir, m => logs.push(m))
    try {
      assert.strictEqual(again.rebuiltTraceStore, false)
      assert.strictEqual(logs.filter(l => l.includes(TRACE_STORE_REBUILT_MESSAGE)).length, 1)
      assert.deepStrictEqual(again.raw.exec('SELECT session_id FROM sessions')[0].values, [['new-key']])
    } finally {
      again.dispose()
    }
  })

  test('a current-version store is left untouched', () => {
    writeDb(db => {
      db.run(SCHEMA_SQL)
      db.run(`PRAGMA user_version = ${TRACE_STORE_VERSION}`)
      seedTraceRows(db, 'turn-key')
      seedKeptRows(db)
    })
    const logs: string[] = []
    const tdb = openDatabaseWith(SQL, dir, m => logs.push(m))
    try {
      assert.strictEqual(tdb.rebuiltTraceStore, false)
      assert.deepStrictEqual(logs.filter(l => l.includes(TRACE_STORE_REBUILT_MESSAGE)), [])
      for (const t of [...TRACE_TABLES, ...KEPT_TABLES]) assert.strictEqual(count(tdb.raw, t), 1, t)
      assert.strictEqual(tdb.raw.exec('SELECT revision FROM trace_revision')[0].values[0][0], 7)
    } finally {
      tdb.dispose()
    }
  })

  test('a brand-new database is stamped current, with nothing to rebuild', () => {
    const logs: string[] = []
    const tdb = openDatabaseWith(SQL, dir, m => logs.push(m))
    try {
      assert.strictEqual(tdb.rebuiltTraceStore, false)
      assert.strictEqual(userVersion(tdb.raw), TRACE_STORE_VERSION)
      assert.deepStrictEqual(logs.filter(l => l.includes(TRACE_STORE_REBUILT_MESSAGE)), [])
    } finally {
      tdb.dispose()
    }
  })

  test('the standalone server\'s outcomes cache (a subset of the tables) is rebuilt the same way', () => {
    const db = new SQL.Database() as unknown as Raw & { close(): void }
    db.run(OUTCOMES_SCHEMA_SQL)
    db.run(`INSERT INTO trace_revision (session_id, revision, fingerprint, checked_at, changed_at) VALUES ('old', 1, 'fp', 1, 1)`)
    db.run(`INSERT INTO git_outcome (session_id, repo_root, head_sha, overall) VALUES ('old', '/r', 'h', 'productive')`)
    db.run(`INSERT INTO limit_hits (provider, session_id, window_kind, hit_at) VALUES ('codex', 'old', 'five_hour', 1)`)
    db.run(`INSERT INTO file_blame (repo_root, file_path, blob_sha, origins_json) VALUES ('/r', 'a.ts', 'b', '{}')`)
    db.run(`INSERT INTO limit_readings (provider, window_kind, used_pct, observed_at, source) VALUES ('claude', 'five_hour', 40, 1, 'claude_cache')`)
    assert.strictEqual(dropStaleTraceStore(db), true)
    db.run(OUTCOMES_SCHEMA_SQL)
    for (const t of ['trace_revision', 'git_outcome', 'limit_hits']) assert.strictEqual(count(db, t), 0, t)
    for (const t of ['file_blame', 'limit_readings']) assert.strictEqual(count(db, t), 1, t)
    assert.strictEqual(dropStaleTraceStore(db), false, 'stamped: never again')
    db.close()
  })

  test('a corrupt file is left untouched and the window runs read-only', () => {
    const dbPath = path.join(dir, 'traceroost.db')
    fs.writeFileSync(dbPath, 'this is not a sqlite database at all, just text padding it out......')
    const before = fs.readFileSync(dbPath)
    const logs: string[] = []
    const tdb = openDatabaseWith(SQL, dir, m => logs.push(m))
    try {
      assert.ok(tdb.loadError)
      assert.strictEqual(tdb.isOwner, false)
      assert.strictEqual(tdb.rebuiltTraceStore, false)
      assert.ok(logs.some(l => l.includes('running without saving')))
      tdb.raw.run(`INSERT INTO sessions (session_id, trace_id, source, workspace, start_time) VALUES ('n', 't', 'codex', '', 0)`)
      tdb.save()
    } finally {
      tdb.dispose()
    }
    assert.deepStrictEqual(fs.readFileSync(dbPath), before, 'the unreadable file was not overwritten')
  })
})
