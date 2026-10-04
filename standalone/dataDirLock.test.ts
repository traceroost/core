import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import {
  tryAcquireDataDirLock, describeLockHolder, isPidAlive, LOCK_FILENAME, REMOTE_STALE_MS,
  type DataDirLockInfo, type LockEnv,
} from './dataDirLock'

function env(over: Partial<LockEnv> = {}): LockEnv {
  return { pid: 1000, hostname: 'box-a', now: () => Date.now(), isPidAlive: () => true, platform: 'linux', ...over }
}

function writeForeignLock(dir: string, info: Partial<DataDirLockInfo>, ageMs = 0): string {
  const lockPath = path.join(dir, LOCK_FILENAME)
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2000, hostname: 'box-a', startedAt: '2026-01-01T00:00:00.000Z', service: false, token: 'foreign', ...info }))
  if (ageMs) {
    const t = new Date(Date.now() - ageMs)
    fs.utimesSync(lockPath, t, t)
  }
  return lockPath
}

suite('dataDirLock', () => {
  let dir: string
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-lock-')) })
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('acquires an unheld dir (creating it), records the holder, and release removes the lock', () => {
    const dataDir = path.join(dir, 'nested', 'data')
    const r = tryAcquireDataDirLock(dataDir, { service: true }, env())
    assert.ok(r.ok)
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, LOCK_FILENAME), 'utf-8')) as DataDirLockInfo
    assert.strictEqual(onDisk.pid, 1000)
    assert.strictEqual(onDisk.hostname, 'box-a')
    assert.strictEqual(onDisk.service, true)
    r.lock.setPorts({ ui: 3001, otlp: 4319, mcp: 4317 })
    assert.strictEqual((JSON.parse(fs.readFileSync(r.lock.lockPath, 'utf-8')) as DataDirLockInfo).uiPort, 3001)
    r.lock.release()
    assert.ok(!fs.existsSync(r.lock.lockPath))
    r.lock.release() // idempotent
  })

  test('a second acquirer is refused while a live holder on this host has it', () => {
    const first = tryAcquireDataDirLock(dir, {}, env({ pid: 1000 }))
    assert.ok(first.ok)
    first.lock.setPorts({ ui: 3000, otlp: 4318, mcp: 4316 })
    const second = tryAcquireDataDirLock(dir, {}, env({ pid: 1001 }))
    assert.ok(!second.ok)
    assert.strictEqual(second.holder?.pid, 1000)
    assert.strictEqual(second.holder?.uiPort, 3000)
    assert.ok(first.lock.isOurs(), 'the refusal leaves the holder\'s lock untouched')
  })

  test('takes over a lock whose pid is dead on this host, or is our own pid (restarted container)', () => {
    writeForeignLock(dir, { pid: 2000 })
    const r = tryAcquireDataDirLock(dir, {}, env({ isPidAlive: pid => pid !== 2000 }))
    assert.ok(r.ok)
    assert.ok(r.lock.isOurs())
    r.lock.release()

    writeForeignLock(dir, { pid: 1000 })
    assert.ok(tryAcquireDataDirLock(dir, {}, env({ pid: 1000 })).ok)
  })

  test('a lock from another host is held until its heartbeat is older than REMOTE_STALE_MS', () => {
    writeForeignLock(dir, { hostname: 'box-b', pid: 1000 }, 1_000)
    const held = tryAcquireDataDirLock(dir, {}, env({ isPidAlive: () => false }))
    assert.ok(!held.ok, 'a remote pid is never probed locally')
    assert.strictEqual(held.holder?.hostname, 'box-b')

    writeForeignLock(dir, { hostname: 'box-b' }, REMOTE_STALE_MS + 5_000)
    assert.ok(tryAcquireDataDirLock(dir, {}, env()).ok)
  })

  test('an unreadable lock is held while young (being written) and taken over once old', () => {
    const lockPath = path.join(dir, LOCK_FILENAME)
    fs.writeFileSync(lockPath, '')
    const young = tryAcquireDataDirLock(dir, {}, env())
    assert.ok(!young.ok)
    assert.strictEqual(young.holder, null)
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath, old, old)
    assert.ok(tryAcquireDataDirLock(dir, {}, env()).ok)
  })

  test('heartbeat keeps the lock, re-creates a deleted one, and reports one taken over', () => {
    const r = tryAcquireDataDirLock(dir, {}, env())
    assert.ok(r.ok)
    assert.ok(r.lock.beat())
    fs.rmSync(r.lock.lockPath)
    assert.ok(r.lock.beat(), 'a deleted lock is re-created')
    assert.ok(r.lock.isOurs())
    writeForeignLock(dir, { hostname: 'box-b' })
    assert.ok(!r.lock.beat(), 'a successor\'s lock means this process is no longer the writer')
    r.lock.release()
    assert.ok(fs.existsSync(r.lock.lockPath), 'release never removes someone else\'s lock')
  })

  test('the refusal names the holder and the ways out', () => {
    const holder: DataDirLockInfo = { pid: 4242, hostname: 'box-a', startedAt: 'T', service: false, uiPort: 3000, otlpPort: 4318, mcpPort: 4316, token: 'x' }
    const msg = describeLockHolder('/data', holder, { hostname: 'box-a', platform: 'win32' })
    assert.match(msg, /pid 4242 on this machine/)
    assert.match(msg, /http:\/\/localhost:3000/)
    assert.match(msg, /taskkill \/PID 4242/)
    assert.match(msg, /DATA_DIR=/)
    assert.match(describeLockHolder('/data', { ...holder, service: true }, { hostname: 'box-a', platform: 'linux' }), /traceroost service stop/)
    assert.match(describeLockHolder('/data', holder, { hostname: 'other', platform: 'linux' }), /on host box-a/)
    assert.match(describeLockHolder('/data', null, { hostname: 'box-a', platform: 'linux' }), /starting up/)
  })

  suite('against a real second process', () => {
    let child: ChildProcess | undefined
    teardown(() => { child?.kill() })

    test('refused while the other process holds the dir, taken over once it is gone', async () => {
      // A separate node process takes the lock with the real pid/hostname probes, then idles.
      const modulePath = path.join(__dirname, 'dataDirLock.js')
      const script = `const r = require(${JSON.stringify(modulePath)}).tryAcquireDataDirLock(${JSON.stringify(dir)});`
        + 'process.stdout.write(r.ok ? "held\\n" : "refused\\n"); setInterval(() => {}, 1000)'
      const proc = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
      child = proc
      const first = await new Promise<string>((resolve, reject) => {
        proc.stdout!.once('data', (d: Buffer) => resolve(d.toString().trim()))
        proc.once('error', reject)
      })
      assert.strictEqual(first, 'held')

      const refused = tryAcquireDataDirLock(dir)
      assert.ok(!refused.ok)
      assert.strictEqual(refused.holder?.pid, proc.pid)
      assert.ok(isPidAlive(proc.pid!))

      // Killed without releasing -- a crash. Its stale lock is taken over.
      const exited = new Promise(resolve => proc.once('exit', resolve))
      proc.kill('SIGKILL')
      await exited
      child = undefined
      // Polled briefly: on Windows a just-exited pid can still probe as alive until the last handle
      // to it (here, libuv's own) is closed, a moment after 'exit'.
      let taken = tryAcquireDataDirLock(dir)
      for (let i = 0; !taken.ok && i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        taken = tryAcquireDataDirLock(dir)
      }
      assert.ok(taken.ok)
      assert.strictEqual(taken.lock.holder.pid, process.pid)
      taken.lock.release()
    })
  })
})
