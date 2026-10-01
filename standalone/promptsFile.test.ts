import * as assert from 'assert'
import { promptsFileFor, IMPORT_SOURCES } from './promptsFile'

suite('promptsFileFor', () => {
  test('each agent gets its own file; Claude Code keeps its existing claude slug', () => {
    assert.deepStrictEqual(promptsFileFor('claude_code'), { filename: 'traceroost-prompts-claude.md', agentName: 'Claude' })
    assert.strictEqual(promptsFileFor('codex').filename, 'traceroost-prompts-codex.md')
    assert.strictEqual(promptsFileFor('copilot').filename, 'traceroost-prompts-copilot.md')
    assert.deepStrictEqual(promptsFileFor('opencode'), { filename: 'traceroost-prompts-opencode.md', agentName: 'OpenCode' })
    assert.deepStrictEqual(promptsFileFor('cursor'), { filename: 'traceroost-prompts-cursor.md', agentName: 'Cursor' })
  })

  test('unknown or hostile ids never reach the filename', () => {
    assert.strictEqual(promptsFileFor('../../etc/x').filename, 'traceroost-prompts-copilot.md')
    assert.strictEqual(promptsFileFor('__proto__').filename, 'traceroost-prompts-copilot.md')
    assert.strictEqual(promptsFileFor(undefined).filename, 'traceroost-prompts-copilot.md')
  })
})

suite('IMPORT_SOURCES', () => {
  test('accepts every source the webview Import tab accepts, including cursor', () => {
    for (const s of ['copilot', 'claude_code', 'codex', 'opencode', 'cursor']) assert.ok(IMPORT_SOURCES.has(s), s)
  })
})
