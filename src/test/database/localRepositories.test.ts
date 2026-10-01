import * as assert from 'assert'
import * as path from 'path'
import { OUTCOMES_SCHEMA_SQL, SCHEMA_SQL } from '../../database/schema'
import { InstructionRepository } from '../../database/instructionRepository'
import { AttributionRepository } from '../../database/attributionRepository'
import { FileBlameRepository } from '../../database/fileBlameRepository'
import { TurnoverRepository } from '../../database/turnoverRepository'
import type { CommitAttribution } from '../../attribution/types'
import type { TurnoverReport } from '../../turnover'

// The four small sql.js repositories behind the Advisor (applied/dismissed suggestions) and the
// AL 05/06 outcome caches (attribution, per-file blame, cohort turnover) — run against the real
// schema so a column rename in schema.ts breaks here rather than silently at runtime.

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>
  close(): void
}

let SQL: { Database: new () => SqlDb }

async function loadSqlJs(): Promise<void> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
}

function openDb(): SqlDb {
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  db.run(OUTCOMES_SCHEMA_SQL)
  return db
}

function applied(id: string, workspace: string, overrides: Partial<Parameters<InstructionRepository['recordApplied']>[0]> = {}) {
  return {
    id, workspace, category: 'context', title: 'Add a.ts', suggestedText: 'Read a.ts first',
    appliedTo: 'CLAUDE.md', appliedText: 'Read a.ts first', baselineCostAvg: 0.42, baselineTurnsAvg: 7.5,
    baselineErrorRate: 0.25, baselineLoopRate: 0.1, baselineInsufficient: false,
    ...overrides,
  }
}

function attribution(sha: string, overrides: Partial<CommitAttribution> = {}): CommitAttribution {
  return {
    sha, authoredAt: '2026-01-02T03:04:05.000Z', linesAdded: 10, linesRemoved: 2, aiLines: 7,
    attribution: 'probable', sessionIds: ['s1', 's2'], isMerge: false,
    ...overrides,
  }
}

function report(headSha: string | null): TurnoverReport {
  return {
    repoRoot: '/repo', headSha, results: [],
    coverage: { attributedLines: 7, totalMergedLines: 10 },
  }
}

suite('local sql.js repositories', () => {
  let db: SqlDb
  suiteSetup(loadSqlJs)
  setup(() => { db = openDb() })
  teardown(() => db.close())

  suite('InstructionRepository', () => {
    test('round-trips an applied suggestion with its baseline', () => {
      const repo = new InstructionRepository(db)
      const before = Date.now()
      repo.recordApplied(applied('hot_file:a_ts', '/ws'))
      const [row] = repo.getApplied('/ws')
      assert.strictEqual(row.id, 'hot_file:a_ts')
      assert.strictEqual(row.appliedTo, 'CLAUDE.md')
      assert.strictEqual(row.baselineCostAvg, 0.42)
      assert.strictEqual(row.baselineTurnsAvg, 7.5)
      assert.strictEqual(row.baselineErrorRate, 0.25)
      assert.strictEqual(row.baselineLoopRate, 0.1)
      assert.strictEqual(row.baselineInsufficient, false)
      assert.ok(row.appliedAtMs >= before - 1000 && row.appliedAtMs <= Date.now() + 1000)
      assert.strictEqual(new Date(row.appliedAtMs).toISOString(), row.appliedAt)
    })

    test('keeps workspaces apart, escapes quotes, and stores the insufficient flag', () => {
      const repo = new InstructionRepository(db)
      repo.recordApplied(applied('a', "/it's/ws", { baselineInsufficient: true }))
      repo.recordApplied(applied('b', '/other'))
      const rows = repo.getApplied("/it's/ws")
      assert.deepStrictEqual(rows.map(r => r.id), ['a'])
      assert.strictEqual(rows[0].baselineInsufficient, true)
      assert.deepStrictEqual(repo.getApplied('/nowhere'), [])
    })

    test('re-applying the same id replaces the row; removeApplied deletes it', () => {
      const repo = new InstructionRepository(db)
      repo.recordApplied(applied('a', '/ws', { appliedText: 'v1' }))
      repo.recordApplied(applied('a', '/ws', { appliedText: 'v2' }))
      const rows = repo.getApplied('/ws')
      assert.strictEqual(rows.length, 1)
      assert.strictEqual(rows[0].appliedText, 'v2')
      repo.removeApplied('a')
      assert.deepStrictEqual(repo.getApplied('/ws'), [])
    })

    test('dismissals are per workspace, idempotent, and reversible', () => {
      const repo = new InstructionRepository(db)
      assert.deepStrictEqual(repo.getDismissedIds('/ws'), [])
      repo.recordDismissed('x', '/ws')
      repo.recordDismissed('x', '/ws')
      repo.recordDismissed('y', "/o'ther")
      assert.deepStrictEqual(repo.getDismissedIds('/ws'), ['x'])
      assert.deepStrictEqual(repo.getDismissedIds("/o'ther"), ['y'])
      repo.undismiss('x', '/other-ws')
      assert.deepStrictEqual(repo.getDismissedIds('/ws'), ['x'], 'undismiss is scoped to its workspace')
      repo.undismiss('x', '/ws')
      assert.deepStrictEqual(repo.getDismissedIds('/ws'), [])
    })
  })

  suite('AttributionRepository', () => {
    test('round-trips a commit attribution, scoped by repo root', () => {
      const repo = new AttributionRepository(db, '/repo')
      assert.strictEqual(repo.get('abc'), undefined)
      repo.put(attribution('abc'))
      assert.deepStrictEqual(repo.get('abc'), attribution('abc'))
      assert.strictEqual(new AttributionRepository(db, '/other-repo').get('abc'), undefined)
    })

    test('merge flag survives, and a re-put overwrites', () => {
      const repo = new AttributionRepository(db, '/repo')
      repo.put(attribution('m1', { isMerge: true, attribution: 'unknown', sessionIds: [] }))
      repo.put(attribution('m1', { isMerge: true, attribution: 'certain', aiLines: 9 }))
      const got = repo.get('m1')
      assert.strictEqual(got?.isMerge, true)
      assert.strictEqual(got?.attribution, 'certain')
      assert.strictEqual(got?.aiLines, 9)
    })

    test('a corrupt session_ids column reads back as no sessions rather than throwing', () => {
      const repo = new AttributionRepository(db, '/repo')
      repo.put(attribution('bad'))
      db.run(`UPDATE commit_attribution SET session_ids = 'not json' WHERE sha = 'bad'`)
      assert.deepStrictEqual(repo.get('bad')?.sessionIds, [])
    })
  })

  suite('FileBlameRepository', () => {
    test('round-trips origins per file and replaces on re-put', () => {
      const repo = new FileBlameRepository(db, "/re'po")
      assert.strictEqual(repo.get('a.ts'), undefined)
      repo.put("it's.ts", 'blob1', { c1: 3, c2: 1 })
      assert.deepStrictEqual(repo.get("it's.ts"), { blobSha: 'blob1', origins: { c1: 3, c2: 1 } })
      repo.put("it's.ts", 'blob2', { c3: 4 })
      assert.deepStrictEqual(repo.get("it's.ts"), { blobSha: 'blob2', origins: { c3: 4 } })
      assert.strictEqual(new FileBlameRepository(db, '/other').get("it's.ts"), undefined)
    })

    test('unparseable origins read back as a cache miss', () => {
      const repo = new FileBlameRepository(db, '/repo')
      repo.put('a.ts', 'blob', {})
      db.run(`UPDATE file_blame SET origins_json = '{' WHERE file_path = 'a.ts'`)
      assert.strictEqual(repo.get('a.ts'), undefined)
    })

    test('pruneExcept keeps only the listed files of this repo; an empty list clears this repo', () => {
      const repo = new FileBlameRepository(db, '/repo')
      const other = new FileBlameRepository(db, '/other')
      repo.put('a.ts', 'b1', { c: 1 })
      repo.put('b.ts', 'b2', { c: 1 })
      repo.put('c.ts', 'b3', { c: 1 })
      other.put('a.ts', 'b9', { c: 1 })
      repo.pruneExcept(['a.ts', 'c.ts'])
      assert.ok(repo.get('a.ts'))
      assert.strictEqual(repo.get('b.ts'), undefined)
      assert.ok(repo.get('c.ts'))
      repo.pruneExcept([])
      assert.strictEqual(repo.get('a.ts'), undefined)
      assert.strictEqual(repo.get('c.ts'), undefined)
      assert.ok(other.get('a.ts'), 'another repo’s rows are untouched')
    })
  })

  suite('TurnoverRepository', () => {
    test('empty until saved, then returns the report and the HEAD it was computed at', () => {
      const repo = new TurnoverRepository(db, '/repo')
      assert.strictEqual(repo.storedHeadSha(), null)
      assert.strictEqual(repo.load(), null)
      repo.save(report('head1'))
      assert.strictEqual(repo.storedHeadSha(), 'head1')
      assert.deepStrictEqual(repo.load(), report('head1'))
      repo.save(report('head2'))
      assert.strictEqual(repo.storedHeadSha(), 'head2')
      assert.strictEqual(new TurnoverRepository(db, '/other').load(), null)
    })

    test('a report with no HEAD (empty repo) is not persisted', () => {
      const repo = new TurnoverRepository(db, '/repo')
      repo.save(report(null))
      assert.strictEqual(repo.storedHeadSha(), null)
    })

    test('a corrupt stored report reads as nothing stored', () => {
      const repo = new TurnoverRepository(db, '/repo')
      repo.save(report('head1'))
      db.run(`UPDATE cohort_turnover SET report_json = 'nope'`)
      assert.strictEqual(repo.load(), null)
      assert.strictEqual(repo.storedHeadSha(), null)
    })
  })
})
