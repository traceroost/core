import * as assert from 'assert'
import * as path from 'path'
import type * as vscode from 'vscode'
import { SCHEMA_SQL } from '../../database/schema'
import { DatabaseWriter } from '../../database/writer'
import { calcTokenCostUsd } from '../../pricing'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'
import type { SqlStatement } from '../../database/db'

// ── Helpers ───────────────────────────────────────────────────────────────────

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  prepare(sql: string): SqlStatement
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

  test('enqueue prefers a non-empty card.workspace over the fallback workspace argument', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    const card = makeCard({ workspace: '/Users/rogerreed/traceroost/core' })
    w.enqueue(card, '/Users/rogerreed/some-other-open-folder')
    await w.drain()
    assert.strictEqual(card.workspace, '/Users/rogerreed/traceroost/core')
    assert.strictEqual(queryValue(db, `SELECT workspace FROM sessions WHERE session_id = 'sess-1'`), '/Users/rogerreed/traceroost/core')
    db.close()
  })

  test('enqueue falls back to the workspace argument when card.workspace is empty', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    const card = makeCard({ workspace: '' })
    w.enqueue(card, '/Users/rogerreed/some-open-folder')
    await w.drain()
    assert.strictEqual(card.workspace, '/Users/rogerreed/some-open-folder')
    assert.strictEqual(queryValue(db, `SELECT workspace FROM sessions WHERE session_id = 'sess-1'`), '/Users/rogerreed/some-open-folder')
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

  test('each edit_details row points at its own timeline entry (prepared-statement row ids)', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    const entry = (spanId: string, files: string[]) => ({
      type: 'tool' as const, spanId, label: 'Edit', durationMs: 1, isError: false, timestamp: '',
      editDetails: files.map(filePath => ({ filePath, toolName: 'Edit' })),
    })
    w.enqueue(makeCard({ sessionId: 'a', timeline: [entry('a1', ['x.ts']), entry('a2', []), entry('a3', ['y.ts', 'z.ts'])] }), 'ws')
    w.enqueue(makeCard({ sessionId: 'b', timeline: [entry('b1', ['w.ts'])] }), 'ws')
    await w.drain()
    const rows = db.exec(`SELECT te.span_id, ed.file_path FROM edit_details ed
      JOIN timeline_entries te ON te.id = ed.timeline_entry_id ORDER BY ed.id`)[0].values
    assert.deepStrictEqual(rows, [['a1', 'x.ts'], ['a3', 'y.ts'], ['a3', 'z.ts'], ['b1', 'w.ts']])
    db.close()
  })

  test('writes keep working after export() (which frees every prepared statement)', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    const tl = [{ type: 'llm' as const, spanId: 'sp', label: 'LLM', durationMs: 1, isError: false, timestamp: '' }]
    w.enqueue(makeCard({ sessionId: 's1', timeline: tl }), 'ws')
    await w.drain()
    db.export()
    w.enqueue(makeCard({ sessionId: 's2', timeline: tl }), 'ws')
    await w.drain()
    assert.strictEqual(countRows(db, 'sessions'), 2)
    assert.strictEqual(countRows(db, 'timeline_entries'), 2)
    db.close()
  })

  test('a write that fails part-way is rolled back whole', async () => {
    const db = await openInMemoryDb()
    const logs: string[] = []
    const w = new DatabaseWriter(db, makeStorageUri(), (m) => logs.push(m))
    const bad = makeCard({
      sessionId: 'bad',
      timeline: [
        { type: 'llm', spanId: 'ok', label: 'LLM', durationMs: 1, isError: false, timestamp: '' },
        // NOT NULL span_id — fails on the second row, after the session row and one entry.
        { type: 'llm', spanId: null as unknown as string, label: 'LLM', durationMs: 1, isError: false, timestamp: '' },
      ],
    })
    w.enqueue(bad, 'ws')
    await w.drain()
    assert.ok(logs.some(m => m.includes('write error for session bad')))
    assert.strictEqual(countRows(db, 'sessions'), 0)
    assert.strictEqual(countRows(db, 'timeline_entries'), 0)
    // The connection is still usable afterwards.
    w.enqueue(makeCard({ sessionId: 'good' }), 'ws')
    await w.drain()
    assert.strictEqual(countRows(db, 'sessions'), 1)
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

// ── Claude OTEL + log double counting ────────────────────────────────────────
// Claude's OTEL cards are per interaction (session_id = interaction spanId) while its log cards
// are per transcript (session_id = transcript id = Claude Code's session.id). The shared key is
// claudeConversationKey — OTEL wins whichever order the two arrive in.

suite('DatabaseWriter — Claude OTEL/log dedupe', () => {
  const T0 = '2024-01-01T00:00:00.000Z'
  const T0_PLUS_2M = '2024-01-01T00:02:00.000Z'
  const otelInteraction = (overrides: Partial<SessionSummaryCard> = {}) => makeCard({
    sessionId: 'interaction-span-1', traceId: 'trace-1', dataSource: 'otel',
    claudeSessionId: 'claude-session-uuid', startTime: T0_PLUS_2M, durationMs: 30_000, ...overrides,
  })
  const logTranscript = (overrides: Partial<SessionSummaryCard> = {}) => makeCard({
    sessionId: 'claude-session-uuid', traceId: 'claude-session-uuid', dataSource: 'log',
    startTime: T0, durationMs: 10 * 60_000, ...overrides,
  })

  test('a log card arriving after OTEL of the same conversation is skipped', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    w.enqueue(otelInteraction(), 'ws')
    await w.drain()
    w.enqueue(logTranscript(), 'ws')
    await w.drain()
    assert.strictEqual(countRows(db, 'sessions'), 1)
    assert.strictEqual(queryValue(db, `SELECT data_source FROM sessions`), 'otel')
    db.close()
  })

  test('an OTEL interaction replaces an already-stored log card of the same conversation', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    w.enqueue(logTranscript(), 'ws')
    await w.drain()
    w.enqueue(otelInteraction(), 'ws')
    await w.drain()
    // The same interaction written again (re-summarized on the next update) stays one row.
    w.enqueue(otelInteraction(), 'ws')
    await w.drain()
    assert.strictEqual(countRows(db, 'sessions'), 1)
    assert.strictEqual(queryValue(db, `SELECT session_id FROM sessions`), 'interaction-span-1')
    db.close()
  })

  test('a gap-split log segment outside every OTEL interaction is kept', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    w.enqueue(otelInteraction(), 'ws')
    await w.drain()
    w.enqueue(logTranscript({ sessionId: 'claude-session-uuid#1', startTime: '2024-01-02T00:00:00.000Z' }), 'ws')
    await w.drain()
    assert.strictEqual(countRows(db, 'sessions'), 2)
    db.close()
  })

  test('a subagent transcript (its own file, parent session id inside) is covered by the parent\'s OTEL', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    w.enqueue(otelInteraction({ startTime: T0, durationMs: 10 * 60_000 }), 'ws')
    await w.drain()
    w.enqueue(logTranscript({
      sessionId: 'agent-a16e8e506b6303ff4', claudeSessionId: 'claude-session-uuid',
      startTime: T0_PLUS_2M, durationMs: 60_000,
    }), 'ws')
    await w.drain()
    assert.strictEqual(countRows(db, 'sessions'), 1)
    db.close()
  })

  test('different conversations are never deduped against each other', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    w.enqueue(otelInteraction({ claudeSessionId: 'another-session' }), 'ws')
    await w.drain()
    w.enqueue(logTranscript(), 'ws')
    await w.drain()
    assert.strictEqual(countRows(db, 'sessions'), 2)
    db.close()
  })
})

suite('DatabaseWriter — OTEL downgrade guard', () => {
  test('a card with fewer calls never replaces a richer stored OTEL row', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    w.enqueue(makeCard({ totalLlmCalls: 40, totalToolCalls: 30, inputTokens: 90_000 }), 'ws')
    await w.drain()
    w.enqueue(makeCard({ totalLlmCalls: 4, totalToolCalls: 3, inputTokens: 9_000 }), 'ws')
    await w.drain()
    assert.strictEqual(queryInt(db, `SELECT input_tokens FROM sessions WHERE session_id = 'sess-1'`), 90_000)
    w.enqueue(makeCard({ totalLlmCalls: 41, totalToolCalls: 30, inputTokens: 95_000 }), 'ws')
    await w.drain()
    assert.strictEqual(queryInt(db, `SELECT input_tokens FROM sessions WHERE session_id = 'sess-1'`), 95_000)
    db.close()
  })
})

suite('DatabaseWriter — unchanged rewrites are skipped', () => {
  const withTimeline = (overrides: Partial<SessionSummaryCard> = {}) => makeCard({
    timeline: [
      { type: 'llm', spanId: 'sp-a', label: 'LLM', durationMs: 10, isError: false, timestamp: 't1' },
      { type: 'tool', spanId: 'sp-b', label: 'Edit', durationMs: 5, isError: false, timestamp: 't2',
        editDetails: [{ filePath: 'x.ts', toolName: 'Edit' }] },
    ],
    ...overrides,
  })
  const timelineIds = (db: SqlDb) => JSON.stringify(db.exec('SELECT id FROM timeline_entries ORDER BY position')[0]?.values)
  const snapshot = (db: SqlDb) => JSON.stringify([
    db.exec('SELECT session_id, model, input_tokens, workspace FROM sessions ORDER BY session_id')[0]?.values,
    db.exec('SELECT session_id, span_id, position, label FROM timeline_entries ORDER BY session_id, position')[0]?.values,
    db.exec('SELECT e.file_path, t.position FROM edit_details e JOIN timeline_entries t ON t.id = e.timeline_entry_id')[0]?.values,
  ])
  async function write(w: DatabaseWriter, card: SessionSummaryCard, ws = 'ws') {
    w.enqueue(card, ws)
    await w.drain()
  }

  test('an identical card leaves its rows in place but still refreshes created_at, as a rewrite would', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    await write(w, withTimeline())
    const ids = timelineIds(db), before = snapshot(db)
    db.run('UPDATE sessions SET created_at = 0')
    await write(w, withTimeline())
    assert.strictEqual(timelineIds(db), ids, 'timeline rows were rewritten')
    assert.strictEqual(snapshot(db), before)
    assert.ok(queryInt(db, 'SELECT created_at FROM sessions') > 0, 'created_at not refreshed')
    db.close()
  })

  test('any change to the card, or the fallback workspace it resolves to, is written', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    await write(w, withTimeline())
    const ids = timelineIds(db)
    await write(w, withTimeline({ inputTokens: 1234 }))
    assert.notStrictEqual(timelineIds(db), ids)
    assert.strictEqual(queryInt(db, 'SELECT input_tokens FROM sessions'), 1234)
    await write(w, withTimeline({ inputTokens: 1234 }), 'other-ws')
    assert.strictEqual(queryValue(db, 'SELECT workspace FROM sessions'), 'other-ws')
    const edited = withTimeline({ inputTokens: 1234 })
    edited.timeline[1].editDetails![0].filePath = 'y.ts'
    await write(w, edited, 'other-ws')
    assert.strictEqual(queryValue(db, 'SELECT file_path FROM edit_details'), 'y.ts')
    db.close()
  })

  test('a row deleted since (retention, clearAll) or replaced by an import is written again', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    await write(w, withTimeline())
    const full = snapshot(db)
    db.run(`DELETE FROM sessions WHERE session_id = 'sess-1'`)
    await write(w, withTimeline())
    assert.strictEqual(snapshot(db), full)
    w.clearAll()
    await write(w, withTimeline())
    assert.strictEqual(snapshot(db), full)
    w.importCards([makeCard({ model: 'imported' })])
    await write(w, withTimeline())
    assert.strictEqual(snapshot(db), full)
    db.close()
  })

  test('a card whose blob write failed is written again next time, so the blob is retried', async () => {
    let fail = true
    const written: string[] = []
    const fakeFs = {
      stat:      (uri: vscode.Uri) => written.includes(uri.path) ? Promise.resolve({}) : Promise.reject(new Error('not found')),
      writeFile: (uri: vscode.Uri) => { if (fail) return Promise.reject(new Error('disk full')); written.push(uri.path); return Promise.resolve() },
    }
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri('blob-retry'), () => {}, fakeFs as unknown as typeof import('vscode').workspace.fs)
    const card = () => makeCard({
      timeline: [{ type: 'llm', spanId: 'sp-retry', label: 'LLM', durationMs: 1, isError: false, timestamp: '', responseText: 'x'.repeat(600) }],
    })
    await write(w, card())
    fail = false
    await write(w, card())
    assert.ok(written.some(p => p.includes('sp-retry-response.txt')))
    db.close()
  })
})
