import * as assert from 'assert'
import * as path from 'path'
import type * as vscode from 'vscode'
import { SCHEMA_SQL } from '../../database/schema'
import { DatabaseWriter } from '../../database/writer'
import { DatabaseReader } from '../../database/reader'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

// ── Helpers ───────────────────────────────────────────────────────────────────

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
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

function makeStorageUri(): vscode.Uri {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('vscode').Uri.file('/tmp/traceroost-reader-test')
}

function makeCard(overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-r1',
    traceId: 'trace-r1',
    source: 'copilot',
    dataSource: 'otel',
    workspace: '',
    userRequest: 'test request',
    model: 'gpt-4o',
    turns: 3,
    inputTokens: 2000,
    outputTokens: 400,
    cacheReadTokens: 800,
    cacheCreateTokens: 200,
    cacheHitRate: 0.4,
    durationMs: 8000,
    startTime: '2024-06-01T12:00:00.000Z',
    filesRead: ['a.ts', 'b.ts'],
    filesSearched: ['src/'],
    filesChanged: ['c.ts'],
    filesWritten: [],
    filesChangedNote: undefined,
    toolCounts: { Read: 5, Edit: 2 },
    totalToolCalls: 7,
    totalLlmCalls: 3,
    errors: 0,
    outcome: 'tool_calls',
    timeline: [
      { type: 'llm', spanId: 'sp-1', label: 'LLM', durationMs: 500, isError: false, timestamp: '2024-06-01T12:00:01.000Z', inputTokens: 1000, outputTokens: 200 },
      { type: 'tool', spanId: 'sp-2', label: 'Read', durationMs: 30, isError: false, timestamp: '2024-06-01T12:00:02.000Z',
        editDetails: [{ filePath: 'a.ts', toolName: 'Read' }] },
    ],
    backgroundSpans: [],
    loopSignals: [],
    ...overrides,
  }
}

async function seedDb(db: SqlDb, cards: SessionSummaryCard[]) {
  const w = new DatabaseWriter(db, makeStorageUri(), () => {})
  for (const c of cards) w.enqueue(c, 'ws')
  await w.drain()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('DatabaseReader', () => {
  test('listSessions returns rows in start_time DESC order', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'a', startTime: '2024-01-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'b', startTime: '2024-03-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'c', startTime: '2024-02-01T00:00:00.000Z' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    const results = reader.listSessions()
    assert.strictEqual(results[0].sessionId, 'b')
    assert.strictEqual(results[1].sessionId, 'c')
    assert.strictEqual(results[2].sessionId, 'a')
    db.close()
  })

  test('listSessions with source filter returns only matching rows', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'cop', source: 'copilot' }),
      makeCard({ sessionId: 'claude', source: 'claude_code' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    const results = reader.listSessions({ source: 'claude_code' })
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].sessionId, 'claude')
    db.close()
  })

  test('listSessions with since filter excludes old rows', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'old', startTime: '2024-01-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'new', startTime: '2024-06-01T00:00:00.000Z' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    const cutoff = Date.parse('2024-03-01T00:00:00.000Z')
    const results = reader.listSessions({ since: cutoff })
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].sessionId, 'new')
    db.close()
  })

  test('loadSessionTimeline returns entries in position order', async () => {
    const db = await openDb()
    await seedDb(db, [makeCard()])
    const reader = new DatabaseReader(db, makeStorageUri())
    const timeline = reader.loadSessionTimeline('sess-r1')
    assert.strictEqual(timeline.length, 2)
    assert.strictEqual(timeline[0].type, 'llm')
    assert.strictEqual(timeline[1].type, 'tool')
    db.close()
  })

  test('loadSessionTimeline populates editDetails correctly', async () => {
    const db = await openDb()
    await seedDb(db, [makeCard()])
    const reader = new DatabaseReader(db, makeStorageUri())
    const timeline = reader.loadSessionTimeline('sess-r1')
    const toolEntry = timeline.find(e => e.type === 'tool')
    assert.ok(toolEntry?.editDetails && toolEntry.editDetails.length === 1)
    assert.strictEqual(toolEntry!.editDetails![0].filePath, 'a.ts')
    db.close()
  })

  test('loadBlob returns null for missing files', async () => {
    const db = await openDb()
    const reader = new DatabaseReader(db, makeStorageUri())
    const result = await reader.loadBlob('nonexistent-span', 'response')
    assert.strictEqual(result, null)
    db.close()
  })

  test('reconstructed SessionSummaryCard round-trips correctly', async () => {
    const db = await openDb()
    const card = makeCard()
    await seedDb(db, [card])
    const reader = new DatabaseReader(db, makeStorageUri())
    const [row] = reader.listSessions()
    assert.strictEqual(row.sessionId, card.sessionId)
    assert.strictEqual(row.traceId, card.traceId)
    assert.strictEqual(row.source, card.source)
    assert.strictEqual(row.model, card.model)
    assert.strictEqual(row.inputTokens, card.inputTokens)
    assert.strictEqual(row.totalToolCalls, card.totalToolCalls)
    assert.deepStrictEqual(row.toolCounts, card.toolCounts)
    assert.deepStrictEqual(row.filesRead, card.filesRead)
    assert.strictEqual(row.outcome, card.outcome)
    db.close()
  })
})
