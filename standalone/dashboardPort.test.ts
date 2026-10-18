import * as assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import {
  CARRY_KEYS, carryImportScript, dashboardPortLock, describeBindError, moveDashboard, validateDashboardPort,
} from './dashboardPort'

function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
}

async function freePort(): Promise<number> {
  const probe = http.createServer()
  const port = await listen(probe)
  await new Promise<void>(r => probe.close(() => r()))
  return port
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve(body))
    }).on('error', reject)
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const handler: http.RequestListener = (_req, res) => { res.end('dashboard') }

suite('dashboardPort', () => {
  suite('validateDashboardPort', () => {
    const state = { port: 3000, configured: 3000, reserved: [4318, 4316, 4317] }

    test('accepts a free-looking port and says it needs a rebind', () => {
      assert.deepStrictEqual(validateDashboardPort(3100, state), { ok: true, port: 3100, rebind: true })
      assert.deepStrictEqual(validateDashboardPort(' 3100 ', state), { ok: true, port: 3100, rebind: true })
    })

    test('refuses out-of-range, fractional and non-numeric values', () => {
      for (const v of [80, 1023, 65536, 3100.5, 'abc', '', null, undefined, '31 00']) {
        assert.strictEqual(validateDashboardPort(v, state).ok, false, String(v))
      }
    })

    test("refuses TraceRoost's own OTLP/MCP ports and OTLP/gRPC", () => {
      for (const p of [4318, 4316, 4317]) {
        const r = validateDashboardPort(p, state)
        assert.ok(!r.ok && /OTLP or MCP/.test(r.error), String(p))
      }
    })

    test('refuses the port it is already on', () => {
      const r = validateDashboardPort(3000, state)
      assert.ok(!r.ok && /already on port 3000/.test(r.error))
    })

    test('choosing the port a startup fallback landed on only saves it', () => {
      assert.deepStrictEqual(validateDashboardPort(3001, { ...state, port: 3001 }), { ok: true, port: 3001, rebind: false })
    })
  })

  test('dashboardPortLock: Docker, then UI_PORT, then a non-loopback bind', () => {
    assert.strictEqual(dashboardPortLock({ docker: false, uiFromEnv: false, requireToken: false }), null)
    assert.strictEqual(dashboardPortLock({ docker: true, uiFromEnv: true, requireToken: true }), 'docker')
    assert.strictEqual(dashboardPortLock({ docker: false, uiFromEnv: true, requireToken: true }), 'env')
    assert.strictEqual(dashboardPortLock({ docker: false, uiFromEnv: false, requireToken: true }), 'network')
  })

  test('describeBindError names the port and the cause', () => {
    assert.match(describeBindError(3100, Object.assign(new Error('x'), { code: 'EADDRINUSE' })), /Port 3100 is in use/)
    assert.match(describeBindError(3100, Object.assign(new Error('x'), { code: 'EACCES' })), /Port 3100 can't be used/)
  })

  suite('moveDashboard', () => {
    test('binds the new port, persists it, serves on both, then closes the old listener', async () => {
      const current = http.createServer(handler)
      const oldPort = await listen(current)
      const port = await freePort()
      const persisted: number[] = []
      const result = await moveDashboard({
        port, host: '127.0.0.1', current, createServer: () => http.createServer(handler),
        persist: p => { persisted.push(p) }, closeDelayMs: 50,
      })
      assert.ok(result.ok)
      try {
        assert.deepStrictEqual(persisted, [port])
        assert.strictEqual(await get(port), 'dashboard')
        assert.strictEqual(await get(oldPort), 'dashboard', 'the old address keeps answering until the delay passes')
        await sleep(150)
        assert.strictEqual(current.listening, false)
      } finally {
        if (result.ok) result.server.close()
      }
    })

    test('a busy port changes nothing: no persist, the old listener keeps serving', async () => {
      const current = http.createServer(handler)
      const oldPort = await listen(current)
      const blocker = http.createServer()
      const busy = await listen(blocker)
      let persisted = false
      try {
        const result = await moveDashboard({
          port: busy, host: '127.0.0.1', current, createServer: () => http.createServer(handler),
          persist: () => { persisted = true }, closeDelayMs: 10,
        })
        assert.ok(!result.ok && result.error.includes(`Port ${busy} is in use`))
        assert.strictEqual(persisted, false)
        await sleep(30)
        assert.strictEqual(await get(oldPort), 'dashboard')
      } finally {
        blocker.close()
        current.close()
      }
    })

    test('a failed save undoes the bind and keeps the old listener', async () => {
      const current = http.createServer(handler)
      const oldPort = await listen(current)
      const port = await freePort()
      try {
        const result = await moveDashboard({
          port, host: '127.0.0.1', current, createServer: () => http.createServer(handler),
          persist: () => { throw new Error('EROFS') }, closeDelayMs: 10,
        })
        assert.ok(!result.ok && /EROFS/.test(result.error))
        await sleep(30)
        assert.strictEqual(await get(oldPort), 'dashboard')
        // The new port was released again — something else can take it.
        const reuse = http.createServer()
        assert.strictEqual(await listen(reuse, port), port)
        reuse.close()
      } finally {
        current.close()
      }
    })
  })

  suite('carryImportScript', () => {
    function run(hash: string) {
      const store: Record<string, string> = {}
      const replaced: string[] = []
      const win: Record<string, unknown> = {}
      const location = { hash, pathname: '/', search: '' }
      const history = { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url) } }
      const localStorage = { setItem: (k: string, v: string) => { store[k] = v } }
      new Function('location', 'history', 'localStorage', 'window', carryImportScript())(location, history, localStorage, win)
      return { store, replaced, win }
    }
    const fragment = (data: unknown) => '#carry=' + encodeURIComponent(JSON.stringify(data))

    test('imports only the carried keys, string values only, and clears the fragment', () => {
      const { store, replaced, win } = run(fragment({
        moved: 3100,
        items: { 'traceroost-theme': 'dark', 'traceroost-sessions-page-size': '50', evil: 'x', 'traceRoost.agentProfiles': 7 },
      }))
      assert.deepStrictEqual(store, { 'traceroost-theme': 'dark', 'traceroost-sessions-page-size': '50' })
      assert.deepStrictEqual(replaced, ['/'])
      assert.strictEqual(win.__DASHBOARD_MOVED_TO__, 3100)
    })

    test('a malformed fragment is cleared and imports nothing', () => {
      const { store, replaced, win } = run('#carry=%7Bnot-json')
      assert.deepStrictEqual(store, {})
      assert.deepStrictEqual(replaced, ['/'])
      assert.strictEqual(win.__DASHBOARD_MOVED_TO__, undefined)
    })

    test('any other fragment is left alone', () => {
      const { replaced } = run('#help-settings')
      assert.deepStrictEqual(replaced, [])
    })
  })

  test("the page's carried keys (media/src/dashboardPortCarry.ts) match CARRY_KEYS", () => {
    const media = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'src', 'dashboardPortCarry.ts'), 'utf-8')
    const match = /DASHBOARD_CARRY_KEYS = (\[[^\]]*\])/.exec(media)
    assert.ok(match, 'DASHBOARD_CARRY_KEYS not found')
    assert.deepStrictEqual(JSON.parse(match[1].replace(/'/g, '"')), [...CARRY_KEYS])
  })
})
