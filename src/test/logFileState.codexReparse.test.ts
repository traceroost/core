import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type * as vscode from 'vscode'
import { LogReader } from '../logReader'
import {
  LOG_FILE_STATE_FILENAME, LOG_FILE_STATE_VERSION, readLogFileState, restoreLogFileState, writeLogFileState,
} from '../logFileState'
import { SCHEMA_SQL } from '../database/schema'
import { DatabaseWriter } from '../database/writer'
import { DatabaseReader } from '../database/reader'
import { calcSessionCostUsd, calcAggregateTokenCostUsd } from '../pricing'
import type { SqlStatement } from '../database/db'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

// The one-time correction of Codex sessions stored before reasoning tokens stopped being added on
// top of output tokens (they're already part of it). The stored rows can't be fixed in place — the
// reasoning count was never stored — so a version-1 log file state forgets the Codex rollout files
// and they're re-parsed; the writer's INSERT OR REPLACE then rewrites each row.

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
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

const MODEL = 'gpt-5'
const START = Date.now() - 2 * 86_400_000

function rollout(output: number, reasoning: number): string {
  const ts = (offsetMs: number) => new Date(START + offsetMs).toISOString()
  const lines = [
    { timestamp: ts(0), type: 'session_meta', payload: { session_id: 'sess', cwd: '/workspace' } },
    { timestamp: ts(1000), type: 'event_msg', payload: { type: 'thread_settings_applied' } },
    { timestamp: ts(1000), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: ts(1000), type: 'event_msg', payload: { type: 'user_message', message: 'fix it' } },
    {
      timestamp: ts(5000), type: 'event_msg', payload: {
        type: 'token_count',
        info: {
          model: MODEL,
          total_token_usage: { input_tokens: 10_000, cached_input_tokens: 4_000, output_tokens: output, reasoning_output_tokens: reasoning },
        },
      },
    },
  ]
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n'
}

function otherCard(overrides: Partial<SessionSummaryCard>): SessionSummaryCard {
  return {
    sessionId: 'x', traceId: 'x', source: 'claude_code', dataSource: 'log', workspace: '/w', userRequest: '',
    model: 'claude-sonnet-4-5', turns: 1, inputTokens: 1000, outputTokens: 900, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: new Date(START).toISOString(), filesRead: [], filesSearched: [],
    filesChanged: [], filesWritten: [], toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

function row(db: SqlDb, id: string): { output: number; cost: number; input: number } {
  const r = db.exec(`SELECT output_tokens, cost_usd, input_tokens FROM sessions WHERE session_id = '${id}'`)[0].values[0]
  return { output: r[0] as number, cost: r[1] as number, input: r[2] as number }
}

suite('logFileState — one-time Codex reasoning-token correction', () => {
  let tmpDir: string
  let storageDir: string
  let codexFile: string
  let savedCodexHome: string | undefined

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-codex-reparse-'))
    storageDir = path.join(tmpDir, 'storage')
    fs.mkdirSync(storageDir)
    const sessionsDir = path.join(tmpDir, 'codex', 'sessions', '2026', '01', '01')
    fs.mkdirSync(sessionsDir, { recursive: true })
    codexFile = path.join(sessionsDir, 'rollout-sess.jsonl')
    fs.writeFileSync(codexFile, rollout(300, 120))
    savedCodexHome = process.env['CODEX_HOME']
    process.env['CODEX_HOME'] = path.join(tmpDir, 'codex')
  })

  teardown(() => {
    if (savedCodexHome === undefined) delete process.env['CODEX_HOME']
    else process.env['CODEX_HOME'] = savedCodexHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('re-derives inflated Codex rows once, leaves other sources alone, and keeps aggregates consistent', async () => {
    const db = await openInMemoryDb()
    const storageUri = (require('vscode') as typeof vscode).Uri.file(storageDir)
    const writer = new DatabaseWriter(db, storageUri, () => {})

    // ── An install from before the fix: rows written, file state persisted as version 1 ──
    const before = new LogReader()
    const [parsed] = before.parseFile(codexFile, 'codex')
    const codexId = parsed.card.sessionId
    assert.strictEqual(parsed.card.outputTokens, 300)
    writer.enqueue(parsed.card, '/w')
    writer.enqueue(otherCard({ sessionId: 'claude-1' }), '/w')
    // OpenCode reports reasoning separately and was never inflated — must not be touched.
    writer.enqueue(otherCard({ sessionId: 'opencode-1', source: 'opencode', model: MODEL }), '/w')
    await writer.drain()
    // What the old parser stored: output_tokens + reasoning_output_tokens, priced as such.
    const inflatedCost = calcAggregateTokenCostUsd(6_000, 4_000, 0, 420, MODEL)
    assert.ok(inflatedCost > 0, `${MODEL} must be priced for this test to mean anything`)
    db.run('UPDATE sessions SET output_tokens = 420, cost_usd = ? WHERE session_id = ?', [inflatedCost, codexId])
    fs.writeFileSync(path.join(storageDir, LOG_FILE_STATE_FILENAME), JSON.stringify({
      ...before.exportFileState(),
      '/elsewhere/claude.jsonl': { bytesRead: 10, mtimeMs: Date.now() },
    }))
    const untouched = { claude: row(db, 'claude-1'), opencode: row(db, 'opencode-1') }

    // ── First activation after the fix (a new process: new reader and writer) ──
    const writer1 = new DatabaseWriter(db, storageUri, () => {})
    const lr1 = new LogReader()
    // Version 3 (one trace per turn) re-reads every file within retention once — which includes
    // version 2's Codex re-read.
    assert.strictEqual(restoreLogFileState(lr1, storageDir, 90), 2, 'every file within retention is forgotten')
    assert.ok(!lr1.exportFileState()['/elsewhere/claude.jsonl'], 'a Claude transcript is re-read too')
    for (const r of lr1.parseFile(codexFile, 'codex')) writer1.enqueue(r.card, '/w')
    await writer1.drain()
    writeLogFileState(storageDir, lr1.exportFileState())

    const fixed = row(db, codexId)
    assert.strictEqual(fixed.output, 300, 'reasoning no longer counted twice')
    const expectedCost = calcSessionCostUsd({ model: MODEL, inputTokens: 10_000, outputTokens: 300, cacheReadTokens: 4_000, cacheCreateTokens: 0, timeline: [] })
    assert.ok(Math.abs(fixed.cost - expectedCost) < 1e-12, `cost recomputed (${fixed.cost} vs ${expectedCost})`)
    assert.ok(fixed.cost < inflatedCost)
    assert.deepStrictEqual(row(db, 'claude-1'), untouched.claude)
    assert.deepStrictEqual(row(db, 'opencode-1'), untouched.opencode)
    assert.strictEqual(readLogFileState(storageDir).version, LOG_FILE_STATE_VERSION)

    // Aggregates are computed from the rows at query time, so they follow the correction.
    const reader = new DatabaseReader(db, storageUri)
    const daily = reader.queryDailyStats({ since: 0 })
    const sum = (k: 'outputTokens' | 'costUsd') => daily.reduce((s, d) => s + d[k], 0)
    assert.strictEqual(sum('outputTokens'), 300 + untouched.claude.output + untouched.opencode.output)
    assert.ok(Math.abs(sum('costUsd') - (fixed.cost + untouched.claude.cost + untouched.opencode.cost)) < 1e-9)
    assert.ok(Math.abs(reader.queryLifetimeStats().totalCostUsd - sum('costUsd')) < 1e-9)

    // ── Second activation: already upgraded, nothing is re-read ──
    const lr2 = new LogReader()
    assert.strictEqual(restoreLogFileState(lr2, storageDir, 90), 0)
    assert.deepStrictEqual(lr2.parseFile(codexFile, 'codex'), [], 'unchanged Codex file skipped')
    assert.deepStrictEqual(row(db, codexId), fixed)
    db.close()
  })

  test('an interrupted upgrade (state never re-persisted) is simply redone', () => {
    const lr = new LogReader()
    lr.parseFile(codexFile, 'codex')
    fs.writeFileSync(path.join(storageDir, LOG_FILE_STATE_FILENAME), JSON.stringify(lr.exportFileState()))
    assert.strictEqual(restoreLogFileState(new LogReader(), storageDir, 90), 1)
    // Crash before writeLogFileState: the version-1 file is still on disk.
    assert.strictEqual(restoreLogFileState(new LogReader(), storageDir, 90), 1)
  })

  test('a Codex file last modified before the retention cutoff is not re-read', () => {
    const old = new Date(Date.now() - 200 * 86_400_000)
    fs.utimesSync(codexFile, old, old)
    const lr = new LogReader()
    lr.parseFile(codexFile, 'codex')
    fs.writeFileSync(path.join(storageDir, LOG_FILE_STATE_FILENAME), JSON.stringify(lr.exportFileState()))
    const restored = new LogReader()
    assert.strictEqual(restoreLogFileState(restored, storageDir, 90), 0)
    assert.deepStrictEqual(restored.parseFile(codexFile, 'codex'), [])
  })

  test('a missing state file reads as current (a fresh install parses everything anyway)', () => {
    assert.deepStrictEqual(readLogFileState(storageDir), { version: LOG_FILE_STATE_VERSION, files: {} })
  })
})
