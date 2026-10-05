import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writeFileAtomic, quarantineCorruptFile } from '../fsAtomic'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-fsatomic-'))
}

suite('fsAtomic', () => {
  suite('writeFileAtomic', () => {
    test('writes a new file and replaces an existing one', () => {
      const file = path.join(tmpDir(), 'store.json')
      writeFileAtomic(file, '{"a":1}')
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), '{"a":1}')
      writeFileAtomic(file, Buffer.from('{"a":2}'))
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), '{"a":2}')
    })

    test('leaves no temp sibling behind', () => {
      const dir = tmpDir()
      writeFileAtomic(path.join(dir, 'x.json'), '[]')
      assert.deepStrictEqual(fs.readdirSync(dir), ['x.json'])
    })

    test('applies the requested mode (owner-only)', function () {
      if (process.platform === 'win32') { this.skip(); return }
      const file = path.join(tmpDir(), 'secret.json')
      fs.writeFileSync(file, 'old', { mode: 0o644 })
      writeFileAtomic(file, 'new', { mode: 0o600 })
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
    })

    test('keeps the old contents when the write fails', () => {
      const dir = tmpDir()
      const file = path.join(dir, 'store.json')
      fs.writeFileSync(file, 'intact')
      // A directory where the file should be renamed over can't be replaced by a file.
      const blocked = path.join(dir, 'blocked')
      fs.mkdirSync(blocked)
      fs.writeFileSync(path.join(blocked, 'child'), '')
      assert.throws(() => writeFileAtomic(blocked, 'x'))
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'intact')
      // and the temp file was cleaned up
      assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['blocked', 'store.json'])
    })
  })

  suite('quarantineCorruptFile', () => {
    test('moves a torn file aside under a timestamped name and keeps its bytes', () => {
      const dir = tmpDir()
      const file = path.join(dir, 'spans.json')
      fs.writeFileSync(file, '[{"traceId":"a"') // torn mid-write
      const aside = quarantineCorruptFile(file, new Date('2026-10-05T12:34:56.789Z'))
      assert.strictEqual(aside, path.join(dir, 'spans.json.corrupt-2026-10-05T12-34-56-789Z'))
      assert.strictEqual(fs.existsSync(file), false)
      assert.strictEqual(fs.readFileSync(aside!, 'utf-8'), '[{"traceId":"a"')
    })

    test('returns null when there is nothing to move', () => {
      assert.strictEqual(quarantineCorruptFile(path.join(tmpDir(), 'missing.json')), null)
    })

    test('torn-file recovery: a quarantined store is not overwritten by the next save', () => {
      const dir = tmpDir()
      const file = path.join(dir, 'spans.json')
      fs.writeFileSync(file, '[{"traceId":"a"')
      let loaded: unknown[] = []
      try { loaded = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown[] } catch {
        quarantineCorruptFile(file, new Date('2026-10-05T00:00:00.000Z'))
      }
      writeFileAtomic(file, JSON.stringify(loaded))
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), '[]')
      const names = fs.readdirSync(dir).sort()
      assert.deepStrictEqual(names, ['spans.json', 'spans.json.corrupt-2026-10-05T00-00-00-000Z'])
    })
  })
})
