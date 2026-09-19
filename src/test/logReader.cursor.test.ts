import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader } from '../logReader'

function writeJsonl(filePath: string, lines: Record<string, unknown>[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

// Fixture shape confirmed against real output from cursor-agent 2026.09.18-9a7762b
// (`cursor-agent --print --output-format json "..."`, inspecting the resulting
// ~/.cursor/projects/<workspace>/agent-transcripts/<uuid>/<uuid>.jsonl) — see
// .staged-issues/support-cursor-cli.md for the full investigation.

suite('LogReader — Cursor CLI (cursor-agent)', () => {
  let tmpDir: string

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-cursor-log-'))
  })

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('parses a plain text-only turn', () => {
    const sessionId = '8eaaa48b-186e-4b0f-833c-f8a9f3495f59'
    const filePath = path.join(tmpDir, `${sessionId}.jsonl`)
    writeJsonl(filePath, [
      { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Friday, Sep 18, 2026, 7:05 PM (UTC-7)</timestamp>\n<user_query>\nsay hello, nothing else\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Hello.' }] } },
      { type: 'turn_ended', status: 'success' },
    ])

    const reader = new LogReader()
    const results = reader.parseFile(filePath, 'cursor')
    assert.strictEqual(results.length, 1)
    const card = results[0].card

    assert.strictEqual(card.sessionId, sessionId)
    assert.strictEqual(card.source, 'cursor')
    assert.strictEqual(card.userRequest, 'say hello, nothing else')
    assert.strictEqual(card.outcome, 'text_response')
    assert.strictEqual(card.totalToolCalls, 0)
    assert.strictEqual(card.errors, 0)
    // Honest gaps, not fabricated: no token/usage data exists anywhere in this format.
    assert.strictEqual(card.inputTokens, 0)
    assert.strictEqual(card.outputTokens, 0)
    // No model name exists in this format either — placeholder mirrors the existing
    // fallback convention (`model || 'claude'` / `'codex'` / `'copilot'` elsewhere).
    assert.strictEqual(card.model, 'cursor-agent')
    // Workspace isn't recoverable from this file (no cwd field) — left blank, same as
    // the documented Copilot CLI precedent, rather than guessed from the sanitized dirname.
    assert.strictEqual(results[0].workspace, '')
  })

  test('records a tool_use block as a tool timeline entry and counts it', () => {
    const sessionId = 'a7f442cb-8a4f-45ed-9ff4-1b6f4c8e1109'
    const filePath = path.join(tmpDir, `${sessionId}.jsonl`)
    writeJsonl(filePath, [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nRead package.json\n</user_query>' }] } },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: "I'll read it." },
            { type: 'tool_use', name: 'Read', input: { path: '/workspace/package.json' } },
          ],
        },
      },
      { role: 'assistant', message: { content: [{ type: 'text', text: '`traceroost`' }] } },
      { type: 'turn_ended', status: 'success' },
    ])

    const reader = new LogReader()
    const card = reader.parseFile(filePath, 'cursor')[0].card

    assert.strictEqual(card.totalToolCalls, 1)
    assert.strictEqual(card.toolCounts['Read'], 1)
    assert.strictEqual(card.outcome, 'tool_calls')
    assert.deepStrictEqual(card.filesRead, ['/workspace/package.json'])

    const toolEntry = card.timeline.find(e => e.type === 'tool')
    assert.ok(toolEntry, 'expected a tool timeline entry')
    assert.strictEqual(toolEntry!.label, 'Tool calls')
  })

  test('a non-success turn_ended status counts as an error', () => {
    const sessionId = '72fb10c3-da00-43bc-974c-279a202a2e62'
    const filePath = path.join(tmpDir, `${sessionId}.jsonl`)
    writeJsonl(filePath, [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\ndo something\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'failed' }] } },
      { type: 'turn_ended', status: 'error' },
    ])

    const reader = new LogReader()
    const card = reader.parseFile(filePath, 'cursor')[0].card
    assert.strictEqual(card.errors, 1)
  })

  test('a Write tool_use block is tracked as both changed and written', () => {
    const sessionId = 'b1111111-1111-1111-1111-111111111111'
    const filePath = path.join(tmpDir, `${sessionId}.jsonl`)
    writeJsonl(filePath, [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\ncreate a file\n</user_query>' }] } },
      {
        role: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { path: '/workspace/new.ts' } }] },
      },
      { type: 'turn_ended', status: 'success' },
    ])

    const reader = new LogReader()
    const card = reader.parseFile(filePath, 'cursor')[0].card
    assert.deepStrictEqual(card.filesChanged, ['/workspace/new.ts'])
    assert.deepStrictEqual(card.filesWritten, ['/workspace/new.ts'])
  })

  test('returns no results for an unchanged file on a second parse (fileState dedup)', () => {
    const sessionId = 'c2222222-2222-2222-2222-222222222222'
    const filePath = path.join(tmpDir, `${sessionId}.jsonl`)
    writeJsonl(filePath, [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nhi\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'turn_ended', status: 'success' },
    ])

    const reader = new LogReader()
    assert.strictEqual(reader.parseFile(filePath, 'cursor').length, 1)
    assert.strictEqual(reader.parseFile(filePath, 'cursor').length, 0)
  })

  test('returns [] for a file with no recognizable user/assistant/turn_ended lines', () => {
    const sessionId = 'd3333333-3333-3333-3333-333333333333'
    const filePath = path.join(tmpDir, `${sessionId}.jsonl`)
    writeJsonl(filePath, [{ some: 'unrelated', shape: true }])

    const reader = new LogReader()
    assert.strictEqual(reader.parseFile(filePath, 'cursor').length, 0)
  })
})
