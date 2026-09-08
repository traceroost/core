import * as assert from 'assert'
import * as path from 'path'
import type * as vscode from 'vscode'
import { SCHEMA_SQL } from '../../database/schema'
import { DatabaseWriter } from '../../database/writer'
import { calcTokenCostUsd } from '../../pricing'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

// ── Helpers ───────────────────────────────────────────────────────────────────

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  export(): Uint8Array
  close(): void
}

async function openInMemoryDb(): Promise<SqlDb> {
  // Locate the sql.js WASM binary relative to the package entry point.
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

function makeCard(overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-1',
    traceId: 'trace-1',
    source: 'claude_code',
    dataSource: 'otel',
    workspace: '',
    userRequest: 'test prompt',
    model: 'claude-sonnet',
    turns: 2,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheCreateTokens: 100,
    cacheHitRate: 0.5,
    durationMs: 5000,
    startTime: '2024-01-01T00:00:00.000Z',
    filesRead: ['a.ts'],
    filesSearched: [],
    filesChanged: ['b.ts'],
    filesWritten: [],
    filesChangedNote: undefined,
    toolCounts: { Bash: 3 },
    totalToolCalls: 3,
    totalLlmCalls: 2,
    errors: 0,
    outcome: 'text_response',
    timeline: [],
    backgroundSpans: [],
    loopSignals: [],
    ...overrides,
  }
}

function makeStorageUri(tag = 'test'): vscode.Uri {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('vscode').Uri.file(`/tmp/traceroost-${tag}`)
}

function queryInt(db: SqlDb, sql: string): number {
  const result = db.exec(sql)
  return result[0]?.values[0]?.[0] as number ?? 0
}

function queryValue(db: SqlDb, sql: string): unknown {
  const result = db.exec(sql)
  return result[0]?.values[0]?.[0]
}

function countRows(db: SqlDb, table: string): number {
  return queryInt(db, `SELECT COUNT(*) FROM ${table}`)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('DatabaseWriter', () => {
  test('writeSession inserts one row into sessions for a minimal card', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    w.enqueue(makeCard(), 'ws-root')
    await w.drain()
    assert.strictEqual(countRows(db, 'sessions'), 1)
    db.close()
  })

  test('writing the same session twice does not create duplicate rows', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    w.enqueue(makeCard(), 'ws-root')
    await w.drain()
    w.enqueue(makeCard({ model: 'claude-opus' }), 'ws-root')
    await w.drain()
    assert.strictEqual(countRows(db, 'sessions'), 1)
    db.close()
  })

  test('timeline_entries has correct count after a write', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    const card = makeCard({
      timeline: [
        { type: 'llm', spanId: 'sp-1', label: 'LLM', durationMs: 100, isError: false, timestamp: '' },
        { type: 'tool', spanId: 'sp-2', label: 'Bash', durationMs: 50, isError: false, timestamp: '' },
      ],
    })
    w.enqueue(card, 'ws')
    await w.drain()
    assert.strictEqual(countRows(db, 'timeline_entries'), 2)
    db.close()
  })

  test('edit_details rows are created for entries that have editDetails', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    const card = makeCard({
      timeline: [{
        type: 'tool', spanId: 'sp-1', label: 'Edit', durationMs: 50, isError: false, timestamp: '',
        editDetails: [
          { filePath: 'src/foo.ts', toolName: 'Edit' },
          { filePath: 'src/bar.ts', toolName: 'Edit' },
        ],
      }],
    })
    w.enqueue(card, 'ws')
    await w.drain()
    assert.strictEqual(countRows(db, 'timeline_entries'), 1)
    assert.strictEqual(countRows(db, 'edit_details'), 2)
    db.close()
  })

  test('re-writing a session with fewer entries removes stale entries', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    const card = makeCard({
      timeline: [
        { type: 'llm', spanId: 'sp-1', label: 'LLM', durationMs: 100, isError: false, timestamp: '' },
        { type: 'tool', spanId: 'sp-2', label: 'Bash', durationMs: 50, isError: false, timestamp: '' },
        { type: 'tool', spanId: 'sp-3', label: 'Read', durationMs: 30, isError: false, timestamp: '' },
      ],
    })
    w.enqueue(card, 'ws')
    await w.drain()
    assert.strictEqual(countRows(db, 'timeline_entries'), 3)

    const smaller = makeCard({ timeline: [{ type: 'llm', spanId: 'sp-1', label: 'LLM', durationMs: 100, isError: false, timestamp: '' }] })
    w.enqueue(smaller, 'ws')
    await w.drain()
    assert.strictEqual(countRows(db, 'timeline_entries'), 1)
    db.close()
  })

  test('blob files are written for string fields at or above the threshold', async () => {
    const written: string[] = []
    const fakeFs = {
      stat:      () => Promise.reject(new Error('not found')),
      writeFile: (_uri: vscode.Uri) => { written.push(_uri.path); return Promise.resolve() },
    }
    const db = await openInMemoryDb()
    const longText = 'x'.repeat(600)
    const card = makeCard({
      timeline: [{
        type: 'llm', spanId: 'sp-blob', label: 'LLM', durationMs: 100,
        isError: false, timestamp: '', responseText: longText,
      }],
    })
    const w = new DatabaseWriter(db, makeStorageUri('blob'), () => {}, fakeFs as unknown as typeof import('vscode').workspace.fs)
    w.enqueue(card, 'ws')
    await w.drain()
    assert.ok(written.some(p => p.includes('sp-blob-response.txt')), 'response blob not written')
    db.close()
  })

  test('blob files are not re-written when they already exist', async () => {
    const writeCount = { n: 0 }
    const fakeFs = {
      stat:      () => Promise.resolve({}),  // file exists
      writeFile: () => { writeCount.n++; return Promise.resolve() },
    }
    const db = await openInMemoryDb()
    const longText = 'x'.repeat(600)
    const card = makeCard({
      timeline: [{
        type: 'llm', spanId: 'sp-exists', label: 'LLM', durationMs: 100,
        isError: false, timestamp: '', responseText: longText,
      }],
    })
    const w = new DatabaseWriter(db, makeStorageUri('exists'), () => {}, fakeFs as unknown as typeof import('vscode').workspace.fs)
    w.enqueue(card, 'ws')
    await w.drain()
    assert.strictEqual(writeCount.n, 0, 'should not write when file already exists')
    db.close()
  })

  test('write failure is caught and does not throw from enqueue', async () => {
    const logs: string[] = []
    const db = await openInMemoryDb()
    db.close()  // close to force SQL errors on next use

    const w = new DatabaseWriter(db, makeStorageUri(), (msg) => logs.push(msg))
    let threw = false
    try {
      w.enqueue(makeCard(), 'ws')
      await w.drain()
    } catch {
      threw = true
    }
    assert.ok(!threw, 'enqueue/drain should not throw on DB error')
    assert.ok(logs.length > 0, 'error should be logged')
  })

  test('clearAll leaves all three tables empty', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    const card = makeCard({
      timeline: [{
        type: 'tool', spanId: 'sp-1', label: 'Edit', durationMs: 10,
        isError: false, timestamp: '',
        editDetails: [{ filePath: 'x.ts' }],
      }],
    })
    w.enqueue(card, 'ws')
    await w.drain()
    assert.ok(countRows(db, 'sessions') > 0)

    w.clearAll()
    assert.strictEqual(countRows(db, 'sessions'), 0)
    assert.strictEqual(countRows(db, 'timeline_entries'), 0)
    assert.strictEqual(countRows(db, 'edit_details'), 0)
    db.close()
  })

  test('cost_usd for a single-model session matches pricing the aggregate totals at that model', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri('cost-single'), () => {})
    const card = makeCard({
      model: 'claude-opus-4',
      inputTokens: 1000, cacheReadTokens: 500, cacheCreateTokens: 100, outputTokens: 200,
      timeline: [
        { type: 'llm', spanId: 'sp-1', label: 'LLM', model: 'claude-opus-4', durationMs: 100, isError: false, timestamp: '', inputTokens: 600, cacheReadTokens: 300, cacheCreateTokens: 60, outputTokens: 120 },
        { type: 'llm', spanId: 'sp-2', label: 'LLM', model: 'claude-opus-4', durationMs: 100, isError: false, timestamp: '', inputTokens: 400, cacheReadTokens: 200, cacheCreateTokens: 40, outputTokens: 80 },
      ],
    })
    w.enqueue(card, 'ws')
    await w.drain()
    const expected = calcTokenCostUsd(400, 500, 100, 200, 'claude-opus-4')
    const actual = queryValue(db, `SELECT cost_usd FROM sessions WHERE session_id = 'sess-1'`) as number
    assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`)
    db.close()
  })

  test('cost_usd for a multi-model session prices each LLM call at its own model, not the aggregate at one model', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri('cost-multi'), () => {})
    // A session where a Task-tool subagent runs on a cheap model while the main
    // loop runs on an expensive one — mirrors real Claude Code sessions.
    const card = makeCard({
      model: 'claude-opus-4',       // dominant model (higher token weight)
      models: ['claude-opus-4', 'claude-haiku-4-5'],
      inputTokens: 1100, cacheReadTokens: 0, cacheCreateTokens: 0, outputTokens: 300,
      timeline: [
        { type: 'llm', spanId: 'sp-opus', label: 'LLM', model: 'claude-opus-4', durationMs: 100, isError: false, timestamp: '', inputTokens: 1000, outputTokens: 200 },
        { type: 'llm', spanId: 'sp-haiku', label: 'LLM', model: 'claude-haiku-4-5', durationMs: 100, isError: false, timestamp: '', inputTokens: 100, outputTokens: 100 },
      ],
    })
    w.enqueue(card, 'ws')
    await w.drain()

    const wrongIfPricedAsOneModel = calcTokenCostUsd(1100, 0, 0, 300, 'claude-opus-4')
    const correct = calcTokenCostUsd(1000, 0, 0, 200, 'claude-opus-4')
      + calcTokenCostUsd(100, 0, 0, 100, 'claude-haiku-4-5')

    const actual = queryValue(db, `SELECT cost_usd FROM sessions WHERE session_id = 'sess-1'`) as number
    assert.ok(Math.abs(actual - correct) < 1e-9, `expected ${correct}, got ${actual}`)
    assert.notStrictEqual(actual, wrongIfPricedAsOneModel, 'must not price every token at the dominant model\'s rate')
    db.close()
  })

  test('models column round-trips as JSON', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri('models-col'), () => {})
    w.enqueue(makeCard({ model: 'claude-opus-4', models: ['claude-opus-4', 'claude-haiku-4-5'] }), 'ws')
    await w.drain()
    const raw = queryValue(db, `SELECT models FROM sessions WHERE session_id = 'sess-1'`) as string
    assert.deepStrictEqual(JSON.parse(raw), ['claude-opus-4', 'claude-haiku-4-5'])
    db.close()
  })

  test('models column defaults to [model] when the card has no models array', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri('models-default'), () => {})
    w.enqueue(makeCard({ model: 'claude-sonnet' }), 'ws')
    await w.drain()
    const raw = queryValue(db, `SELECT models FROM sessions WHERE session_id = 'sess-1'`) as string
    assert.deepStrictEqual(JSON.parse(raw), ['claude-sonnet'])
    db.close()
  })
})
