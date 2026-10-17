/**
 * Installs, exercises, upgrades over a running copy, and uninstalls the TraceRoost NSIS installer on
 * Windows — the Windows counterpart of check-deb.sh. Run it on a Windows machine (CI: the
 * windows-latest and windows-11-arm runners) with a built installer:
 *
 *   node scripts/check-nsis.mjs dist\TraceRoost-<version>-win-<arch>.exe
 *
 * It checks:
 *
 *   - a silent install (`/S`) is per-user: %LOCALAPPDATA%\Programs\traceroost-desktop, with the
 *     collector, the tray icon and the uninstaller, a Start Menu shortcut, and an entry under
 *     HKCU's Uninstall key — nothing under Program Files, nothing needing an administrator;
 *   - the *installed* app passes the packaged smoke test (scripts/smoke-packaged.mjs): owned
 *     collector, dashboard, and a `--quit` that flushes;
 *   - installing again **over a running app** (an upgrade) quits it the cooperative way first —
 *     build/installer.nsh runs `traceroost-desktop --quit`, the app stops its collector over the
 *     owner channel, and a span sent just before is on disk — rather than electron-builder's own
 *     Stop-Process, which would kill the collector unflushed;
 *   - a silent uninstall removes the app, the shortcut and the Uninstall entry, and leaves the
 *     user's data directory alone.
 *
 * HOME/USERPROFILE are redirected for the app runs, as in the smoke test, so the collector's agent
 * auto-configuration never touches the machine's real ~/.claude.
 */

import { spawn, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

if (process.platform !== 'win32') {
  console.error('check-nsis: Windows only')
  process.exit(2)
}
const installer = path.resolve(process.argv[2] ?? '')
if (!process.argv[2] || !fs.existsSync(installer)) {
  console.error('usage: node scripts/check-nsis.mjs path\\to\\TraceRoost-<version>-win-<arch>.exe')
  process.exit(2)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'traceroost-desktop')
const exe = path.join(installDir, 'traceroost-desktop.exe')
const uninstaller = path.join(installDir, 'Uninstall traceroost-desktop.exe')
const shortcut = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TraceRoost.lnk')
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const UI_PORT = 31900
const OTLP_PORT = 31918
const MCP_PORT = 31916

const passes = []
const failures = []
const check = (ok, what) => { (ok ? passes : failures).push(what); console.log(`${ok ? '  ✔' : '  ✘'} ${what}`) }

console.log(`check-nsis: ${path.basename(installer)} on ${os.release()} ${process.arch}`)

// ── Install ──
console.log('\n── silent install ──')
const installed = runInstaller(installer, ['/S'])
check(installed.status === 0, `installer /S exited 0 (got ${installed.status}, ${installed.seconds}s)`)
check(await waitFor(() => fs.existsSync(exe), 60_000), `installed per-user at ${exe}`)
check(!installDir.toLowerCase().startsWith((process.env.ProgramFiles ?? 'C:\\Program Files').toLowerCase()), 'not under Program Files')
for (const rel of ['resources/app.asar', 'resources/collector/standalone/server.js', 'resources/collector/node_modules/sql.js/dist/sql-wasm.wasm', 'resources/tray/trayWindows.ico', 'resources/LICENSE', 'resources/THIRD_PARTY_NOTICES.md']) {
  check(fs.existsSync(path.join(installDir, rel)), `installed ${rel}`)
}
check(!fs.existsSync(path.join(installDir, 'traceroost.exe')), 'no traceroost.exe to shadow the npm CLI')
check(fs.existsSync(uninstaller), 'the uninstaller is installed')
check(fs.existsSync(shortcut), 'Start Menu shortcut TraceRoost.lnk')
check(uninstallEntry() !== undefined, `an Uninstall entry under ${UNINSTALL_KEY} names TraceRoost`)

// ── The installed app, end to end ──
console.log('\n── smoke test of the installed app ──')
const smoke = spawnSync(process.execPath, [path.join(here, 'smoke-packaged.mjs'), exe], { stdio: 'inherit', timeout: 300_000 })
check(smoke.status === 0, 'the installed app passes the packaged smoke test')

// ── Upgrade over a running app ──
console.log('\n── reinstall over a running app ──')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-nsis-home-'))
const dataDir = path.join(home, '.traceroost')
const lockPath = path.join(dataDir, 'server.lock')
const logPath = path.join(dataDir, 'desktop.log')
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env
const env = {
  ...inherited,
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  DATA_DIR: dataDir,
  UI_PORT: String(UI_PORT),
  OTLP_PORT: String(OTLP_PORT),
  MCP_PORT: String(MCP_PORT),
  TRACEROOST_NO_UPDATE_CHECK: '1',
}
// Electron keeps its single-instance lock under APPDATA; the directories have to exist.
for (const dir of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true })
const app = spawn(exe, [], { env, stdio: 'ignore' })
let appExit
const appExited = new Promise(resolve => app.once('exit', code => { appExit = code; resolve() }))
const held = await waitFor(() => {
  const lock = readJson(lockPath)
  return lock && lock.uiPort !== undefined ? lock : undefined
}, 90_000)
check(held !== undefined, 'the installed app owns a collector')
let traceId
if (held) {
  traceId = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')
  check((await post(`http://127.0.0.1:${OTLP_PORT}/v1/traces`, oneSpanTrace(traceId))) === 200, 'a span is accepted just before the upgrade')
  // The installer inherits this environment, so the `--quit` it launches reaches this instance —
  // as it does for a user, whose installer runs in the same session as the app.
  const upgrade = runInstaller(installer, ['/S'], env)
  check(upgrade.status === 0, `reinstall /S over the running app exited 0 (got ${upgrade.status}, ${upgrade.seconds}s)`)
  const quit = await Promise.race([appExited.then(() => true), delay(30_000).then(() => false)])
  check(quit, 'the running app was closed by the installer')
  if (quit) check(appExit === 0, `…and exited 0 — it quit, it was not killed (code ${appExit})`)
  const log = readText(logPath) ?? ''
  check(/a second launch asked this instance to quit/.test(log), 'the installer asked it to quit with --quit (build/installer.nsh)')
  check(/asking the collector \(pid \d+\) to shut down \(owner channel\)/.test(log), 'the app stopped its collector over the owner channel')
  check(/Saved \d+ spans to /.test(log), 'the collector saved its spans on the way out')
  check(!/killing it/.test(log), 'the collector did not need to be force-killed')
  check(await waitFor(() => !fs.existsSync(lockPath), 10_000), 'the data dir lock was released')
  check(!pidAlive(held.pid), `the collector (pid ${held.pid}) is gone`)
  check((readText(path.join(dataDir, 'spans.json')) ?? '').includes(traceId), 'the span sent just before the upgrade is in spans.json')
  check(fs.existsSync(exe), 'the app is installed again after the upgrade')
}
if (appExit === undefined) { app.kill(); await Promise.race([appExited, delay(5_000)]) }
const leftover = readJson(lockPath)
if (leftover && pidAlive(leftover.pid)) { try { process.kill(leftover.pid) } catch { /* gone */ } }

// ── Uninstall ──
console.log('\n── silent uninstall ──')
// The uninstaller copies itself to %TEMP% and re-runs from there, so its own exit is not the end of
// the work: wait for the files to go.
const removed = runInstaller(uninstaller, ['/S'])
check(removed.status === 0, `uninstaller /S exited 0 (got ${removed.status}, ${removed.seconds}s)`)
check(await waitFor(() => !fs.existsSync(exe), 90_000), 'the app is removed')
check(await waitFor(() => !fs.existsSync(shortcut), 30_000), 'the Start Menu shortcut is removed')
check(await waitFor(() => uninstallEntry() === undefined, 30_000), 'the Uninstall entry is removed')
check(fs.existsSync(path.join(dataDir, 'spans.json')), 'the user\'s data directory is kept')

fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
if (failures.length > 0) {
  console.error(`\ncheck-nsis: ${failures.length} check(s) failed, ${passes.length} passed`)
  for (const f of failures) console.error(`  ✘ ${f}`)
  process.exit(1)
}
console.log(`\ncheck-nsis: all ${passes.length} checks passed`)

// ── helpers ──

/**
 * Runs an NSIS installer or uninstaller and waits for it. A silent NSIS run that hangs is almost
 * always a dialog with no silent default, so on a timeout the window titles of every process that
 * could be involved are printed before it is killed — the title says which dialog it was.
 */
function runInstaller(file, args, env = process.env) {
  const started = Date.now()
  const r = spawnSync(file, args, { env, stdio: 'inherit', timeout: 300_000 })
  const seconds = Math.round((Date.now() - started) / 1000)
  if (r.status === null) {
    console.log(`  … ${path.basename(file)} did not finish in ${seconds}s (${r.error?.message ?? r.signal}); what was running:`)
    const t = spawnSync('tasklist', ['/v', '/fo', 'csv'], { encoding: 'utf8' })
    for (const line of (t.stdout ?? '').split('\n')) {
      if (/TraceRoost|traceroost|powershell|pwsh|Un_A|Au_|cmd\.exe|tasklist|taskkill/i.test(line)) console.log(`    ${line.trim()}`)
    }
  }
  return { status: r.status, seconds }
}

/** The HKCU Uninstall subkey whose DisplayName is TraceRoost, or undefined. */
function uninstallEntry() {
  const r = spawnSync('reg', ['query', UNINSTALL_KEY, '/s', '/f', 'TraceRoost', '/d', '/e'], { encoding: 'utf8' })
  if (r.status !== 0) return undefined
  return /DisplayName\s+REG_SZ\s+TraceRoost/.test(r.stdout) ? r.stdout : undefined
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return undefined } }
function readText(p) { try { return fs.readFileSync(p, 'utf8') } catch { return undefined } }
function pidAlive(pid) { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value
    await delay(250)
  }
  return undefined
}

function oneSpanTrace(id) {
  const nowNs = BigInt(Date.now()) * 1_000_000n
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }, { key: 'session.id', value: { stringValue: `nsis-${id}` } }] },
      scopeSpans: [{
        scope: { name: 'com.anthropic.claude_code' },
        spans: [{
          traceId: id, spanId: id.slice(0, 16), name: 'claude_code.interaction', kind: 1,
          startTimeUnixNano: String(nowNs - 2_000_000_000n), endTimeUnixNano: String(nowNs),
          attributes: [{ key: 'user_prompt', value: { stringValue: 'upgrade flush' } }], status: { code: 0 },
        }],
      }],
    }],
  }
}

function post(url, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body)
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', () => resolve(0))
    req.setTimeout(5_000, () => req.destroy(new Error('timeout')))
    req.end(data)
  })
}
