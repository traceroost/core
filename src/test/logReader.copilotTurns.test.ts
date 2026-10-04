import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader } from '../logReader'
import { traceKey, derivedTraceKey } from '../traceIdentity'

// Synthetic Copilot Chat (VS Code) delta logs and Copilot CLI event logs — no real user data.
function writeJsonl(filePath: string, lines: Record<string, unknown>[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}
function snapshot(creationDateMs: number, model = 'copilot/gpt-5.6-luna') {
  return { kind: 0, v: { version: 3, creationDate: creationDateMs, sessionId: 'sess', requests: [], inputState: { selectedModel: { id: model, metadata: { family: model.replace(/^copilot\//, '') } } } } }
}
/** One `kind: 2` push adding a request — the format's own turn. */
function requestsPush(ts: number, message: string, completionTokens?: number, requestId: string | null = `request_${ts}`) {
  const req: Record<string, unknown> = { timestamp: ts, message: { text: message } }
  if (requestId) req['requestId'] = requestId
  if (completionTokens !== undefined) req['completionTokens'] = completionTokens
  return { kind: 2, k: ['requests'], v: [req] }
}
const completionTokensSet = (idx: number, tokens: number) => ({ kind: 1, k: ['requests', idx, 'completionTokens'], v: tokens })
const resultSet = (idx: number, totalElapsed: number) => ({ kind: 1, k: ['requests', idx, 'result'], v: { timings: { firstProgress: 900, totalElapsed } } })

suite('LogReader — Copilot Chat, one trace per request', () => {
  let tmpDir: string
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-copilot-turns-')) })
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  test('each request is its own trace, keyed by its requestId, grouped by the chat as one conversation', () => {
    const filePath = path.join(tmpDir, 'chat-1.jsonl')
    const t0 = 1_777_000_000_000
    writeJsonl(filePath, [snapshot(t0), requestsPush(t0, 'yes', 10, 'request_a'), requestsPush(t0 + 60_000, 'yes', 20, 'request_b'), resultSet(1, 4200)])
    const cards = new LogReader().parseFile(filePath, 'copilot_vscode').map(r => r.card)
    assert.deepStrictEqual(cards.map(c => c.sessionId), [traceKey('copilot', 'request_a'), traceKey('copilot', 'request_b')])
    assert.deepStrictEqual(cards.map(c => c.outputTokens), [10, 20])
    assert.strictEqual(cards[1].durationMs, 4200)
    assert.ok(cards.every(c => c.conversationId === 'chat-1' && !c.derived && c.sourceRank === 2))
  })

  test('a late completionTokens update addresses its request by its position in the whole chat', () => {
    const filePath = path.join(tmpDir, 'chat-2.jsonl')
    const t0 = 1_777_000_000_000
    writeJsonl(filePath, [snapshot(t0), requestsPush(t0, 'first', 10), requestsPush(t0 + 5 * 3600_000, 'second'), completionTokensSet(1, 25)])
    const cards = new LogReader().parseFile(filePath, 'copilot_vscode').map(r => r.card)
    assert.deepStrictEqual(cards.map(c => c.outputTokens), [10, 25])
  })

  test('a request starts at its own timestamp, not the chat panel\'s creation; one with no requestId gets a derived key', () => {
    const filePath = path.join(tmpDir, 'chat-3.jsonl')
    const panelCreated = 1_777_000_000_000
    const first = panelCreated + 5 * 3600_000
    writeJsonl(filePath, [snapshot(panelCreated), requestsPush(first, 'finally typed something', 10, null)])
    const card = new LogReader().parseFile(filePath, 'copilot_vscode')[0].card
    assert.strictEqual(card.startTime, new Date(first).toISOString())
    assert.strictEqual(card.sessionId, derivedTraceKey('copilot', 'chat-3', String(first)))
    assert.strictEqual(card.derived, true)
  })
})

suite('LogReader — Copilot CLI, one trace per prompt', () => {
  let tmpDir: string
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-copilot-cli-turns-')) })
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  test('each user.message opens a turn (derived key); session-wide input usage lands on the last turn', () => {
    const dir = path.join(tmpDir, 'b1c2d3e4-0000-4000-8000-000000000001')
    const file = path.join(dir, 'events.jsonl')
    writeJsonl(file, [
      { type: 'session.start', id: 'ev-0', timestamp: '2026-05-01T10:00:00.000Z', data: { selectedModel: 'gpt-5.6-luna', context: { cwd: '/work/repo' } } },
      { type: 'user.message', id: 'ev-1', timestamp: '2026-05-01T10:00:01.000Z', data: { transformedContent: 'add a test' } },
      { type: 'assistant.message', id: 'ev-2', timestamp: '2026-05-01T10:00:05.000Z', data: { outputTokens: 40, toolRequests: [{ name: 'edit', arguments: { path: '/work/repo/a.ts' } }] } },
      { type: 'user.message', id: 'ev-3', timestamp: '2026-05-01T10:02:00.000Z', data: { transformedContent: 'run it' } },
      { type: 'assistant.message', id: 'ev-4', timestamp: '2026-05-01T10:02:05.000Z', data: { outputTokens: 10 } },
      { type: 'session.shutdown', id: 'ev-5', timestamp: '2026-05-01T10:03:00.000Z', data: { modelMetrics: { 'gpt-5.6-luna': { usage: { inputTokens: 5000, cacheReadTokens: 1000, cacheWriteTokens: 0 } } } } },
    ])
    const sessionId = path.basename(dir)
    const cards = new LogReader().parseFile(file, 'copilot').map(r => r.card)
    assert.deepStrictEqual(cards.map(c => c.sessionId), [derivedTraceKey('copilot', sessionId, 'ev-1'), derivedTraceKey('copilot', sessionId, 'ev-3')])
    assert.deepStrictEqual(cards.map(c => c.userRequest), ['add a test', 'run it'])
    assert.deepStrictEqual(cards.map(c => c.outputTokens), [40, 10])
    assert.deepStrictEqual(cards.map(c => c.cacheReadTokens), [0, 1000])
    assert.deepStrictEqual(cards[0].filesChanged, ['/work/repo/a.ts'])
    assert.ok(cards.every(c => c.derived && c.workspace === '/work/repo'))
  })
})
