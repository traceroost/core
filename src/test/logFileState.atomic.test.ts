import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LOG_FILE_STATE_FILENAME, LOG_FILE_STATE_VERSION, readLogFileState, writeLogFileState } from '../logFileState'

suite('logFileState — atomic write and torn-file recovery', () => {
  let dir: string
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-lfs-')) })
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('round-trips through an atomic, owner-only write with no temp sibling', () => {
    writeLogFileState(dir, { '/a.jsonl': { bytesRead: 10, mtimeMs: 5 } })
    assert.deepStrictEqual(fs.readdirSync(dir), [LOG_FILE_STATE_FILENAME])
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, LOG_FILE_STATE_FILENAME)).mode & 0o777, 0o600)
    assert.deepStrictEqual(readLogFileState(dir), { version: LOG_FILE_STATE_VERSION, files: { '/a.jsonl': { bytesRead: 10, mtimeMs: 5 } } })
  })

  test('a torn file is quarantined, read as empty, and not overwritten by the next write', () => {
    const file = path.join(dir, LOG_FILE_STATE_FILENAME)
    fs.writeFileSync(file, '{"version":5,"files":{"/a.jsonl":{"bytesRead":1')
    const logs: string[] = []
    assert.deepStrictEqual(readLogFileState(dir, m => logs.push(m)), { version: LOG_FILE_STATE_VERSION, files: {} })
    assert.strictEqual(logs.length, 1)
    assert.ok(logs[0].includes('moved it to'))
    writeLogFileState(dir, {})
    const names = fs.readdirSync(dir).sort()
    assert.strictEqual(names.length, 2)
    assert.ok(names.some(n => n.startsWith(`${LOG_FILE_STATE_FILENAME}.corrupt-`)))
  })

  test('a missing file reads as empty without logging', () => {
    const logs: string[] = []
    assert.deepStrictEqual(readLogFileState(dir, m => logs.push(m)), { version: LOG_FILE_STATE_VERSION, files: {} })
    assert.deepStrictEqual(logs, [])
  })
})
