import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { appendSuggestion, removeSuggestion } from '../instructionFiles'

suite('instructionFiles — apply/remove suggestion blocks', () => {
  let dir: string
  let file: string
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-instr-'))
    file = path.join(dir, 'CLAUDE.md')
  })
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('remove takes out exactly the applied block and keeps user text written after it', () => {
    fs.writeFileSync(file, '# Project\n\nExisting rules.')
    appendSuggestion(file, 'Always run the tests.', 'sug-1')
    fs.appendFileSync(file, '\n## My own section\n\nDo not delete me.\n')
    assert.ok(removeSuggestion(file, 'sug-1'))
    const after = fs.readFileSync(file, 'utf8')
    assert.ok(!after.includes('Always run the tests.'))
    assert.ok(!after.includes('TraceRoost suggestion'))
    assert.ok(after.includes('Do not delete me.'))
    assert.ok(after.startsWith('# Project\n\nExisting rules.'))
  })

  test('removing one block leaves a neighboring block intact', () => {
    fs.writeFileSync(file, '# Project')
    appendSuggestion(file, 'First.', 'a')
    appendSuggestion(file, 'Second.', 'b')
    assert.ok(removeSuggestion(file, 'a'))
    const after = fs.readFileSync(file, 'utf8')
    assert.ok(!after.includes('First.'))
    assert.ok(after.includes('Second.'))
    assert.ok(removeSuggestion(file, 'b'))
    assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), '# Project')
  })

  test('legacy block (no end marker) is removed only when its text still matches exactly', () => {
    const legacy = '# Project\n\n<!-- TraceRoost suggestion applied 2026-01-01 id:old -->\nUse pnpm.\nUser text right below.\n'
    fs.writeFileSync(file, legacy)
    assert.ok(removeSuggestion(file, 'old', 'Use pnpm.'))
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# Project\nUser text right below.\n')
  })

  test('legacy block with edited or unknown text is left untouched', () => {
    const legacy = '# Project\n\n<!-- TraceRoost suggestion applied 2026-01-01 id:old -->\nUse pnpm always.\n'
    fs.writeFileSync(file, legacy)
    assert.strictEqual(removeSuggestion(file, 'old', 'Use npm.'), false)
    assert.strictEqual(removeSuggestion(file, 'old'), false)
    assert.strictEqual(fs.readFileSync(file, 'utf8'), legacy)
  })

  test('label with regex metacharacters is matched literally', () => {
    fs.writeFileSync(file, '# P')
    appendSuggestion(file, 'X', 'file:src/a.ts (hot)')
    assert.strictEqual(removeSuggestion(file, 'file:src/aXts (hot)'), false)
    assert.ok(removeSuggestion(file, 'file:src/a.ts (hot)'))
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# P')
  })
})
