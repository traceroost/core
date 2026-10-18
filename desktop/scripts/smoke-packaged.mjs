/**
 * Smoke test for the *packaged* app: launches the built app the way the desktop would, and checks
 * that it comes up as an app-owned collector, serves its dashboard, and quits cleanly.
 *
 *   node scripts/smoke-packaged.mjs [path/to/TraceRoost.app]                 # macOS
 *   node scripts/smoke-packaged.mjs [path/to/traceroost-desktop | *.AppImage] # Linux
 *   node scripts/smoke-packaged.mjs [path\to\traceroost-desktop.exe]         # Windows
 *
 * Defaults to the build for this machine's architecture under dist/ (the .app on macOS, the
 * unpacked directory's executable on Linux and Windows). On Linux, pass /opt/TraceRoost/traceroost-desktop to
 * test an installed .deb, or an .AppImage; on Windows, the installed
 * `%LOCALAPPDATA%\Programs\TraceRoost\traceroost-desktop.exe` to test what the NSIS installer put there. Linux needs a display: run it under `xvfb-run -a`. Exit code 0 means every
 * check passed; anything else prints what failed along with the app's output and desktop.log.
 *
 * This is the check the unit and integration tests cannot do: they run the staged tree out of the
 * build directory on the development Electron binary. Only the packaged bundle proves that
 * resources.ts's packaged path is right, that the asar holds what main.js needs, that
 * extraResources landed where they should, and that the (ad-hoc or real) signature lets the
 * binary launch at all on Apple Silicon.
 *
 * Isolation, as in src/stagedCollector.test.ts: HOME is a temporary directory, because the
 * collector auto-configures the agents it finds and must not point a developer's live agents at a
 * port that is about to disappear. The data dir is inside that HOME, and the ports are fixed and
 * high so the test neither lands on nor pushes aside a real collector on 3000/4318/4316.
 *
 * Quitting is a SIGTERM to the app on macOS and Linux, which main.ts turns into app.quit() — the
 * same path as ⌘Q. Windows has no SIGTERM (`kill` is TerminateProcess), so there the test runs
 * `traceroost-desktop.exe --quit`, which reaches the running instance and quits it the same way —
 * the path the NSIS installer and uninstaller take (build/installer.nsh). Either way the app stops
 * its collector with the owner channel's shutdown request (standalone/ownerChannel.ts), and the test
 * proves the flush: a span is sent just before quitting, inside the collector's one-second save
 * debounce, and must be in spans.json afterwards, saved by the shutdown itself. A lock left behind,
 * or a collector still alive after the app has gone, is a failure: that is the orphaned-writer case
 * the ownership design exists to prevent.
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

const desktopDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI_PORT = 31800
const OTLP_PORT = 31818
const MCP_PORT = 31816
const READY_TIMEOUT_MS = 90_000
const QUIT_TIMEOUT_MS = 20_000

const isLinux = process.platform === 'linux'
const isWindows = process.platform === 'win32'
const appPath = path.resolve(process.argv[2] ?? (isLinux
  ? path.join(desktopDir, 'dist', process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'traceroost-desktop')
  : isWindows
    ? path.join(desktopDir, 'dist', process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked', 'traceroost-desktop.exe')
    : path.join(desktopDir, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'TraceRoost.app')))
const isAppImage = appPath.endsWith('.AppImage')
// How to quit: `--quit` on Windows (no SIGTERM there), SIGTERM elsewhere. SMOKE_QUIT=arg tests the
// `--quit` path on macOS and Linux too.
const quitWithArg = isWindows || process.env.SMOKE_QUIT === 'arg'
const binary = isLinux || isWindows ? appPath : path.join(appPath, 'Contents', 'MacOS', 'TraceRoost')
if (!fs.existsSync(binary)) {
  console.error(`smoke: ${binary} does not exist — run \`pnpm run pack\` / \`pnpm run pack:linux\` / \`pnpm run pack:win\` (or pass the path)`)
  process.exit(2)
}
if (isLinux && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.error('smoke: no display — run this under `xvfb-run -a` (or in a desktop session)')
  process.exit(2)
}
// The version the app ships: read from its staged collector, except inside an AppImage (a
// compressed image, not a directory), where the build's own version is the expectation.
const shippedVersion = isAppImage
  ? JSON.parse(fs.readFileSync(path.join(desktopDir, '..', 'package.json'), 'utf8')).version
  : JSON.parse(fs.readFileSync(isLinux || isWindows
    ? path.join(path.dirname(fs.realpathSync(binary)), 'resources', 'collector', 'package.json')
    : path.join(appPath, 'Contents', 'Resources', 'collector', 'package.json'), 'utf8')).version

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-smoke-home-'))
const dataDir = path.join(home, '.traceroost')
const lockPath = path.join(dataDir, 'server.lock')
const logPath = path.join(dataDir, 'desktop.log')
const output = []
const failures = []
const check = (ok, what) => { (ok ? passes : failures).push(what); console.log(`${ok ? '  ✔' : '  ✘'} ${what}`) }
const passes = []

// The app must start as an *app*. A shell inside VS Code's extension host (or any Electron host)
// carries ELECTRON_RUN_AS_NODE=1, and an Electron binary launched with that set is plain Node: with
// no script it exits 0 in a few milliseconds, which looks exactly like a broken bundle.
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env
const appEnv = {
  ...inherited,
  HOME: home,
  // Windows: os.homedir() is USERPROFILE (the data dir and agent configs), and Electron keeps its
  // own state and the app's prefs under APPDATA — all inside the fake HOME too.
  ...(isWindows ? {
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  } : {}),
  // Linux keeps Electron's own state (and the app's prefs) under XDG_CONFIG_HOME, and the
  // autostart / launcher entries under XDG_CONFIG_HOME / XDG_DATA_HOME: all inside the fake HOME.
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  DATA_DIR: dataDir,
  UI_PORT: String(UI_PORT),
  OTLP_PORT: String(OTLP_PORT),
  MCP_PORT: String(MCP_PORT),
  // No network from a smoke test: the npm version check is the collector's one outbound call.
  TRACEROOST_NO_UPDATE_CHECK: '1',
}
// They must exist: Electron puts its single-instance lock in userData under APPDATA, and a launch
// that cannot take the lock exits 0 at once, as a second instance would.
if (isWindows) for (const dir of [appEnv.APPDATA, appEnv.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true })
const app = spawn(binary, [], {
  env: appEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
})
app.stdout.on('data', c => output.push(c.toString()))
app.stderr.on('data', c => output.push(c.toString()))
let exit
const exited = new Promise(resolve => app.once('exit', (code, signal) => { exit = { code, signal }; resolve() }))

console.log(`smoke: launched ${path.relative(process.cwd(), appPath)} (pid ${app.pid}) with HOME=${home}`)

try {
  // ── Ready: the collector's own lock names a live pid with bound ports ──
  const held = await waitFor(() => {
    const lock = readJson(lockPath)
    return lock && typeof lock.pid === 'number' && lock.uiPort !== undefined && lock.otlpPort !== undefined ? lock : undefined
  }, READY_TIMEOUT_MS, 'the collector to claim the data dir lock with bound ports')
  check(held !== undefined, 'collector claimed the data dir and bound its ports')
  if (!held) throw new Error('not ready')
  check(held.uiPort === UI_PORT && held.otlpPort === OTLP_PORT && held.mcpPort === MCP_PORT, `bound the configured ports (${UI_PORT}/${OTLP_PORT}/${MCP_PORT})`)
  check(held.version === shippedVersion, `lock records the shipped version ${shippedVersion} (got ${held.version})`)
  check(held.service === false, 'an app-owned collector does not claim to be the background service')
  check(held.pid !== app.pid, 'the collector is a separate process from the app')

  // ── Serving ──
  const health = await get(`http://127.0.0.1:${UI_PORT}/health`)
  check(health.status === 200 && JSON.parse(health.body).status === 'ok', '/health answers ok')
  const probe = await get(`http://127.0.0.1:${OTLP_PORT}/traceroost/standalone`)
  const identity = probe.status === 200 ? JSON.parse(probe.body) : {}
  check(identity.traceroost === true && identity.kind === 'standalone', 'identity probe names a standalone TraceRoost collector')
  const page = await get(`http://127.0.0.1:${UI_PORT}/`)
  check(page.status === 200 && /<!DOCTYPE html>/i.test(page.body), 'dashboard page serves')
  const asset = await get(`http://127.0.0.1:${UI_PORT}/dashboard.js`)
  check(asset.status === 200 && asset.body.length > 100_000, `dashboard.js serves from the packaged media tree (${asset.body.length} bytes)`)
  const summary = await get(`http://127.0.0.1:${UI_PORT}/api/summary`)
  check(summary.status === 200 && Array.isArray(JSON.parse(summary.body).sessions), '/api/summary answers')

  // ── The shell's own account of itself ──
  const log = await waitFor(() => {
    const text = readText(logPath)
    return text && /\[desktop\] mode: own/.test(text) ? text : undefined
  }, 15_000, 'desktop.log to record owned mode')
  check(log !== undefined, 'desktop.log records owned mode')
  check(!/cannot start|startup failed/.test(log ?? ''), 'desktop.log has no startup failure')

  // ── Agent configuration stayed inside the redirected HOME ──
  const realClaude = path.join(os.homedir(), '.claude', 'settings.json')
  const realText = readText(realClaude) ?? ''
  check(!realText.includes(String(OTLP_PORT)), 'the real ~/.claude/settings.json was not pointed at the test port')

  // ── A span that only the shutdown's own save can have put on disk ──
  const traceId = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')
  const ingest = await post(`http://127.0.0.1:${OTLP_PORT}/v1/traces`, oneSpanTrace(traceId))
  check(ingest.status === 200, `OTLP span accepted (status ${ingest.status})`)

  // ── Quit: SIGTERM (POSIX) or `--quit` (Windows) → app.quit() → collector flushed, lock released ──
  const collectorPid = held.pid
  const how = quitWithArg ? '`traceroost-desktop --quit`' : 'SIGTERM'
  if (quitWithArg) {
    const quitter = spawn(binary, ['--quit'], { env: appEnv, stdio: 'ignore' })
    const quitterExit = await Promise.race([new Promise(r => quitter.once('exit', code => r(code))), delay(QUIT_TIMEOUT_MS).then(() => 'timeout')])
    check(quitterExit === 0, `the --quit launch handed the request over and exited 0 (got ${quitterExit})`)
  } else {
    app.kill('SIGTERM')
  }
  const quit = await Promise.race([exited.then(() => true), delay(QUIT_TIMEOUT_MS).then(() => false)])
  check(quit, `app exited within ${QUIT_TIMEOUT_MS / 1000}s of ${how}`)
  if (quit) check(exit.code === 0, `app exited 0 (code ${exit.code}, signal ${exit.signal})`)
  // The collector releases the lock from its own exit handler; give it a moment past the app's exit.
  const released = await waitFor(() => (fs.existsSync(lockPath) ? undefined : true), 5_000, 'the lock to be released', { appMayHaveExited: true })
  check(released === true, 'data dir lock released')
  check(!pidAlive(collectorPid), `collector (pid ${collectorPid}) is gone`)
  const finalLog = readText(logPath) ?? ''
  check(/quitting — stopping and flushing the collector first/.test(finalLog), 'quit went through the owned-collector flush path')
  check(!/killing it/.test(finalLog), 'the collector did not need to be force-killed')
  check(/asking the collector \(pid \d+\) to shut down \(owner channel\)/.test(finalLog), 'the stop request went over the owner channel')
  check(/Shutdown requested by the app that started this collector/.test(finalLog), 'the collector honoured the request')
  check(/Saved \d+ spans to /.test(finalLog), 'the collector\'s shutdown saved its spans')
  check((readText(path.join(dataDir, 'spans.json')) ?? '').includes(traceId), 'the span sent just before quitting is in spans.json — flushed, not lost')
  if (quitWithArg) check(/a second launch asked this instance to quit/.test(finalLog), 'the running instance received the --quit request')

  if (isLinux) {
    // What the shell decided about this desktop, and that it ran sandboxed — the app refuses
    // otherwise, so reaching owned mode at all already proves it; the log line says how.
    check(/\[desktop\] tray: (available|unavailable)/.test(finalLog), `desktop.log records the tray check (${(/\[desktop\] tray: [^\n]*/.exec(finalLog) ?? ['none'])[0]})`)
    check(!/refusing to start/.test(finalLog), 'the app did not refuse to start for want of a sandbox')
    check(!fs.existsSync(path.join(home, '.config', 'autostart')), 'nothing was added to autostart without being asked')
  }
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err))
} finally {
  if (exit === undefined) {
    app.kill('SIGKILL')
    await Promise.race([exited, delay(3_000)])
  }
  // Belt and braces: never leave the smoke collector running on a developer's machine.
  const lock = readJson(lockPath)
  if (lock && pidAlive(lock.pid)) { try { process.kill(lock.pid, 'SIGKILL') } catch { /* gone */ } }
}

if (failures.length > 0) {
  console.error(`\nsmoke: ${failures.length} check(s) failed, ${passes.length} passed`)
  for (const f of failures) console.error(`  ✘ ${f}`)
  if (exit !== undefined) console.error(`  (app exit: code ${exit.code}, signal ${exit.signal})`)
  console.error('\n── app output ──\n' + output.join('').trim())
  console.error('\n── desktop.log ──\n' + (readText(logPath) ?? '(none)').trim())
  fs.rmSync(home, { recursive: true, force: true })
  process.exit(1)
}
fs.rmSync(home, { recursive: true, force: true })
console.log(`\nsmoke: all ${passes.length} checks passed`)

// ── helpers ──

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return undefined } }
function readText(p) { try { return fs.readFileSync(p, 'utf8') } catch { return undefined } }
function pidAlive(pid) { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitFor(probe, timeoutMs, what, { appMayHaveExited = false } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exit !== undefined && !appMayHaveExited) { failures.push(`the app exited early (code ${exit.code}, signal ${exit.signal}) while waiting for ${what}`); return undefined }
    const value = probe()
    if (value !== undefined) return value
    await delay(200)
  }
  failures.push(`timed out after ${timeoutMs / 1000}s waiting for ${what}`)
  return undefined
}

/** One Claude Code interaction span, as an agent's OTLP/HTTP JSON exporter sends it. */
function oneSpanTrace(traceId) {
  const nowNs = BigInt(Date.now()) * 1_000_000n
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }, { key: 'session.id', value: { stringValue: `smoke-${traceId}` } }] },
      scopeSpans: [{
        scope: { name: 'com.anthropic.claude_code' },
        spans: [{
          traceId, spanId: traceId.slice(0, 16), name: 'claude_code.interaction', kind: 1,
          startTimeUnixNano: String(nowNs - 2_000_000_000n), endTimeUnixNano: String(nowNs),
          attributes: [{ key: 'user_prompt', value: { stringValue: 'smoke flush' } }], status: { code: 0 },
        }],
      }],
    }],
  }
}

function post(url, body, timeoutMs = 5_000) {
  return new Promise(resolve => {
    const data = JSON.stringify(body)
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
    })
    req.on('error', err => resolve({ status: 0, body: String(err) }))
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.end(data)
  })
}

function get(url, timeoutMs = 5_000) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', err => resolve({ status: 0, body: String(err) }))
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
  })
}
