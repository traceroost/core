import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { desktopLogPath, openDesktopLog, rotateIfNeeded } from './logs'

suite('logs', () => {
  let dir: string
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-desktop-log-')) })
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('the log sits in the data dir, beside the collector\'s own', () => {
    assert.strictEqual(desktopLogPath('/data/tr'), path.join('/data/tr', 'desktop.log'))
  })

  test('a log under the limit is left alone', () => {
    const file = path.join(dir, 'desktop.log')
    fs.writeFileSync(file, 'small')
    assert.strictEqual(rotateIfNeeded(file, 1024), false)
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'small')
  })

  test('an oversized log rolls to .1, keeping its contents', () => {
    const file = path.join(dir, 'desktop.log')
    fs.writeFileSync(file, 'x'.repeat(2048))
    assert.strictEqual(rotateIfNeeded(file, 1024), true)
    assert.ok(!fs.existsSync(file))
    assert.strictEqual(fs.readFileSync(`${file}.1`, 'utf-8').length, 2048)
  })

  test('only one generation is kept — a second roll replaces the first', () => {
    const file = path.join(dir, 'desktop.log')
    fs.writeFileSync(file, 'a'.repeat(2048))
    rotateIfNeeded(file, 1024)
    fs.writeFileSync(file, 'b'.repeat(2048))
    rotateIfNeeded(file, 1024)
    assert.strictEqual(fs.readFileSync(`${file}.1`, 'utf-8')[0], 'b')
    assert.ok(!fs.existsSync(`${file}.2`))
  })

  test('a missing log is not an error — there is nothing to rotate yet', () => {
    assert.strictEqual(rotateIfNeeded(path.join(dir, 'absent.log')), false)
  })

  test('opening a log creates the data dir owner-only and timestamps what it writes', async () => {
    const dataDir = path.join(dir, 'fresh')
    const log = openDesktopLog(dataDir)
    log.write('[desktop] hello')
    const stream = log.stream()
    assert.ok(stream, 'the log stream should have opened')
    const flushed = new Promise<void>(resolve => stream.once('close', () => resolve()))
    log.close()
    await flushed
    const text = fs.readFileSync(log.filePath, 'utf-8')
    assert.match(text, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[desktop\] hello$/m)
    assert.strictEqual(fs.statSync(dataDir).mode & 0o777, 0o700)
  })

  test('a data dir that cannot be created does not stop the shell from running', () => {
    // A path under a regular file can never be a directory.
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, '')
    const log = openDesktopLog(path.join(blocker, 'nested'))
    assert.strictEqual(log.stream(), undefined)
    log.write('[desktop] still works')
    log.close()
  })
})
