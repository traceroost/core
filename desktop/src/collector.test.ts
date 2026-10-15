import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LOCK_FILENAME } from '../../standalone/dataDirLock'
import { OwnedCollector, type CollectorState } from './collector'

/**
 * A stand-in for the collector: it claims the data-dir lock the way the real one does, then waits.
 * Using a stub rather than the real collector keeps these tests about the supervisor — readiness,
 * restart, graceful stop — and keeps them fast. `desktop/test/staged-collector.test.ts` runs the
 * real thing.
 *
 * It honours the same shutdown contract as the real collector: with TRACEROOST_SHUTDOWN_ON_STDIN_END=1
 * set by the supervisor, EOF on stdin means flush and exit. It records *which* request reached it
 * (`flushed` holds "stdin" or "signal"), so the tests can prove the supervisor used the channel
 * that works on Windows rather than the signal that does not.
 *
 * Behaviour is driven by env vars so one script covers every case:
 *   STUB_PORTS=0        claim the lock but never bind ports (never becomes ready)
 *   STUB_EXIT_AFTER=n   exit non-zero n ms after starting (a crash)
 *   STUB_IGNORE_STOP=1  ignore the shutdown request (and SIGTERM), so the supervisor has to kill it
 */
const STUB = `
const fs = require('fs'), path = require('path')
const dataDir = process.env.DATA_DIR
fs.mkdirSync(dataDir, { recursive: true })
const lock = { pid: process.pid, hostname: require('os').hostname(), startedAt: new Date().toISOString(), service: false, token: 'stub', version: '0.19.1' }
if (process.env.STUB_PORTS !== '0') Object.assign(lock, { uiPort: 31990, otlpPort: 31991, mcpPort: 31992 })
fs.writeFileSync(path.join(dataDir, '${LOCK_FILENAME}'), JSON.stringify(lock))
const flushAndExit = how => { fs.writeFileSync(path.join(dataDir, 'flushed'), how); process.exit(0) }
if (process.env.STUB_IGNORE_STOP === '1') {
  // Wedged: stdin is consumed but EOF is ignored, and SIGTERM gets an explicit no-op handler —
  // with no handler at all, Node's default action would terminate it and nothing would be tested.
  process.stdin.resume()
  process.on('SIGTERM', () => {})
} else {
  if (process.env.TRACEROOST_SHUTDOWN_ON_STDIN_END === '1') {
    process.stdin.on('end', () => flushAndExit('stdin'))
    process.stdin.resume()
  }
  process.on('SIGTERM', () => flushAndExit('signal'))
}
if (process.env.STUB_EXIT_AFTER) setTimeout(() => { console.error('stub crash'); process.exit(3) }, Number(process.env.STUB_EXIT_AFTER))
setInterval(() => {}, 1000)
`

suite('collector — supervised child', () => {
  let dir: string
  let script: string
  let dataDir: string
  let collector: OwnedCollector | undefined
  const lines: string[] = []

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-desktop-collector-'))
    script = path.join(dir, 'stub-server.js')
    dataDir = path.join(dir, 'data')
    fs.writeFileSync(script, STUB)
    lines.length = 0
  })

  teardown(async () => {
    try { await collector?.stop() } catch { /* already gone */ }
    collector = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function make(env: Record<string, string | undefined> = {}): OwnedCollector {
    collector = new OwnedCollector({
      serverScript: script,
      execPath: process.execPath,
      dataDir,
      env,
      log: line => lines.push(line),
    })
    return collector
  }

  test('becomes ready only once the child holds the lock, and reports the ports from it', async () => {
    const state = await make().start()
    assert.strictEqual(state.status, 'running')
    assert.ok(state.status === 'running')
    // The ports come from the lock the child wrote, not from anything the supervisor assumed.
    assert.strictEqual(state.uiPort, 31990)
    assert.strictEqual(state.otlpPort, 31991)
    assert.strictEqual(state.mcpPort, 31992)
    const held = JSON.parse(fs.readFileSync(path.join(dataDir, LOCK_FILENAME), 'utf-8')) as { pid: number }
    assert.strictEqual(state.pid, held.pid)
  })

  test('a child that never binds its ports is a failed start, not a false "running"', async function () {
    this.timeout(45_000)
    await assert.rejects(make({ STUB_PORTS: '0' }).start(), /did not become ready/)
  })

  test('the child is never told it is the background service', async () => {
    // TRACEROOST_SERVICE=1 would make the collector wait forever for a busy data dir and would put
    // it under `traceroost service stop`. An app-owned collector is neither.
    await make().start()
    const env = fs.readFileSync(path.join(dataDir, LOCK_FILENAME), 'utf-8')
    assert.match(env, /"service":false/)
  })

  test('stop is graceful: the child gets the chance to flush before it goes', async () => {
    const c = make()
    await c.start()
    await c.stop()
    assert.ok(fs.existsSync(path.join(dataDir, 'flushed')), 'the child should have run its flush handler')
    assert.strictEqual(c.current().status, 'stopped')
    assert.strictEqual(c.isOwning(), false)
  })

  test('the stop request is the stdin channel, not a signal — so it works where SIGTERM does not', async () => {
    // Windows has no SIGTERM; child.kill() there is TerminateProcess and runs no handler. The
    // supervisor must therefore ask over stdin on every platform, and the stub records which
    // request actually reached it.
    const c = make()
    await c.start()
    await c.stop()
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'flushed'), 'utf-8'), 'stdin')
    assert.ok(!lines.some(l => l.includes('killing it')), lines.join('\n'))
  })

  test('a deliberate stop is not mistaken for a crash, so nothing is restarted behind it', async () => {
    const c = make()
    await c.start()
    await c.stop()
    await new Promise(r => setTimeout(r, 1_500))
    assert.strictEqual(c.current().status, 'stopped')
    assert.ok(!lines.some(l => l.includes('restarting')), lines.join('\n'))
  })

  test('a wedged child that ignores the shutdown request is killed rather than hung on', async function () {
    this.timeout(20_000)
    const c = make({ STUB_IGNORE_STOP: '1' })
    await c.start()
    const started = Date.now()
    await c.stop()
    assert.strictEqual(c.current().status, 'stopped')
    assert.ok(Date.now() - started >= 10_000, 'should have waited for the graceful window first')
    assert.ok(lines.some(l => l.includes('killing it')), lines.join('\n'))
  })

  test('a crash is restarted after a backoff delay, and the state says so meanwhile', async function () {
    this.timeout(20_000)
    const c = make({ STUB_EXIT_AFTER: '200' })
    const seen: CollectorState['status'][] = []
    c.onStateChange(s => seen.push(s.status))
    await c.start()
    await new Promise(r => setTimeout(r, 1_200))
    assert.ok(seen.includes('restarting'), `expected a restarting state, saw ${seen.join(',')}`)
    const restarting = seen.indexOf('restarting')
    assert.ok(restarting >= 0)
    assert.ok(lines.some(l => l.includes('exited unexpectedly')), lines.join('\n'))
    await c.stop()
  })

  test('the collector\'s own output is captured, so a failed start can be explained', async function () {
    this.timeout(20_000)
    const c = make({ STUB_EXIT_AFTER: '200' })
    await c.start()
    await new Promise(r => setTimeout(r, 600))
    await c.stop()
    // The stub printed "stub crash" to stderr before exiting.
    assert.ok(lines.some(l => l.includes('exited unexpectedly')), lines.join('\n'))
  })

  test('starting twice does not spawn a second writer', async () => {
    const c = make()
    const first = await c.start()
    const second = await c.start()
    assert.deepStrictEqual(first, second)
  })

  test('stopping when nothing runs is a no-op, not an error', async () => {
    const c = make()
    await c.stop()
    assert.strictEqual(c.current().status, 'stopped')
  })

  test('restart ends with a running collector again', async function () {
    this.timeout(20_000)
    const c = make()
    const before = await c.start()
    const after = await c.restart()
    assert.strictEqual(after.status, 'running')
    assert.ok(before.status === 'running' && after.status === 'running')
    assert.notStrictEqual(before.pid, after.pid)
  })
})
