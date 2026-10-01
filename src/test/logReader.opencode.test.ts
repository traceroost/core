import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader, type OpenCodeSqlFactory } from '../logReader'

// ── In-memory sql.js fixture ──────────────────────────────────────────────────

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  export(): Uint8Array
  close(): void
}

async function makeOpenCodeSqlFactory(): Promise<{ factory: OpenCodeSqlFactory; createDb: () => SqlDb }> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new (data?: Buffer | Uint8Array) => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  return {
    factory: SQL as unknown as OpenCodeSqlFactory,
    createDb: () => new SQL.Database(),
  }
}

// Matches the actual OpenCode database schema (confirmed 2026-06-10).
const OPENCODE_SCHEMA = `
  CREATE TABLE session (
    id               TEXT PRIMARY KEY,
    parent_id        TEXT,
    title            TEXT NOT NULL DEFAULT '',
    directory        TEXT NOT NULL DEFAULT '',
    model            TEXT,
    time_created     INTEGER NOT NULL DEFAULT 0,
    time_updated     INTEGER NOT NULL DEFAULT 0,
    tokens_input     INTEGER NOT NULL DEFAULT 0,
    tokens_output    INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE message (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL
  );
`

function insertSession(db: SqlDb, id: string, opts: {
  parentId?: string | null
  title?: string
  directory?: string
  model?: string
  timeCreated?: number
  tokIn?: number; tokOut?: number; tokReasoning?: number
  tokCacheRead?: number; tokCacheWrite?: number
} = {}) {
  db.run(
    `INSERT INTO session
      (id, parent_id, title, directory, model, time_created, tokens_input,
       tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, opts.parentId ?? null, opts.title ?? '', opts.directory ?? '/workspace',
      opts.model ?? JSON.stringify({ id: 'claude-sonnet-4-6', providerID: 'anthropic' }),
      opts.timeCreated ?? 1704067200000,  // 2024-01-01T00:00:00.000Z
      opts.tokIn ?? 1000, opts.tokOut ?? 200, opts.tokReasoning ?? 0,
      opts.tokCacheRead ?? 500, opts.tokCacheWrite ?? 100,
    ],
  )
}

function insertMessage(db: SqlDb, id: string, sessionId: string, role: 'user' | 'assistant') {
  db.run('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
    [id, sessionId, 1704067200000, JSON.stringify({ role })])
}

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('LogReader — OpenCode', () => {
  let factory: OpenCodeSqlFactory
  let createDb: () => SqlDb

  suiteSetup(async () => {
    const result = await makeOpenCodeSqlFactory()
    factory = result.factory
    createDb = result.createDb
  })

  test('reads session from DB with correct token aggregation', async () => {
    const db = createDb()
    db.run(OPENCODE_SCHEMA)

    insertSession(db, 'sess-1', {
      title: 'Fix the bug', directory: '/my/project',
      model: JSON.stringify({ id: 'claude-sonnet-4-6', providerID: 'anthropic' }),
      timeCreated: 1704067200000,
      tokIn: 1800, tokOut: 350, tokReasoning: 50, tokCacheRead: 800, tokCacheWrite: 100,
    })
    insertMessage(db, 'msg-u1', 'sess-1', 'user')
    insertMessage(db, 'msg-a1', 'sess-1', 'assistant')
    insertMessage(db, 'msg-a2', 'sess-1', 'assistant')

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-'))
    fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.from(db.export()))
    db.close()
    const origEnv = process.env['OPENCODE_DATA_DIR']
    process.env['OPENCODE_DATA_DIR'] = dataDir

    try {
      const reader = new LogReader({ sqlFactory: factory })
      const results = reader.scanOpenCode()
      const sess = results.find(r => r.card.sessionId === 'sess-1')
      assert.ok(sess, 'session should be found')
      assert.strictEqual(sess!.card.source, 'opencode')
      assert.strictEqual(sess!.card.model, 'claude-sonnet-4-6')
      assert.strictEqual(sess!.card.userRequest, 'Fix the bug')
      assert.strictEqual(sess!.workspace, '/my/project')
      assert.strictEqual(sess!.card.turns, 2)  // 2 assistant messages
      // inputTokens = tokIn + tokCacheRead + tokCacheWrite = 1800 + 800 + 100 = 2700
      assert.strictEqual(sess!.card.inputTokens, 2700)
      // outputTokens = tokOut + tokReasoning = 350 + 50 = 400
      assert.strictEqual(sess!.card.outputTokens, 400)
      assert.strictEqual(sess!.card.cacheReadTokens, 800)
      assert.strictEqual(sess!.card.cacheCreateTokens, 100)
      assert.strictEqual(sess!.card.startTime, '2024-01-01T00:00:00.000Z')
    } finally {
      if (origEnv === undefined) delete process.env['OPENCODE_DATA_DIR']
      else process.env['OPENCODE_DATA_DIR'] = origEnv
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('excludes subagent sessions (parent_id set)', async () => {
    const db = createDb()
    db.run(OPENCODE_SCHEMA)

    insertSession(db, 'root-1', { title: 'Root', tokIn: 500 })
    insertSession(db, 'child-1', { parentId: 'root-1', title: 'Subagent', tokIn: 200 })
    insertMessage(db, 'msg-r', 'root-1', 'assistant')
    insertMessage(db, 'msg-c', 'child-1', 'assistant')

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-'))
    fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.from(db.export()))
    db.close()
    const origEnv = process.env['OPENCODE_DATA_DIR']
    process.env['OPENCODE_DATA_DIR'] = dataDir

    try {
      const reader = new LogReader({ sqlFactory: factory })
      const results = reader.scanOpenCode()
      const ids = results.map(r => r.card.sessionId)
      assert.ok(ids.includes('root-1'), 'root session should be present')
      assert.ok(!ids.includes('child-1'), 'subagent session should be excluded')
    } finally {
      if (origEnv === undefined) delete process.env['OPENCODE_DATA_DIR']
      else process.env['OPENCODE_DATA_DIR'] = origEnv
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('falls back to JSON message files when no sqlFactory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fallback-'))
    const msgDir = path.join(tmpDir, 'storage', 'message')
    fs.mkdirSync(msgDir, { recursive: true })

    fs.writeFileSync(path.join(msgDir, 'msg-a.json'), JSON.stringify({
      role: 'assistant', session_id: 'fallback-sess', id: 'claude-sonnet-4-6',
      tokens: { input: 600, output: 120, reasoning: 0, cache: { read: 200, write: 50 } },
    }))
    fs.writeFileSync(path.join(msgDir, 'msg-u.json'), JSON.stringify({ role: 'user', session_id: 'fallback-sess' }))
    // dummy opencode.db so the data dir is detected
    fs.writeFileSync(path.join(tmpDir, 'opencode.db'), '')

    const origEnv = process.env['OPENCODE_DATA_DIR']
    process.env['OPENCODE_DATA_DIR'] = tmpDir

    try {
      const reader = new LogReader()  // no sqlFactory → fallback
      const results = reader.scanOpenCode()
      const sess = results.find(r => r.card.sessionId === 'fallback-sess')
      assert.ok(sess, 'fallback session should be found')
      assert.strictEqual(sess!.card.source, 'opencode')
      assert.strictEqual(sess!.card.model, 'claude-sonnet-4-6')
      assert.strictEqual(sess!.card.turns, 1)
      assert.strictEqual(sess!.card.outputTokens, 120)
      assert.strictEqual(sess!.card.cacheReadTokens, 200)
      assert.strictEqual(sess!.card.cacheCreateTokens, 50)
    } finally {
      process.env['OPENCODE_DATA_DIR'] = origEnv
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('returns no results when OPENCODE_DATA_DIR does not exist', () => {
    const origEnv = process.env['OPENCODE_DATA_DIR']
    process.env['OPENCODE_DATA_DIR'] = '/nonexistent/path/opencode'
    try {
      const reader = new LogReader({ sqlFactory: factory })
      assert.strictEqual(reader.scanOpenCode().length, 0)
    } finally {
      process.env['OPENCODE_DATA_DIR'] = origEnv
    }
  })
})
