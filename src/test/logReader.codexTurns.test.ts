import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader, codexTurnRanges } from '../logReader'
import { summarizeSpans } from '../spanSummarizer'
import { traceKey, derivedTraceKey } from '../traceIdentity'
import type { Span } from '../types'

// Synthetic Codex rollouts in the on-disk shape (no real user data).
const THREAD = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b'

function writeJsonl(filePath: string, lines: Record<string, unknown>[]) {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}
const sessionMeta = (ts: string) => ({ timestamp: ts, type: 'session_meta', payload: { id: THREAD, cwd: '/work/repo' } })
const settings = (ts: string) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'thread_settings_applied' } })
const taskStarted = (ts: string, turnId?: string) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started', ...(turnId ? { turn_id: turnId } : {}) } })
const userMessage = (ts: string, message: string) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message } })
const turnContext = (ts: string, turnId?: string) => ({ timestamp: ts, type: 'turn_context', payload: { model: 'gpt-5.6-luna', cwd: '/work/repo', ...(turnId ? { turn_id: turnId } : {}) } })
function tokenCount(ts: string, input: number, output: number, cached = 0) {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5.6-luna', total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached }, last_token_usage: { input_tokens: 1, output_tokens: 1 } } } }
}
/** A turn as Codex logs it: bookkeeping within milliseconds, then the prompt. */
function turn(ts: string, message: string, turnId?: string): Record<string, unknown>[] {
  return [settings(ts), taskStarted(ts, turnId), turnContext(ts, turnId), userMessage(ts, message)]
}
const at = (base: string, ms: number) => new Date(Date.parse(base) + ms).toISOString()
const T0 = '2026-05-01T10:00:00.000Z'

suite('codexTurnRanges — one range per turn', () => {
  test('a turn starts at its earliest near-simultaneous bookkeeping line, not at the user_message', () => {
    const parsed = [sessionMeta(T0), ...turn(at(T0, 1000), 'one', 't-1'), tokenCount(at(T0, 5000), 100, 10), ...turn(at(T0, 60_000), 'two', 't-2')]
    const ranges = codexTurnRanges(parsed)
    assert.deepStrictEqual(ranges.map(r => [r.start, r.end, r.turnId]), [[0, 6, 't-1'], [6, 10, 't-2']])
  })

  test('a user_message inside a running turn (same turn_id) opens no turn', () => {
    const parsed = [
      sessionMeta(T0), ...turn(at(T0, 1000), 'refactor it', 't-1'),
      userMessage(at(T0, 30_000), 'also the tests'), taskStarted(at(T0, 30_000), 't-1'),
      tokenCount(at(T0, 40_000), 100, 10),
    ]
    assert.deepStrictEqual(codexTurnRanges(parsed).map(r => r.turnId), ['t-1'])
  })

  test('a rollout with no turn ids: one turn per prompt, derived from its timestamp', () => {
    const parsed = [sessionMeta(T0), ...turn(at(T0, 1000), 'one'), ...turn(at(T0, 60_000), 'two')]
    const ranges = codexTurnRanges(parsed)
    assert.deepStrictEqual(ranges.map(r => r.turnId), ['', ''])
    assert.deepStrictEqual(ranges.map(r => r.openingTs), [at(T0, 1000), at(T0, 60_000)])
  })
})

suite('LogReader — Codex, one trace per turn', () => {
  let tmpDir: string
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-codex-turns-')) })
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  test('each turn is keyed by Codex\'s turn_id and reports only its own token delta', () => {
    const filePath = path.join(tmpDir, `rollout-2026-05-01T10-00-00-${THREAD}.jsonl`)
    writeJsonl(filePath, [
      sessionMeta(T0),
      ...turn(at(T0, 1000), 'day one work', 't-1'), tokenCount(at(T0, 5000), 16000, 150),
      ...turn(at(T0, 3 * 86_400_000), 'day four work', 't-2'), tokenCount(at(T0, 3 * 86_400_000 + 5000), 33700, 2200, 500),
    ])
    const results = new LogReader().parseFile(filePath, 'codex')
    assert.deepStrictEqual(results.map(r => r.card.sessionId), [traceKey('codex', 't-1'), traceKey('codex', 't-2')])
    assert.strictEqual(results[0].card.inputTokens, 16000)
    assert.strictEqual(results[1].card.inputTokens, 500 + (33700 - 500 - 16000))
    assert.strictEqual(results[1].card.outputTokens, 2200 - 150)
    assert.ok(results.every(r => r.card.conversationId === THREAD && r.card.workspace === '/work/repo'))
    assert.ok(results[1].card.durationMs < 60_000, 'a turn never spans the multi-day gap')
  })

  test('a turn with no token_count of its own reports zero and does not reset the baseline', () => {
    const filePath = path.join(tmpDir, 'rollout-empty-middle.jsonl')
    writeJsonl(filePath, [
      sessionMeta(T0),
      ...turn(at(T0, 1000), 'first', 't-1'), tokenCount(at(T0, 2000), 10000, 100),
      ...turn(at(T0, 60_000), 'second', 't-2'),
      ...turn(at(T0, 120_000), 'third', 't-3'), tokenCount(at(T0, 125_000), 25000, 500),
    ])
    const results = new LogReader().parseFile(filePath, 'codex')
    assert.deepStrictEqual(results.map(r => r.card.inputTokens), [10000, 0, 15000])
    assert.strictEqual(results[1].card.sourceRank, 1, 'no usage on disk → partial')
  })

  test('turn_aborted, logged when the user comes back, does not stretch a turn', () => {
    const filePath = path.join(tmpDir, 'rollout-aborted.jsonl')
    const resumedAt = at(T0, 3 * 86_400_000)
    writeJsonl(filePath, [
      sessionMeta(T0), ...turn(at(T0, 1000), 'first', 't-1'), tokenCount(at(T0, 2000), 100, 10),
      { timestamp: resumedAt, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't-1' } },
      ...turn(at(T0, 3 * 86_400_000 + 31_000), 'resumed', 't-2'),
    ])
    const results = new LogReader().parseFile(filePath, 'codex')
    assert.strictEqual(results.length, 2)
    assert.ok(results[0].card.durationMs < 60_000)
    assert.ok(results[1].card.durationMs < 60_000)
  })

  test('a rollout with no turn ids gets derived keys, marked derived', () => {
    const filePath = path.join(tmpDir, 'rollout-old.jsonl')
    writeJsonl(filePath, [sessionMeta(T0), ...turn(at(T0, 1000), 'first'), tokenCount(at(T0, 2000), 100, 10)])
    // An old rollout: a fresh one with an id-less turn is held for its turn_id (cloudKeyStability).
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(filePath, old, old)
    const card = new LogReader().parseFile(filePath, 'codex')[0].card
    assert.strictEqual(card.sessionId, derivedTraceKey('codex', THREAD, at(T0, 1000)))
    assert.strictEqual(card.derived, true)
  })

  test('the Codex OTEL card of a turn gets the same key as its rollout turn', () => {
    const attr = (key: string, v: string) => ({ key, value: { stringValue: v } })
    const spans: Span[] = [
      { traceId: 'otel-a', spanId: 'prompt-1', name: 'codex.user_prompt', startTime: '1777629601000000000', endTime: '1777629601000000000',
        attributes: [attr('event.name', 'codex.user_prompt'), attr('conversation.id', THREAD), attr('turn.id', 't-1'), attr('prompt', 'day one work')] },
      { traceId: 'otel-a', spanId: 'sse-1', name: 'codex.sse_event', startTime: '1777629602000000000', endTime: '1777629603000000000',
        attributes: [attr('event.name', 'codex.sse_event'), attr('conversation.id', THREAD), attr('turn.id', 't-1'), attr('event.kind', 'response.completed'), { key: 'input_token_count', value: { intValue: 16000 } }, { key: 'output_token_count', value: { intValue: 150 } }] },
    ]
    const card = summarizeSpans(spans).sessions.find(s => s.source === 'codex')
    assert.ok(card)
    assert.strictEqual(card.sessionId, traceKey('codex', 't-1'))
    assert.strictEqual(card.sourceRank, 3)
  })
})
