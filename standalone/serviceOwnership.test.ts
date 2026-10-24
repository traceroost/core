import * as assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { LOCK_FILENAME, tryAcquireDataDirLock } from './dataDirLock'
import { SERVER_LOCK_FILENAME, decideAgentSetupOwner, detectAgentSetupOwner, postServiceAction, readServerLock, type AgentSetupOwnerInput } from '../src/serviceOwnership'
import { defaultServiceConfig, writeServiceConfig } from '../src/serviceConfig'

/** A stand-in for a standalone server: `/traceroost/standalone` (the OTLP identity probe),
 *  `/health`, and `POST /action`, which records what it was sent. */
function fakeServer(reply: (body: unknown) => unknown = () => ({ ok: true })): Promise<{ port: number; posts: Array<{ body: unknown; headers: http.IncomingHttpHeaders }>; close: () => Promise<void> }> {
  const posts: Array<{ body: unknown; headers: http.IncomingHttpHeaders }> = []
  const server = http.createServer((req, res) => {
    if (req.url === '/traceroost/standalone') { res.end(JSON.stringify({ traceroost: true, kind: 'standalone' })); return }
    if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok' })); return }
    if (req.method === 'POST' && req.url === '/action') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
        posts.push({ body, headers: req.headers })
        res.end(JSON.stringify(reply(body)))
      })
      return
    }
    res.writeHead(404); res.end()
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as { port: number }).port,
    posts,
    close: () => new Promise(r => server.close(() => r())),
  })))
}

suite('serviceOwnership — the background service always wins', () => {
  const base: AgentSetupOwnerInput = {
    extensionPort: 4318, lockPortIsStandalone: true, hostname: 'mac', isPidAlive: () => true,
  }
  const lock = { pid: 42, hostname: 'mac', service: true, uiPort: 3000, otlpPort: 4319 }

  test('the lock file name matches the data-dir lock\'s', () => {
    assert.strictEqual(SERVER_LOCK_FILENAME, LOCK_FILENAME)
  })

  test('the extension\'s collector lost its port to a standalone server: the service decides', () => {
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, portOwner: 'standalone' }), { owner: 'service', otlpPort: 4318 })
  })

  test('a live lock on this host whose OTLP port is TraceRoost\'s: the service, on its own port', () => {
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, lock }), { owner: 'service', otlpPort: 4319 })
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, lock: { ...lock, hostname: 'MAC' } }), { owner: 'service', otlpPort: 4319 })
  })

  test('otherwise the extension sets agents up itself', () => {
    const ext = { owner: 'extension' }
    assert.deepStrictEqual(decideAgentSetupOwner(base), ext, 'no lock')
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, portOwner: 'plugin' }), ext, 'another VS Code window')
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, portOwner: 'foreign' }), ext, 'an unrelated app')
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, lock, isPidAlive: () => false }), ext, 'a crashed server\'s leftover lock')
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, lock: { ...lock, hostname: 'other' } }), ext, 'a server on another host')
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, lock: { ...lock, otlpPort: undefined } }), ext, 'still binding its ports')
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, lock, lockPortIsStandalone: false }), ext, 'its port now belongs to something else')
  })

  suite('against a real lock and a listening server', () => {
    let home: string
    let dataDir: string
    setup(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-ownership-'))
      dataDir = path.join(home, 'data')
    })
    teardown(() => fs.rmSync(home, { recursive: true, force: true }))

    test('reads the lock a standalone server writes', () => {
      const acquired = tryAcquireDataDirLock(dataDir, { service: true })
      assert.ok(acquired.ok)
      acquired.lock.setPorts({ ui: 3001, otlp: 4320, mcp: 4316 })
      try {
        assert.deepStrictEqual(
          (({ pid, hostname, service, uiPort, otlpPort }) => ({ pid, hostname, service, uiPort, otlpPort }))(readServerLock(dataDir)!),
          { pid: process.pid, hostname: os.hostname(), service: true, uiPort: 3001, otlpPort: 4320 },
        )
      } finally { acquired.lock.release() }
      assert.strictEqual(readServerLock(dataDir), undefined, 'released')
    })

    test('a running server holding the lock decides; once it stops answering, the extension does', async () => {
      const srv = await fakeServer()
      writeServiceConfig({ ...defaultServiceConfig(home), dataDir }, home)
      const acquired = tryAcquireDataDirLock(dataDir, {})
      assert.ok(acquired.ok)
      acquired.lock.setPorts({ ui: srv.port, otlp: srv.port, mcp: 4316 })
      try {
        assert.deepStrictEqual(await detectAgentSetupOwner(4318, undefined, home), { owner: 'service', otlpPort: srv.port })
        await srv.close()
        assert.deepStrictEqual(await detectAgentSetupOwner(4318, undefined, home), { owner: 'extension' })
      } finally { acquired.lock.release() }
    })

    test('actions go to the service\'s dashboard, with no token on loopback', async () => {
      const srv = await fakeServer(body => ({ echoed: body }))
      try {
        writeServiceConfig({ ...defaultServiceConfig(home), uiPort: srv.port, authToken: 'secret' }, home)
        const reply = await postServiceAction(4318, { type: 'removeAgentSetup', dryRun: true }, home)
        assert.deepStrictEqual(reply, { echoed: { type: 'removeAgentSetup', dryRun: true } })
        assert.strictEqual(srv.posts[0].headers['content-type'], 'application/json')
        assert.strictEqual(srv.posts[0].headers.authorization, undefined, 'loopback binds need no token')
      } finally { await srv.close() }
    })

    test('no dashboard answering: undefined, so the caller says the service manages setup', async () => {
      const srv = await fakeServer()
      const port = srv.port
      await srv.close()
      writeServiceConfig({ ...defaultServiceConfig(home), uiPort: port }, home)
      assert.strictEqual(await postServiceAction(4318, { type: 'reconfigureOtel' }, home), undefined)
    })
  })
})
