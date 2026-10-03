import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openDatabaseWith, type SqlJsStatic } from '../../database/db'
import { SCHEMA_SQL } from '../../database/schema'

// Opening a traceroost.db written by an older release: SCHEMA_SQL runs first (CREATE ... IF NOT
// EXISTS, so existing tables keep their old shape), then applyMigrations adds the missing
// columns/tables. If any step threw, openDatabaseWith would fall back to an empty read-only
// database — the user would see no history — so the upgrade path is pinned end to end here.

async function loadSqlJs(): Promise<SqlJsStatic> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<SqlJsStatic>
  return initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
}

const MIGRATED_SESSION_COLS = [
  'cost_usd', 'data_source', 'files_written', 'models', 'one_shot_stats', 'initiator', 'conversation_id',
  'language', 'language_secondary', 'files_changed_count', 'lines_added', 'lines_removed',
]

function columns(raw: { exec(sql: string): Array<{ values: unknown[][] }> }, table: string): string[] {
  return raw.exec(`PRAGMA table_info(${table})`)[0]?.values.map(r => r[1] as string) ?? []
}

suite('TraceRoostDb — upgrading a database from an older release', () => {
  let SQL: SqlJsStatic
  let dir: string
  suiteSetup(async () => { SQL = await loadSqlJs() })
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-dbup-')) })
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  /** Today's schema minus everything applyMigrations is responsible for, with one stored session. */
  function writeLegacyDb(): void {
    const db = new SQL.Database()
    db.run(SCHEMA_SQL)
    for (const col of MIGRATED_SESSION_COLS) db.run(`ALTER TABLE sessions DROP COLUMN ${col}`)
    db.run('ALTER TABLE timeline_entries DROP COLUMN cache_read_tokens')
    db.run('ALTER TABLE timeline_entries DROP COLUMN cache_create_tokens')
    db.run('ALTER TABLE trace_revision DROP COLUMN payload_hash')
    db.run('DROP TABLE instruction_applied')
    db.run('DROP TABLE instruction_dismissed')
    db.run(`INSERT INTO sessions (session_id, trace_id, source, workspace, start_time) VALUES ('legacy-1', 't', 'codex', '/w', 1)`)
    for (const col of MIGRATED_SESSION_COLS) assert.ok(!columns(db, 'sessions').includes(col))
    fs.writeFileSync(path.join(dir, 'traceroost.db'), Buffer.from(db.export()))
    db.close()
  }

  test('adds every missing column/table, keeps existing rows, and stays writable', () => {
    writeLegacyDb()
    const logs: string[] = []
    const tdb = openDatabaseWith(SQL, dir, m => logs.push(m))
    try {
      assert.strictEqual(tdb.loadError, undefined, `load failed: ${logs.join('\n')}`)
      assert.ok(tdb.isOwner, 'an upgraded DB is saved normally, not opened read-only')
      for (const col of MIGRATED_SESSION_COLS) assert.ok(columns(tdb.raw, 'sessions').includes(col), col)
      assert.ok(columns(tdb.raw, 'timeline_entries').includes('cache_read_tokens'))
      assert.ok(columns(tdb.raw, 'timeline_entries').includes('cache_create_tokens'))
      assert.ok(columns(tdb.raw, 'trace_revision').includes('payload_hash'))
      assert.ok(columns(tdb.raw, 'instruction_applied').includes('baseline_insufficient'))
      assert.deepStrictEqual(columns(tdb.raw, 'instruction_dismissed').sort(), ['dismissed_at', 'id', 'workspace'])
      const row = tdb.raw.exec(`SELECT session_id, cost_usd, data_source, files_written, models, one_shot_stats, initiator FROM sessions`)[0].values
      assert.deepStrictEqual(row, [['legacy-1', 0, 'otel', '[]', '[]', '{}', null]], 'pre-existing rows get the column defaults')
      // Language and change size: older rows stay NULL (shown "—"), no backfill.
      const lang = tdb.raw.exec(`SELECT language, language_secondary, files_changed_count, lines_added, lines_removed FROM sessions`)[0].values
      assert.deepStrictEqual(lang, [[null, null, null, null, null]])
      tdb.save()
    } finally {
      tdb.dispose()
    }

    // Re-opening the now-current file re-runs the guarded migrations as no-ops.
    const again = openDatabaseWith(SQL, dir)
    try {
      assert.strictEqual(again.loadError, undefined)
      assert.strictEqual(again.raw.exec('SELECT COUNT(*) FROM sessions')[0].values[0][0], 1)
    } finally {
      again.dispose()
    }
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
      assert.ok(logs.some(l => l.includes('running without saving')))
      tdb.raw.run(`INSERT INTO sessions (session_id, trace_id, source, workspace, start_time) VALUES ('n', 't', 'codex', '', 0)`)
      tdb.save()
    } finally {
      tdb.dispose()
    }
    assert.deepStrictEqual(fs.readFileSync(dbPath), before, 'the unreadable file was not overwritten')
  })
})
