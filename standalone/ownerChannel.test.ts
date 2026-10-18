import * as assert from 'assert'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  installOwnerChannel, isShutdownRequest, OWNER_CHANNEL_ENV, OWNER_CHANNEL_IPC, SHUTDOWN_REQUEST,
  type OwnerChannelProcess, type ShutdownReason,
} from './ownerChannel'

/** A stand-in for `process`: an EventEmitter with an env and (optionally) an IPC `send`. */
function fakeProcess(opts: { env?: Record<string, string | undefined>; ipc?: boolean } = {}): EventEmitter & OwnerChannelProcess {
  const emitter = new EventEmitter() as EventEmitter & OwnerChannelProcess
  emitter.env = opts.env ?? { [OWNER_CHANNEL_ENV]: OWNER_CHANNEL_IPC }
  if (opts.ipc !== false) emitter.send = () => true
  return emitter
}

suite('ownerChannel — cooperative shutdown over IPC', () => {
  test('recognises exactly the shutdown request and nothing else', () => {
    assert.strictEqual(isShutdownRequest(SHUTDOWN_REQUEST), true)
    assert.strictEqual(isShutdownRequest({ type: 'traceroost:shutdown' }), true)
    for (const other of [
      undefined, null, 'traceroost:shutdown', 42, [], ['traceroost:shutdown'],
      {}, { type: 'shutdown' }, { type: 'TRACEROOST:SHUTDOWN' }, { type: 'traceroost:shutdown', token: 'x' },
      { cmd: 'NODE_HANDLE' },
    ]) {
      assert.strictEqual(isShutdownRequest(other), false, JSON.stringify(other))
    }
  })

  test('a shutdown request runs the shutdown once', () => {
    const proc = fakeProcess()
    const calls: ShutdownReason[] = []
    assert.strictEqual(installOwnerChannel(proc, r => calls.push(r)), true)
    proc.emit('message', { type: 'something-else' })
    assert.deepStrictEqual(calls, [])
    proc.emit('message', SHUTDOWN_REQUEST)
    proc.emit('message', SHUTDOWN_REQUEST)
    proc.emit('disconnect')
    assert.deepStrictEqual(calls, ['requested'])
  })

  test('the owner going away (channel closed) is a shutdown too, so a collector never outlives its app', () => {
    const proc = fakeProcess()
    const calls: ShutdownReason[] = []
    installOwnerChannel(proc, r => calls.push(r))
    proc.emit('disconnect')
    proc.emit('message', SHUTDOWN_REQUEST)
    assert.deepStrictEqual(calls, ['owner-gone'])
  })

  test('inert unless the owner asked for it: no env flag, no channel', () => {
    for (const proc of [fakeProcess({ env: {} }), fakeProcess({ env: { [OWNER_CHANNEL_ENV]: '1' } })]) {
      const calls: ShutdownReason[] = []
      assert.strictEqual(installOwnerChannel(proc, r => calls.push(r)), false)
      proc.emit('message', SHUTDOWN_REQUEST)
      proc.emit('disconnect')
      assert.deepStrictEqual(calls, [])
    }
  })

  test('the env flag alone grants nothing: without an IPC channel nobody can send the request', () => {
    const proc = fakeProcess({ ipc: false })
    assert.strictEqual(installOwnerChannel(proc, () => assert.fail('must not shut down')), false)
    assert.strictEqual(proc.listenerCount('message'), 0)
    assert.strictEqual(proc.listenerCount('disconnect'), 0)
  })

  suite('a real child process', () => {
    let dir: string
    setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-owner-channel-')) })
    teardown(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))

    /** A child that installs the channel the way server.ts does, flushes a marker file, and exits 0. */
    function child(): string {
      const script = path.join(dir, 'child.js')
      fs.writeFileSync(script, `
        const fs = require('fs')
        const { installOwnerChannel } = require(${JSON.stringify(require.resolve('./ownerChannel'))})
        const ok = installOwnerChannel(process, reason => {
          fs.writeFileSync(${JSON.stringify(path.join(dir, 'flushed'))}, reason)
          process.exit(0)
        })
        if (!ok) process.exit(5)
        process.send('ready')
        setInterval(() => {}, 1000)
      `)
      return script
    }

    function run(onReady: (c: ReturnType<typeof spawn>) => void): Promise<number | null> {
      return new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [child()], {
          env: { ...process.env, [OWNER_CHANNEL_ENV]: OWNER_CHANNEL_IPC },
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        })
        const timer = setTimeout(() => { c.kill('SIGKILL'); reject(new Error('child did not exit')) }, 8_000)
        c.on('message', m => { if (m === 'ready') onReady(c) })
        c.on('exit', code => { clearTimeout(timer); resolve(code) })
        c.on('error', reject)
      })
    }

    test('the request over the pipe flushes and exits 0 — on every OS, Windows included', async function () {
      this.timeout(15_000)
      const code = await run(c => c.send(SHUTDOWN_REQUEST))
      assert.strictEqual(code, 0)
      assert.strictEqual(fs.readFileSync(path.join(dir, 'flushed'), 'utf-8'), 'requested')
    })

    test('the parent closing the channel flushes and exits 0', async function () {
      this.timeout(15_000)
      const code = await run(c => c.disconnect())
      assert.strictEqual(code, 0)
      assert.strictEqual(fs.readFileSync(path.join(dir, 'flushed'), 'utf-8'), 'owner-gone')
    })
  })
})
