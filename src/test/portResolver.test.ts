import * as assert from 'assert'
import * as http from 'http'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  listenWithFallback, PortScanExhaustedError,
  readResolvedPorts, writeResolvedPorts, resolvedPortsPath,
  type ResolvedPorts,
} from '../portResolver'

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-portresolver-test-'))
}

function listenPlain(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.removeListener('error', reject); resolve() })
  })
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

      const server = http.createServer()
      try {
        const bound = await listenWithFallback(server, takenPort, '127.0.0.1')
        assert.notStrictEqual(bound, takenPort)
        assert.strictEqual(bound, takenPort + 1)
      } finally {
        await close(server)
        await close(blocker)
      }
    })

    test('calls onFallback with the requested and bound ports only when they differ', async () => {
      const blocker = http.createServer()
      await listenPlain(blocker, 0, '127.0.0.1')
      const takenPort = (blocker.address() as { port: number }).port

      let calledWith: [number, number] | undefined
      const server = http.createServer()
      try {
        await listenWithFallback(server, takenPort, '127.0.0.1', {
          onFallback: (requested, bound) => { calledWith = [requested, bound] },
        })
        assert.deepStrictEqual(calledWith, [takenPort, takenPort + 1])
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
      const blockers: http.Server[] = []
      const server = http.createServer()
      try {
        await listenPlain(server, 0, '127.0.0.1')
        const base = (server.address() as { port: number }).port
        await close(server)

        // Occupy base..base+2 so a cap of 2 has no free port left in range.
        for (let i = 0; i <= 2; i++) {
          const b = http.createServer()
          await listenPlain(b, base + i, '127.0.0.1')
          blockers.push(b)
        }

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
    })

    test('returns undefined when no record has been written yet', () => {
      const home = tmpHome()
      assert.strictEqual(readResolvedPorts(home), undefined)
    })
  })
})
