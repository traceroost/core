import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, CODEX_TURN_ID_SETTLE_MS, type LogSessionResult, type OpenCodeSqlFactory } from '../logReader'
import { maybeEnqueueSession } from '../cloud/org/enqueueSession'
import { maybeForwardOnContentChange } from '../cloud/org/contentChangeForward'
import { setCredentialStore, type CredentialStore } from '../cloud/org/credentials'
import type { OrgCredentials } from '../cloud/org/config'
import { ForwardQueue } from '../cloud/forward/queue'
import { toUuid, traceKey, derivedTraceKey, traceKeysInWindow, claudeInteractionKey } from '../traceIdentity'
import { DatabaseWriter } from '../database/writer'
import { DatabaseReader } from '../database/reader'
import { SCHEMA_SQL, OUTCOMES_SCHEMA_SQL } from '../database/schema'
import { ClaudeJoinRepository } from '../database/claudeJoinRepository'
import { ClaudeTurnJoiner } from '../claudeTurnJoin'
import type { ReconciliationService } from '../reconcile/reconciliationService'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

// "Cloud is getting more traces than core has to give": every wire session_id a host enqueues has
// to be a key the local store ends up holding. A key is a pure function of agent ids, so a file
// read while it is still being written must never produce a key that the finished file doesn't —
// otherwise the early key is sent, the cloud keeps that row, and the local store (rebuilt from
// the finished file) never lists it. These tests grow realistic agent logs one write at a time
// through the real parse path, push every emitted card through the real enqueue path, and compare
// the wire ids queued with the keys a from-scratch read of the finished file holds.

function memoryStore(): CredentialStore {
  let cur: OrgCredentials | null = {
    endpoint: 'https://test.traceroost.com', orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1', role: 'developer',
    perDeveloperVisibility: false, accessToken: 'a', refreshToken: 'r',
    accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
  }
  return { load: () => cur, save: (c) => { cur = c }, clear: () => { cur = null } }
}

function queuedWireIds(): Set<string> {
  return new Set(new ForwardQueue().list().map(i => i.payload.session?.session_id).filter((id): id is string => !!id))
}

async function enqueueAll(results: LogSessionResult[]): Promise<void> {
  for (const r of results) await maybeEnqueueSession({ ...r.card, workspace: r.card.workspace || r.workspace })
}

/** The wire ids of every key a fresh read of the finished input holds. */
function wireIds(results: LogSessionResult[]): Set<string> {
  return new Set(results.map(r => toUuid(r.card.sessionId)))
}

function extra(sent: Set<string>, held: Set<string>): string[] {
  return [...sent].filter(id => !held.has(id))
}

const realHome = process.env.HOME
const realUserProfile = process.env.USERPROFILE

suite('cloud key stability — a growing log never sends a key the store does not keep', () => {
  let home: string
  let work: string

  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-keystab-home-'))
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-keystab-work-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
    setCredentialStore(memoryStore())
  })

  teardown(() => {
    setCredentialStore(undefined)
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(work, { recursive: true, force: true })
  })

  // ── Claude Code ─────────────────────────────────────────────────────────────

  test('Claude Code: a transcript read before its first prompt line (queue-operation lines only) sends no extra key', async () => {
    // The shape Claude Code writes today (checked against a real transcript): the session file
    // opens with queue-operation enqueue/dequeue lines — a timestamp, no uuid — ~90 ms before the
    // first prompt line, which carries the turn's promptId.
    const SID = '7d0e3c1a-2b4f-4e6a-9c8d-1f2e3a4b5c6d'
    const file = path.join(work, 'projects', '-work-repo', `${SID}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const T = (ms: number) => new Date(Date.parse('2026-10-04T09:00:00.000Z') + ms).toISOString()
    const base = { sessionId: SID, cwd: work, version: '2.1.0', gitBranch: 'main', userType: 'external', isSidechain: false }
    const lines: Record<string, unknown>[] = [
      { type: 'queue-operation', operation: 'enqueue', timestamp: T(0), sessionId: SID, content: 'fix the build' },
      { type: 'queue-operation', operation: 'dequeue', timestamp: T(40), sessionId: SID },
      { ...base, type: 'user', uuid: 'u-1', parentUuid: null, promptId: 'p-1', timestamp: T(94), message: { role: 'user', content: 'fix the build' } },
      { ...base, type: 'attachment', uuid: 'att-1', parentUuid: 'u-1', timestamp: T(95) },
      { ...base, type: 'assistant', uuid: 'a-1', parentUuid: 'att-1', timestamp: T(2000), requestId: 'req_1', message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'done' }] } },
      { ...base, type: 'user', uuid: 'u-2', parentUuid: 'a-1', promptId: 'p-2', timestamp: T(60_000), message: { role: 'user', content: 'now the tests' } },
      { ...base, type: 'assistant', uuid: 'a-2', parentUuid: 'u-2', timestamp: T(62_000), requestId: 'req_2', message: { id: 'msg_2', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'ok' }] } },
    ]

    const live = new LogReader()
    fs.writeFileSync(file, '')
    for (const line of lines) {
      const json = JSON.stringify(line)
      // Half a line first (a read mid-write), then the rest.
      fs.appendFileSync(file, json.slice(0, Math.floor(json.length / 2)))
      await enqueueAll(live.parseFile(file, 'claude'))
      fs.appendFileSync(file, json.slice(Math.floor(json.length / 2)) + '\n')
      await enqueueAll(live.parseFile(file, 'claude'))
    }

    const held = wireIds(new LogReader().parseFile(file, 'claude'))
    assert.deepStrictEqual([...held].sort(), [traceKey('claude', 'p-1'), traceKey('claude', 'p-2')].map(toUuid).sort())
    assert.deepStrictEqual(extra(queuedWireIds(), held), [], 'every queued wire id is a key the finished transcript holds')
  })

  // ── Copilot CLI ─────────────────────────────────────────────────────────────

  test('Copilot CLI: a session read between session.start and its first user.message sends no extra key', async () => {
    const sid = 'c0p1107c-0000-4000-8000-000000000042'
    const file = path.join(work, 'session-state', sid, 'events.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const lines: Record<string, unknown>[] = [
      { type: 'session.start', id: 'ev-0', timestamp: '2026-10-04T09:00:00.000Z', data: { selectedModel: 'gpt-5.6-luna', startTime: '2026-10-04T09:00:00.000Z', context: { cwd: work } } },
      // The user may sit at the prompt for minutes — every scan in between sees only session.start.
      { type: 'user.message', id: 'ev-1', timestamp: '2026-10-04T09:04:00.000Z', data: { transformedContent: 'add a test' } },
      { type: 'assistant.message', id: 'ev-2', timestamp: '2026-10-04T09:04:05.000Z', data: { outputTokens: 40 } },
      { type: 'session.shutdown', id: 'ev-3', timestamp: '2026-10-04T09:05:00.000Z', data: { modelMetrics: { 'gpt-5.6-luna': { usage: { inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } } } } },
    ]
    const live = new LogReader()
    fs.writeFileSync(file, '')
    for (const line of lines) {
      fs.appendFileSync(file, JSON.stringify(line) + '\n')
      await enqueueAll(live.parseFile(file, 'copilot'))
    }
    const held = wireIds(new LogReader().parseFile(file, 'copilot'))
    assert.strictEqual(held.size, 1)
    assert.deepStrictEqual(extra(queuedWireIds(), held), [], 'the prompt-less placeholder turn must not reach the cloud')
  })

  test('Copilot CLI: a prompt-less log that has its own activity still yields one trace', () => {
    const sid = 'c0p1107c-0000-4000-8000-000000000043'
    const file = path.join(work, 'session-state', sid, 'events.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, [
      { type: 'session.start', id: 'ev-0', timestamp: '2026-10-04T09:00:00.000Z', data: { selectedModel: 'gpt-5.6-luna', context: { cwd: work } } },
      { type: 'assistant.message', id: 'ev-1', timestamp: '2026-10-04T09:00:05.000Z', data: { outputTokens: 40 } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')
    const cards = new LogReader().parseFile(file, 'copilot').map(r => r.card)
    assert.strictEqual(cards.length, 1)
    assert.strictEqual(cards[0].outputTokens, 40)
  })

  // ── OpenCode ────────────────────────────────────────────────────────────────

  test('OpenCode: a session read before its first message, and before its reply, keeps one key (guard)', async () => {
    // Holds today: a session row with no usage yet is not read at all (the session query skips
    // zero-token rows), so the `session@<time>` placeholder turn never goes out for a new session.
    const sqlJsDir = path.dirname(require.resolve('sql.js'))
    type SqlDb = { run(sql: string, params?: unknown[]): void; export(): Uint8Array; close(): void }
    const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
    const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
    const dataDir = path.join(work, 'opencode')
    fs.mkdirSync(dataDir, { recursive: true })
    const origEnv = process.env['OPENCODE_DATA_DIR']
    process.env['OPENCODE_DATA_DIR'] = dataDir
    const T0 = Date.parse('2026-10-04T09:00:00.000Z')
    const stages: Array<(db: SqlDb) => void> = [
      db => db.run(`INSERT INTO session (id, parent_id, title, directory, model, time_created) VALUES ('ses_1', NULL, '', ?, ?, ?)`,
        [work, JSON.stringify({ id: 'claude-sonnet-4-6', providerID: 'anthropic' }), T0]),
      db => db.run(`INSERT INTO message (id, session_id, time_created, data) VALUES ('msg_u1', 'ses_1', ?, ?)`,
        [T0 + 30_000, JSON.stringify({ role: 'user', time: { created: T0 + 30_000 } })]),
      db => db.run(`INSERT INTO message (id, session_id, time_created, data) VALUES ('msg_a1', 'ses_1', ?, ?)`,
        [T0 + 31_000, JSON.stringify({ role: 'assistant', parentID: 'msg_u1', time: { created: T0 + 31_000, completed: T0 + 33_000 }, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } })]),
      db => db.run(`UPDATE session SET tokens_input = 100, tokens_output = 10 WHERE id = 'ses_1'`),
    ]
    try {
      const db = new SQL.Database()
      db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL DEFAULT '', directory TEXT NOT NULL DEFAULT '', model TEXT,
        time_created INTEGER NOT NULL DEFAULT 0, time_updated INTEGER NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0,
        tokens_cache_write INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);`)
      let last: LogSessionResult[] = []
      for (const stage of stages) {
        stage(db)
        fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.from(db.export()))
        // A fresh reader per stage: the database file's size need not change between stages.
        last = new LogReader({ sqlFactory: SQL as unknown as OpenCodeSqlFactory }).scanOpenCode()
        await enqueueAll(last)
      }
      db.close()
      const held = wireIds(last)
      assert.strictEqual(held.size, 1)
      assert.deepStrictEqual(extra(queuedWireIds(), held), [])
    } finally {
      if (origEnv === undefined) delete process.env['OPENCODE_DATA_DIR']
      else process.env['OPENCODE_DATA_DIR'] = origEnv
    }
  })

  // ── Codex / Copilot Chat (guards: these were checked and hold) ──────────────

  test('Codex: a rollout growing a line at a time keeps one key per turn (turn ids precede the prompt)', async () => {
    const THREAD = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b'
    const file = path.join(work, `rollout-2026-10-04T09-00-00-${THREAD}.jsonl`)
    const ts = (ms: number) => new Date(Date.parse('2026-10-04T09:00:00.000Z') + ms).toISOString()
    const turn = (ms: number, id: string, msg: string) => [
      { timestamp: ts(ms), type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
      { timestamp: ts(ms + 1), type: 'turn_context', payload: { model: 'gpt-5.6-luna', cwd: work, turn_id: id } },
      { timestamp: ts(ms + 2), type: 'event_msg', payload: { type: 'user_message', message: msg } },
      { timestamp: ts(ms + 3000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: ms + 100, output_tokens: 10 }, last_token_usage: { input_tokens: 1, output_tokens: 1 } } } },
      { timestamp: ts(ms + 3001), type: 'event_msg', payload: { type: 'task_complete', turn_id: id } },
    ]
    const lines = [{ timestamp: ts(0), type: 'session_meta', payload: { id: THREAD, cwd: work } }, ...turn(1000, 't-1', 'one'), ...turn(60_000, 't-2', 'two')]
    const live = new LogReader()
    fs.writeFileSync(file, '')
    for (const line of lines) {
      fs.appendFileSync(file, JSON.stringify(line) + '\n')
      await enqueueAll(live.parseFile(file, 'codex'))
    }
    const held = wireIds(new LogReader().parseFile(file, 'codex'))
    assert.strictEqual(held.size, 2)
    assert.deepStrictEqual(extra(queuedWireIds(), held), [])
  })

  test('Codex: a user_message read before its task_started line (no turn_id yet) is held, then sent once under its turn id', async () => {
    // Codex writes the prompt first and the turn_id a moment later. A read in between has a turn
    // with no id — a derived key the next read would replace — so while the rollout is still
    // fresh (written within CODEX_TURN_ID_SETTLE_MS) that turn is held, not emitted.
    const THREAD = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5c'
    const file = path.join(work, `rollout-2026-10-04T09-00-00-${THREAD}.jsonl`)
    const ts = (ms: number) => new Date(Date.parse('2026-10-04T09:00:00.000Z') + ms).toISOString()
    const lines = [
      { timestamp: ts(0), type: 'session_meta', payload: { id: THREAD, cwd: work } },
      { timestamp: ts(1000), type: 'event_msg', payload: { type: 'user_message', message: 'one' } },
      { timestamp: ts(1002), type: 'event_msg', payload: { type: 'task_started', turn_id: 't-1' } },
      { timestamp: ts(1003), type: 'turn_context', payload: { model: 'gpt-5.6-luna', cwd: work, turn_id: 't-1' } },
      { timestamp: ts(4000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 }, last_token_usage: { input_tokens: 1, output_tokens: 1 } } } },
      { timestamp: ts(4001), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't-1' } },
    ]
    const live = new LogReader()
    fs.writeFileSync(file, '')
    const emitted: string[] = []
    for (const line of lines) {
      fs.appendFileSync(file, JSON.stringify(line) + '\n')
      const results = live.parseFile(file, 'codex')
      emitted.push(...results.map(r => r.card.sessionId))
      await enqueueAll(results)
    }
    assert.ok(!emitted.includes(derivedTraceKey('codex', THREAD, ts(1000))), 'the id-less first read is held, never emitted')
    const held = wireIds(new LogReader().parseFile(file, 'codex'))
    assert.deepStrictEqual([...held], [toUuid(traceKey('codex', 't-1'))])
    assert.deepStrictEqual(extra(queuedWireIds(), held), [])
  })

  test('Codex: a rollout that never logs a turn_id still yields its turn once the file has sat still', () => {
    const THREAD = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5d'
    const file = path.join(work, `rollout-2026-10-04T09-00-00-${THREAD}.jsonl`)
    const ts = (ms: number) => new Date(Date.parse('2026-10-04T09:00:00.000Z') + ms).toISOString()
    fs.writeFileSync(file, [
      { timestamp: ts(0), type: 'session_meta', payload: { id: THREAD, cwd: work } },
      { timestamp: ts(1000), type: 'event_msg', payload: { type: 'user_message', message: 'one' } },
      { timestamp: ts(4000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 }, last_token_usage: { input_tokens: 1, output_tokens: 1 } } } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')
    const reader = new LogReader()
    // Fresh: held, and the file is left for the next scan to read again.
    assert.deepStrictEqual(reader.parseFile(file, 'codex'), [])
    assert.ok(!(file in reader.exportFileState()), 'a held file is not recorded as read')
    // Settled: what the rollout says it is — one derived turn.
    const old = new Date(Date.now() - CODEX_TURN_ID_SETTLE_MS - 5_000)
    fs.utimesSync(file, old, old)
    const cards = reader.parseFile(file, 'codex').map(r => r.card)
    assert.deepStrictEqual(cards.map(c => c.sessionId), [derivedTraceKey('codex', THREAD, ts(1000))])
    assert.strictEqual(cards[0].derived, true)
    assert.deepStrictEqual(reader.parseFile(file, 'codex'), [], 'now recorded: an unchanged file is not re-read')
  })

  test('Copilot Chat: a chat log growing a request at a time keeps one key per request', async () => {
    const file = path.join(work, 'workspaceStorage', 'abc', 'chatSessions', 'chat-1.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const lines = [
      { kind: 0, v: { creationDate: Date.parse('2026-10-04T08:00:00.000Z'), inputState: { selectedModel: { id: 'gpt-5' } } } },
      { kind: 2, k: ['requests'], v: [{ requestId: 'request_1', timestamp: Date.parse('2026-10-04T09:00:00.000Z'), message: { text: 'one' } }] },
      { kind: 1, k: ['requests', 0, 'result'], v: { usage: { completionTokens: 10, promptTokens: 100 }, timings: { totalElapsed: 2000 } } },
      { kind: 2, k: ['requests'], v: [{ requestId: 'request_2', timestamp: Date.parse('2026-10-04T09:01:00.000Z'), message: { text: 'two' } }] },
    ]
    const live = new LogReader()
    fs.writeFileSync(file, '')
    for (const line of lines) {
      fs.appendFileSync(file, JSON.stringify(line) + '\n')
      await enqueueAll(live.parseFile(file, 'copilot_vscode'))
    }
    const held = wireIds(new LogReader().parseFile(file, 'copilot_vscode'))
    assert.strictEqual(held.size, 2)
    assert.deepStrictEqual(extra(queuedWireIds(), held), [])
  })
})

// ── Unkeyed live cards ────────────────────────────────────────────────────────

function liveCard(sessionId: string, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId, traceId: 'trace-' + sessionId, source: 'claude_code', dataSource: 'otel', workspace: '/tmp/not-a-repo-' + sessionId,
    userRequest: 'x', model: 'claude-sonnet-4-6', turns: 1,
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: '2026-10-04T09:00:00.000Z',
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

suite('cloud key stability — a live card with no settled key is never sent', () => {
  let home: string
  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-keystab-live-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
    setCredentialStore(memoryStore())
  })
  teardown(() => {
    setCredentialStore(undefined)
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    fs.rmSync(home, { recursive: true, force: true })
  })

  // A Claude turn whose root span hasn't arrived (a long tool run, a permission prompt) is listed
  // under a synthesized `synth-` id; one whose transcript join is on hold has a provisional id
  // (`keyPending`). Both reach every forwarding path — the standalone server's idle-OTEL check,
  // both hosts' reconciliation (repo.listSessions() / buildSessionSummary() include live cards)
  // and the org panel's "Check for unsent traces" — but neither id is ever stored or put in a
  // trace manifest, so a row sent under one is a cloud row the local store never holds.
  const unkeyed: Array<[string, SessionSummaryCard]> = [
    ['a synthesized in-progress root', liveCard('synth-0af3c2d1e4b5')],
    ['a Claude interaction whose transcript join is on hold', liveCard('5b2e9c1d0a3f4e6b', { keyPending: true })],
  ]

  for (const [name, card] of unkeyed) {
    test(`${name}: maybeEnqueueSession sends nothing (first send and reconciliation re-send)`, async () => {
      assert.deepStrictEqual(traceKeysInWindow([card], 0, Date.now()), [], 'the manifest never lists it')
      assert.strictEqual((await maybeEnqueueSession(card)).enqueued, false)
      assert.strictEqual((await maybeEnqueueSession(card, undefined, undefined, 3)).enqueued, false)
      assert.strictEqual(new ForwardQueue().depth(), 0)
    })

    test(`${name}: maybeForwardOnContentChange sends nothing`, async () => {
      const reconciliation = {
        recordContentChange: () => ({ revision: 1, changed: true }),
      } as unknown as ReconciliationService
      assert.strictEqual((await maybeForwardOnContentChange(reconciliation, card)).enqueued, false)
      assert.strictEqual(new ForwardQueue().depth(), 0)
    })
  }

  test('a settled card is still sent', async () => {
    assert.strictEqual((await maybeEnqueueSession(liveCard(traceKey('claude', 'p-1')))).enqueued, true)
    assert.strictEqual(new ForwardQueue().depth(), 1)
  })
})

// ── Keys a re-read file stops producing leave the store ──────────────────────

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>
  prepare(sql: string): import('../database/db').SqlStatement
  close(): void
}

async function openDb(schema: string): Promise<SqlDb> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(schema)
  return db
}

const CSID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
let cseq = 0
const cuuid = () => `10000000-0000-4000-8000-${String(++cseq).padStart(12, '0')}`
const cPrompt = (ts: string, text: string, promptId?: string) =>
  ({ type: 'user', uuid: cuuid(), sessionId: CSID, cwd: '/work/repo', timestamp: ts, ...(promptId ? { promptId } : {}), message: { role: 'user', content: text } })
const cReply = (ts: string, msgId: string) =>
  ({ type: 'assistant', uuid: cuuid(), sessionId: CSID, timestamp: ts, message: { id: msgId, model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: 'done' }] } })
const writeLines = (file: string, lines: Record<string, unknown>[], append = false) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  if (append) fs.appendFileSync(file, body)
  else fs.writeFileSync(file, body)
}

suite('cloud key stability — keys a re-read log stops producing are retired', () => {
  let tmp: string
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-retire-')) })
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  // A transcript started by a Claude Code build that stamped no promptIds and continued by one
  // that does: every earlier turn's derived key gives way to the promptId turn. The derived keys
  // were already stored (and sent); nothing produces them any more.
  const oldFormat = () => [cPrompt('2026-10-04T09:00:00.000Z', 'one'), cReply('2026-10-04T09:00:02.000Z', 'm1'), cPrompt('2026-10-04T09:05:00.000Z', 'two'), cReply('2026-10-04T09:05:02.000Z', 'm2')]
  const newTurn = () => [cPrompt('2026-10-04T10:00:00.000Z', 'three', 'p-3'), cReply('2026-10-04T10:00:02.000Z', 'm3')]

  test('a key the file stops producing is reported once — also across a restart (persisted with the file state)', () => {
    const file = path.join(tmp, `${CSID}.jsonl`)
    writeLines(file, oldFormat())
    const first = new LogReader()
    const before = first.parseFile(file, 'claude').map(r => r.card.sessionId)
    assert.strictEqual(before.length, 2)
    assert.deepStrictEqual(first.takeRetiredKeys(), [])

    // Restart: the next process restores the persisted state, then the file changes.
    const state = JSON.parse(JSON.stringify(first.exportFileState())) as ReturnType<LogReader['exportFileState']>
    const second = new LogReader()
    second.importFileState(state)
    writeLines(file, newTurn(), true)
    const after = second.parseFile(file, 'claude').map(r => r.card.sessionId)
    assert.deepStrictEqual(after, [traceKey('claude', 'p-3')])
    assert.deepStrictEqual(second.takeRetiredKeys().sort(), [...before].sort())
    assert.deepStrictEqual(second.takeRetiredKeys(), [], 'reported once')
  })

  test('a key another file still produces (a resumed or forked copy) is not retired', () => {
    const a = path.join(tmp, 'a', `${CSID}.jsonl`)
    const b = path.join(tmp, 'b', `${CSID}.jsonl`)
    writeLines(a, [cPrompt('2026-10-04T09:00:00.000Z', 'one', 'p-1'), cReply('2026-10-04T09:00:02.000Z', 'm1')])
    writeLines(b, [cPrompt('2026-10-04T09:00:00.000Z', 'one', 'p-1'), cReply('2026-10-04T09:00:02.000Z', 'm1')])
    const reader = new LogReader()
    reader.parseFile(a, 'claude')
    reader.parseFile(b, 'claude')
    writeLines(a, [cPrompt('2026-10-04T11:00:00.000Z', 'other', 'p-9'), cReply('2026-10-04T11:00:02.000Z', 'm9')])
    reader.parseFile(a, 'claude')
    assert.deepStrictEqual(reader.takeRetiredKeys(), [])
  })

  test('the extension store: retired keys leave the database (log rows only), its manifest keys match a fresh read', async () => {
    const db = await openDb(SCHEMA_SQL)
    const writer = new DatabaseWriter(db, require('vscode').Uri.file(path.join(tmp, 'storage')), () => {})
    const file = path.join(tmp, `${CSID}.jsonl`)
    writeLines(file, oldFormat())
    const reader = new LogReader()
    for (const r of reader.parseFile(file, 'claude')) writer.enqueue(r.card, '/work/repo')
    // An OTEL row of its own under an unrelated key, which no log file produces.
    writer.enqueue(liveCard(traceKey('claude', 'otel-only')), '/work/repo')
    await writer.drain()
    writeLines(file, newTurn(), true)
    for (const r of reader.parseFile(file, 'claude')) writer.enqueue(r.card, '/work/repo')
    await writer.drain()
    const retired = reader.takeRetiredKeys()
    assert.strictEqual(writer.deleteLogSessions([...retired, traceKey('claude', 'otel-only')]).length, 2, 'the OTEL row is not a log row')

    const dbReader = new DatabaseReader(db, require('vscode').Uri.file(path.join(tmp, 'storage')))
    const held = new Set(dbReader.listTraceKeys(0, Date.now()))
    const fresh = new LogReader().parseFile(file, 'claude').map(r => toUuid(r.card.sessionId))
    assert.deepStrictEqual([...held].sort(), [...fresh, toUuid(traceKey('claude', 'otel-only'))].sort())
    assert.strictEqual(Number(db.exec('SELECT COUNT(*) FROM timeline_entries WHERE session_id IN (' + retired.map(k => `'${k}'`).join(',') + ')')[0].values[0][0]), 0,
      'their timeline rows go with them')
    db.close()
  })
})

// ── Claude join decisions hold across restarts ───────────────────────────────

suite('cloud key stability — a Claude join decision holds across a restart', () => {
  let tmp: string
  let file: string
  let clock: number
  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-join-'))
    file = path.join(tmp, `${CSID}.jsonl`)
    clock = Date.parse('2026-10-04T12:00:00.000Z')
  })
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
  const joiner = (store?: ClaudeJoinRepository, awaitStore = false) =>
    new ClaudeTurnJoiner({ findTranscripts: sid => (sid === CSID ? [file] : []), holdMs: 5_000, now: () => clock, store, awaitStore })
  const start = Date.parse('2026-10-04T10:00:00.000Z')

  test('an interaction that fell back to its claude:interaction key keeps it after a restart, even once its turn is on disk', async () => {
    const db = await openDb(OUTCOMES_SCHEMA_SQL)
    const store = new ClaudeJoinRepository(db)
    // Run 1: the transcript line never shows up within the hold.
    writeLines(file, [cPrompt('2026-10-04T09:00:00.000Z', 'earlier', 'p-0')])
    const run1 = joiner(store)
    assert.strictEqual(run1.resolve({ interactionId: 'span-1', claudeSessionId: CSID, startMs: start }).status, 'pending')
    clock += 6_000
    const decided = run1.resolve({ interactionId: 'span-1', claudeSessionId: CSID, startMs: start })
    assert.deepStrictEqual(decided, { status: 'derived', key: claudeInteractionKey(CSID, start) })

    // The line lands later; run 2 re-reads the same spans.
    writeLines(file, [cPrompt('2026-10-04T10:00:00.020Z', 'late', 'p-1')], true)
    assert.deepStrictEqual(joiner(store).resolve({ interactionId: 'span-1', claudeSessionId: CSID, startMs: start }), decided)
    // Without the store it would have flipped — the mechanism this guards against.
    assert.strictEqual(joiner().resolve({ interactionId: 'span-1', claudeSessionId: CSID, startMs: start }).status, 'joined')
    db.close()
  })

  test('a turn joined in an earlier run is never taken by another interaction in the next', async () => {
    const db = await openDb(OUTCOMES_SCHEMA_SQL)
    const store = new ClaudeJoinRepository(db)
    writeLines(file, [cPrompt('2026-10-04T10:00:00.020Z', 'hi', 'p-1')])
    assert.deepStrictEqual(joiner(store).resolve({ interactionId: 'span-1', claudeSessionId: CSID, startMs: start }), { status: 'joined', key: traceKey('claude', 'p-1'), derived: false })
    // Next run: a different interaction close by is seen first.
    const run2 = joiner(store)
    assert.strictEqual(run2.resolve({ interactionId: 'span-2', claudeSessionId: CSID, startMs: start + 10 }).status, 'pending')
    clock += 6_000
    assert.strictEqual(run2.resolve({ interactionId: 'span-2', claudeSessionId: CSID, startMs: start + 10 }).status, 'derived')
    assert.deepStrictEqual(run2.resolve({ interactionId: 'span-1', claudeSessionId: CSID, startMs: start }), { status: 'joined', key: traceKey('claude', 'p-1'), derived: false })
    db.close()
  })

  test('a joiner waiting for its store decides nothing until it is attached', async () => {
    const db = await openDb(OUTCOMES_SCHEMA_SQL)
    const store = new ClaudeJoinRepository(db)
    store.put('span-1', { status: 'derived', key: claudeInteractionKey(CSID, start) })
    writeLines(file, [cPrompt('2026-10-04T10:00:00.020Z', 'hi', 'p-1')])
    const j = joiner(undefined, true)
    clock += 60_000
    assert.strictEqual(j.resolve({ interactionId: 'span-1', claudeSessionId: CSID, startMs: start }).status, 'pending')
    j.attachStore(store)
    assert.deepStrictEqual(j.resolve({ interactionId: 'span-1', claudeSessionId: CSID, startMs: start }), { status: 'derived', key: claudeInteractionKey(CSID, start) })
    db.close()
  })
})
