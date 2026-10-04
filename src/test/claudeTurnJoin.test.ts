import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { ClaudeTurnJoiner, setClaudeTurnJoiner, DEFAULT_JOIN_HOLD_MS } from '../claudeTurnJoin'
import { summarizeSpans } from '../spanSummarizer'
import { LogReader } from '../logReader'
import { DatabaseWriter } from '../database/writer'
import { SCHEMA_SQL } from '../database/schema'
import { traceKey, claudeInteractionKey } from '../traceIdentity'
import type { Span } from '../types'
import type * as vscode from 'vscode'

// Synthetic Claude Code transcript + OTEL — no real user data. OTEL's interaction span starts a
// few ms *before* the transcript's prompt line is written.
const SID = '3f2e1d0c-9b8a-4765-8432-10fedcba9876'
let n = 0
const id = () => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`
const prompt = (ts: string, text: string, promptId: string) =>
  ({ type: 'user', uuid: id(), sessionId: SID, cwd: '/work/repo', timestamp: ts, promptId, message: { role: 'user', content: text } })
const reply = (ts: string, msgId: string) =>
  ({ type: 'assistant', uuid: id(), sessionId: SID, timestamp: ts, message: { id: msgId, model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: 'done' }] } })
const ms = (iso: string) => Date.parse(iso)
const ns = (msValue: number) => `${BigInt(msValue) * 1_000_000n}`

function interactionSpans(spanId: string, startMs: number, promptLength?: number): Span[] {
  const attr = (key: string, v: string | number) => typeof v === 'number' ? { key, value: { intValue: v } } : { key, value: { stringValue: v } }
  return [
    { traceId: `trace-${spanId}`, spanId, name: 'claude_code.interaction', startTime: ns(startMs), endTime: ns(startMs + 4000),
      attributes: [attr('session.id', SID), ...(promptLength ? [attr('user_prompt_length', promptLength)] : [])] },
    { traceId: `trace-${spanId}`, spanId: `${spanId}-llm`, parentSpanId: spanId, name: 'claude_code.llm_request', startTime: ns(startMs + 500), endTime: ns(startMs + 3000),
      attributes: [attr('session.id', SID), attr('model', 'claude-sonnet-4-6'), attr('input_tokens', 120), attr('output_tokens', 30)] },
  ]
}

suite('ClaudeTurnJoiner — OTEL interaction → transcript turn', () => {
  let tmpDir: string
  let file: string
  let clock: number
  const joiner = (holdMs = DEFAULT_JOIN_HOLD_MS) => new ClaudeTurnJoiner({ findTranscripts: sid => (sid === SID ? [file] : []), holdMs, now: () => clock })
  const write = (lines: Record<string, unknown>[]) => fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-join-'))
    file = path.join(tmpDir, `${SID}.jsonl`)
    clock = ms('2026-05-01T12:00:00.000Z')
  })
  teardown(() => {
    setClaudeTurnJoiner(null)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('joins the turn whose prompt line follows the interaction start by a few ms', () => {
    write([prompt('2026-05-01T10:00:00.017Z', 'yes', 'p-1'), reply('2026-05-01T10:00:02.000Z', 'm1'), prompt('2026-05-01T10:01:00.040Z', 'yes', 'p-2')])
    const j = joiner()
    assert.deepStrictEqual(j.resolve({ interactionId: 'span-1', claudeSessionId: SID, startMs: ms('2026-05-01T10:00:00.000Z') }), { status: 'joined', key: traceKey('claude', 'p-1'), derived: false })
    assert.deepStrictEqual(j.resolve({ interactionId: 'span-2', claudeSessionId: SID, startMs: ms('2026-05-01T10:01:00.000Z') }), { status: 'joined', key: traceKey('claude', 'p-2'), derived: false })
  })

  test('OTEL before its transcript line: held, then joined once the line exists — never to the neighbouring turn', () => {
    // The previous turn's prompt is 1.5 s before this interaction — inside the ±2 s window, but
    // a line that far *before* an interaction is never its own (OTEL always leads).
    write([prompt('2026-05-01T10:00:00.000Z', 'previous', 'p-0')])
    const j = joiner()
    const input = { interactionId: 'span-1', claudeSessionId: SID, startMs: ms('2026-05-01T10:00:01.500Z') }
    assert.deepStrictEqual(j.resolve(input), { status: 'pending' })
    fs.appendFileSync(file, JSON.stringify(prompt('2026-05-01T10:00:01.567Z', 'now', 'p-1')) + '\n')
    clock += 1000
    assert.deepStrictEqual(j.resolve(input), { status: 'joined', key: traceKey('claude', 'p-1'), derived: false })
  })

  test('unjoinable after the hold: a derived interaction key, final — a line appearing later changes nothing', () => {
    write([prompt('2026-05-01T09:00:00.000Z', 'much earlier', 'p-0')])
    const j = joiner(5000)
    const input = { interactionId: 'span-1', claudeSessionId: SID, startMs: ms('2026-05-01T10:00:00.000Z') }
    assert.strictEqual(j.resolve(input).status, 'pending')
    clock += 5000
    const derived = { status: 'derived', key: claudeInteractionKey(SID, input.startMs) }
    assert.deepStrictEqual(j.resolve(input), derived)
    fs.appendFileSync(file, JSON.stringify(prompt('2026-05-01T10:00:00.020Z', 'late', 'p-1')) + '\n')
    assert.deepStrictEqual(j.resolve(input), derived, 'never merged by guesswork after the fact')
  })

  test('two lines within a few ms: user_prompt_length (equal, or one longer with IDE context) breaks the tie; otherwise no join', () => {
    write([prompt('2026-05-01T10:00:00.010Z', 'abc', 'p-1'), prompt('2026-05-01T10:00:00.030Z', 'abcdef', 'p-2')])
    assert.strictEqual((joiner().resolve({ interactionId: 's', claudeSessionId: SID, startMs: ms('2026-05-01T10:00:00.000Z'), promptLength: 7 }) as { key: string }).key, traceKey('claude', 'p-2'))
    assert.strictEqual((joiner().resolve({ interactionId: 's', claudeSessionId: SID, startMs: ms('2026-05-01T10:00:00.000Z'), promptLength: 3 }) as { key: string }).key, traceKey('claude', 'p-1'))
    assert.strictEqual(joiner().resolve({ interactionId: 's', claudeSessionId: SID, startMs: ms('2026-05-01T10:00:00.000Z') }).status, 'derived')
  })

  test('a turn is joined by at most one interaction', () => {
    write([prompt('2026-05-01T10:00:00.017Z', 'go', 'p-1')])
    const j = joiner(0)
    assert.strictEqual(j.resolve({ interactionId: 'a', claudeSessionId: SID, startMs: ms('2026-05-01T10:00:00.000Z') }).status, 'joined')
    assert.strictEqual(j.resolve({ interactionId: 'b', claudeSessionId: SID, startMs: ms('2026-05-01T10:00:00.005Z') }).status, 'derived')
  })

  test('summarizeSpans: a joined OTEL card carries the transcript turn\'s key; transcript then OTEL is one row with the OTEL rank', async () => {
    write([prompt('2026-05-01T10:00:00.017Z', 'fix the parser', 'p-1'), reply('2026-05-01T10:00:02.000Z', 'm1')])
    setClaudeTurnJoiner(joiner())
    const otel = summarizeSpans(interactionSpans('span-1', ms('2026-05-01T10:00:00.000Z'))).sessions[0]
    assert.strictEqual(otel.sessionId, traceKey('claude', 'p-1'))
    assert.strictEqual(otel.sourceRank, 3)
    assert.strictEqual(otel.conversationId, SID)

    const logCard = new LogReader().parseFile(file, 'claude')[0].card
    assert.strictEqual(logCard.sessionId, otel.sessionId)

    const sqlJsDir = path.dirname(require.resolve('sql.js'))
    const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => { run(s: string, p?: unknown[]): void; exec(s: string, p?: unknown[]): Array<{ values: unknown[][] }>; prepare(s: string): never; close(): void } }>
    const SQL = await initSqlJs({ locateFile: f => path.join(sqlJsDir, f) })
    const db = new SQL.Database()
    db.run(SCHEMA_SQL)
    const w = new DatabaseWriter(db as never, require('vscode').Uri.file(path.join(tmpDir, 'store')) as vscode.Uri, () => {})
    w.enqueue(logCard, '')
    await w.drain()
    w.enqueue(otel, '')
    await w.drain()
    w.enqueue({ ...logCard }, '')  // the transcript re-scanned after OTEL
    await w.drain()
    const rows = db.exec('SELECT session_id, data_source, source_rank FROM sessions')[0].values
    assert.deepStrictEqual(rows, [[traceKey('claude', 'p-1'), 'otel', 3]])
    db.close()
  })

  test('summarizeSpans: a join still on hold is marked pending; with no joiner the interaction is derived', () => {
    write([])
    setClaudeTurnJoiner(joiner())
    const pending = summarizeSpans(interactionSpans('span-9', ms('2026-05-01T10:00:00.000Z'))).sessions[0]
    assert.strictEqual(pending.keyPending, true)
    assert.strictEqual(pending.sessionId, 'span-9')
    setClaudeTurnJoiner(null)
    const derived = summarizeSpans(interactionSpans('span-9', ms('2026-05-01T10:00:00.000Z'))).sessions[0]
    assert.strictEqual(derived.sessionId, claudeInteractionKey(SID, ms('2026-05-01T10:00:00.000Z')))
    assert.strictEqual(derived.derived, true)
  })
})
