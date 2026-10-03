import * as assert from 'assert'
import { summarizeSpans } from '../spanSummarizer'
import type { Span } from '../types'

// How the OTEL summarizers recover changed/read/searched files and edit details from span
// attributes — the input to attribution, one-shot rate and the "files changed" UI. The
// spanSummarizer suite covers tokens/models/timeline shape; this one covers the argument parsing.

let seq = 0
function attr(key: string, value: string | number) {
  return typeof value === 'number' ? { key, value: { intValue: value } } : { key, value: { stringValue: value } }
}
function span(traceId: string, name: string, attrs: Array<[string, string | number]>, extra: Partial<Span> = {}): Span {
  seq++
  return {
    traceId, spanId: extra.spanId ?? `s${seq}`, name,
    startTime: String(1_700_000_000_000_000_000n + BigInt(seq) * 1_000_000n),
    endTime: String(1_700_000_000_000_000_000n + BigInt(seq) * 1_000_000n + 500_000n),
    attributes: attrs.map(([k, v]) => attr(k, v)),
    ...extra,
  }
}

suite('Claude Code summarizer — file extraction', () => {
  function claudeSession(children: Span[]) {
    const root = span('ct', 'claude_code.interaction', [['user_prompt', 'edit things']], { spanId: 'root' })
    const result = summarizeSpans([root, ...children.map(c => ({ ...c, parentSpanId: c.parentSpanId ?? 'root' }))])
    const s = result.sessions.find(x => x.source === 'claude_code')
    assert.ok(s, 'claude session built')
    return s!
  }

  test('reads tool_use blocks in gen_ai.output.messages: Edit/Write/MultiEdit/Read/Grep', () => {
    const msgs = JSON.stringify([
      { role: 'user', content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/r/ignored-user.ts' } }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/r/src/a.ts', old_string: 'x', new_string: 'y' } },
        { type: 'tool_use', name: 'Write', input: { filePath: '/r/src/b.ts', content: 'body' } },
        { type: 'tool_use', name: 'MultiEdit', input: { file_path: '/r/src/c.ts', edits: [
          { file_path: '/r/src/c.ts', oldString: '1', newString: '2' }, { old_string: 'no path' },
        ] } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/r/src/deep/read.ts' } },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO', file_path: '/r' } },
        { type: 'tool_use', name: 'Edit' },  // no input → skipped
      ] },
    ])
    const s = claudeSession([span('ct', 'claude_code.llm_request', [['gen_ai.output.messages', msgs], ['stop_reason', 'tool_use']])])
    assert.deepStrictEqual(s.filesChanged.sort(), ['/r/src/a.ts', '/r/src/b.ts', '/r/src/c.ts'])
    assert.deepStrictEqual(s.filesWritten, ['/r/src/b.ts'])
    assert.deepStrictEqual(s.filesRead, ['read.ts'])
    assert.deepStrictEqual(s.filesSearched, ['TODO'])
    const llm = s.timeline.find(e => e.type === 'llm')!
    assert.strictEqual(llm.action, 'called tools')
    assert.deepStrictEqual(llm.editDetails!.map(d => [d.filePath, d.toolName, d.oldString, d.newString, d.content]), [
      ['/r/src/a.ts', 'Edit', 'x', 'y', undefined],
      ['/r/src/b.ts', 'Write', undefined, undefined, 'body'],
      ['/r/src/c.ts', 'MultiEdit', undefined, undefined, undefined],
      ['/r/src/c.ts', 'Edit', '1', '2', undefined],
    ])
    assert.strictEqual(s.filesChangedNote, undefined)
  })

  test('malformed gen_ai.output.messages is ignored without losing the LLM entry', () => {
    const s = claudeSession([span('ct', 'claude_code.llm_request', [['gen_ai.output.messages', '{not json'], ['stop_reason', 'end_turn']])])
    assert.strictEqual(s.totalLlmCalls, 1)
    assert.strictEqual(s.timeline[0].action, 'text response')
    assert.deepStrictEqual(s.filesChanged, [])
  })

  test('claude_code.tool spans: JSON tool_input (incl. MultiEdit edits) sets changed/read/searched files', () => {
    const s = claudeSession([
      span('ct', 'claude_code.tool', [['tool_name', 'Edit'], ['tool_input', JSON.stringify({ file_path: '/home/dev/proj/src/x.ts', old_string: 'a', new_string: 'b' })]]),
      span('ct', 'claude_code.tool', [['tool_name', 'MultiEdit'], ['tool_input', JSON.stringify({ edits: [{ filePath: '/home/dev/proj/src/y.ts', old_string: 'c', new_string: 'd' }] })]]),
      span('ct', 'claude_code.tool', [['tool_name', 'Read'], ['input', JSON.stringify({ file_path: '/home/dev/proj/README.md' })]]),
      span('ct', 'claude_code.tool', [['tool_name', 'Glob'], ['gen_ai.tool.call.arguments', JSON.stringify({ pattern: '**/*.ts', file_path: '/home/dev/proj' })]]),
      span('ct', 'claude_code.tool', [['tool_name', 'Bash'], ['full_command', 'ls -la']]),  // not JSON → skipped, still counted
    ])
    assert.deepStrictEqual(s.filesChanged.sort(), ['/home/dev/proj/src/x.ts', '/home/dev/proj/src/y.ts'])
    assert.deepStrictEqual(s.filesRead, ['README.md'])
    assert.deepStrictEqual(s.filesSearched, ['**/*.ts'])
    assert.deepStrictEqual(s.toolCounts, { Edit: 1, MultiEdit: 1, Read: 1, Glob: 1, Bash: 1 })
    const edit = s.timeline.find(e => e.label === 'Edit')!
    assert.deepStrictEqual(edit.editDetails, [{ filePath: '/home/dev/proj/src/x.ts', oldString: 'a', newString: 'b', content: undefined }])
    assert.strictEqual(s.timeline.find(e => e.label === 'Bash')!.toolInput, 'ls -la')
  })

  test('a direct file_path attribute is the fallback when tool_input has no path', () => {
    const s = claudeSession([
      span('ct', 'claude_code.tool', [['tool_name', 'Write'], ['tool_input', '{}'], ['file_path', '/r/w.ts']]),
      span('ct', 'claude_code.tool', [['tool_name', 'Grep'], ['file_path', '/r/src']]),
    ])
    assert.deepStrictEqual(s.filesChanged, ['/r/w.ts'])
    assert.deepStrictEqual(s.filesWritten, ['/r/w.ts'])
    assert.deepStrictEqual(s.filesSearched, ['/r/src'])
  })

  test('claude_code.tool_result spans fill in paths and suppress the "paths unavailable" note', () => {
    const s = claudeSession([
      span('ct', 'claude_code.tool', [['tool_name', 'Edit']]),  // redacted args → would trigger the note
      span('ct', 'claude_code.tool_result', [['tool.name', 'Edit'], ['tool_input', JSON.stringify({ file_path: '/r/e.ts' })]]),
      span('ct', 'claude_code.tool_result', [['tool_name', 'Write'], ['input', '  /r/raw-path.ts  ']]),  // bare path string
      span('ct', 'claude_code.tool_result', [['tool_name', 'MultiEdit'], ['tool_input', JSON.stringify({ edits: [{ file_path: '/r/m1.ts' }, {}] })]]),
      span('ct', 'claude_code.tool_result', [['tool_name', 'Read'], ['tool_input', '/r/read-me.ts']]),
      span('ct', 'claude_code.tool_result', [['tool_name', 'Grep'], ['tool_input', '/r/searched']]),
      span('ct', 'claude_code.tool_result', [['tool_name', 'Edit']]),  // no args → ignored
    ])
    assert.deepStrictEqual(s.filesChanged.sort(), ['/r/e.ts', '/r/m1.ts', '/r/raw-path.ts'])
    assert.deepStrictEqual(s.filesWritten, ['/r/raw-path.ts'])
    assert.deepStrictEqual(s.filesRead, ['read-me.ts'])
    assert.deepStrictEqual(s.filesSearched, ['/r/searched'])
    assert.strictEqual(s.filesChangedNote, undefined)
  })

  test('the "paths unavailable" note pluralises by write-op count', () => {
    const s = claudeSession([
      span('ct', 'claude_code.tool', [['tool_name', 'Edit']]),
      span('ct', 'claude_code.tool', [['tool_name', 'Write']]),
    ])
    assert.match(s.filesChangedNote!, /unavailable for 2 write operations\./)
  })

  test('a permission prompt child becomes a user_input entry after its tool', () => {
    const tool = span('ct', 'claude_code.tool', [['tool_name', 'Bash']], { spanId: 'tool1' })
    const blocked = span('ct', 'claude_code.tool.blocked_on_user', [['decision', 'accept'], ['duration_ms', 4200]], { parentSpanId: 'tool1' })
    const s = claudeSession([tool, blocked])
    const idx = s.timeline.findIndex(e => e.spanId === 'tool1')
    assert.deepStrictEqual(
      { type: s.timeline[idx + 1].type, label: s.timeline[idx + 1].label, decision: s.timeline[idx + 1].decision, ms: s.timeline[idx + 1].durationMs },
      { type: 'user_input', label: 'Permission prompt', decision: 'accept', ms: 4200 },
    )
  })
})

suite('Copilot summarizer — file extraction', () => {
  function copilotSession(tools: Array<[string, unknown]>) {
    const agent = span('cp', 'invoke_agent', [['copilot_chat.user_request', 'change it'], ['gen_ai.request.model', 'gpt-4.1']], { spanId: 'agent' })
    const children = tools.map(([name, args]) => span('cp', `execute_tool ${name}`, [
      ['gen_ai.tool.name', name], ['gen_ai.tool.call.arguments', typeof args === 'string' ? args : JSON.stringify(args)],
    ], { parentSpanId: 'agent' }))
    const s = summarizeSpans([agent, ...children]).sessions.find(x => x.source === 'copilot')
    assert.ok(s)
    return s!
  }

  test('read_file / grep_search / file_search / replace / multi_replace / create_file', () => {
    const s = copilotSession([
      ['read_file', { filePath: '/w/src/deep/a.ts' }],
      ['grep_search', { query: 'needle' }],
      ['file_search', { includePattern: '**/*.md' }],
      ['replace_string_in_file', { filePath: '/w/src/b.ts', oldString: 'o', newString: 'n' }],
      ['multi_replace_string_in_file', { replacements: [{ filePath: '/w/src/c.ts', oldString: '1', newString: '2' }, { oldString: 'no path' }] }],
      ['create_file', { filePath: '/w/src/new.ts', content: 'export {}' }],
      ['read_file', '{bad json'],
    ])
    assert.deepStrictEqual(s.filesRead, ['a.ts'])
    assert.deepStrictEqual(s.filesSearched.sort(), ['**/*.md', 'needle'])
    assert.deepStrictEqual(s.filesChanged.sort(), ['/w/src/b.ts', '/w/src/c.ts', '/w/src/new.ts'])
    const details = s.timeline.flatMap(e => e.editDetails ?? [])
    assert.deepStrictEqual(details, [
      { filePath: '/w/src/b.ts', oldString: 'o', newString: 'n' },
      { filePath: '/w/src/c.ts', oldString: '1', newString: '2' },
      { filePath: '/w/src/new.ts', content: 'export {}' },
    ])
    assert.strictEqual(s.toolCounts['read_file'], 2)
  })

  test('apply_patch: splits a multi-file patch into per-file old/new hunks, skipping markers', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: /w/src/one.ts',
      '@@ function f() {',
      '-  return 1',
      '+  return 2',
      '   context line',
      '*** Add File: /w/src/two.ts',
      '+export const two = 2',
      '*** End Patch',
    ].join('\n')
    const s = copilotSession([['apply_patch', { input: patch }]])
    assert.deepStrictEqual(s.filesChanged.sort(), ['/w/src/one.ts', '/w/src/two.ts'])
    const details = s.timeline.flatMap(e => e.editDetails ?? [])
    assert.deepStrictEqual(details, [
      { filePath: '/w/src/one.ts', toolName: 'apply_patch', oldString: '  return 1', newString: '  return 2' },
      { filePath: '/w/src/two.ts', toolName: 'apply_patch', oldString: undefined, newString: 'export const two = 2' },
    ])
  })

  test('apply_patch with no file headers produces no edit details', () => {
    const s = copilotSession([['apply_patch', { patch: '*** Begin Patch\n*** End Patch' }]])
    assert.deepStrictEqual(s.filesChanged, [])
    assert.strictEqual(s.timeline.find(e => e.type === 'tool')!.editDetails, undefined)
  })
})
