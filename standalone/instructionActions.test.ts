import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { handleInstructionMessage, knownWorkspace, loadInstructionState, saveInstructionState, type InstructionHost, type InstructionState } from './instructionActions'
import type { SessionSummaryCard } from '../src/summarizers/summarizerTypes'

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

  /** A host whose recorded sessions ran in `workspaces` (just `ws` by default). */
  function host(workspaces: string[] = [ws]): InstructionHost {
    return {
      sessions: () => workspaces.map((w, i) => ({ sessionId: `s${i}`, workspace: w } as SessionSummaryCard)),
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

  test('the workspace must be one the recorded sessions ran in', () => {
    const other = path.join(dir, 'other')
    fs.mkdirSync(other)
    for (const msg of [
      apply({ workspace: other }),
      { type: 'removeInstructionSuggestion', id: 'hot_file:a', workspace: other },
      { type: 'dismissInstructionSuggestion', id: 'hot_file:a', workspace: other },
      { type: 'getInstructionFiles', workspace: other },
    ]) {
      const r = handleInstructionMessage(msg, host([ws]))
      assert.strictEqual(r.status, 400, String(msg.type))
      assert.match(r.error ?? '', /not a workspace in the recorded sessions/)
    }
    assert.strictEqual(fs.existsSync(path.join(other, 'CLAUDE.md')), false)
    assert.strictEqual(fs.existsSync(stateFile), false)
  })

  test('knownWorkspace: exact, absolute session workspaces only', () => {
    const sessions = [{ workspace: ws }, { workspace: '' }, { workspace: 'relative/repo' }, {}] as SessionSummaryCard[]
    assert.strictEqual(knownWorkspace(ws, sessions), true)
    assert.strictEqual(knownWorkspace(path.join(ws, 'sub'), sessions), false)
    assert.strictEqual(knownWorkspace(path.dirname(ws), sessions), false)
    assert.strictEqual(knownWorkspace(ws + path.sep, sessions), false)
    assert.strictEqual(knownWorkspace('relative/repo', sessions), false)
    assert.strictEqual(knownWorkspace('', sessions), false)
  })

  test('each recorded workspace applies into its own folder, with its own records', () => {
    const other = path.join(dir, 'other')
    fs.mkdirSync(other)
    const h = host([ws, other])
    handleInstructionMessage(apply(), h)
    const r = handleInstructionMessage(apply({ workspace: other, targetFile: 'AGENTS.md', appliedText: 'Other.' }), h)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.changed, other)
    assert.strictEqual(r.messages[0].workspace, other)
    assert.ok(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8').includes('Always read a.ts first.'))
    assert.ok(fs.readFileSync(path.join(other, 'AGENTS.md'), 'utf8').includes('Other.'))
    assert.strictEqual(fs.existsSync(path.join(other, 'CLAUDE.md')), false)

    // Same id in both repos: two records, and removing one leaves the other.
    assert.deepStrictEqual(loadInstructionState(stateFile).applied.map(a => [a.workspace, a.id]).sort(),
      [[ws, 'hot_file:a'], [other, 'hot_file:a']].sort())
    const removed = handleInstructionMessage({ type: 'removeInstructionSuggestion', id: 'hot_file:a', workspace: other }, h)
    assert.deepStrictEqual(removed.messages, [{ type: 'appliedSuggestions', workspace: other, records: [] }])
    assert.strictEqual(fs.readFileSync(path.join(other, 'AGENTS.md'), 'utf8'), '')
    const left = handleInstructionMessage({ type: 'getAppliedSuggestions', workspace: ws }, h)
    assert.deepStrictEqual((left.messages[0].records as Array<{ id: string }>).map(a => a.id), ['hot_file:a'])

    // Dismissals are per workspace too.
    handleInstructionMessage({ type: 'dismissInstructionSuggestion', id: 'loop:x', workspace: other }, h)
    assert.deepStrictEqual(handleInstructionMessage({ type: 'getDismissedSuggestions', workspace: ws }, h).messages,
      [{ type: 'dismissedSuggestions', workspace: ws, ids: [] }])
    assert.deepStrictEqual(handleInstructionMessage({ type: 'getDismissedSuggestions', workspace: other }, h).messages,
      [{ type: 'dismissedSuggestions', workspace: other, ids: ['loop:x'] }])
  })

  test('a recorded workspace whose folder is gone lists no files and refuses apply/remove', () => {
    handleInstructionMessage(apply(), host())
    fs.rmSync(ws, { recursive: true, force: true })
    const files = handleInstructionMessage({ type: 'getInstructionFiles', workspace: ws }, host())
    assert.deepStrictEqual(files.messages, [{ type: 'instructionFiles', workspace: ws, files: [], missing: true }])
    const r = handleInstructionMessage(apply({ id: 'loop:y' }), host())
    assert.strictEqual(r.status, 409)
    assert.match(r.error ?? '', /no longer exists/)
    assert.strictEqual(fs.existsSync(ws), false, 'apply must not recreate the folder')
    const rm = handleInstructionMessage({ type: 'removeInstructionSuggestion', id: 'hot_file:a', workspace: ws }, host())
    assert.strictEqual(rm.status, 409)
    assert.strictEqual(loadInstructionState(stateFile).applied.length, 1, 'the record is kept')
  })

  test('remove takes the block back out and replies with the remaining records', () => {
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# Rules\n')
    handleInstructionMessage(apply(), host())
    const r = handleInstructionMessage({ type: 'removeInstructionSuggestion', id: 'hot_file:a', workspace: ws }, host())
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(r.messages, [{ type: 'appliedSuggestions', workspace: ws, records: [] }])
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
    assert.deepStrictEqual(r.messages, [{ type: 'dismissedSuggestions', workspace: ws, ids: ['loop:x'] }])
    const other = handleInstructionMessage({ type: 'getDismissedSuggestions', workspace: '/elsewhere' }, host())
    assert.deepStrictEqual(other.messages, [{ type: 'dismissedSuggestions', workspace: '/elsewhere', ids: [] }])
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
    assert.strictEqual(handleInstructionMessage({ type: 'getInstructionFiles' }, host()).status, 400)
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
