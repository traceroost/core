import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { SCHEMA_SQL } from '../../database/schema'
import { resolveOutcomeCacheKey } from '../../gitOutcome'
import { ReconciliationService, type ReconcileInput } from '../../reconcile/reconciliationService'

// reconcileMany reads each repo root's HEAD/trunk tip once per pass and reuses a session's stored
// file sha (git_outcome_key) while HEAD and its file list are unchanged. These tests count the
// git subprocesses actually spawned (through a logging `git` shim first on PATH) and check every
// resulting fingerprint against resolveOutcomeCacheKey's uncached, per-session path — the key
// before this optimization — so "cheaper" can't quietly become "different".

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
}

async function openInMemoryDb(): Promise<SqlDb> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

const LONG_AGO = new Date(Date.now() - 10 * 60_000).toISOString()
const FILES = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
const N = 12

// The shim is POSIX sh; the logic under test is platform-independent.
const suiteOrSkip = process.platform === 'win32' ? suite.skip : suite

suiteOrSkip('reconcileMany: per-pass repo tips and stored file shas', () => {
  let tmp: string
  let repoDir: string
  let spawnLog: string
  let savedPath: string | undefined

  function git(...args: string[]): string {
    const date = '2026-01-01T00:00:00Z'
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
  }
  function spawned(): string[] {
    return fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf-8').split('\n').filter(Boolean) : []
  }
  function resetSpawns(): void {
    fs.rmSync(spawnLog, { force: true })
  }
  const inputs: ReconcileInput[] = Array.from({ length: N }, (_, i) => ({
    sessionId: `s${i}`,
    workspace: '',
    filesChanged: [],
    endTime: LONG_AGO,
  }))
  function sessions(): ReconcileInput[] {
    return inputs.map((s, i) => ({ ...s, workspace: repoDir, filesChanged: [path.join(repoDir, FILES[i % FILES.length])] }))
  }
  function fingerprints(db: SqlDb): Map<string, string> {
    const rows = db.exec('SELECT session_id, fingerprint FROM trace_revision')[0]?.values ?? []
    return new Map(rows.map(r => [r[0] as string, r[1] as string]))
  }
  async function assertKeysMatchUncachedPath(db: SqlDb): Promise<void> {
    const stored = fingerprints(db)
    for (const s of sessions()) {
      const live = await resolveOutcomeCacheKey(s.workspace, s.filesChanged)
      assert.strictEqual(stored.get(s.sessionId), live?.cacheKey, `${s.sessionId}: fingerprint must equal the uncached per-session key`)
    }
  }

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-pass-snapshot-'))
    repoDir = path.join(tmp, 'repo')
    fs.mkdirSync(repoDir)
    spawnLog = path.join(tmp, 'spawns.log')
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim()
    const shimDir = path.join(tmp, 'bin')
    fs.mkdirSync(shimDir)
    fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${spawnLog}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
    savedPath = process.env.PATH
    process.env.PATH = `${shimDir}${path.delimiter}${savedPath ?? ''}`

    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@traceroost.local')
    git('config', 'user.name', 'TraceRoost Test')
    for (const f of FILES) fs.writeFileSync(path.join(repoDir, f), `${f} v1\n`)
    git('add', '-A')
    git('commit', '-qm', 'initial')
    git('checkout', '-qb', 'feature')
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a.txt v2\n')
    git('commit', '-qam', 'feature change')
  })

  teardown(() => {
    process.env.PATH = savedPath
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('unchanged repo: a later pass spawns no per-session git process and returns the same results', async () => {
    const db = await openInMemoryDb()
    const first = await new ReconciliationService(db).reconcileMany(sessions())
    assert.deepStrictEqual(first.map(r => r.outcome?.overall), sessions().map((_, i) => (i % FILES.length === 0 ? 'committed' : 'merged')))

    resetSpawns()
    // A fresh service over the same database: the next activation's startup pass.
    const again = await new ReconciliationService(db).reconcileMany(sessions())
    const calls = spawned()
    assert.deepStrictEqual(calls.filter(c => /^(log|show) /.test(c)), [], 'no git log/show for an unchanged session')
    // Per repo, not per session: find the root and trunk ref, read HEAD + trunk tip once at the
    // start of the pass and once more for the end-of-pass recheck.
    assert.ok(calls.every(c => /^(rev-parse|symbolic-ref|show-ref) /.test(c)), JSON.stringify(calls))
    assert.strictEqual(calls.filter(c => c.startsWith('rev-parse HEAD ')).length, 2, JSON.stringify(calls))
    assert.deepStrictEqual(again.map(r => r.outcome), first.map(r => r.outcome))
    assert.deepStrictEqual(again.map(r => r.revision), first.map(r => r.revision))
    assert.ok(again.every(r => !r.changed))
    await assertKeysMatchUncachedPath(db)
  })

  test('trunk advances with HEAD unchanged: stored file shas are reused, but the new trunk tip still reclassifies', async () => {
    const db = await openInMemoryDb()
    await new ReconciliationService(db).reconcileMany(sessions())
    git('branch', '-f', 'main', 'feature')

    resetSpawns()
    const after = await new ReconciliationService(db).reconcileMany(sessions())
    assert.ok(after.every(r => r.outcome?.overall === 'merged'))
    assert.deepStrictEqual(after.map(r => r.changed), sessions().map((_, i) => i % FILES.length === 0))
    assert.deepStrictEqual(spawned().filter(c => c.startsWith('log ')), [], 'HEAD did not move, so no file sha needed recomputing')
    await assertKeysMatchUncachedPath(db)
  })

  test('new commit (HEAD and trunk move): file shas are recomputed and results match the uncached path', async () => {
    const db = await openInMemoryDb()
    await new ReconciliationService(db).reconcileMany(sessions())
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', 'feature', '-m', 'merge feature')
    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'b.txt v2\n')
    git('commit', '-qam', 'b on main')

    resetSpawns()
    const after = await new ReconciliationService(db).reconcileMany(sessions())
    assert.ok(after.every(r => r.outcome?.overall === 'merged'))
    assert.strictEqual(spawned().filter(c => c.startsWith('log ')).length >= N, true, 'every session re-reads its file sha at the new HEAD')
    await assertKeysMatchUncachedPath(db)
  })

  test('uncommitted working-tree edit is still detected with HEAD and trunk unchanged', async () => {
    const db = await openInMemoryDb()
    await new ReconciliationService(db).reconcileMany(sessions())
    fs.writeFileSync(path.join(repoDir, 'c.txt'), 'c.txt edited, not committed\n')

    resetSpawns()
    const after = await new ReconciliationService(db).reconcileMany(sessions())
    for (const [i, r] of after.entries()) {
      const expected = i % FILES.length === 2 ? 'abandoned' : i % FILES.length === 0 ? 'committed' : 'merged'
      assert.strictEqual(r.outcome?.overall, expected, r.sessionId)
      assert.strictEqual(r.changed, i % FILES.length === 2, r.sessionId)
    }
    assert.deepStrictEqual(spawned().filter(c => c.startsWith('log ')), [], 'the edit is caught by the working-tree digest, not a git log')
    await assertKeysMatchUncachedPath(db)
  })

  test('trunk moving mid-pass: sessions checked against the pass-start tips are redone before the pass returns', async () => {
    const db = await openInMemoryDb()
    await new ReconciliationService(db).reconcileMany(sessions())

    const service = new ReconciliationService(db)
    let moved = false
    service.subscribe(() => {
      // Synchronously, right after the first session of the pass completes — every later session
      // in this pass still sees the snapshot taken before this move.
      if (!moved) { moved = true; git('branch', '-f', 'main', 'feature') }
    })
    const after = await service.reconcileMany(sessions())
    assert.ok(moved)
    assert.ok(after.every(r => r.outcome?.overall === 'merged'), JSON.stringify(after.map(r => r.outcome?.overall)))
    await assertKeysMatchUncachedPath(db)

    // And the pass after that is warm again against the new tips.
    resetSpawns()
    await new ReconciliationService(db).reconcileMany(sessions())
    assert.deepStrictEqual(spawned().filter(c => /^(log|show) /.test(c)), [])
  })
})
