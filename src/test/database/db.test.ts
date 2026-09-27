import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openDatabaseWith, type SqlJsStatic } from '../../database/db'

async function loadSqlJs(): Promise<SqlJsStatic> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<SqlJsStatic>
  return initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-db-'))
}

function sessionCount(dir: string, SQL: SqlJsStatic): number {
  const db = new SQL.Database(fs.readFileSync(path.join(dir, 'traceroost.db')))
  const n = db.exec('SELECT COUNT(*) FROM sessions')[0]?.values[0]?.[0] as number
  db.close()
  return n
}

function insertSession(raw: { run(sql: string, params?: unknown[]): void }, id: string): void {
  raw.run(`INSERT INTO sessions (session_id, trace_id, source, workspace, start_time) VALUES (?, ?, 'claude_code', '', 0)`, [id, id])
}

// Another live process — stands in for a second VS Code window holding the owner lock.
const OTHER_LIVE_PID = process.ppid
const DEAD_PID = 2 ** 22 + 12345

suite('TraceRoostDb (multi-window safety)', () => {
  let SQL: SqlJsStatic
  suiteSetup(async () => { SQL = await loadSqlJs() })

  test('saves atomically and reloads, leaving no temp file behind', () => {
    const dir = tmpDir()
    const a = openDatabaseWith(SQL, dir)
    assert.ok(a.isOwner)
    insertSession(a.raw, 's1')
    assert.strictEqual(a.save(), true)
    assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [])
    a.dispose()
    assert.ok(!fs.existsSync(path.join(dir, 'traceroost.db.owner')), 'owner lock released on dispose')
    assert.strictEqual(sessionCount(dir, SQL), 1)
  })

  test('an unreadable existing file is never replaced by an empty database', () => {
    const dir = tmpDir()
    const dbPath = path.join(dir, 'traceroost.db')
    fs.writeFileSync(dbPath, 'this is not a sqlite file, but it is the user\'s data')
    const before = fs.readFileSync(dbPath)
    const a = openDatabaseWith(SQL, dir)
    assert.ok(a.loadError)
    assert.strictEqual(a.isOwner, false)
    insertSession(a.raw, 's1')
    assert.strictEqual(a.save(), false)
    a.dispose()
    assert.deepStrictEqual(fs.readFileSync(dbPath), before)
  })

  test('a window that does not hold the owner lock never writes the file', () => {
    const dir = tmpDir()
    const owner = openDatabaseWith(SQL, dir)
    insertSession(owner.raw, 'from-owner')
    owner.save()
    owner.dispose()
    // Simulate another live window holding the lock.
    fs.writeFileSync(path.join(dir, 'traceroost.db.owner'), String(OTHER_LIVE_PID))
    const reader = openDatabaseWith(SQL, dir)
    assert.strictEqual(reader.isOwner, false)
    insertSession(reader.raw, 'from-reader')
    assert.strictEqual(reader.save(), false)
    reader.dispose()
    assert.strictEqual(sessionCount(dir, SQL), 1)
  })

  test('a lock left by a dead process is taken over', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'traceroost.db.owner'), String(DEAD_PID))
    const a = openDatabaseWith(SQL, dir)
    assert.ok(a.isOwner)
    a.dispose()
  })

  test('a stale read-only window does not take over once the file has changed under it', () => {
    const dir = tmpDir()
    const first = openDatabaseWith(SQL, dir)
    first.save()
    first.dispose()
    const lockPath = path.join(dir, 'traceroost.db.owner')
    fs.writeFileSync(lockPath, String(OTHER_LIVE_PID))
    const stale = openDatabaseWith(SQL, dir)
    assert.strictEqual(stale.isOwner, false)
    // The owning window writes newer history, then exits.
    fs.rmSync(lockPath)
    const newer = openDatabaseWith(SQL, dir)
    insertSession(newer.raw, 'newer')
    // Distinct mtime even on coarse-granularity filesystems.
    const future = new Date(Date.now() + 5_000)
    newer.save()
    fs.utimesSync(path.join(dir, 'traceroost.db'), future, future)
    newer.dispose()
    assert.strictEqual(stale.save(), false, 'stale copy must not overwrite the newer file')
    stale.dispose()
    assert.strictEqual(sessionCount(dir, SQL), 1)
  })
})
