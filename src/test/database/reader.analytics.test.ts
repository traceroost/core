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
  return { scheme: 'file', path: '/tmp/traceroost-analytics-test', fsPath: '/tmp/traceroost-analytics-test' } as unknown as vscode.Uri
}

function makeCard(overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId:         'sess-1',
    traceId:           'trace-1',
    source:            'copilot',
    dataSource:        'otel',
    workspace:         '',
    userRequest:       'build the thing',
    model:             'claude-sonnet-4-6',
    turns:             3,
    inputTokens:       5000,
    outputTokens:      800,
    cacheReadTokens:   1000,
    cacheCreateTokens: 200,
    cacheHitRate:      0.2,
    durationMs:        9000,
    startTime:         '2025-01-15T10:00:00.000Z',
    filesRead:         [],
    filesSearched:     [],
    filesChanged:      [],
    filesWritten:      [],
    toolCounts:        {},
    totalToolCalls:    2,
    totalLlmCalls:     3,
    errors:            0,
    outcome:           'tool_calls',
    timeline:          [],
    backgroundSpans:   [],
    loopSignals:       [],
    ...overrides,
  }
}

// ── queryDailyStats ───────────────────────────────────────────────────────────

suite('DatabaseReader.queryDailyStats', () => {
  test('returns rows in ascending date order', async () => {
    const db = await openDb()
    const storageUri = makeStorageUri()
    const writer = new DatabaseWriter(db, storageUri, () => {})
    const reader = new DatabaseReader(db, storageUri)

    writer.enqueue(makeCard({ sessionId: 'a', startTime: '2025-01-15T10:00:00.000Z', inputTokens: 100, outputTokens: 20 }), 'ws')
    writer.enqueue(makeCard({ sessionId: 'b', startTime: '2025-01-16T10:00:00.000Z', inputTokens: 200, outputTokens: 40 }), 'ws')
    await writer.drain()

    const since = new Date('2025-01-01').getTime()
    const rows = reader.queryDailyStats({ since })
    assert.ok(rows.length >= 2, 'Should return at least 2 rows')
    assert.ok(rows[0].day < rows[1].day, 'Rows should be sorted ASC by date')
  })

  test('excludes rows before since cutoff', async () => {
    const db = await openDb()
    const storageUri = makeStorageUri()
    const writer = new DatabaseWriter(db, storageUri, () => {})
    const reader = new DatabaseReader(db, storageUri)

    writer.enqueue(makeCard({ sessionId: 'old', startTime: '2024-01-01T00:00:00.000Z' }), 'ws')
    writer.enqueue(makeCard({ sessionId: 'new', startTime: '2025-06-01T00:00:00.000Z' }), 'ws')
    await writer.drain()

    const since = new Date('2025-01-01').getTime()
    const rows = reader.queryDailyStats({ since })
    assert.ok(rows.every(r => r.day >= '2025-01-01'), 'All rows should be on or after since date')
  })

  test('source filter restricts results', async () => {
    const db = await openDb()
    const storageUri = makeStorageUri()
    const writer = new DatabaseWriter(db, storageUri, () => {})
    const reader = new DatabaseReader(db, storageUri)

    writer.enqueue(makeCard({ sessionId: 'cop', source: 'copilot',    startTime: '2025-06-01T10:00:00.000Z' }), 'ws')
    writer.enqueue(makeCard({ sessionId: 'cla', source: 'claude_code',startTime: '2025-06-01T11:00:00.000Z' }), 'ws')
    await writer.drain()

    const since = new Date('2025-01-01').getTime()
    const rows = reader.queryDailyStats({ since, source: 'copilot' })
    // The SQL filters by source so totals should only reflect copilot
    assert.ok(rows.length >= 1)
    // Should have 1 row for 2025-06-01 with sessionCount 1 (copilot only)
    const jun1 = rows.find(r => r.day === '2025-06-01')
    assert.ok(jun1, 'Should have a row for 2025-06-01')
    assert.strictEqual(jun1.sessionCount, 1)
  })
})

// ── queryLifetimeStats ────────────────────────────────────────────────────────

suite('DatabaseReader.queryLifetimeStats', () => {
  test('returns zeros for empty database', async () => {
    const db = await openDb()
    const reader = new DatabaseReader(db, makeStorageUri())
    const stats = reader.queryLifetimeStats()
    assert.strictEqual(stats.totalSessions, 0)
    assert.strictEqual(stats.totalTokens, 0)
  })

  test('sums sessions correctly', async () => {
    const db = await openDb()
    const storageUri = makeStorageUri()
    const writer = new DatabaseWriter(db, storageUri, () => {})
    const reader = new DatabaseReader(db, storageUri)

    writer.enqueue(makeCard({ sessionId: 'x1', inputTokens: 1000, outputTokens: 200, startTime: '2025-01-15T10:00:00.000Z' }), 'ws')
    writer.enqueue(makeCard({ sessionId: 'x2', inputTokens: 500,  outputTokens: 100, startTime: '2025-01-16T10:00:00.000Z' }), 'ws')
    await writer.drain()

    const stats = reader.queryLifetimeStats()
    assert.strictEqual(stats.totalSessions, 2)
    assert.strictEqual(stats.totalTokens, 1000 + 200 + 500 + 100)
    assert.ok(stats.oldestSessionMs <= stats.newestSessionMs)
  })
})

// ── searchSessions ────────────────────────────────────────────────────────────

suite('DatabaseReader.searchSessions', () => {
  test('text filter matches user_request', async () => {
    const db = await openDb()
    const storageUri = makeStorageUri()
    const writer = new DatabaseWriter(db, storageUri, () => {})
    const reader = new DatabaseReader(db, storageUri)

    writer.enqueue(makeCard({ sessionId: 's1', userRequest: 'fix the login bug' }), 'ws')
    writer.enqueue(makeCard({ sessionId: 's2', userRequest: 'write unit tests' }), 'ws')
    await writer.drain()

    const result = reader.searchSessions({ text: 'login', limit: 10, offset: 0 })
    assert.strictEqual(result.sessions.length, 1)
    assert.strictEqual(result.sessions[0].sessionId, 's1')
    assert.strictEqual(result.totalCount, 1)
  })

  test('orderBy cost_usd returns sessions in correct order', async () => {
    const db = await openDb()
    const storageUri = makeStorageUri()
    const writer = new DatabaseWriter(db, storageUri, () => {})
    const reader = new DatabaseReader(db, storageUri)

    // claude-sonnet-4-6 has known rates, so cost_usd will be non-zero
    writer.enqueue(makeCard({ sessionId: 'cheap', model: 'claude-sonnet-4-6', inputTokens: 100,   outputTokens: 20 }),  'ws')
    writer.enqueue(makeCard({ sessionId: 'pricey',model: 'claude-sonnet-4-6', inputTokens: 50000, outputTokens: 5000 }), 'ws')
    await writer.drain()

    const result = reader.searchSessions({ orderBy: 'cost_usd', orderDir: 'DESC', limit: 10, offset: 0 })
    assert.ok(result.sessions.length >= 2)
    assert.strictEqual(result.sessions[0].sessionId, 'pricey')
  })

  test('pagination returns correct slice and totalCount', async () => {
    const db = await openDb()
    const storageUri = makeStorageUri()
    const writer = new DatabaseWriter(db, storageUri, () => {})
    const reader = new DatabaseReader(db, storageUri)

    for (let i = 0; i < 5; i++) {
      writer.enqueue(makeCard({ sessionId: `p${i}`, userRequest: 'paginate me' }), 'ws')
    }
    await writer.drain()

    const page1 = reader.searchSessions({ text: 'paginate', limit: 2, offset: 0 })
    assert.strictEqual(page1.totalCount, 5)
    assert.strictEqual(page1.sessions.length, 2)

    const page2 = reader.searchSessions({ text: 'paginate', limit: 2, offset: 2 })
    assert.strictEqual(page2.totalCount, 5)
    assert.strictEqual(page2.sessions.length, 2)

    const page3 = reader.searchSessions({ text: 'paginate', limit: 2, offset: 4 })
    assert.strictEqual(page3.totalCount, 5)
    assert.strictEqual(page3.sessions.length, 1)
  })
})

// ── queryBurnRate ─────────────────────────────────────────────────────────────

suite('DatabaseReader.queryBurnRate', () => {
  test('returns null for sessions with fewer than 2 LLM entries', async () => {
    const db = await openDb()
    const storageUri = makeStorageUri()
    const writer = new DatabaseWriter(db, storageUri, () => {})
    const reader = new DatabaseReader(db, storageUri)

    writer.enqueue(makeCard({
      sessionId: 'br1',
      timeline: [
        { type: 'llm', spanId: 'sp1', label: 'LLM', durationMs: 500, isError: false,
          timestamp: '2025-06-01T10:00:00.000Z', inputTokens: 100, outputTokens: 20 },
      ],
    }), 'ws')
    await writer.drain()

    const result = reader.queryBurnRate('br1')
    assert.strictEqual(result, null, 'Should be null with < 2 LLM entries')
  })

  test('computes tokensPerMinute from entry timestamps', async () => {
    const db = await openDb()
    const storageUri = makeStorageUri()
    const writer = new DatabaseWriter(db, storageUri, () => {})
    const reader = new DatabaseReader(db, storageUri)

    // Two LLM entries 2 minutes apart, 200 total tokens
    writer.enqueue(makeCard({
      sessionId: 'br2',
      model: 'claude-sonnet-4-6',
      inputTokens: 150,
      outputTokens: 50,
      timeline: [
        { type: 'llm', spanId: 'sp1', label: 'LLM', durationMs: 1000, isError: false,
          timestamp: '2025-06-01T10:00:00.000Z', inputTokens: 80, outputTokens: 20 },
        { type: 'llm', spanId: 'sp2', label: 'LLM', durationMs: 1000, isError: false,
          timestamp: '2025-06-01T10:02:00.000Z', inputTokens: 70, outputTokens: 30 },
      ],
    }), 'ws')
    await writer.drain()

    const result = reader.queryBurnRate('br2')
    assert.ok(result !== null, 'Should return a BurnRate result')
    // 200 tokens over 2 minutes = 100 tok/min
    assert.ok(Math.abs(result.burnRate.tokensPerMinute - 100) < 5, 'tokensPerMinute should be ~100')
    assert.ok(result.burnRate.costPerHour >= 0, 'costPerHour should be non-negative')
    // Claude sonnet has known context window, so projection should be non-null
    assert.ok(result.projection !== null, 'Should have projection for known model')
  })
})
