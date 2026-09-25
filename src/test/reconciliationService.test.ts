import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { SCHEMA_SQL } from '../database/schema'
import { ReconciliationService, type ReconcileResult } from '../reconcile/reconciliationService'

// Real temporary git repos (matching gitOutcome.test.ts's own convention) plus a real in-memory
// sql.js database — this exercises the durable revision store and GitOutcomeRepository cache
// exactly as DashboardPanel/standalone server do, not a mock of either.

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

let repoDir: string
let fileCounter = 0

function git(args: string[], isoDate?: string): string {
  const env = isoDate
    ? { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate }
    : process.env
  return execFileSync('git', args, { cwd: repoDir, env, encoding: 'utf-8' })
}

function writeFile(relPath: string, content: string): void {
  const abs = path.join(repoDir, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function commitAll(message: string, isoDate: string): void {
  git(['add', '-A'])
  git(['commit', '-m', message, '--allow-empty'], isoDate)
}

// Well outside the 2-minute active-session grace window every call below needs to clear.
const LONG_AGO = new Date(Date.now() - 10 * 60_000).toISOString()

suite('reconciliationService', () => {
  setup(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-reconcile-'))
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@traceroost.local'])
    git(['config', 'user.name', 'TraceRoost Test'])
    fileCounter++
  })

  teardown(() => {
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('allocates revision 1 on first reconcile and reuses it on an unchanged re-check', async () => {
    const db = await openInMemoryDb()
    const service = new ReconciliationService(db)
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    const abs = path.join(repoDir, file)

    const first = await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs], endTime: LONG_AGO })
    assert.strictEqual(first.outcome?.overall, 'merged')
    assert.strictEqual(first.revision, 1)
    assert.strictEqual(first.changed, true)

    const second = await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs], endTime: LONG_AGO })
    assert.strictEqual(second.revision, 1, 'a repeated check of identical evidence must not allocate a new revision')
    assert.strictEqual(second.changed, false)
  })

  test('bumps the revision when an uncommitted edit changes the working-tree outcome', async () => {
    const db = await openInMemoryDb()
    const service = new ReconciliationService(db)
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    const abs = path.join(repoDir, file)

    const committed = await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs], endTime: LONG_AGO })
    assert.strictEqual(committed.outcome?.overall, 'merged')

    // No new commit — just an on-disk edit. The old cache key (commit sha + trunk sha only) would
    // not have moved; this is exactly the "edits without a commit" gap staged feature 10 calls out.
    writeFile(file, 'v2 (uncommitted)')
    const edited = await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs], endTime: LONG_AGO })
    assert.strictEqual(edited.outcome?.overall, 'abandoned')
    assert.strictEqual(edited.revision, 2, 'an uncommitted edit that changes the outcome must allocate a new revision')
    assert.strictEqual(edited.changed, true)
  })

  test('bumps the revision when the trunk branch merges the session\'s commit later', async () => {
    const db = await openInMemoryDb()
    const service = new ReconciliationService(db)
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    git(['checkout', '-q', '-b', 'feature'])
    writeFile(file, 'v2')
    commitAll('feature change', '2026-01-02T00:00:00Z')
    const abs = path.join(repoDir, file)

    const onFeature = await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs], endTime: LONG_AGO })
    assert.strictEqual(onFeature.outcome?.overall, 'committed')
    assert.strictEqual(onFeature.revision, 1)

    git(['checkout', '-q', 'main'])
    git(['merge', '-q', '--no-ff', 'feature', '-m', 'merge feature'], '2026-01-03T00:00:00Z')

    const afterMerge = await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs], endTime: LONG_AGO })
    assert.strictEqual(afterMerge.outcome?.overall, 'merged')
    assert.strictEqual(afterMerge.revision, 2)
  })

  test('defers classification and notifies no listener while inside the active-session grace window', async () => {
    const db = await openInMemoryDb()
    const service = new ReconciliationService(db)
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    const abs = path.join(repoDir, file)

    const notifications: ReconcileResult[] = []
    service.subscribe(r => notifications.push(r))

    const result = await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs], endTime: new Date().toISOString() })
    assert.strictEqual(result.deferred, true)
    assert.strictEqual(notifications.length, 0)
  })

  test('concurrent reconcile calls for the same session share one in-flight classification', async () => {
    const db = await openInMemoryDb()
    const service = new ReconciliationService(db)
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    const abs = path.join(repoDir, file)

    const [a, b] = await Promise.all([
      service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs], endTime: LONG_AGO }),
      service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs], endTime: LONG_AGO }),
    ])
    assert.deepStrictEqual(a, b)
    assert.strictEqual(a.revision, 1, 'two concurrent first-time calls must not double-allocate a revision')
  })

  test('notifies subscribers on a real outcome change but not on an unchanged re-check', async () => {
    const db = await openInMemoryDb()
    const service = new ReconciliationService(db)
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    const abs = path.join(repoDir, file)

    const notifications: ReconcileResult[] = []
    service.subscribe(r => notifications.push(r))

    await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs], endTime: LONG_AGO })
    await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs], endTime: LONG_AGO })
    assert.strictEqual(notifications.length, 2, 'reconcile() itself notifies on every completed (non-deferred) check')
    assert.strictEqual(notifications[0].changed, true)
    assert.strictEqual(notifications[1].changed, false)
  })

  test('two independent sessions in different repos share one global, strictly increasing revision counter', async () => {
    const db = await openInMemoryDb()
    const service = new ReconciliationService(db)

    const file1 = `file${fileCounter}.txt`
    writeFile(file1, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    const abs1 = path.join(repoDir, file1)

    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-reconcile-other-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: otherRepo })
      execFileSync('git', ['config', 'user.email', 'test@traceroost.local'], { cwd: otherRepo })
      execFileSync('git', ['config', 'user.name', 'TraceRoost Test'], { cwd: otherRepo })
      const file2 = 'other.txt'
      fs.writeFileSync(path.join(otherRepo, file2), 'v1')
      execFileSync('git', ['add', '-A'], { cwd: otherRepo })
      execFileSync('git', ['commit', '-m', 'initial', '--allow-empty'], { cwd: otherRepo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } })
      const abs2 = path.join(otherRepo, file2)

      const r1 = await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs1], endTime: LONG_AGO })
      const r2 = await service.reconcile({ sessionId: 's2', workspace: otherRepo, filesChanged: [abs2], endTime: LONG_AGO })
      assert.strictEqual(r1.revision, 1)
      assert.strictEqual(r2.revision, 2, 'revisions are a single global counter (see schema.ts), not per-session — a second session\'s first check still advances it')

      // Re-checking s1 (unchanged) must not consume another global revision, and re-checking s2
      // with a real change must take the next one in sequence regardless of s1's own value.
      const r1Again = await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [abs1], endTime: LONG_AGO })
      assert.strictEqual(r1Again.revision, 1)
      fs.writeFileSync(abs2, 'v2 (uncommitted)')
      const r2Changed = await service.reconcile({ sessionId: 's2', workspace: otherRepo, filesChanged: [abs2], endTime: LONG_AGO })
      assert.strictEqual(r2Changed.revision, 3)
    } finally {
      fs.rmSync(otherRepo, { recursive: true, force: true })
    }
  })

  test('returns a null outcome/revision for a session with nothing to classify, and never throws', async () => {
    const db = await openInMemoryDb()
    const service = new ReconciliationService(db)
    const result = await service.reconcile({ sessionId: 's1', workspace: repoDir, filesChanged: [], endTime: LONG_AGO })
    assert.strictEqual(result.outcome, null)
    assert.strictEqual(result.revision, null)
    assert.strictEqual(result.changed, false)
  })
})
