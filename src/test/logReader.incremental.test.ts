import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader } from '../logReader'

// _readNewLines reads only appended bytes of a growing transcript but must always return every
// line of the file — the same result a full re-read would give.
type Internals = { _readNewLines(filePath: string): string[] | null }

suite('LogReader — incremental transcript reads', () => {
  let tmpDir: string
  let file: string
  let reader: Internals

  function fullRead(): string[] {
    return fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim())
  }
  // mtime granularity can be coarse; bump it so every write reads as a change.
  let mtime = Date.now() / 1000
  function touch(): void {
    mtime += 1
    fs.utimesSync(file, mtime, mtime)
  }

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-incremental-'))
    file = path.join(tmpDir, 'sess.jsonl')
    reader = new LogReader() as unknown as Internals
  })
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  test('appended lines — including a line still being written — match a full re-read', () => {
    fs.writeFileSync(file, '{"a":1}\n{"b":"é"}\n')
    touch()
    assert.deepStrictEqual(reader._readNewLines(file), fullRead())
    fs.appendFileSync(file, '{"c":3}\n{"d":')
    touch()
    assert.deepStrictEqual(reader._readNewLines(file), fullRead())
    fs.appendFileSync(file, '4}\n{"e":"ü"}\n')
    touch()
    const lines = reader._readNewLines(file)
    assert.deepStrictEqual(lines, fullRead())
    assert.strictEqual(lines!.length, 5)
  })

  test('unchanged file returns null', () => {
    fs.writeFileSync(file, '{"a":1}\n')
    touch()
    reader._readNewLines(file)
    assert.strictEqual(reader._readNewLines(file), null)
  })

  test('a rewritten (not appended) file is re-read from scratch', () => {
    fs.writeFileSync(file, '{"a":1}\n{"b":2}\n')
    touch()
    reader._readNewLines(file)
    fs.writeFileSync(file, '{"x":9}\n{"y":8}\n{"z":7}\n')
    touch()
    assert.deepStrictEqual(reader._readNewLines(file), fullRead())
    fs.writeFileSync(file, '{"q":1}\n')
    touch()
    assert.deepStrictEqual(reader._readNewLines(file), ['{"q":1}'])
  })
})

suite('LogReader — Claude session id on log cards', () => {
  test('a transcript card carries the sessionId its lines record (the key OTEL session.id shares)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-claudesid-'))
    try {
      const file = path.join(tmpDir, 'agent-a1.jsonl')
      const lines = [
        { type: 'user', sessionId: 'parent-uuid', cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'do it' } },
        { type: 'assistant', sessionId: 'parent-uuid', timestamp: '2026-01-01T00:00:05.000Z', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] } },
      ]
      fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
      const [result] = new LogReader().parseFile(file, 'claude')
      assert.strictEqual(result.card.sessionId, 'agent-a1')
      assert.strictEqual(result.card.claudeSessionId, 'parent-uuid')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
