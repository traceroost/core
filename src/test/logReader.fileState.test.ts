import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader } from '../logReader'

function writeJsonl(filePath: string, lines: Record<string, unknown>[]) {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

function claudeSession(): Record<string, unknown>[] {
  return [
    { type: 'user', cwd: '/workspace', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'fix the bug' } },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:05.000Z',
      message: {
        model: 'claude-sonnet-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'done' }],
      },
    },
  ]
}

suite('LogReader — file-state persistence across restarts', () => {
  let tmpDir: string

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-filestate-'))
  })

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('exportFileState/importFileState round-trips the mtime/size cache', () => {
    const filePath = path.join(tmpDir, 'sess-1.jsonl')
    writeJsonl(filePath, claudeSession())

    const first = new LogReader()
    const initial = first.parseFile(filePath, 'claude')
    assert.strictEqual(initial.length, 1, 'first parse should produce a session')

    const snapshot = first.exportFileState()
    assert.ok(snapshot[filePath], 'exported snapshot should record the parsed file')

    const restored = new LogReader()
    restored.importFileState(snapshot)
    assert.deepStrictEqual(restored.exportFileState(), snapshot)
  })

  test('a restored (simulated-restart) LogReader skips an unchanged file instead of re-parsing it', () => {
    const filePath = path.join(tmpDir, 'sess-1.jsonl')
    writeJsonl(filePath, claudeSession())

    // Process 1: parses the file, then would persist its file state to disk before exiting.
    const beforeRestart = new LogReader()
    const initial = beforeRestart.parseFile(filePath, 'claude')
    assert.strictEqual(initial.length, 1)
    const persisted = beforeRestart.exportFileState()

    // Process 2 ("after restart"): a brand-new LogReader, as every extension activation creates
    // today — but restored from the persisted snapshot instead of starting empty.
    const afterRestart = new LogReader()
    afterRestart.importFileState(persisted)
    const rescan = afterRestart.parseFile(filePath, 'claude')
    assert.deepStrictEqual(rescan, [], 'unchanged file should be skipped, not re-parsed, after a simulated restart')

    // Sanity check: without the restore, a brand-new LogReader has no memory of the file and
    // re-parses it — this is the behavior being fixed, confirmed here so the test above is
    // actually exercising the fix rather than something else entirely.
    const withoutRestore = new LogReader()
    const rescanWithoutRestore = withoutRestore.parseFile(filePath, 'claude')
    assert.strictEqual(rescanWithoutRestore.length, 1, 'a LogReader with no restored state re-parses the file')
  })

  test('a changed file is re-parsed even after restoring file state', async () => {
    const filePath = path.join(tmpDir, 'sess-1.jsonl')
    writeJsonl(filePath, claudeSession())

    const beforeRestart = new LogReader()
    beforeRestart.parseFile(filePath, 'claude')
    const persisted = beforeRestart.exportFileState()

    // Ensure the mtime actually advances — some filesystems have coarse mtime resolution.
    await new Promise(resolve => setTimeout(resolve, 10))
    fs.appendFileSync(filePath, JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:01:00.000Z', message: { content: 'one more thing' } }) + '\n')

    const afterRestart = new LogReader()
    afterRestart.importFileState(persisted)
    const rescan = afterRestart.parseFile(filePath, 'claude')
    assert.strictEqual(rescan.length, 1, 'a genuinely changed file is still re-parsed after restoring file state')
  })
})
