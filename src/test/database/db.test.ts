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

suite('TraceRoostDb (saving)', () => {
  let SQL: SqlJsStatic
  suiteSetup(async () => { SQL = await loadSqlJs() })

  function timelineCount(raw: { exec(sql: string): Array<{ values: unknown[][] }> }): number {
    return raw.exec('SELECT COUNT(*) FROM timeline_entries')[0].values[0][0] as number
  }

  test('foreign keys (and ON DELETE CASCADE) stay on after a save', () => {
    const dir = tmpDir()
    const a = openDatabaseWith(SQL, dir)
    insertSession(a.raw, 's1')
    a.raw.run(`INSERT INTO timeline_entries (session_id, span_id, position, type) VALUES ('s1', 'sp1', 0, 'llm')`)
    // sql.js's export() reopens the connection; foreign_keys used to reset to off right here.
    a.save()
    assert.strictEqual(a.raw.exec('PRAGMA foreign_keys')[0].values[0][0], 1)
    a.raw.run(`DELETE FROM sessions WHERE session_id = 's1'`)
    assert.strictEqual(timelineCount(a.raw), 0, 'timeline rows cascade-deleted with their session')
    a.dispose()
  })

  test('saveSoon coalesces a burst of requests into one save and runs every callback after it', async () => {
    const dir = tmpDir()
    const a = openDatabaseWith(SQL, dir)
    a.saveCoalesceMs = 50
    let saves = 0
    const realSave = a.save.bind(a)
    a.save = () => { saves++; return realSave() }
    const results: boolean[] = []
    insertSession(a.raw, 's1')
    a.saveSoon(saved => results.push(saved))
    insertSession(a.raw, 's2')
    a.saveSoon(saved => results.push(saved))
    a.saveSoon()
    assert.strictEqual(saves, 0, 'nothing is written synchronously')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.strictEqual(saves, 1)
    assert.deepStrictEqual(results, [true, true])
    assert.strictEqual(sessionCount(dir, SQL), 2)

    // A request right after a save waits out the coalescing interval rather than saving again.
    insertSession(a.raw, 's3')
    a.saveSoon()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.strictEqual(saves, 1)
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.strictEqual(saves, 2)
    assert.strictEqual(sessionCount(dir, SQL), 3)
    a.dispose()
  })

  test('dispose flushes a pending saveSoon and runs its callback', () => {
    const dir = tmpDir()
    const a = openDatabaseWith(SQL, dir)
    a.saveCoalesceMs = 60_000
    a.save()
    insertSession(a.raw, 's1')
    let called: boolean | undefined
    a.saveSoon(saved => { called = saved })
    a.dispose()
    assert.strictEqual(called, true)
    assert.strictEqual(sessionCount(dir, SQL), 1)
  })

  test('saveSoon on a window that does not own the file writes nothing and reports false', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'traceroost.db.owner'), String(OTHER_LIVE_PID))
    const reader = openDatabaseWith(SQL, dir)
    insertSession(reader.raw, 's1')
    const saved = await new Promise<boolean>(resolve => reader.saveSoon(resolve))
    assert.strictEqual(saved, false)
    assert.ok(!fs.existsSync(path.join(dir, 'traceroost.db')))
    reader.dispose()
  })
})
