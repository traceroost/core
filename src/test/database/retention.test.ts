import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { SCHEMA_SQL } from '../../database/schema'
import { DatabaseWriter } from '../../database/writer'
import { runRetention, compactTraceSends } from '../../database/retention'
import { DatabaseReader } from '../../database/reader'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'
import type * as vscode from 'vscode'
import type { SqlStatement } from '../../database/db'

// ── Helpers ───────────────────────────────────────────────────────────────────

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  prepare(sql: string): SqlStatement
  export(): Uint8Array
  close(): void
}

async function openDb(): Promise<SqlDb> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

function makeStorageUri(dir: string): vscode.Uri {
  return { scheme: 'file', path: dir, fsPath: dir } as unknown as vscode.Uri
}

function makeCard(id: string, startIso: string): SessionSummaryCard {
  return {
    sessionId: id, traceId: id, source: 'copilot', dataSource: 'otel', workspace: 'ws', userRequest: 'test',
    model: 'gpt-4o', turns: 1, inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0,
    durationMs: 1000, startTime: startIso,
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
  }
}

function countSessions(db: SqlDb): number {
  const r = db.exec('SELECT COUNT(*) FROM sessions')
  return (r[0]?.values[0]?.[0] as number) ?? 0
}

function countTimeline(db: SqlDb): number {
  const r = db.exec('SELECT COUNT(*) FROM timeline_entries')
  return (r[0]?.values[0]?.[0] as number) ?? 0
}

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('runRetention', () => {
  test('deletes sessions older than cutoff, keeps newer ones', async () => {
    const db = await openDb()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-ret-'))
    const storageUri = makeStorageUri(tmpDir)
    const writer = new DatabaseWriter(db, storageUri, () => {})
    const blobsDir = path.join(tmpDir, 'blobs')
    fs.mkdirSync(blobsDir, { recursive: true })

    const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString()
    const newDate = new Date(Date.now() - 1  * 86_400_000).toISOString()

    writer.enqueue(makeCard('old-1', oldDate), 'ws')
    writer.enqueue(makeCard('old-2', oldDate), 'ws')
    writer.enqueue(makeCard('new-1', newDate), 'ws')
    await writer.drain()

    assert.strictEqual(countSessions(db), 3)

    await runRetention(db, 30, blobsDir, () => {})

    assert.strictEqual(countSessions(db), 1, 'Only the new session should remain')
    const remaining = db.exec("SELECT session_id FROM sessions")
    assert.strictEqual(remaining[0]?.values[0]?.[0], 'new-1')
  })

  test('cascade: deleted sessions timeline_entries are gone', async () => {
    const db = await openDb()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-ret2-'))
    const storageUri = makeStorageUri(tmpDir)
    const writer = new DatabaseWriter(db, storageUri, () => {})
    const blobsDir = path.join(tmpDir, 'blobs')
    fs.mkdirSync(blobsDir, { recursive: true })

    const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString()
    const cardWithTimeline: SessionSummaryCard = {
      ...makeCard('old-tl', oldDate),
      timeline: [
        { type: 'llm', spanId: 'sp1', label: 'LLM', durationMs: 100, isError: false, timestamp: oldDate, inputTokens: 50, outputTokens: 10 },
      ],
    }
    writer.enqueue(cardWithTimeline, 'ws')
    await writer.drain()

    assert.ok(countTimeline(db) > 0, 'Should have timeline entries before retention')
    await runRetention(db, 30, blobsDir, () => {})
    assert.strictEqual(countTimeline(db), 0, 'Timeline entries should be gone after retention')
  })

  test('blob eviction deletes files with no corresponding span_id', async () => {
    const db = await openDb()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-ret3-'))
    const blobsDir = path.join(tmpDir, 'blobs')
    fs.mkdirSync(blobsDir, { recursive: true })

    // Create an orphaned blob file (no corresponding DB entry)
    fs.writeFileSync(path.join(blobsDir, 'orphan-span-id-response.txt'), 'orphaned content')

    await runRetention(db, 30, blobsDir, () => {})

    assert.ok(!fs.existsSync(path.join(blobsDir, 'orphan-span-id-response.txt')), 'Orphaned blob should be deleted')
  })

  test('blob eviction keeps files for existing span_ids', async () => {
    const db = await openDb()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-ret4-'))
    const storageUri = makeStorageUri(tmpDir)
    const blobsDir = path.join(tmpDir, 'blobs')
    fs.mkdirSync(blobsDir, { recursive: true })

    const recentDate = new Date(Date.now() - 1 * 86_400_000).toISOString()
    const card: SessionSummaryCard = {
      ...makeCard('kept', recentDate),
      timeline: [
        { type: 'llm', spanId: 'live-span', label: 'LLM', durationMs: 100, isError: false, timestamp: recentDate,
          inputTokens: 50, outputTokens: 10,
        },
      ],
    }
    // Write card directly to DB to get timeline_entry row (writer enqueues blobs via vscode.workspace.fs which isn't available in test)
    // Use a fresh writer that doesn't write blobs
    const w = new DatabaseWriter(db, storageUri, () => {})
    w.enqueue(card, 'ws')
    await w.drain()

    // Manually create a blob for the span (simulating a real blob file)
    const blobFile = path.join(blobsDir, 'live-span-response.txt')
    fs.writeFileSync(blobFile, 'x'.repeat(600))  // above threshold to simulate real blob

    await runRetention(db, 30, blobsDir, () => {})

    assert.ok(fs.existsSync(blobFile), 'Blob for existing span should NOT be deleted')
  })

  test('drops the git-outcome cache and revision rows of the sessions it deleted', async () => {
    const db = await openDb()
    const w = new DatabaseWriter(db, makeStorageUri(os.tmpdir()), () => {})
    w.importCards([
      makeCard('old', new Date(Date.now() - 100 * 86_400_000).toISOString()),
      makeCard('new', new Date(Date.now() - 1 * 86_400_000).toISOString()),
    ])
    for (const id of ['old', 'new']) {
      db.run(`INSERT INTO git_outcome (session_id, repo_root, head_sha, overall) VALUES (?, '/r', 'k', 'productive')`, [id])
      db.run(`INSERT INTO git_outcome_key (session_id, repo_root, head_sha, trunk_sha, rel_paths_hash, file_sha, cache_key)
              VALUES (?, '/r', 'h', 't', 'p', 'f', 'k')`, [id])
      db.run(`INSERT INTO trace_revision (session_id, revision, fingerprint, checked_at, changed_at)
              VALUES (?, 1, 'fp', 0, 0)`, [id])
    }
    await runRetention(db, 30, path.join(os.tmpdir(), 'traceroost-ret-none'), () => {})
    for (const table of ['git_outcome', 'git_outcome_key', 'trace_revision']) {
      assert.deepStrictEqual(db.exec(`SELECT session_id FROM ${table}`)[0].values, [['new']], table)
    }
  })

  test('compactTraceSends folds rows older than an hour into one, keeping every count the same', async () => {
    const db = await openDb()
    const now = Date.UTC(2026, 5, 1)
    const sends: Array<[number, number]> = [
      [now - 30 * 86_400_000, 5], [now - 2 * 86_400_000, 3], [now - 2 * 3_600_000, 2], // folded
      [now - 30 * 60_000, 7], [now - 2 * 60_000, 1],                                   // kept
    ]
    for (const [at, n] of sends) db.run('INSERT INTO trace_sends (sent_at, count) VALUES (?, ?)', [at, n])
    const reader = new DatabaseReader(db, makeStorageUri(os.tmpdir()))
    const before = [now, now + 10 * 60_000, now + 2 * 3_600_000].map(t => reader.queryTraceSendStats(t))
    compactTraceSends(db, now)
    assert.strictEqual(db.exec('SELECT COUNT(*) FROM trace_sends')[0].values[0][0], 3)
    assert.deepStrictEqual([now, now + 10 * 60_000, now + 2 * 3_600_000].map(t => reader.queryTraceSendStats(t)), before)
    assert.deepStrictEqual(before[0], { last5Min: 1, lastHour: 8, allTime: 18 })
    compactTraceSends(db, now)
    assert.strictEqual(db.exec('SELECT COUNT(*) FROM trace_sends')[0].values[0][0], 3, 'a second pass changes nothing')
  })

  test('compacts the file when most of it is free pages after the delete', async () => {
    const db = await openDb()
    db.run('PRAGMA foreign_keys = ON')
    const w = new DatabaseWriter(db, makeStorageUri(os.tmpdir()), () => {})
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString()
    w.importCards(Array.from({ length: 3000 }, (_, i) => ({ ...makeCard(`old-${i}`, old), userRequest: 'x'.repeat(2000) })))
    w.importCards([makeCard('new', new Date().toISOString())])
    const pages = () => Number(db.exec('PRAGMA page_count')[0].values[0][0])
    const before = pages()
    await runRetention(db, 30, path.join(os.tmpdir(), 'traceroost-ret-none'), () => {})
    assert.strictEqual(countSessions(db), 1)
    assert.strictEqual(Number(db.exec('PRAGMA freelist_count')[0].values[0][0]), 0)
    assert.ok(pages() < before / 4, `${before} -> ${pages()} pages`)
  })
})
