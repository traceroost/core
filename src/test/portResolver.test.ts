import * as assert from 'assert'
import * as http from 'http'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { EventEmitter } from 'events'
import {
  listenWithFallback, PortScanExhaustedError, isUnavailablePort,
  readResolvedPorts, writeResolvedPorts, resolvedPortsPath, serviceDashboardUrl, isDashboardListening,
  type ResolvedPorts,
} from '../portResolver'
import { defaultServiceConfig, writeServiceConfig } from '../serviceConfig'

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-portresolver-test-'))
}

function listenPlain(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.removeListener('error', reject); resolve() })
  })
}

/** The first port after `after` that this machine will actually bind on `host` — on Windows,
 *  ports inside an excluded port range (Hyper-V/WinNAT reservations) refuse binds with EACCES, so
 *  "taken + 1" isn't necessarily the next usable port. Probes with a plain listen. */
async function nextBindablePort(after: number, host: string): Promise<number> {
  for (let port = after + 1; port < after + 200; port++) {
    const probe = http.createServer()
    try {
      await listenPlain(probe, port, host)
      await close(probe)
      return port
    } catch { /* in use or reserved — keep going */ }
  }
  throw new Error(`no bindable port after ${after}`)
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

suite('portResolver', () => {
  suite('listenWithFallback', () => {
    test('binds the preferred port when it is free', async () => {
      const probe = http.createServer()
      await listenPlain(probe, 0, '127.0.0.1')
      const freePort = (probe.address() as { port: number }).port
      await close(probe)

      const server = http.createServer()
      try {
        const bound = await listenWithFallback(server, freePort, '127.0.0.1')
        assert.strictEqual(bound, freePort)
      } finally {
        await close(server)
      }
    })

    test('falls back to the next free port when the preferred one is taken', async () => {
      const blocker = http.createServer()
      await listenPlain(blocker, 0, '127.0.0.1')
      const takenPort = (blocker.address() as { port: number }).port

      const expected = await nextBindablePort(takenPort, '127.0.0.1')
      const server = http.createServer()
      try {
        const bound = await listenWithFallback(server, takenPort, '127.0.0.1')
        assert.notStrictEqual(bound, takenPort)
        assert.strictEqual(bound, expected)
      } finally {
        await close(server)
        await close(blocker)
      }
    })

    test('steps over the ports in `avoid` while scanning', async () => {
      const blocker = http.createServer()
      await listenPlain(blocker, 0, '127.0.0.1')
      const takenPort = (blocker.address() as { port: number }).port

      // The port the scan would otherwise take is free — `avoid` alone has to skip it.
      const wouldTake = await nextBindablePort(takenPort, '127.0.0.1')
      const expected = await nextBindablePort(wouldTake, '127.0.0.1')
      const server = http.createServer()
      try {
        const bound = await listenWithFallback(server, takenPort, '127.0.0.1', { avoid: [wouldTake] })
        assert.strictEqual(bound, expected)
      } finally {
        await close(server)
        await close(blocker)
      }
    })

    test('still tries the preferred port when it is listed in `avoid`', async () => {
      const probe = http.createServer()
      await listenPlain(probe, 0, '127.0.0.1')
      const freePort = (probe.address() as { port: number }).port
      await close(probe)

      const server = http.createServer()
      try {
        assert.strictEqual(await listenWithFallback(server, freePort, '127.0.0.1', { avoid: [freePort] }), freePort)
      } finally {
        await close(server)
      }
    })

    test('calls onFallback with the requested and bound ports only when they differ', async () => {
      const blocker = http.createServer()
      await listenPlain(blocker, 0, '127.0.0.1')
      const takenPort = (blocker.address() as { port: number }).port

      const expected = await nextBindablePort(takenPort, '127.0.0.1')
      let calledWith: [number, number] | undefined
      const server = http.createServer()
      try {
        await listenWithFallback(server, takenPort, '127.0.0.1', {
          onFallback: (requested, bound) => { calledWith = [requested, bound] },
        })
        assert.deepStrictEqual(calledWith, [takenPort, expected])
      } finally {
        await close(server)
        await close(blocker)
      }
    })

    test('does not call onFallback when the preferred port binds directly', async () => {
      // Find a free port first (0 = ephemeral), then re-request that exact port — 0 itself isn't
      // a meaningful "preferred port" for this assertion, since the OS never binds literal 0.
      const probe = http.createServer()
      await listenPlain(probe, 0, '127.0.0.1')
      const freePort = (probe.address() as { port: number }).port
      await close(probe)

      let called = false
      const server = http.createServer()
      try {
        await listenWithFallback(server, freePort, '127.0.0.1', { onFallback: () => { called = true } })
        assert.strictEqual(called, false)
      } finally {
        await close(server)
      }
    })

    test('exhausting the bounded scan throws PortScanExhaustedError rather than hanging', async () => {
      let blockers: http.Server[] = []
      let base = 0
      try {
        // Occupy base..base+2 so a cap of 2 has no free port left in range. The OS only promises
        // that `base` itself was free, so pick a new base if a neighbour is already taken.
        for (let attempt = 0; attempt < 20 && blockers.length < 3; attempt++) {
          for (const b of blockers) { await close(b) }
          blockers = []
          const server = http.createServer()
          await listenPlain(server, 0, '127.0.0.1')
          base = (server.address() as { port: number }).port
          await close(server)
          for (let i = 0; i <= 2; i++) {
            const b = http.createServer()
            try {
              await listenPlain(b, base + i, '127.0.0.1')
            } catch {
              break
            }
            blockers.push(b)
          }
        }
        assert.strictEqual(blockers.length, 3, 'could not reserve three consecutive ports')

        const probe = http.createServer()
        try {
          await assert.rejects(
            () => listenWithFallback(probe, base, '127.0.0.1', { cap: 2 }),
            PortScanExhaustedError,
          )
        } finally {
          await close(probe)
        }
      } finally {
        for (const b of blockers) { await close(b) }
      }
    })

    test('a fresh call after the conflict clears returns to the preferred port, not the fallback', async () => {
      const blocker = http.createServer()
      await listenPlain(blocker, 0, '127.0.0.1')
      const takenPort = (blocker.address() as { port: number }).port

      const first = http.createServer()
      const firstBound = await listenWithFallback(first, takenPort, '127.0.0.1')
      assert.strictEqual(firstBound, takenPort + 1)
      await close(first)
      await close(blocker)

      // The original port is free again — a fresh resolution is not sticky to the fallback.
      const second = http.createServer()
      try {
        const secondBound = await listenWithFallback(second, takenPort, '127.0.0.1')
        assert.strictEqual(secondBound, takenPort)
      } finally {
        await close(second)
      }
    })
  })

  suite('resolved-ports record', () => {
    test('round-trips through resolvedPortsPath', () => {
      const home = tmpHome()
      const record: ResolvedPorts = { ui: 3000, otlp: 4318, mcp: 4316, resolvedAt: new Date().toISOString(), pid: 1234 }
      writeResolvedPorts(record, home)
      assert.strictEqual(fs.existsSync(resolvedPortsPath(home)), true)
      assert.deepStrictEqual(readResolvedPorts(home), record)
      // Atomic (no temp sibling) and owner-only, like config.json beside it.
      assert.deepStrictEqual(fs.readdirSync(path.dirname(resolvedPortsPath(home))), ['ports.json'])
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(resolvedPortsPath(home)).mode & 0o777, 0o600)
    })

    test('returns undefined when no record has been written yet', () => {
      const home = tmpHome()
      assert.strictEqual(readResolvedPorts(home), undefined)
    })
  })

  suite('Windows excluded port ranges', () => {
    /** A server double whose listen() fails with `codes[port]` for listed ports and binds otherwise. */
    function fakeServer(codes: Record<number, string>): http.Server {
      const ee = new EventEmitter() as EventEmitter & { listen: (port: number) => void; address: () => { port: number } }
      let bound = 0
      ee.listen = (port: number) => {
        setImmediate(() => {
          const code = codes[port]
          if (code) ee.emit('error', Object.assign(new Error(`listen ${code}`), { code }))
          else { bound = port; ee.emit('listening') }
        })
      }
      ee.address = () => ({ port: bound })
      return ee as unknown as http.Server
    }

    test('isUnavailablePort: EADDRINUSE everywhere, EACCES only on Windows', () => {
      assert.strictEqual(isUnavailablePort('EADDRINUSE', 'linux'), true)
      assert.strictEqual(isUnavailablePort('EADDRINUSE', 'win32'), true)
      assert.strictEqual(isUnavailablePort('EACCES', 'win32'), true)
      assert.strictEqual(isUnavailablePort('EACCES', 'linux'), false)
      assert.strictEqual(isUnavailablePort('EACCES', 'darwin'), false)
      assert.strictEqual(isUnavailablePort('EADDRNOTAVAIL', 'win32'), false)
    })

    test('on Windows, a reserved (EACCES) preferred port falls back to the next bindable one', async () => {
      let fell: [number, number] | undefined
      const bound = await listenWithFallback(fakeServer({ 4318: 'EACCES', 4319: 'EACCES', 4320: 'EADDRINUSE' }), 4318, '127.0.0.1', {
        platform: 'win32', onFallback: (r, b) => { fell = [r, b] },
      })
      assert.strictEqual(bound, 4321)
      assert.deepStrictEqual(fell, [4318, 4321])
    })

    test('off Windows, EACCES (a privileged port) is still a hard error', async () => {
      await assert.rejects(
        listenWithFallback(fakeServer({ 80: 'EACCES' }), 80, '127.0.0.1', { platform: 'linux' }),
        (e: NodeJS.ErrnoException) => e.code === 'EACCES',
      )
    })

    test('a scan that only meets reserved ports ends in PortScanExhaustedError, not a hang', async () => {
      const codes: Record<number, string> = {}
      for (let p = 5000; p <= 5003; p++) codes[p] = 'EACCES'
      await assert.rejects(
        listenWithFallback(fakeServer(codes), 5000, '127.0.0.1', { platform: 'win32', cap: 3 }),
        PortScanExhaustedError,
      )
    })
  })
})

suite('serviceDashboardUrl', () => {
  /** A stand-in dashboard answering /health like the standalone UI server, on a free port. */
  async function fakeDashboard(): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); return }
      res.writeHead(401); res.end()
    })
    await listenPlain(server, 0, '127.0.0.1')
    return { server, port: (server.address() as { port: number }).port }
  }
  /** A port nothing listens on: bind one, note it, close it. */
  async function deadPort(): Promise<number> {
    const s = http.createServer()
    await listenPlain(s, 0, '127.0.0.1')
    const port = (s.address() as { port: number }).port
    await close(s)
    return port
  }
  const ports = (ui: number, otlp: number): ResolvedPorts => ({ ui, otlp, mcp: 4316, resolvedAt: new Date().toISOString(), pid: 1 })

  test('uses the resolved-ports record when it describes the server on that OTLP port and it answers', async () => {
    const home = tmpHome()
    const { server, port } = await fakeDashboard()
    try {
      writeServiceConfig({ ...defaultServiceConfig(home), uiPort: await deadPort() }, home)
      writeResolvedPorts(ports(port, 4318), home)
      assert.strictEqual(await serviceDashboardUrl(4318, home), `http://localhost:${port}`)
    } finally { await close(server) }
  })

  test('a stale ports.json (nothing listening there) falls back to the configured dashboard port', async () => {
    const home = tmpHome()
    const { server, port } = await fakeDashboard()
    try {
      writeServiceConfig({ ...defaultServiceConfig(home), uiPort: port }, home)
      writeResolvedPorts(ports(await deadPort(), 4318), home)
      assert.strictEqual(await serviceDashboardUrl(4318, home), `http://localhost:${port}`)
      // A record for some other OTLP port is ignored outright.
      writeResolvedPorts(ports(await deadPort(), 4320), home)
      assert.strictEqual(await serviceDashboardUrl(4318, home), `http://localhost:${port}`)
    } finally { await close(server) }
  })

  test('undefined when no dashboard answers on any candidate', async () => {
    const home = tmpHome()
    writeServiceConfig({ ...defaultServiceConfig(home), uiPort: await deadPort() }, home)
    writeResolvedPorts(ports(await deadPort(), 4318), home)
    assert.strictEqual(await serviceDashboardUrl(4318, home, 300), undefined)
  })

  test('carries the access token only when the service binds beyond loopback', async () => {
    const home = tmpHome()
    const { server, port } = await fakeDashboard()
    try {
      writeServiceConfig({ ...defaultServiceConfig(home), uiPort: port, authToken: 'tok123' }, home)
      assert.strictEqual(await serviceDashboardUrl(4318, home), `http://localhost:${port}`)
      writeServiceConfig({ ...defaultServiceConfig(home), uiPort: port, authToken: 'tok123', bindHost: '0.0.0.0' }, home)
      assert.strictEqual(await serviceDashboardUrl(4318, home), `http://localhost:${port}/?token=tok123`)
    } finally { await close(server) }
  })

  test('isDashboardListening: a port answering something other than TraceRoost health is not a dashboard', async () => {
    const other = http.createServer((_req, res) => { res.writeHead(200); res.end('hello') })
    await listenPlain(other, 0, '127.0.0.1')
    try {
      assert.strictEqual(await isDashboardListening((other.address() as { port: number }).port), false)
    } finally { await close(other) }
  })
})
