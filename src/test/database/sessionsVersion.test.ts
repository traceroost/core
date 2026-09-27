import * as assert from 'assert'
import * as os from 'os'
import * as path from 'path'
import type * as vscode from 'vscode'
import { SCHEMA_SQL } from '../../database/schema'
import { DatabaseWriter } from '../../database/writer'
import { DatabaseReader } from '../../database/reader'
import { runRetention } from '../../database/retention'
import { SessionRepository } from '../../sessionRepository'
import { SessionStore } from '../../sessionStore'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'
import type { SqlStatement } from '../../database/db'

// The listSessions() memo is only correct if every write to `sessions` bumps the reader's
// sessionsVersion — these run each write path against a real database and check the memoized
// list reflects it straight away.

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  prepare(sql: string): SqlStatement
}

async function openDb(): Promise<SqlDb> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

function makeCard(sessionId: string, startTime: string, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId, traceId: 'trace-' + sessionId, source: 'copilot', dataSource: 'otel', workspace: '/ws',
    userRequest: 'x', model: 'gpt-4o', turns: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
    cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 1000, startTime,
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [], toolCounts: {},
    totalToolCalls: 0, totalLlmCalls: 1, errors: 0, outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

suite('SessionRepository.listSessions memo — invalidated by every sessions write', () => {
  async function setup() {
    const db = await openDb()
    const dir = path.join(os.tmpdir(), 'traceroost-sessions-version-test')
    const uri = { scheme: 'file', path: dir, fsPath: dir } as unknown as vscode.Uri
    const writer = new DatabaseWriter(db, uri, () => {})
    const store = new SessionStore({} as vscode.ExtensionContext)
    const repo = new SessionRepository(new DatabaseReader(db, uri), writer, store)
    const ids = () => repo.listSessions().map(s => s.sessionId)
    return { db, writer, store, repo, ids }
  }

  test('enqueue + drain, importCards, clearAll', async () => {
    const { writer, ids } = await setup()
    assert.deepStrictEqual(ids(), [])
    writer.enqueue(makeCard('a', '2025-01-01T00:00:00.000Z'), '/ws')
    await writer.drain()
    assert.deepStrictEqual(ids(), ['a'])
    writer.importCards([makeCard('b', '2025-01-02T00:00:00.000Z')])
    assert.deepStrictEqual(ids(), ['b', 'a'])
    writer.clearAll()
    assert.deepStrictEqual(ids(), [])
  })

  test('an in-place rewrite of a stored card is visible', async () => {
    const { writer, repo } = await setup()
    writer.enqueue(makeCard('a', '2025-01-01T00:00:00.000Z'), '/ws')
    await writer.drain()
    assert.strictEqual(repo.listSessions()[0].model, 'gpt-4o')
    writer.enqueue(makeCard('a', '2025-01-01T00:00:00.000Z', { model: 'changed' }), '/ws')
    await writer.drain()
    assert.strictEqual(repo.listSessions()[0].model, 'changed')
  })

  test('retention deletes', async () => {
    const { db, writer, ids } = await setup()
    writer.importCards([makeCard('old', '2000-01-01T00:00:00.000Z'), makeCard('new', new Date().toISOString())])
    assert.deepStrictEqual(ids(), ['new', 'old'])
    await runRetention(db, 30, path.join(os.tmpdir(), 'traceroost-sessions-version-test-missing'), () => {})
    assert.deepStrictEqual(ids(), ['new'])
  })

  test('live span window changes', async () => {
    const { store, repo } = await setup()
    const before = repo.listSessions().length
    store.addSpan({
      traceId: 't1', spanId: 's1', name: 'claude_code.interaction', startTime: String(Date.now() * 1e6), endTime: String((Date.now() + 1000) * 1e6),
      attributes: [{ key: 'user_prompt', value: { stringValue: 'hi' } }], status: { code: 0 },
    } as never)
    assert.ok(repo.listSessions().length > before)
    store.clear()
    assert.strictEqual(repo.listSessions().length, before)
  })
})
