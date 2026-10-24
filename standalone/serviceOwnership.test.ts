import * as assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { LOCK_FILENAME, tryAcquireDataDirLock } from './dataDirLock'
import { SERVER_LOCK_FILENAME, decideAgentSetupOwner, detectAgentSetupOwner, postServiceAction, readServerLock, type AgentSetupOwnerInput } from '../src/serviceOwnership'
import { defaultServiceConfig, writeServiceConfig } from '../src/serviceConfig'
import { writeResolvedPorts } from '../src/portResolver'

/** A stand-in for a standalone server: `/traceroost/standalone` (the OTLP identity probe),
 *  `/health`, and `POST /action`, which records what it was sent. */
function fakeServer(reply: (body: unknown) => unknown = () => ({ ok: true }), identity: Record<string, unknown> = { managesAgentSetup: true }): Promise<{ port: number; posts: Array<{ body: unknown; headers: http.IncomingHttpHeaders }>; close: () => Promise<void> }> {
  const posts: Array<{ body: unknown; headers: http.IncomingHttpHeaders }> = []
  const server = http.createServer((req, res) => {
    if (req.url === '/traceroost/standalone') { res.end(JSON.stringify({ traceroost: true, kind: 'standalone', ...identity })); return }
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
    extensionPort: 4318, portOwnerManagesSetup: true, lockPortManagesSetup: true, hostname: 'mac', isPidAlive: () => true,
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
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, lock, lockPortManagesSetup: false }), ext, 'its port now belongs to something else')
  })

  test('a standalone server that doesn\'t manage agent setup (Docker) never takes over', () => {
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, portOwner: 'standalone', portOwnerManagesSetup: false, lockPortManagesSetup: false }), { owner: 'extension' })
    assert.deepStrictEqual(decideAgentSetupOwner({ ...base, portOwner: 'standalone', portOwnerManagesSetup: false, lock }), { owner: 'service', otlpPort: 4319 },
      'a host service on another port still does')
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

    test('a server on a DATA_DIR override is found through the data dir ports.json records', async () => {
      const srv = await fakeServer()
      const otherDir = path.join(home, 'elsewhere')
      const acquired = tryAcquireDataDirLock(otherDir, {})
      assert.ok(acquired.ok)
      acquired.lock.setPorts({ ui: srv.port, otlp: srv.port, mcp: 4316 })
      try {
        assert.deepStrictEqual(await detectAgentSetupOwner(4318, undefined, home), { owner: 'extension' }, 'config.json\'s data dir has no lock')
        writeResolvedPorts({ ui: srv.port, otlp: srv.port, mcp: 4316, resolvedAt: new Date().toISOString(), pid: process.pid, dataDir: otherDir }, home)
        assert.deepStrictEqual(await detectAgentSetupOwner(4318, undefined, home), { owner: 'service', otlpPort: srv.port })
      } finally { acquired.lock.release(); await srv.close() }
    })

    test('a server with TRACEROOST_NO_AUTOCONFIG=1 (managesAgentSetup false) holding the lock: the extension decides', async () => {
      const srv = await fakeServer(undefined, { managesAgentSetup: false })
      writeServiceConfig({ ...defaultServiceConfig(home), dataDir }, home)
      const acquired = tryAcquireDataDirLock(dataDir, {})
      assert.ok(acquired.ok)
      acquired.lock.setPorts({ ui: srv.port, otlp: srv.port, mcp: 4316 })
      try {
        assert.deepStrictEqual(await detectAgentSetupOwner(4318, undefined, home), { owner: 'extension' })
      } finally { acquired.lock.release(); await srv.close() }
    })

    test('a Docker container answering on the extension\'s port: the extension keeps setting agents up', async () => {
      const docker = await fakeServer(undefined, { managesAgentSetup: false, docker: true })
      const older = await fakeServer(undefined, {})
      try {
        assert.deepStrictEqual(await detectAgentSetupOwner(docker.port, 'standalone', home), { owner: 'extension' })
        assert.deepStrictEqual(await detectAgentSetupOwner(older.port, 'standalone', home), { owner: 'extension' }, 'a server that doesn\'t say')
        const host = await fakeServer()
        try {
          assert.deepStrictEqual(await detectAgentSetupOwner(host.port, 'standalone', home), { owner: 'service', otlpPort: host.port })
        } finally { await host.close() }
      } finally { await docker.close(); await older.close() }
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
