import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader } from '../logReader'

function writeJsonl(filePath: string, lines: Record<string, unknown>[]) {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

const NOTIFICATION = '<task-notification><task-id>t1</task-id><status>completed</status>'
  + '<summary>Background lint run found 2 warnings.</summary></task-notification>'

suite('LogReader — Claude Code task-notification prompts', () => {
  let tmpDir: string

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-claude-log-'))
  })

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('a task-notification turn and the next real prompt are separate traces — agent- and user-initiated', () => {
    const filePath = path.join(tmpDir, 'sess-1.jsonl')
    writeJsonl(filePath, [
      { type: 'user', cwd: '/workspace', timestamp: '2026-01-01T00:00:00.000Z', message: { content: NOTIFICATION } },
      {
        type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z',
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'noted' }] },
      },
      { type: 'user', cwd: '/workspace', timestamp: '2026-01-01T00:00:02.000Z', message: { content: 'fix the flaky test' } },
    ])

    const reader = new LogReader()
    const results = reader.parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 2, 'one trace per turn')
    assert.strictEqual(results[0].card.userRequest, '[background task] Background lint run found 2 warnings.')
    assert.strictEqual(results[0].card.initiator, 'agent')
    assert.strictEqual(results[1].card.userRequest, 'fix the flaky test')
    assert.strictEqual(results[1].card.initiator, 'user')
  })

  test('falls back to the notification summary when the whole session is background-only', () => {
    const filePath = path.join(tmpDir, 'sess-2.jsonl')
    writeJsonl(filePath, [
      { type: 'user', cwd: '/workspace', timestamp: '2026-01-01T00:00:00.000Z', message: { content: NOTIFICATION } },
      {
        type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z',
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] },
      },
    ])

    const reader = new LogReader()
    const results = reader.parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 1)
    const card = results[0].card
    assert.strictEqual(card.userRequest, '[background task] Background lint run found 2 warnings.')
    assert.strictEqual(card.initiator, 'agent')
  })
})
