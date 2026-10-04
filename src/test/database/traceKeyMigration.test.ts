import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type * as vscode from 'vscode'
import { SCHEMA_SQL } from '../../database/schema'
import { DatabaseWriter } from '../../database/writer'
import { DatabaseReader } from '../../database/reader'
import { migrateTraceKeys } from '../../database/traceKeyMigration'
import { LogReader } from '../../logReader'
import { traceKey, toUuid, claudeInteractionKey } from '../../traceIdentity'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'
import type { SqlStatement } from '../../database/db'

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>
  prepare(sql: string): SqlStatement
  close(): void
}

async function openInMemoryDb(): Promise<SqlDb> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

// Synthetic data only. A Claude Code session `SID` whose transcript has turn p-1 at T (+17 ms
// after its OTEL interaction started) — and rows as the pre-feature-11 writer stored them.
const SID = '5e4d3c2b-1a09-4876-8543-210fedcba987'
const T = Date.parse('2026-05-01T10:00:00.000Z')

function card(overrides: Partial<SessionSummaryCard>): SessionSummaryCard {
  return {
    sessionId: 'x', traceId: 'x', source: 'claude_code', dataSource: 'otel', workspace: '/work/repo',
    userRequest: 'p', model: 'claude-sonnet-4-6', turns: 1, inputTokens: 120, outputTokens: 30,
    cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 4000,
    startTime: new Date(T).toISOString(), filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0, outcome: 'unknown',
    timeline: [{ type: 'llm', spanId: 'llm-1', label: 'LLM', durationMs: 10, isError: false, timestamp: new Date(T).toISOString() }],
    backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

suite('migrateTraceKeys — one-time local re-key', () => {
  let tmpDir: string
  let transcript: string
  let db: SqlDb
  const ids = () => (db.exec('SELECT session_id FROM sessions ORDER BY session_id')[0]?.values ?? []).map(r => String(r[0]))
  const val = (sql: string, params: unknown[] = []) => db.exec(sql, params)[0]?.values[0]?.[0]

  setup(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-rekey-'))
    transcript = path.join(tmpDir, 'proj', `${SID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, [
      { type: 'user', uuid: 'u-1', sessionId: SID, promptId: 'p-1', cwd: '/work/repo', timestamp: new Date(T + 17).toISOString(), message: { role: 'user', content: 'fix it' } },
      { type: 'assistant', uuid: 'a-1', sessionId: SID, timestamp: new Date(T + 2000).toISOString(), message: { id: 'm-1', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: 'done' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')

    db = await openInMemoryDb()
    const w = new DatabaseWriter(db, (require('vscode') as typeof vscode).Uri.file(path.join(tmpDir, 'store')), () => {})
    // As stored before stable trace identity:
    w.enqueue(card({ sessionId: 'span-a', traceId: 'otel-a', claudeSessionId: SID }), '')                               // joinable
    w.enqueue(card({ sessionId: 'span-b', traceId: 'otel-b', claudeSessionId: SID, startTime: new Date(T + 600_000).toISOString() }), '') // no turn there
    w.enqueue(card({ sessionId: 'span-c', traceId: 'codex:thread-1:turn-9', source: 'codex' }), '')                      // Codex turn id
    w.enqueue(card({ sessionId: 'cp-span', traceId: 'cp-trace', source: 'copilot' }), '')                               // own OTEL key
    w.enqueue(card({ sessionId: SID, traceId: SID, dataSource: 'log' }), '')                                             // whole-file log row
    w.enqueue(card({ sessionId: 'gone-file#1', traceId: 'gone-file#1', dataSource: 'log' }), '')                          // transcript deleted
    await w.drain()
    db.run(`INSERT INTO git_outcome (session_id, repo_root, head_sha, overall) VALUES ('span-a', '/work/repo', 'abc', 'merged')`)
  })
  teardown(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const find = (sid: string) => (sid === SID ? [transcript] : [])

  test('re-keys OTEL rows from stored evidence, aliases the old ids, marks log rows legacy', () => {
    const result = migrateTraceKeys(db, { findTranscripts: find })
    assert.deepStrictEqual(result, { rekeyed: 3, derived: 1, legacy: 2 })
    const joined = traceKey('claude', 'p-1')
    const derived = claudeInteractionKey(SID, T + 600_000)
    const codex = traceKey('codex', 'turn-9')
    assert.deepStrictEqual(ids(), [SID, joined, derived, codex, 'cp-span', 'gone-file#1'].sort())
    // The row, its timeline and its per-session caches moved with it.
    assert.strictEqual(val('SELECT COUNT(*) FROM timeline_entries WHERE session_id = ?', [joined]), 1)
    assert.strictEqual(val('SELECT COUNT(*) FROM timeline_entries WHERE session_id = ?', ['span-a']), 0)
    assert.strictEqual(val('SELECT overall FROM git_outcome WHERE session_id = ?', [joined]), 'merged')
    assert.strictEqual(val('SELECT derived FROM sessions WHERE session_id = ?', [derived]), 1)
    assert.strictEqual(val('SELECT derived FROM sessions WHERE session_id = ?', [joined]), 0)
    assert.strictEqual(val('SELECT legacy FROM sessions WHERE session_id = ?', ['cp-span']), 0)
    assert.strictEqual(val('SELECT legacy FROM sessions WHERE session_id = ?', [SID]), 1)
    assert.strictEqual(val('SELECT legacy FROM sessions WHERE session_id = ?', ['gone-file#1']), 1)
    // Old ids — raw, and as the wire uuid the cloud holds — resolve to the new key.
    const reader = new DatabaseReader(db, (require('vscode') as typeof vscode).Uri.file(tmpDir))
    assert.strictEqual(reader.resolveTraceAlias('span-a'), joined)
    assert.strictEqual(reader.resolveTraceAlias(toUuid('span-a')), joined)
    assert.strictEqual(reader.resolveTraceAlias('span-c'), codex)
    // The manifest hook skips legacy rows.
    assert.deepStrictEqual(reader.listTraceKeys(0, Date.now()).sort(), [joined, derived, codex, toUuid('cp-span')].sort())
    assert.deepStrictEqual(reader.listTraceKeys(T + 1, Date.now()), [derived], 'only the window asked for')
    assert.strictEqual(reader.localHorizonMs(), T)
  })

  test('idempotent: a second run is a no-op, and re-running over migrated rows changes nothing', () => {
    migrateTraceKeys(db, { findTranscripts: find })
    const after = ids()
    assert.strictEqual(migrateTraceKeys(db, { findTranscripts: find }), null, 'recorded as done')
    db.run('DELETE FROM trace_key_migration')
    assert.deepStrictEqual(migrateTraceKeys(db, { findTranscripts: find }), { rekeyed: 0, derived: 0, legacy: 2 })
    assert.deepStrictEqual(ids(), after)
  })

  test('safe to interrupt: a run that fails part-way leaves nothing changed, and the next run completes', () => {
    let calls = 0
    assert.throws(() => migrateTraceKeys(db, { findTranscripts: sid => { if (++calls > 1) throw new Error('disk gone'); return find(sid) } }))
    assert.deepStrictEqual(ids(), [SID, 'cp-span', 'gone-file#1', 'span-a', 'span-b', 'span-c'].sort())
    assert.strictEqual(val('SELECT COUNT(*) FROM trace_aliases'), 0)
    assert.strictEqual(val('SELECT COUNT(*) FROM trace_key_migration'), 0)
    assert.ok(migrateTraceKeys(db, { findTranscripts: find }))
    assert.ok(ids().includes(traceKey('claude', 'p-1')))
  })

  test('after migration, re-reading the transcript retires the legacy row onto the per-turn key, keeping the OTEL row', async () => {
    migrateTraceKeys(db, { findTranscripts: find })
    const w = new DatabaseWriter(db, (require('vscode') as typeof vscode).Uri.file(path.join(tmpDir, 'store')), () => {})
    for (const r of new LogReader().parseFile(transcript, 'claude')) w.enqueue(r.card, '')
    await w.drain()
    const key = traceKey('claude', 'p-1')
    assert.ok(!ids().includes(SID), 'the whole-file row is retired')
    assert.strictEqual(val('SELECT data_source FROM sessions WHERE session_id = ?', [key]), 'otel', 'the migrated OTEL row outranks the transcript')
    const reader = new DatabaseReader(db, (require('vscode') as typeof vscode).Uri.file(tmpDir))
    assert.strictEqual(reader.resolveTraceAlias(SID), key)
    assert.strictEqual(val('SELECT legacy FROM sessions WHERE session_id = ?', ['gone-file#1']), 1, 'no transcript left: stays legacy, keeps its id')
  })
})
