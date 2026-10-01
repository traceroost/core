import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { handleInstructionMessage, loadInstructionState, saveInstructionState, type InstructionHost, type InstructionState } from './instructionActions'

suite('standalone instruction actions', () => {
  let dir: string
  let ws: string
  let stateFile: string

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-instr-'))
    ws = path.join(dir, 'repo')
    fs.mkdirSync(ws)
    stateFile = path.join(dir, 'data', 'instruction-suggestions.json')
  })
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  function host(root: string | null = ws): InstructionHost {
    return {
      root,
      sessions: () => [],
      load: () => loadInstructionState(stateFile),
      save: (s: InstructionState) => saveInstructionState(stateFile, s),
      now: () => Date.parse('2026-10-01T12:00:00Z'),
    }
  }

  const apply = (extra: Record<string, unknown> = {}) => ({
    type: 'applyInstructionSuggestion', id: 'hot_file:a', workspace: ws, targetFile: 'CLAUDE.md',
    appliedText: 'Always read a.ts first.', category: 'context', title: 'Add a.ts', suggestedText: 'Always read a.ts first.',
    ...extra,
  })

  test('apply appends to the file, persists the record, and replies like the extension', () => {
    const r = handleInstructionMessage(apply(), host())
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.changed, ws)
    assert.deepStrictEqual(r.messages.map(m => m.type), ['appliedSuggestions', 'instructionApplied'])
    assert.strictEqual(r.messages[1].id, 'hot_file:a')
    const records = r.messages[0].records as Array<Record<string, unknown>>
    assert.strictEqual(records.length, 1)
    assert.strictEqual(records[0].appliedTo, 'CLAUDE.md')
    assert.strictEqual(records[0].appliedAt, '2026-10-01T12:00:00.000Z')
    assert.strictEqual(records[0].baselineInsufficient, true)
    assert.match(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8'), /id:hot_file:a -->\nAlways read a\.ts first\./)

    const again = handleInstructionMessage({ type: 'getAppliedSuggestions', workspace: ws }, host())
    assert.strictEqual((again.messages[0].records as unknown[]).length, 1)
  })

  test('re-applying the same id replaces the record rather than duplicating it', () => {
    handleInstructionMessage(apply(), host())
    const r = handleInstructionMessage(apply({ appliedText: 'Edited.' }), host())
    const records = r.messages[0].records as Array<Record<string, unknown>>
    assert.strictEqual(records.length, 1)
    assert.strictEqual(records[0].appliedText, 'Edited.')
  })

  test('apply refuses a target outside the workspace and writes nothing', () => {
    for (const targetFile of ['../outside.md', path.join(dir, 'outside.md'), '.', '', 42]) {
      const r = handleInstructionMessage(apply({ targetFile }), host())
      assert.strictEqual(r.status, 400, String(targetFile))
      assert.match(r.error ?? '', /outside the workspace/)
      assert.deepStrictEqual(r.messages, [])
    }
    assert.strictEqual(fs.existsSync(path.join(dir, 'outside.md')), false)
    assert.deepStrictEqual(loadInstructionState(stateFile).applied, [])
  })

  test('the server root wins over the message workspace, as workspaceFolders[0] does', () => {
    const other = path.join(dir, 'other')
    fs.mkdirSync(other)
    handleInstructionMessage(apply({ workspace: other }), host(ws))
    assert.ok(fs.existsSync(path.join(ws, 'CLAUDE.md')))
    assert.strictEqual(fs.existsSync(path.join(other, 'CLAUDE.md')), false)
  })

  test('remove takes the block back out and replies with the remaining records', () => {
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# Rules\n')
    handleInstructionMessage(apply(), host())
    const r = handleInstructionMessage({ type: 'removeInstructionSuggestion', id: 'hot_file:a', workspace: ws }, host())
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(r.messages, [{ type: 'appliedSuggestions', records: [] }])
    assert.strictEqual(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8'), '# Rules\n')
    // Unknown id: nothing to do, nothing posted — same as the extension.
    const none = handleInstructionMessage({ type: 'removeInstructionSuggestion', id: 'nope', workspace: ws }, host())
    assert.deepStrictEqual(none, { status: 200, messages: [], changed: undefined })
  })

  test('remove refuses a stored appliedTo that escapes the workspace', () => {
    saveInstructionState(stateFile, { dismissed: [], applied: [{
      id: 'x', workspace: ws, category: 'context', title: '', suggestedText: '', appliedTo: '../../.bashrc',
      appliedText: 't', appliedAt: '2026-01-01T00:00:00.000Z', appliedAtMs: 0, baselineCostAvg: 0,
      baselineTurnsAvg: 0, baselineErrorRate: 0, baselineLoopRate: 0, baselineInsufficient: true,
    }] })
    const r = handleInstructionMessage({ type: 'removeInstructionSuggestion', id: 'x', workspace: ws }, host())
    assert.strictEqual(r.status, 400)
    assert.strictEqual(loadInstructionState(stateFile).applied.length, 1)
  })

  test('dismiss is recorded once per workspace and read back as ids', () => {
    for (let i = 0; i < 2; i++) {
      const r = handleInstructionMessage({ type: 'dismissInstructionSuggestion', id: 'loop:x', workspace: ws }, host())
      assert.deepStrictEqual(r.messages, [])
      assert.strictEqual(r.changed, ws)
    }
    assert.strictEqual(loadInstructionState(stateFile).dismissed.length, 1)
    const r = handleInstructionMessage({ type: 'getDismissedSuggestions', workspace: ws }, host())
    assert.deepStrictEqual(r.messages, [{ type: 'dismissedSuggestions', ids: ['loop:x'] }])
    const other = handleInstructionMessage({ type: 'getDismissedSuggestions', workspace: '/elsewhere' }, host())
    assert.deepStrictEqual(other.messages, [{ type: 'dismissedSuggestions', ids: [] }])
  })

  test('getInstructionFiles answers with an instructionFiles message', () => {
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'hello')
    const r = handleInstructionMessage({ type: 'getInstructionFiles', workspace: ws }, host())
    assert.strictEqual(r.messages[0].type, 'instructionFiles')
    const files = r.messages[0].files as Array<{ path: string; exists: boolean; content: string }>
    assert.ok(files.some(f => f.exists && f.content === 'hello'))
  })

  test('missing fields and unknown types are 400s, not writes', () => {
    assert.strictEqual(handleInstructionMessage(null, host()).status, 400)
    assert.strictEqual(handleInstructionMessage({ type: 'dismissInstructionSuggestion', workspace: ws }, host()).status, 400)
    assert.strictEqual(handleInstructionMessage({ type: 'getAppliedSuggestions' }, host()).status, 400)
    assert.strictEqual(handleInstructionMessage({ type: 'getInstructionFiles' }, host(null)).status, 400)
    assert.strictEqual(handleInstructionMessage({ type: 'bogus', id: 'a', workspace: ws }, host()).status, 400)
    assert.strictEqual(handleInstructionMessage(apply({ appliedText: '' }), host()).status, 400)
    assert.strictEqual(fs.existsSync(stateFile), false)
  })

  test('a missing or corrupt state file loads as empty', () => {
    assert.deepStrictEqual(loadInstructionState(stateFile), { applied: [], dismissed: [] })
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(stateFile, '{not json')
    assert.deepStrictEqual(loadInstructionState(stateFile), { applied: [], dismissed: [] })
  })
})
