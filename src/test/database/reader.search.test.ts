import * as assert from 'assert'
import * as path from 'path'
import type * as vscode from 'vscode'
import { SCHEMA_SQL } from '../../database/schema'
import { DatabaseWriter } from '../../database/writer'
import { DatabaseReader, type SearchQuery } from '../../database/reader'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

// searchSessions is the real backend query builder behind the webview's bounded-time-range
// fetch (media/src/App.tsx's TimeRangePicker.fireSearch) and the uncapped Export path — the
// SQLite analogue of a hosted app's server-side query. listSessions (reader.test.ts) already
// covers the simpler unfiltered-list path; this file is dedicated to searchSessions's own
// conditions/orderBy/limit-offset logic, which had no prior coverage at all.

// ── Helpers (mirrors reader.test.ts) ─────────────────────────────────────────────

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
  return require('vscode').Uri.file('/tmp/traceroost-reader-search-test')
}

function makeCard(overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-1',
    traceId: 'trace-1',
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
    filesRead: [],
    filesSearched: [],
    filesChanged: [],
    filesWritten: [],
    filesChangedNote: undefined,
    toolCounts: {},
    totalToolCalls: 0,
    totalLlmCalls: 1,
    errors: 0,
    outcome: 'tool_calls',
    timeline: [],
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

function ids(sessions: SessionSummaryCard[]): string[] {
  return sessions.map(s => s.sessionId)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Note: text-filter matching (prompt / session_id / trace_id) and one orderBy example already
// have coverage in reader.analytics.test.ts's own 'DatabaseReader.searchSessions' suite — this
// file picks up from there rather than repeating it: every other filter, every remaining sort
// column and direction, and the allow-list fallback behavior neither file covered yet.

suite('DatabaseReader.searchSessions — filters', () => {
  test('source filter narrows to an exact match', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'a', source: 'copilot' }),
      makeCard({ sessionId: 'b', source: 'claude_code' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    assert.deepStrictEqual(ids(reader.searchSessions({ source: 'claude_code' }).sessions), ['b'])
    db.close()
  })

  test('model filter narrows to an exact match', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'a', model: 'gpt-4o' }),
      makeCard({ sessionId: 'b', model: 'claude-3' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    assert.deepStrictEqual(ids(reader.searchSessions({ model: 'claude-3' }).sessions), ['b'])
    db.close()
  })

  test('since/until bound the start_time window inclusively', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'before', startTime: '2024-01-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'inside', startTime: '2024-02-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'after', startTime: '2024-03-01T00:00:00.000Z' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    const since = new Date('2024-01-15T00:00:00.000Z').getTime()
    const until = new Date('2024-02-15T00:00:00.000Z').getTime()
    assert.deepStrictEqual(ids(reader.searchSessions({ since, until }).sessions), ['inside'])
    db.close()
  })

  test('minCostUsd excludes sessions below the threshold', async () => {
    const db = await openDb()
    // gpt-4o priced via pricing.ts; token volumes chosen to land clearly above/below the threshold
    await seedDb(db, [
      makeCard({ sessionId: 'cheap', model: 'gpt-4o', inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }),
      makeCard({ sessionId: 'expensive', model: 'gpt-4o', inputTokens: 100000, outputTokens: 100000, cacheReadTokens: 0, cacheCreateTokens: 0 }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    const { sessions } = reader.searchSessions({ minCostUsd: 0.01 })
    assert.deepStrictEqual(ids(sessions), ['expensive'])
    db.close()
  })

  test('sidechain sessions are always excluded, filters or not', async () => {
    const db = await openDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    w.enqueue(makeCard({ sessionId: 'main' }), 'ws')
    w.enqueue(makeCard({ sessionId: 'side' }), 'ws')
    await w.drain()
    // Flip is_sidechain directly — DatabaseWriter has no public knob for it and it's an internal
    // classification (sub-agent/Task-tool spans), same as the writer/reader tests' own approach
    // for state not exposed on SessionSummaryCard.
    db.run(`UPDATE sessions SET is_sidechain = 1 WHERE session_id = 'side'`)
    const reader = new DatabaseReader(db, makeStorageUri())
    assert.deepStrictEqual(ids(reader.searchSessions({}).sessions), ['main'])
    db.close()
  })

  test('synth-prefixed (in-progress placeholder) sessions are always excluded', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'synth-abc123' }),
      makeCard({ sessionId: 'real-session' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    assert.deepStrictEqual(ids(reader.searchSessions({}).sessions), ['real-session'])
    db.close()
  })

  test('combined filters (source + model + since) all narrow together', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'match', source: 'claude_code', model: 'claude-3', startTime: '2024-06-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'wrong-source', source: 'copilot', model: 'claude-3', startTime: '2024-06-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'wrong-model', source: 'claude_code', model: 'gpt-4o', startTime: '2024-06-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'too-old', source: 'claude_code', model: 'claude-3', startTime: '2023-01-01T00:00:00.000Z' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    const since = new Date('2024-01-01T00:00:00.000Z').getTime()
    const { sessions } = reader.searchSessions({ source: 'claude_code', model: 'claude-3', since })
    assert.deepStrictEqual(ids(sessions), ['match'])
    db.close()
  })

  test('totalCount reflects the full filtered set, not the limit-capped page', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'a', source: 'claude_code' }),
      makeCard({ sessionId: 'b', source: 'claude_code' }),
      makeCard({ sessionId: 'c', source: 'claude_code' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    const { sessions, totalCount } = reader.searchSessions({ source: 'claude_code', limit: 2 })
    assert.strictEqual(sessions.length, 2)
    assert.strictEqual(totalCount, 3)
    db.close()
  })
})

suite('DatabaseReader.searchSessions — sort', () => {
  const ALLOWED_ORDER_KEYS: NonNullable<SearchQuery['orderBy']>[] = [
    'start_time', 'cost_usd', 'total_tokens', 'duration_ms', 'errors',
  ]

  test('start_time sorts chronologically, both directions', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'mid', startTime: '2024-02-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'old', startTime: '2024-01-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'new', startTime: '2024-03-01T00:00:00.000Z' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    assert.deepStrictEqual(
      ids(reader.searchSessions({ orderBy: 'start_time', orderDir: 'DESC' }).sessions),
      ['new', 'mid', 'old'],
    )
    assert.deepStrictEqual(
      ids(reader.searchSessions({ orderBy: 'start_time', orderDir: 'ASC' }).sessions),
      ['old', 'mid', 'new'],
    )
    db.close()
  })

  test('duration_ms sorts numerically, both directions', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'a', durationMs: 5000 }),
      makeCard({ sessionId: 'b', durationMs: 500 }),
      makeCard({ sessionId: 'c', durationMs: 50000 }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    assert.deepStrictEqual(
      ids(reader.searchSessions({ orderBy: 'duration_ms', orderDir: 'DESC' }).sessions),
      ['c', 'a', 'b'],
    )
    assert.deepStrictEqual(
      ids(reader.searchSessions({ orderBy: 'duration_ms', orderDir: 'ASC' }).sessions),
      ['b', 'a', 'c'],
    )
    db.close()
  })

  test('errors sorts numerically, both directions', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'a', errors: 0 }),
      makeCard({ sessionId: 'b', errors: 5 }),
      makeCard({ sessionId: 'c', errors: 2 }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    assert.deepStrictEqual(
      ids(reader.searchSessions({ orderBy: 'errors', orderDir: 'DESC' }).sessions),
      ['b', 'c', 'a'],
    )
    assert.deepStrictEqual(
      ids(reader.searchSessions({ orderBy: 'errors', orderDir: 'ASC' }).sessions),
      ['a', 'c', 'b'],
    )
    db.close()
  })

  test('total_tokens sorts by input+output tokens, a computed expression, both directions', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'a', inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 }), // 200
      makeCard({ sessionId: 'b', inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheCreateTokens: 0 }), // 2000
      makeCard({ sessionId: 'c', inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }), // 500
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    assert.deepStrictEqual(
      ids(reader.searchSessions({ orderBy: 'total_tokens', orderDir: 'DESC' }).sessions),
      ['b', 'c', 'a'],
    )
    assert.deepStrictEqual(
      ids(reader.searchSessions({ orderBy: 'total_tokens', orderDir: 'ASC' }).sessions),
      ['a', 'c', 'b'],
    )
    db.close()
  })

  test('cost_usd sorts by the stored cost column, both directions', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'cheap', model: 'gpt-4o', inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }),
      makeCard({ sessionId: 'expensive', model: 'gpt-4o', inputTokens: 100000, outputTokens: 100000, cacheReadTokens: 0, cacheCreateTokens: 0 }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    assert.deepStrictEqual(
      ids(reader.searchSessions({ orderBy: 'cost_usd', orderDir: 'DESC' }).sessions),
      ['expensive', 'cheap'],
    )
    assert.deepStrictEqual(
      ids(reader.searchSessions({ orderBy: 'cost_usd', orderDir: 'ASC' }).sessions),
      ['cheap', 'expensive'],
    )
    db.close()
  })

  test('an orderBy key outside the allow-list falls back to start_time rather than erroring', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'old', startTime: '2024-01-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'new', startTime: '2024-02-01T00:00:00.000Z' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    // Cast past the type since this specifically exercises a client-controlled value arriving
    // outside the allow-list (SearchQuery.orderBy's own runtime guard, reader.ts's allowedOrder set).
    const { sessions } = reader.searchSessions({ orderBy: 'user_request; DROP TABLE sessions;--' as SearchQuery['orderBy'], orderDir: 'DESC' })
    assert.deepStrictEqual(ids(sessions), ['new', 'old']) // same as start_time DESC
    db.close()
  })

  test('an unrecognized orderDir falls back to DESC', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'old', startTime: '2024-01-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'new', startTime: '2024-02-01T00:00:00.000Z' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    const { sessions } = reader.searchSessions({ orderDir: 'sideways' as SearchQuery['orderDir'] })
    assert.deepStrictEqual(ids(sessions), ['new', 'old'])
    db.close()
  })

  test('every allowed sort key returns the full, unfiltered row count', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'a' }),
      makeCard({ sessionId: 'b' }),
      makeCard({ sessionId: 'c' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    for (const orderBy of ALLOWED_ORDER_KEYS) {
      for (const orderDir of ['ASC', 'DESC'] as const) {
        const { sessions } = reader.searchSessions({ orderBy, orderDir })
        assert.strictEqual(sessions.length, 3, `${orderBy} ${orderDir} dropped a row`)
      }
    }
    db.close()
  })
})

suite('DatabaseReader.searchSessions — pagination', () => {
  test('limit caps the page size', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'a', startTime: '2024-01-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'b', startTime: '2024-01-02T00:00:00.000Z' }),
      makeCard({ sessionId: 'c', startTime: '2024-01-03T00:00:00.000Z' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    const { sessions } = reader.searchSessions({ limit: 2, orderBy: 'start_time', orderDir: 'ASC' })
    assert.deepStrictEqual(ids(sessions), ['a', 'b'])
    db.close()
  })

  test('offset pages past the first limit-sized window without overlap or gaps', async () => {
    const db = await openDb()
    await seedDb(db, [
      makeCard({ sessionId: 'a', startTime: '2024-01-01T00:00:00.000Z' }),
      makeCard({ sessionId: 'b', startTime: '2024-01-02T00:00:00.000Z' }),
      makeCard({ sessionId: 'c', startTime: '2024-01-03T00:00:00.000Z' }),
    ])
    const reader = new DatabaseReader(db, makeStorageUri())
    const page1 = reader.searchSessions({ limit: 2, offset: 0, orderBy: 'start_time', orderDir: 'ASC' })
    const page2 = reader.searchSessions({ limit: 2, offset: 2, orderBy: 'start_time', orderDir: 'ASC' })
    assert.deepStrictEqual(ids(page1.sessions), ['a', 'b'])
    assert.deepStrictEqual(ids(page2.sessions), ['c'])
    assert.strictEqual(page1.totalCount, 3)
    assert.strictEqual(page2.totalCount, 3)
    db.close()
  })

  test('defaults to a limit of 50 and offset of 0 when omitted', async () => {
    const db = await openDb()
    const cards = Array.from({ length: 60 }, (_, i) =>
      makeCard({ sessionId: `s${i}`, startTime: new Date(2024, 0, 1 + i).toISOString() }))
    await seedDb(db, cards)
    const reader = new DatabaseReader(db, makeStorageUri())
    const { sessions, totalCount } = reader.searchSessions({})
    assert.strictEqual(sessions.length, 50)
    assert.strictEqual(totalCount, 60)
    db.close()
  })
})
