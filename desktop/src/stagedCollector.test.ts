/**
 * The Stage 1 gate, as a test: the *real* staged collector, started by the *real* supervisor, on
 * Electron's bundled Node — no stubs on either side.
 *
 * This is the test that would catch the packaging mistakes that unit tests cannot: a collector
 * bundle that needs a module the app does not ship, a `sql.js` whose WASM is not beside it, a
 * dashboard asset tree staged at the wrong depth, or an Electron upgrade whose Node no longer runs
 * the bundle. All of those produce a perfectly green unit suite and an app that does nothing.
 *
 * It is skipped, not failed, when the staged tree or the Electron binary is absent — a checkout
 * that has not run `pnpm run build` in desktop/ has nothing to test here, and the unit suite is
 * expected to run without a 300 MB download.
 *
 * HOME is redirected to a temporary directory for the duration. The collector auto-configures the
 * agents it finds on startup — writing OTEL endpoints into `~/.claude/settings.json`,
 * `~/.codex/config.toml` and VS Code's settings — and pointing a developer's real agents at a test
 * port that is about to disappear is not an acceptable side effect of running the test suite.
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { LOCK_FILENAME, type DataDirLockInfo } from '../../standalone/dataDirLock'
import { OwnedCollector } from './collector'

const DESKTOP_DIR = path.join(__dirname, '..', '..', '..', '..', 'desktop')
const STAGED = path.join(DESKTOP_DIR, 'resources', 'collector', 'standalone', 'server.js')
/** Electron's binary inside the npm package, per platform — the same thing `electron .` runs. */
const ELECTRON = path.join(DESKTOP_DIR, 'node_modules', 'electron', 'dist',
  ...(process.platform === 'darwin' ? ['Electron.app', 'Contents', 'MacOS', 'Electron']
    : process.platform === 'win32' ? ['electron.exe']
    : ['electron']))

/** High, fixed ports: the collector scans upward from a busy port, and a test must not land on
 *  (or push itself off) the developer's real collector on 3000/4318/4316. */
const UI_PORT = 31700
const OTLP_PORT = 31718
const MCP_PORT = 31716

function get(url: string, timeoutMs = 5_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timed out fetching ${url}`)) })
  })
}

suite('staged collector — the packaged article, end to end', () => {
  let home: string
  let dataDir: string
  let collector: OwnedCollector | undefined
  const lines: string[] = []

  suiteSetup(function () {
    if (!fs.existsSync(STAGED) || !fs.existsSync(ELECTRON)) {
      // Nothing staged to test. `cd desktop && npm install && pnpm run build` sets it up. CI sets
      // the variable so that a missing stage fails there instead of passing silently — a skip
      // looks exactly like success in a green run, and this suite is what the desktop job is for.
      const missing = `${fs.existsSync(STAGED) ? '' : `${STAGED} `}${fs.existsSync(ELECTRON) ? '' : ELECTRON}`.trim()
      if (process.env.TRACEROOST_DESKTOP_REQUIRE_STAGED === '1') {
        throw new Error(`the staged collector suite cannot run: missing ${missing}`)
      }
      this.skip()
    }
  })

  /**
   * The child's environment. The collector finds agents and their settings through `os.homedir()`
   * and, on Windows, `%APPDATA%` / `%LOCALAPPDATA%` (src/logReader.ts, src/autoConfigNode.ts);
   * `os.homedir()` reads HOME on Unix but USERPROFILE on Windows, so redirecting HOME alone would
   * leave a Windows run writing OTEL endpoints into the real profile. Every one of them is pointed
   * into the temporary home.
   */
  function collectorEnv(): Record<string, string> {
    return {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      UI_PORT: String(UI_PORT),
      OTLP_PORT: String(OTLP_PORT),
      MCP_PORT: String(MCP_PORT),
    }
  }

  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-desktop-home-'))
    dataDir = path.join(home, '.traceroost')
    lines.length = 0
  })

  teardown(async () => {
    try { await collector?.stop() } catch { /* already gone */ }
    collector = undefined
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function startStaged(): Promise<ReturnType<OwnedCollector['start']>> {
    collector = new OwnedCollector({
      serverScript: STAGED,
      execPath: ELECTRON,
      dataDir,
      env: collectorEnv(),
      log: line => lines.push(line),
    })
    return collector.start()
  }

  test('starts on Electron\'s Node, binds its ports, and serves the dashboard it ships', async function () {
    this.timeout(90_000)
    const state = await startStaged()
    assert.strictEqual(state.status, 'running', lines.join('\n'))
    assert.ok(state.status === 'running')
    assert.strictEqual(state.uiPort, UI_PORT)
    assert.strictEqual(state.otlpPort, OTLP_PORT)

    // Liveness, and the identity probe the attach handshake relies on.
    assert.deepStrictEqual(JSON.parse((await get(`http://127.0.0.1:${UI_PORT}/health`)).body), { status: 'ok' })
    const probe = JSON.parse((await get(`http://127.0.0.1:${OTLP_PORT}/traceroost/standalone`)).body) as Record<string, unknown>
    assert.strictEqual(probe.traceroost, true)
    assert.strictEqual(probe.kind, 'standalone')

    // The page, and an asset out of the staged media tree — the thing a wrong staging depth breaks.
    const page = await get(`http://127.0.0.1:${UI_PORT}/`)
    assert.strictEqual(page.status, 200)
    assert.match(page.body, /<!DOCTYPE html>/)
    const asset = await get(`http://127.0.0.1:${UI_PORT}/dashboard.js`)
    assert.strictEqual(asset.status, 200)
    assert.ok(asset.body.length > 100_000, `dashboard.js came back as ${asset.body.length} bytes`)

    // The summary API, which is what the dashboard actually renders from.
    const summary = JSON.parse((await get(`http://127.0.0.1:${UI_PORT}/api/summary`)).body) as Record<string, unknown>
    assert.ok(Array.isArray(summary.sessions))
  })

  test('records its version in the lock, so another instance can judge compatibility', async function () {
    this.timeout(90_000)
    await startStaged()
    const held = JSON.parse(fs.readFileSync(path.join(dataDir, LOCK_FILENAME), 'utf-8')) as DataDirLockInfo
    assert.match(held.version ?? '', /^\d+\.\d+\.\d+/)
    // Not the background service: an app-owned collector must not claim to be one.
    assert.strictEqual(held.service, false)
  })

  test('ships sql.js where the collector resolves it, with its WASM beside it', async function () {
    this.timeout(30_000)
    const { createRequire } = await import('module')
    const stagedRequire = createRequire(STAGED)
    const resolved = stagedRequire.resolve('sql.js')
    assert.ok(resolved.startsWith(path.join(DESKTOP_DIR, 'resources', 'collector')), `resolved outside the staged tree: ${resolved}`)
    assert.ok(fs.existsSync(path.join(path.dirname(resolved), 'sql-wasm.wasm')))
  })

  test('auto-configuration lands in the redirected HOME, never the developer\'s own', async function () {
    this.timeout(90_000)
    await startStaged()
    // Proof the isolation above actually holds — if this ever fails, the test suite is editing the
    // real ~/.claude/settings.json and pointing live agents at a port that is about to close.
    const claudeSettings = path.join(home, '.claude', 'settings.json')
    if (fs.existsSync(claudeSettings)) {
      assert.match(fs.readFileSync(claudeSettings, 'utf-8'), new RegExp(String(OTLP_PORT)))
    }
    assert.ok(fs.existsSync(dataDir))
  })

  test('a graceful stop flushes and releases the data dir, leaving it free for the next start', async function () {
    this.timeout(90_000)
    const c = new OwnedCollector({
      serverScript: STAGED, execPath: ELECTRON, dataDir,
      env: collectorEnv(),
      log: line => lines.push(line),
    })
    collector = c
    await c.start()
    assert.ok(fs.existsSync(path.join(dataDir, LOCK_FILENAME)))
    await c.stop()
    assert.strictEqual(c.current().status, 'stopped')
    // The collector releases the lock from its own 'exit' handler. A lock left behind would make
    // the next start look like a crashed holder's leftover rather than a clean slate.
    assert.ok(!fs.existsSync(path.join(dataDir, LOCK_FILENAME)), 'the data dir lock should have been released')
    assert.ok(!lines.some(l => l.includes('killing it')), 'should not have needed the forced kill')
  })
})
