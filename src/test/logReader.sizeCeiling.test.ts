import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, MAX_LOG_FILE_BYTES } from '../logReader'

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

suite('LogReader — file size ceiling', () => {
  let tmpDir: string
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-sizecap-')) })
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  test('the default ceiling is documented at 512 MB', () => {
    assert.strictEqual(MAX_LOG_FILE_BYTES, 512 * 1024 * 1024)
  })

  test('a file over the ceiling is skipped with one warning and not retried until it changes', () => {
    const filePath = path.join(tmpDir, 'huge.jsonl')
    writeJsonl(filePath, claudeSession())
    const size = fs.statSync(filePath).size
    const logs: string[] = []
    const reader = new LogReader({ log: m => logs.push(m), maxFileBytes: size - 1 })

    assert.deepStrictEqual(reader.parseFile(filePath, 'claude'), [])
    assert.strictEqual(logs.filter(l => l.includes('Skipping') && l.includes('over the')).length, 1)
    // Same file, unchanged: no second warning, still nothing produced, no crash loop.
    assert.deepStrictEqual(reader.parseFile(filePath, 'claude'), [])
    assert.deepStrictEqual(reader.parseFile(filePath, 'claude'), [])
    assert.strictEqual(logs.filter(l => l.includes('Skipping')).length, 1)
    // Its state is recorded so the periodic scan treats it as seen.
    assert.ok(reader.exportFileState()[filePath])
  })

  test('a file under the ceiling parses as before', () => {
    const filePath = path.join(tmpDir, 'ok.jsonl')
    writeJsonl(filePath, claudeSession())
    const reader = new LogReader({ maxFileBytes: fs.statSync(filePath).size })
    assert.strictEqual(reader.parseFile(filePath, 'claude').length, 1)
  })

  test('collectFileMeta leaves out files last modified before minMtimeMs', () => {
    const projects = path.join(tmpDir, 'projects')
    fs.mkdirSync(projects)
    const oldFile = path.join(projects, 'old.jsonl')
    const newFile = path.join(projects, 'new.jsonl')
    writeJsonl(oldFile, claudeSession())
    writeJsonl(newFile, claudeSession())
    const old = new Date(Date.now() - 200 * 86_400_000)
    fs.utimesSync(oldFile, old, old)
    const prev = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
    try {
      const reader = new LogReader()
      const all = reader.collectFileMeta().filter(f => f.agentKey === 'claude').map(f => f.filePath).sort()
      assert.deepStrictEqual(all, [newFile, oldFile].sort())
      const recent = reader.collectFileMeta({ minMtimeMs: Date.now() - 90 * 86_400_000 }).filter(f => f.agentKey === 'claude').map(f => f.filePath)
      assert.deepStrictEqual(recent, [newFile])
      // 0 / undefined: no filtering
      assert.strictEqual(reader.collectFileMeta({ minMtimeMs: 0 }).filter(f => f.agentKey === 'claude').length, 2)
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = prev
    }
  })
})
