import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader } from '../logReader'

function writeJsonl(filePath: string, lines: Record<string, unknown>[]) {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

// A multi-block assistant response as Claude Code persists it: one line per
// content block, every line repeating the same message.id and the same
// message.usage (the per-block lines differ only in content and top-level uuid).
function multiBlockMessage(id: string) {
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }
  return [
    {
      type: 'assistant', timestamp: '2026-01-01T00:00:05.000Z', uuid: 'line-1-' + id,
      message: { id, model: 'claude-sonnet-5', usage, content: [{ type: 'text', text: 'thinking...' }] },
    },
    {
      type: 'assistant', timestamp: '2026-01-01T00:00:05.000Z', uuid: 'line-2-' + id,
      message: { id, model: 'claude-sonnet-5', usage, content: [{ type: 'tool_use', name: 'Read', id: 'toolu-1', input: { file_path: '/workspace/a.ts' } }] },
    },
    {
      type: 'assistant', timestamp: '2026-01-01T00:00:05.000Z', uuid: 'line-3-' + id,
      message: { id, model: 'claude-sonnet-5', usage, content: [{ type: 'text', text: 'done' }] },
    },
  ]
}

suite('LogReader — Claude multi-block message usage', () => {
  let tmpDir: string

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-h1-'))
  })

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('bills usage once per message.id, not once per content-block line', () => {
    const filePath = path.join(tmpDir, 'sess-1.jsonl')
    writeJsonl(filePath, [
      { type: 'user', cwd: '/workspace', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'fix the bug' } },
      ...multiBlockMessage('msg_multi'),
      { type: 'user', cwd: '/workspace', timestamp: '2026-01-01T00:10:00.000Z', message: { content: 'thanks' } },
    ])

    const reader = new LogReader()
    const results = reader.parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 1, 'expected one parsed session')
    const card = results[0].card

    // One API message = one usage record: 3 lines must not triple it.
    // (card.inputTokens is the total context: raw input + cacheRead + cacheCreate.)
    assert.strictEqual(card.inputTokens, 1100, 'total context must be billed once')
    assert.strictEqual(card.outputTokens, 50, 'outputTokens must be billed once')
    assert.strictEqual(card.cacheReadTokens, 1000, 'cacheReadTokens must be billed once')
    assert.strictEqual(card.turns, 1, 'turns must count the message once')
  })
  test('retains growing output and content while counting equal distinct messages', () => {
    const filePath = path.join(tmpDir, 'growing.jsonl')
    const blocks = multiBlockMessage('growing')
    blocks[0].message.usage.output_tokens = 3
    // Give each line an independent usage snapshot.
    blocks[1].message.usage = { ...blocks[1].message.usage, output_tokens: 2055 }
    blocks[2].message.usage = { ...blocks[2].message.usage, output_tokens: 3 }
    writeJsonl(filePath, [
      { type: 'user', cwd: '/workspace', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'fix' } },
      ...blocks,
      ...multiBlockMessage('distinct'),
    ])
    const card = new LogReader().parseFile(filePath, 'claude')[0].card
    assert.strictEqual(card.outputTokens, 2105)
    assert.strictEqual(card.inputTokens, 2200)
    assert.strictEqual(card.turns, 2)
    assert.strictEqual(card.totalToolCalls, 2)
  })

})
