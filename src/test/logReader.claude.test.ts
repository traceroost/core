import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader } from '../logReader'
import { getFileEditCounts } from '../loopDetector'
import { computeOneShotStats } from '../oneShotRate'

function writeJsonl(filePath: string, lines: Record<string, unknown>[]) {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

suite('LogReader — Claude Code edit details', () => {
  let tmpDir: string

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-claude-log-'))
  })

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('populates editDetails from an Edit tool_use block', () => {
    const filePath = path.join(tmpDir, 'sess-1.jsonl')
    writeJsonl(filePath, [
      { type: 'user', cwd: '/workspace', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'fix the bug' } },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:05.000Z',
        message: {
          model: 'claude-sonnet-5',
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [
            {
              type: 'tool_use', name: 'Edit',
              input: { file_path: '/workspace/a.ts', old_string: 'const x = 1', new_string: 'const x = 2' },
            },
          ],
        },
      },
    ])

    const reader = new LogReader()
    const results = reader.parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 1, 'expected one parsed session')
    const card = results[0].card

    const toolEntry = card.timeline.find(e => e.type === 'tool')
    assert.ok(toolEntry, 'expected a tool timeline entry')
    assert.strictEqual(toolEntry!.editDetails?.length, 1)
    assert.strictEqual(toolEntry!.editDetails![0].filePath, '/workspace/a.ts')
    assert.strictEqual(toolEntry!.editDetails![0].oldString, 'const x = 1')
    assert.strictEqual(toolEntry!.editDetails![0].newString, 'const x = 2')

    // Full pipeline: this is what was silently returning zero before the fix.
    const counts = getFileEditCounts(card)
    assert.strictEqual(Object.keys(counts).length, 1)
    const stats = computeOneShotStats(card)
    assert.strictEqual(stats.filesConsidered, 1)
    assert.strictEqual(stats.oneShotFiles, 1)
  })

  test('populates one EditDetail per file for a MultiEdit block', () => {
    const filePath = path.join(tmpDir, 'sess-2.jsonl')
    writeJsonl(filePath, [
      { type: 'user', cwd: '/workspace', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'refactor' } },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:05.000Z',
        message: {
          model: 'claude-sonnet-5',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            {
              type: 'tool_use', name: 'MultiEdit',
              input: {
                file_path: '/workspace/b.ts',
                edits: [
                  { old_string: 'foo', new_string: 'bar' },
                  { old_string: 'foo', new_string: 'bar' },
                ],
              },
            },
          ],
        },
      },
    ])

    const reader = new LogReader()
    const results = reader.parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 1)
    const card = results[0].card
    const toolEntry = card.timeline.find(e => e.type === 'tool')
    assert.strictEqual(toolEntry!.editDetails?.length, 2)
    assert.ok(toolEntry!.editDetails!.every(ed => ed.filePath === '/workspace/b.ts'))

    const counts = getFileEditCounts(card)
    assert.strictEqual(counts['/workspace/b.ts'].length, 2)
  })

  test('does not populate editDetails for a Read tool_use block', () => {
    const filePath = path.join(tmpDir, 'sess-3.jsonl')
    writeJsonl(filePath, [
      { type: 'user', cwd: '/workspace', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'look at this' } },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:05.000Z',
        message: {
          model: 'claude-sonnet-5',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/workspace/c.ts' } },
          ],
        },
      },
    ])

    const reader = new LogReader()
    const results = reader.parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 1)
    const card = results[0].card
    const toolEntry = card.timeline.find(e => e.type === 'tool')
    assert.strictEqual(toolEntry!.editDetails, undefined)

    const stats = computeOneShotStats(card)
    assert.strictEqual(stats.filesConsidered, 0)
  })
})
