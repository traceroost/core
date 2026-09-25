import * as assert from 'assert'
import * as path from 'path'
import { SCHEMA_SQL } from '../../database/schema'
import { TraceRevisionRepository } from '../../database/traceRevisionRepository'

// ── Helpers ───────────────────────────────────────────────────────────────────

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  export(): Uint8Array
  close(): void
}

async function openInMemoryDb(): Promise<SqlDb> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

suite('TraceRevisionRepository', () => {
  test('get() returns undefined for a session with no row', async () => {
    const db = await openInMemoryDb()
    const repo = new TraceRevisionRepository(db)
    assert.strictEqual(repo.get('unknown'), undefined)
  })

  test('recordCheck() on a brand-new session allocates revision 1 and reports changed', async () => {
    const db = await openInMemoryDb()
    const repo = new TraceRevisionRepository(db)
    const result = repo.recordCheck('s1', 'fp1', 'merged')
    assert.deepStrictEqual(result, { revision: 1, changed: true })
    const row = repo.get('s1')
    assert.strictEqual(row?.lifecycle, 'active')
    assert.strictEqual(row?.fingerprint, 'fp1')
    assert.strictEqual(row?.outcomeOverall, 'merged')
    assert.strictEqual(row?.checkedAt, row?.changedAt, 'a first insert sets checked_at and changed_at to the same instant')
  })

  test('recordCheck() with an unchanged outcome reuses the revision and does not move changed_at', async () => {
    const db = await openInMemoryDb()
    const repo = new TraceRevisionRepository(db)
    repo.recordCheck('s1', 'fp1', 'merged')
    const before = repo.get('s1')!

    const result = repo.recordCheck('s1', 'fp2', 'merged')
    assert.deepStrictEqual(result, { revision: 1, changed: false })
    const after = repo.get('s1')!
    assert.strictEqual(after.revision, 1)
    assert.strictEqual(after.fingerprint, 'fp2', 'fingerprint still refreshes on an unchanged re-check')
    assert.strictEqual(after.changedAt, before.changedAt, 'changed_at must not move when the outcome value is unchanged')
  })

  test('recordCheck() with a different outcome allocates a new revision and moves changed_at', async () => {
    const db = await openInMemoryDb()
    const repo = new TraceRevisionRepository(db)
    repo.recordCheck('s1', 'fp1', 'committed')

    const result = repo.recordCheck('s1', 'fp2', 'merged')
    assert.deepStrictEqual(result, { revision: 2, changed: true })
    const row = repo.get('s1')!
    assert.strictEqual(row.outcomeOverall, 'merged')
    assert.strictEqual(row.fingerprint, 'fp2')
  })

  test('a transition from a non-null outcome to null counts as a change', async () => {
    const db = await openInMemoryDb()
    const repo = new TraceRevisionRepository(db)
    repo.recordCheck('s1', 'fp1', 'merged')

    const result = repo.recordCheck('s1', 'fp2', null)
    assert.deepStrictEqual(result, { revision: 2, changed: true })
    assert.strictEqual(repo.get('s1')?.outcomeOverall, null)
  })

  test('a transition from null to a non-null outcome counts as a change', async () => {
    const db = await openInMemoryDb()
    const repo = new TraceRevisionRepository(db)
    repo.recordCheck('s1', 'fp1', null)

    const result = repo.recordCheck('s1', 'fp2', 'abandoned')
    assert.deepStrictEqual(result, { revision: 2, changed: true })
  })

  test('repeated null outcomes are treated as unchanged', async () => {
    const db = await openInMemoryDb()
    const repo = new TraceRevisionRepository(db)
    repo.recordCheck('s1', 'fp1', null)
    const result = repo.recordCheck('s1', 'fp2', null)
    assert.deepStrictEqual(result, { revision: 1, changed: false })
  })

  test('revisions are a single global counter shared across sessions, not per-session', async () => {
    const db = await openInMemoryDb()
    const repo = new TraceRevisionRepository(db)
    const s1First = repo.recordCheck('s1', 'fp1', 'merged')
    const s2First = repo.recordCheck('s2', 'fp1', 'merged')
    assert.strictEqual(s1First.revision, 1)
    assert.strictEqual(s2First.revision, 2, 'a second session\'s first check still advances the shared counter')

    // Re-checking s1 unchanged must not consume another global slot; s2's next real change must
    // still take the next value in sequence regardless of s1's own revision.
    const s1Again = repo.recordCheck('s1', 'fp1', 'merged')
    assert.strictEqual(s1Again.revision, 1)
    const s2Changed = repo.recordCheck('s2', 'fp2', 'abandoned')
    assert.strictEqual(s2Changed.revision, 3)
  })

  test('get() handles a session id containing a single quote without breaking the query', async () => {
    const db = await openInMemoryDb()
    const repo = new TraceRevisionRepository(db)
    const sessionId = "o'brien-session"
    repo.recordCheck(sessionId, 'fp1', 'merged')
    const row = repo.get(sessionId)
    assert.strictEqual(row?.outcomeOverall, 'merged')
    // Must not have leaked a row under some mis-escaped/mangled id, and must not have matched
    // every row (which would happen if the quote broke out of the string literal).
    assert.strictEqual(repo.get("unrelated"), undefined)
  })

  test('recordCheck() also tolerates a session id containing a single quote', async () => {
    const db = await openInMemoryDb()
    const repo = new TraceRevisionRepository(db)
    const sessionId = "weird's-id"
    const first = repo.recordCheck(sessionId, 'fp1', 'committed')
    assert.strictEqual(first.changed, true)
    const second = repo.recordCheck(sessionId, 'fp2', 'committed')
    assert.deepStrictEqual(second, { revision: first.revision, changed: false })
  })

  test('two distinct sessions never share a row', async () => {
    const db = await openInMemoryDb()
    const repo = new TraceRevisionRepository(db)
    repo.recordCheck('s1', 'fp1', 'merged')
    repo.recordCheck('s2', 'fp1', 'abandoned')
    assert.strictEqual(repo.get('s1')?.outcomeOverall, 'merged')
    assert.strictEqual(repo.get('s2')?.outcomeOverall, 'abandoned')
  })
})
