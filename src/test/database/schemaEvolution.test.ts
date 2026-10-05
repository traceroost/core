import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openDatabaseWith, KEPT_TABLE_COLUMNS, type SqlJsStatic } from '../../database/db'
import { ensureColumn, ensureColumns, storeDowngradeWarning, tableColumns } from '../../database/schemaEvolution'
import { TRACE_STORE_VERSION } from '../../database/traceStore'

// Columns added to tables that survive a trace-store rebuild are added by ensureColumn on open —
// CREATE TABLE IF NOT EXISTS never alters an existing table, so without this the next INSERT
// naming the new column fails on every store written before it. A store from a *newer* build is
// warned about, not silently run.

async function loadSqlJs(): Promise<SqlJsStatic> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<SqlJsStatic>
  return initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-schema-'))
}

suite('schemaEvolution.ensureColumn', () => {
  let SQL: SqlJsStatic
  suiteSetup(async () => { SQL = await loadSqlJs() })

  test('adds a missing column once and leaves an existing one alone', () => {
    const db = new SQL.Database()
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)')
    db.run("INSERT INTO t (id, a) VALUES (1, 'x')")

    assert.strictEqual(ensureColumn(db, 't', 'b', 'INTEGER NOT NULL DEFAULT 0'), true)
    assert.deepStrictEqual(tableColumns(db, 't'), ['id', 'a', 'b'])
    // Existing rows take the default; the column is usable at once.
    assert.strictEqual(db.exec('SELECT b FROM t WHERE id = 1')[0].values[0][0], 0)

    assert.strictEqual(ensureColumn(db, 't', 'b', 'INTEGER NOT NULL DEFAULT 0'), false, 'second run is a no-op')
    assert.strictEqual(ensureColumn(db, 't', 'a', 'TEXT'), false, 'a column the schema already made')
    db.close()
  })

  test('does nothing for a table that does not exist yet (the schema creates it complete)', () => {
    const db = new SQL.Database()
    assert.strictEqual(ensureColumn(db, 'missing', 'c', 'TEXT'), false)
    assert.deepStrictEqual(tableColumns(db, 'missing'), [])
    db.close()
  })

  test('ensureColumns reports exactly the columns it added', () => {
    const db = new SQL.Database()
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)')
    const added = ensureColumns(db, [
      { table: 't', column: 'a', ddl: 'TEXT' },
      { table: 't', column: 'b', ddl: 'TEXT' },
      { table: 'nope', column: 'c', ddl: 'TEXT' },
    ])
    assert.deepStrictEqual(added.map(m => `${m.table}.${m.column}`), ['t.b'])
    db.close()
  })

  test('quotes identifiers', () => {
    const db = new SQL.Database()
    db.run('CREATE TABLE "odd name" (id INTEGER PRIMARY KEY)')
    assert.strictEqual(ensureColumn(db, 'odd name', 'select', 'TEXT'), true)
    assert.deepStrictEqual(tableColumns(db, 'odd name'), ['id', 'select'])
    db.close()
  })
})

suite('schemaEvolution.storeDowngradeWarning', () => {
  let SQL: SqlJsStatic
  suiteSetup(async () => { SQL = await loadSqlJs() })

  test('is silent for a current or older store', () => {
    const db = new SQL.Database()
    assert.strictEqual(storeDowngradeWarning(db, TRACE_STORE_VERSION), null, 'fresh database (version 0)')
    db.run(`PRAGMA user_version = ${TRACE_STORE_VERSION}`)
    assert.strictEqual(storeDowngradeWarning(db, TRACE_STORE_VERSION), null, 'current')
    db.close()
  })

  test('names both versions for a store written by a newer build', () => {
    const db = new SQL.Database()
    db.run(`PRAGMA user_version = ${TRACE_STORE_VERSION + 3}`)
    const warning = storeDowngradeWarning(db, TRACE_STORE_VERSION)
    assert.ok(warning, 'warns')
    assert.ok(warning.includes(`store version ${TRACE_STORE_VERSION + 3}`), warning)
    assert.ok(warning.includes(`this build writes ${TRACE_STORE_VERSION}`), warning)
    db.close()
  })

  test('openDatabaseWith logs the warning and keeps the newer store (no rebuild, no downgrade of the stamp)', () => {
    const dir = tmpDir()
    const newer = TRACE_STORE_VERSION + 1
    const seed = openDatabaseWith(SQL, dir)
    seed.raw.run(`INSERT INTO sessions (session_id, trace_id, source, workspace, start_time) VALUES ('s1', 's1', 'claude_code', '', 0)`)
    seed.raw.run(`PRAGMA user_version = ${newer}`)
    seed.dispose()

    const logged: string[] = []
    const db = openDatabaseWith(SQL, dir, m => logged.push(m))
    assert.ok(logged.some(m => m.includes(`store version ${newer}`)), logged.join('\n'))
    assert.strictEqual(db.rebuiltTraceStore, false)
    assert.strictEqual(db.raw.exec('SELECT COUNT(*) FROM sessions')[0].values[0][0], 1, 'history kept')
    assert.strictEqual(Number(db.raw.exec('PRAGMA user_version')[0].values[0][0]), newer, 'stamp not lowered')
    db.dispose()
  })
})

suite('db.KEPT_TABLE_COLUMNS', () => {
  let SQL: SqlJsStatic
  suiteSetup(async () => { SQL = await loadSqlJs() })

  test('every entry names a table the schema creates, and a fresh store already has the column', () => {
    const dir = tmpDir()
    const db = openDatabaseWith(SQL, dir)
    for (const m of KEPT_TABLE_COLUMNS) {
      const cols = tableColumns(db.raw, m.table)
      assert.ok(cols.length > 0, `${m.table} is not in the schema`)
      assert.ok(cols.includes(m.column), `${m.table}.${m.column}: add it to SCHEMA_SQL too — new stores must not depend on the migration`)
    }
    db.dispose()
  })
})
