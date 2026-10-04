import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader, dedupeByUuid } from '../logReader'
import { segmentClaudeTurns } from '../claudeTurns'
import { traceKey, derivedTraceKey, toUuid } from '../traceIdentity'

// Synthetic transcripts in Claude Code's on-disk shape (no real user data): prompt lines carry
// the turn's promptId; assistant lines carry message.id/usage; tool results come back as user
// lines whose content is a tool_result block.
const SID = '6c1d2b8e-0f4a-4c33-9d2e-5a1b7c9e0f11'
let seq = 0
function uuid(): string { return `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}` }

function prompt(ts: string, text: string, promptId: string | undefined, extra: Record<string, unknown> = {}) {
  return { type: 'user', uuid: uuid(), sessionId: SID, cwd: '/work/repo', timestamp: ts, ...(promptId ? { promptId } : {}), message: { role: 'user', content: text }, ...extra }
}
function toolResult(ts: string, promptId: string | undefined, extraText?: string) {
  const content: unknown[] = [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' }]
  if (extraText) content.push({ type: 'text', text: extraText })
  return { type: 'user', uuid: uuid(), sessionId: SID, timestamp: ts, ...(promptId ? { promptId } : {}), message: { role: 'user', content } }
}
function reply(ts: string, msgId: string, opts: { input?: number; output?: number; tool?: string; model?: string } = {}) {
  const content = opts.tool
    ? [{ type: 'tool_use', id: 'toolu_01', name: opts.tool, input: { file_path: '/work/repo/src/a.ts', old_string: 'a', new_string: 'b' } }]
    : [{ type: 'text', text: 'done' }]
  return {
    type: 'assistant', uuid: uuid(), sessionId: SID, timestamp: ts, requestId: `req_${msgId}`,
    message: { id: msgId, model: opts.model ?? 'claude-sonnet-4-6', usage: { input_tokens: opts.input ?? 100, output_tokens: opts.output ?? 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content },
  }
}
function writeJsonl(filePath: string, lines: Record<string, unknown>[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

suite('segmentClaudeTurns — one turn per promptId', () => {
  test('repeated prompt text never merges turns: each promptId is its own turn', () => {
    const lines = [
      prompt('2026-05-01T10:00:00.000Z', 'yes', 'p-1'), reply('2026-05-01T10:00:02.000Z', 'msg_1'),
      prompt('2026-05-01T10:01:00.000Z', 'yes', 'p-2'), reply('2026-05-01T10:01:02.000Z', 'msg_2'),
      prompt('2026-05-01T10:02:00.000Z', 'yes', 'p-3'), reply('2026-05-01T10:02:02.000Z', 'msg_3'),
    ]
    const turns = segmentClaudeTurns(lines)
    assert.deepStrictEqual(turns.map(t => t.turnId), ['p-1', 'p-2', 'p-3'])
    assert.ok(turns.every(t => t.exact))
    assert.strictEqual(new Set(turns.map(t => traceKey('claude', t.turnId))).size, 3)
  })

  test('interrupt marker, compaction carry-over and slash-command lines stay in the turn whose promptId they share', () => {
    const lines = [
      prompt('2026-05-01T10:00:00.000Z', '<command-name>/review</command-name>', 'p-1'),
      prompt('2026-05-01T10:00:00.010Z', '<local-command-stdout>Reviewing…</local-command-stdout>', 'p-1'),
      reply('2026-05-01T10:00:02.000Z', 'msg_1', { tool: 'Edit' }),
      prompt('2026-05-01T10:00:05.000Z', '[Request interrupted by user for tool use]', 'p-1'),
      prompt('2026-05-01T10:00:06.000Z', 'This session is being continued from a previous conversation that ran out of context.', 'p-1', { isCompactSummary: true }),
      reply('2026-05-01T10:00:08.000Z', 'msg_2'),
      prompt('2026-05-01T10:05:00.000Z', 'next thing', 'p-2'),
    ]
    const turns = segmentClaudeTurns(lines)
    assert.strictEqual(turns.length, 2)
    assert.deepStrictEqual(turns[0].indices, [0, 1, 2, 3, 4, 5])
    assert.deepStrictEqual(turns[1].indices, [6])
  })

  test('a message typed while the agent works (delivered in a tool result) opens no turn', () => {
    const lines = [
      prompt('2026-05-01T10:00:00.000Z', 'refactor the parser', 'p-1'),
      reply('2026-05-01T10:00:02.000Z', 'msg_1', { tool: 'Edit' }),
      // Delivered with the next tool result, under a promptId of its own — still the same turn.
      toolResult('2026-05-01T10:00:10.000Z', 'p-queued', 'also update the tests'),
      reply('2026-05-01T10:00:12.000Z', 'msg_2'),
    ]
    const turns = segmentClaudeTurns(lines)
    assert.strictEqual(turns.length, 1)
    assert.deepStrictEqual(turns[0].indices, [0, 1, 2, 3])
  })

  test('a transcript from before promptIds: one derived turn per real prompt, continuation lines excluded', () => {
    const lines = [
      prompt('2026-05-01T10:00:00.000Z', 'first', undefined),
      reply('2026-05-01T10:00:02.000Z', 'msg_1', { tool: 'Read' }),
      toolResult('2026-05-01T10:00:03.000Z', undefined),
      prompt('2026-05-01T10:00:04.000Z', '[Request interrupted by user]', undefined),
      prompt('2026-05-01T10:01:00.000Z', 'second', undefined),
    ]
    const turns = segmentClaudeTurns(lines)
    assert.strictEqual(turns.length, 2)
    assert.ok(turns.every(t => !t.exact))
    assert.strictEqual(turns[0].turnId, lines[0].uuid)
    assert.deepStrictEqual(turns[0].indices, [0, 1, 2, 3])
  })
})

suite('LogReader — Claude Code, one trace per turn', () => {
  let tmpDir: string
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-claude-turns-')) })
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  test('each turn is its own trace keyed by its promptId, grouped by the transcript as one conversation', () => {
    const filePath = path.join(tmpDir, 'proj', `${SID}.jsonl`)
    writeJsonl(filePath, [
      prompt('2026-05-01T10:00:00.000Z', 'yes', 'p-1'), reply('2026-05-01T10:00:02.000Z', 'msg_1', { input: 100 }),
      prompt('2026-05-01T10:01:00.000Z', 'yes', 'p-2'), reply('2026-05-01T10:01:02.000Z', 'msg_2', { input: 200 }),
    ])
    const results = new LogReader().parseFile(filePath, 'claude')
    assert.deepStrictEqual(results.map(r => r.card.sessionId), [traceKey('claude', 'p-1'), traceKey('claude', 'p-2')])
    assert.deepStrictEqual(results.map(r => r.card.inputTokens), [100, 200])
    assert.ok(results.every(r => r.card.conversationId === SID && r.card.claudeSessionId === SID))
    assert.ok(results.every(r => r.card.sourceRank === 2 && !r.card.derived))
    assert.strictEqual(results[0].card.startTime, '2026-05-01T10:00:00.000Z')
  })

  test('a resumed copy of the transcript upserts onto the original turns — same keys', () => {
    const lines = [prompt('2026-05-01T10:00:00.000Z', 'fix it', 'p-1'), reply('2026-05-01T10:00:02.000Z', 'msg_1')]
    const original = path.join(tmpDir, 'proj', `${SID}.jsonl`)
    const resumed = path.join(tmpDir, 'proj', '9a8b7c6d-1111-4222-8333-444455556666.jsonl')
    writeJsonl(original, lines)
    writeJsonl(resumed, [...lines.map(l => ({ ...l, sessionId: 'resumed' })), prompt('2026-05-02T09:00:00.000Z', 'continue', 'p-2')])
    const reader = new LogReader()
    const a = reader.parseFile(original, 'claude').map(r => r.card.sessionId)
    const b = reader.parseFile(resumed, 'claude').map(r => r.card.sessionId)
    assert.deepStrictEqual(a, [traceKey('claude', 'p-1')])
    assert.deepStrictEqual(b, [traceKey('claude', 'p-1'), traceKey('claude', 'p-2')])
  })

  test('a subagent transcript is folded into the turn that spawned it and never gets a key of its own', () => {
    const filePath = path.join(tmpDir, 'proj', `${SID}.jsonl`)
    writeJsonl(filePath, [
      prompt('2026-05-01T10:00:00.000Z', 'explore the repo', 'p-1'),
      reply('2026-05-01T10:00:02.000Z', 'msg_1', { tool: 'Task', input: 100, output: 10 }),
      toolResult('2026-05-01T10:00:40.000Z', 'p-1'),
      reply('2026-05-01T10:00:42.000Z', 'msg_2', { input: 100, output: 10 }),
      prompt('2026-05-01T10:05:00.000Z', 'thanks', 'p-2'),
      reply('2026-05-01T10:05:01.000Z', 'msg_3', { input: 100, output: 10 }),
    ])
    const agentFile = path.join(tmpDir, 'proj', SID, 'subagents', 'agent-a16e8e506b6303ff4.jsonl')
    writeJsonl(agentFile, [
      { type: 'user', uuid: uuid(), sessionId: SID, isSidechain: true, timestamp: '2026-05-01T10:00:03.000Z', message: { role: 'user', content: 'Explore src/' } },
      { ...reply('2026-05-01T10:00:10.000Z', 'msg_sub_1', { input: 1000, output: 50, model: 'claude-haiku-4-5' }), isSidechain: true },
      { ...reply('2026-05-01T10:00:30.000Z', 'msg_sub_2', { input: 1000, output: 50, model: 'claude-haiku-4-5' }), isSidechain: true },
    ])
    const reader = new LogReader()
    assert.deepStrictEqual(reader.parseFile(agentFile, 'claude'), [])
    const results = reader.parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 2)
    const parent = results[0].card
    assert.strictEqual(parent.sessionId, traceKey('claude', 'p-1'))
    assert.strictEqual(parent.subagentCount, 1)
    assert.strictEqual(parent.inputTokens, 2200)
    assert.strictEqual(parent.outputTokens, 120)
    assert.strictEqual(parent.totalLlmCalls, 4)
    assert.strictEqual(parent.initiator, 'user')
    assert.strictEqual(results[1].card.subagentCount, undefined)
    assert.strictEqual(results[1].card.inputTokens, 100)
    // Never collected as a file of its own.
    assert.ok(!reader.collectFileMeta().some(f => f.filePath === agentFile))
  })

  test('a growing transcript returns only the turns whose card changed', () => {
    const filePath = path.join(tmpDir, 'proj', `${SID}.jsonl`)
    const first = [prompt('2026-05-01T10:00:00.000Z', 'one', 'p-1'), reply('2026-05-01T10:00:02.000Z', 'msg_1')]
    writeJsonl(filePath, first)
    const reader = new LogReader()
    assert.strictEqual(reader.parseFile(filePath, 'claude').length, 1)
    assert.strictEqual(reader.parseFile(filePath, 'claude').length, 0, 'unchanged file → nothing')
    fs.appendFileSync(filePath, [prompt('2026-05-01T10:03:00.000Z', 'two', 'p-2'), reply('2026-05-01T10:03:02.000Z', 'msg_2')].map(l => JSON.stringify(l)).join('\n') + '\n')
    const again = reader.parseFile(filePath, 'claude')
    assert.deepStrictEqual(again.map(r => r.card.sessionId), [traceKey('claude', 'p-2')])
  })

  test('no promptIds (older transcript): derived keys from the conversation id and the prompt line\'s own uuid', () => {
    const filePath = path.join(tmpDir, 'proj', `${SID}.jsonl`)
    const p1 = prompt('2026-05-01T10:00:00.000Z', 'fix the bug', undefined)
    const p2 = prompt('2026-05-01T10:10:00.000Z', 'thanks', undefined)
    writeJsonl(filePath, [p1, reply('2026-05-01T10:00:05.000Z', 'msg_1'), p2])
    const cards = new LogReader().parseFile(filePath, 'claude').map(r => r.card)
    assert.deepStrictEqual(cards.map(c => c.sessionId), [derivedTraceKey('claude', SID, p1.uuid), derivedTraceKey('claude', SID, p2.uuid)])
    assert.ok(cards.every(c => c.derived))
    assert.strictEqual(cards[1].sourceRank, 1, 'a turn with no usage on disk is a partial transcript')
  })

  test('a replayed history block (duplicate uuids) does not create a turn or inflate one', () => {
    const filePath = path.join(tmpDir, 'proj', `${SID}.jsonl`)
    const p1 = prompt('2026-05-01T10:00:00.000Z', 'original prompt', 'p-1')
    writeJsonl(filePath, [p1, reply('2026-05-01T10:00:05.000Z', 'msg_1'), { ...p1, slug: 'added-by-a-later-version' }])
    const results = new LogReader().parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].card.turns, 1)
    assert.ok(results[0].card.durationMs < 60_000)
  })
})

suite('dedupeByUuid', () => {
  test('dedupeByUuid keeps the first occurrence, leaves uuid-less and malformed lines alone', () => {
    const a = JSON.stringify({ type: 'user', uuid: 'a', message: { content: 'first' } })
    const result = dedupeByUuid([a, JSON.stringify({ type: 'session_meta' }), JSON.stringify({ type: 'session_meta' }), 'not json', a])
    assert.strictEqual(result.length, 4)
  })

  test('toUuid passes a UUID through and mints a stable v8 uuid for anything else', () => {
    assert.strictEqual(toUuid(SID.toUpperCase()), SID)
    assert.strictEqual(toUuid('claude:turn:p-1'), traceKey('claude', 'p-1'))
    assert.match(traceKey('claude', 'p-1'), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
