import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader } from '../logReader'
import { summarizeSpans } from '../spanSummarizer'
import type { Span } from '../types'

// Language (src/language.ts) and change size (src/editStats.ts) are set on every card when it is
// built — LogReader's _buildCard for log files, summarizeSpans for OTEL — so every surface (DB,
// standalone's in-memory store, export, cloud forwarding) sees them without its own pass.

let seq = 0
function attr(key: string, value: string) { return { key, value: { stringValue: value } } }
function span(traceId: string, name: string, attrs: Array<[string, string]>, extra: Partial<Span> = {}): Span {
  seq++
  return {
    traceId, spanId: extra.spanId ?? `ls${seq}`, name,
    startTime: String(1_700_000_000_000_000_000n + BigInt(seq) * 1_000_000n),
    endTime: String(1_700_000_000_000_000_000n + BigInt(seq) * 1_000_000n + 500_000n),
    attributes: attrs.map(([k, v]) => attr(k, v)),
    ...extra,
  }
}

suite('Summarizers — language and change size', () => {
  let tmpDir: string
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-lang-')) })
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  test('Claude Code log: language from read/edited files, lines from Edit + Write', () => {
    const filePath = path.join(tmpDir, 'sess-lang.jsonl')
    const lines = [
      { type: 'user', cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'refactor' } },
      {
        type: 'assistant', timestamp: '2026-01-01T00:00:05.000Z',
        message: {
          model: 'claude-sonnet-5',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/w/README.md' } },
            { type: 'tool_use', name: 'Read', input: { file_path: '/w/src/util.py' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/w/src/main.py', old_string: 'a = 1', new_string: 'a = 2\nb = 3' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/w/web/app.ts', content: 'export {}\nconsole.log(1)\n' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/w/package.json', old_string: '"a"', new_string: '"b"' } },
          ],
        },
      },
    ]
    fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    const [result] = new LogReader().parseFile(filePath, 'claude')
    const card = result.card
    assert.strictEqual(card.language, 'python')
    assert.strictEqual(card.languageSecondary, 'typescript')
    // package.json counts as a changed file (not as a language).
    assert.strictEqual(card.filesChangedCount, 3)
    assert.strictEqual(card.linesAdded, 2 + 2 + 1)
    assert.strictEqual(card.linesRemoved, 1 + 1)
  })

  test('Claude Code OTEL: tool spans give language and change size', () => {
    const root = span('ct-lang', 'claude_code.interaction', [['user_prompt', 'edit']], { spanId: 'root-lang' })
    const kids = [
      span('ct-lang', 'claude_code.tool', [['tool_name', 'Edit'], ['tool_input', JSON.stringify({ file_path: '/p/src/a.go', old_string: 'x', new_string: 'y' })]]),
      span('ct-lang', 'claude_code.tool', [['tool_name', 'Write'], ['tool_input', JSON.stringify({ file_path: '/p/src/b.go', content: 'package b\n' })]]),
    ].map(s => ({ ...s, parentSpanId: 'root-lang' }))
    const s = summarizeSpans([root, ...kids]).sessions.find(x => x.source === 'claude_code')!
    assert.strictEqual(s.language, 'go')
    assert.strictEqual(s.languageSecondary, null)
    assert.deepStrictEqual([s.filesChangedCount, s.linesAdded, s.linesRemoved], [2, 2, 1])
  })

  test('Codex OTEL: apply_patch gives language, files changed and line counts', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/lib.rs',
      '@@',
      '-fn old() {}',
      '+fn new() {}',
      '+fn more() {}',
      '*** Add File: docs/NOTES.md',
      '+note',
      '*** End Patch',
    ].join('\n')
    const spans: Span[] = [
      span('cx-lang', 'codex.user_message', [['user_prompt', 'patch it']], { spanId: 'cx-lang-root' }),
      span('cx-lang', 'codex.tool_result', [['tool_name', 'apply_patch'], ['arguments', JSON.stringify({ input: patch })]], { spanId: 'cx-lang-tool' }),
    ]
    const codex = summarizeSpans(spans).sessions.find(s => s.source === 'codex')!
    assert.ok(codex)
    assert.strictEqual(codex.language, 'rust')
    assert.strictEqual(codex.languageSecondary, null)
    assert.strictEqual(codex.filesChangedCount, 2)
    assert.strictEqual(codex.linesAdded, 3)
    assert.strictEqual(codex.linesRemoved, 1)
  })

  test('a log source with no file paths reads none, with unknown-free 0/0 change size', () => {
    const filePath = path.join(tmpDir, 'sess-none.jsonl')
    fs.writeFileSync(filePath, [
      { type: 'user', cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'hi' } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:02.000Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'hello' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')
    const card = new LogReader().parseFile(filePath, 'claude')[0].card
    assert.strictEqual(card.language, 'none')
    assert.strictEqual(card.languageSecondary, null)
    assert.deepStrictEqual([card.filesChangedCount, card.linesAdded, card.linesRemoved], [0, 0, 0])
  })
})
