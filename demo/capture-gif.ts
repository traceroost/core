#!/usr/bin/env node
/**
 * Regenerates media/demo.gif from synthetic fixture data on a fully isolated, scratch
 * instance — no real telemetry, and none of the real machine's agent config is touched.
 *
 * Prerequisites:
 *   npx playwright install chromium   (one-time)
 *   ffmpeg on PATH                    (brew install ffmpeg / apt install ffmpeg)
 *
 * Usage:
 *   pnpm run demo:gif                       # writes media/demo.gif (asks before overwriting)
 *   pnpm run demo:gif -- --out /tmp/x.gif   # write elsewhere instead, for review first
 *   pnpm run demo:gif -- --force            # overwrite media/demo.gif without asking
 *   pnpm run demo:gif -- --dry-run          # run the tour, skip recording — for tuning pauses
 *   pnpm run demo:gif -- --speed 2          # faster tour -> shorter capture
 *   pnpm run demo:gif -- --headed           # show the browser while it records (debugging)
 *   pnpm run demo:gif -- --theme light      # capture in light mode instead of the dark default
 *
 * Safety, and why it's structured this way: see .staged-issues/demo-gif-capture.md. In
 * short — the standalone server this spawns is started with TRACEROOST_NO_AUTOCONFIG=1
 * (the real off-switch) AND with HOME/DATA_DIR pointed at a scratch temp directory this
 * script creates and deletes (a second, independent layer — if a future change ever adds
 * an auto-config call site that forgets to check the env var, it still can't reach the
 * real ~/.claude, ~/.codex, or VS Code Copilot config, because "home" itself is fake for
 * the whole lifetime of this process).
 */

import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { runTour } from './tour'
import { waitForAuthToken } from './authToken'

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function flag(name: string, fallback: string): string {
  const i = args.indexOf('--' + name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
function hasFlag(name: string): boolean { return args.includes('--' + name) }

const DRY_RUN  = hasFlag('dry-run')
const FORCE    = hasFlag('force')
const HEADED   = hasFlag('headed')
const SPEED    = parseFloat(flag('speed', '1')) || 1
const SCENARIO = flag('scenario', 'story')
const AGENTS   = flag('agents', '')
const THEME    = flag('theme', 'dark') as 'dark' | 'light'
if (THEME !== 'dark' && THEME !== 'light') {
  err(`--theme must be "dark" or "light", got "${THEME}"`)
  process.exit(1)
}
const OUT      = path.resolve(flag('out', path.join(__dirname, '..', 'media', 'demo.gif')))

// Distinct from the default 3000/4318 on purpose — a real `pnpm run local` instance can
// stay running on the defaults the whole time this script runs, with no port fight.
const UI_PORT   = parseInt(flag('ui-port', '13000'), 10)
const OTLP_PORT = parseInt(flag('otlp-port', '14318'), 10)

// Matches the current media/demo.gif exactly (`sips -g pixelWidth -g pixelHeight`) —
// change deliberately, not by accident, since the README doesn't set an explicit
// width and the file's own pixel size is what renders.
const WIDTH  = parseInt(flag('width', '1000'), 10)
const HEIGHT = parseInt(flag('height', '646'), 10)
const FPS    = parseInt(flag('fps', '10'), 10)

function log(msg: string) { process.stdout.write(`\x1b[36m[demo:gif]\x1b[0m ${msg}\n`) }
function err(msg: string) { process.stderr.write(`\x1b[31m[demo:gif]\x1b[0m ${msg}\n`) }

// ── Preflight ────────────────────────────────────────────────────────────────

function haveFfmpeg(): boolean {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  return r.error === undefined && r.status === 0
}

function checkServer(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'GET', path: '/', timeout: 2000 },
      () => resolve(true)
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await checkServer(port)) return true
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

// Waits (briefly) for the child to actually exit before returning, so the scratch directory
// isn't removed out from under a shutdown handler still trying to write to it (the standalone
// server saves its in-memory spans to DATA_DIR on SIGTERM) — cosmetic (a removed scratch dir
// is harmless either way), but a clean exit beats a spurious ENOENT stack trace in the log.
function killAndWait(child: ReturnType<typeof spawn> | undefined, timeoutMs = 3000): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!DRY_RUN && fs.existsSync(OUT) && !FORCE) {
    err(`${OUT} already exists.`)
    err('Pass --force to overwrite it, or --out <path> to write somewhere else for review first.')
    process.exit(1)
  }

  if (!DRY_RUN && !haveFfmpeg()) {
    err('ffmpeg is not on PATH — required to convert the recorded video to a GIF.')
    err('  macOS:   brew install ffmpeg')
    err('  Debian/Ubuntu: sudo apt install ffmpeg')
    err('Or pass --dry-run to run the tour without recording (for tuning pause lengths).')
    process.exit(1)
  }

  let chromium: import('playwright').BrowserType
  try {
    const pw = await import('playwright')
    chromium = pw.chromium
  } catch {
    err('playwright is not installed. Run:')
    err('  pnpm add -D playwright')
    err('  npx playwright install chromium')
    process.exit(1)
  }

  // ── Scratch environment ─────────────────────────────────────────────────────
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-democapture-'))
  const scratchHome  = path.join(scratchRoot, 'home')
  const scratchData  = path.join(scratchRoot, 'data')
  const scratchVideo = path.join(scratchRoot, 'video')
  for (const d of [scratchHome, scratchData, scratchVideo]) fs.mkdirSync(d, { recursive: true })
  log(`Scratch environment: ${scratchRoot}`)

  let serverProc: ReturnType<typeof spawn> | undefined
  let replayProc: ReturnType<typeof spawn> | undefined
  let exitCode = 0

  try {
    log('Building the standalone bundle (node esbuild.js --production)…')
    const build = spawnSync(process.execPath, [path.join(__dirname, '..', 'esbuild.js'), '--production'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    })
    if (build.status !== 0) throw new Error('esbuild failed — see output above')

    log(`Starting standalone server on port ${UI_PORT} (OTLP ${OTLP_PORT}) — scratch HOME, auto-configure disabled…`)
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'standalone', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        HOME: scratchHome,
        USERPROFILE: scratchHome, // Windows equivalent of HOME, same belt-and-suspenders reasoning
        DATA_DIR: scratchData,
        UI_PORT: String(UI_PORT),
        OTLP_PORT: String(OTLP_PORT),
        TRACEROOST_NO_AUTOCONFIG: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    serverProc.stdout?.on('data', d => process.stdout.write(`  [server] ${d}`))
    serverProc.stderr?.on('data', d => process.stderr.write(`  [server] ${d}`))

    const up = await waitForServer(UI_PORT, 20_000)
    if (!up) throw new Error(`standalone server did not come up on port ${UI_PORT} within 20s`)
    log('Server is up.')

    // Every UI request is authenticated, unconditionally, even on loopback (src/httpSecurity.ts)
    // — navigating without the token gets a 401 page with no tab bar at all, and the tour then
    // "succeeds" having silently clicked nothing. (This bug already existed in demo/browser.ts;
    // fixed there too as part of this change.)
    const token = await waitForAuthToken(scratchHome)
    if (!token) throw new Error(`could not read the auth token from ${scratchHome}/.traceroost/config.json`)

    const browser = await chromium.launch({ headless: !HEADED })
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      colorScheme: THEME,
      recordVideo: DRY_RUN ? undefined : { dir: scratchVideo, size: { width: WIDTH, height: HEIGHT } },
    })
    // Matches media/src/state.ts's THEME_STORAGE_KEY — set before the app's own anti-flash
    // script runs (standalone/server.ts) so it picks up the explicit choice on first paint
    // instead of the scratch profile's default ("system").
    await context.addInitScript(theme => {
      try { localStorage.setItem('traceroost-theme', theme) } catch { /* ignore */ }
    }, THEME)
    const page = await context.newPage()
    await page.goto(`http://localhost:${UI_PORT}/?token=${token}`)
    await page.waitForLoadState('domcontentloaded')
    log('Browser open. Starting replay…')

    const replayArgs = [
      path.join(__dirname, 'replay.ts'),
      '--speed', String(SPEED),
      '--port', String(OTLP_PORT),
      '--scenario', SCENARIO,
      ...(AGENTS ? ['--agents', AGENTS] : []),
    ]
    replayProc = spawn(process.execPath, [path.join(__dirname, 'run-ts.js'), ...replayArgs], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    replayProc.stdout?.on('data', d => process.stdout.write(`  [replay] ${d}`))
    replayProc.stderr?.on('data', d => process.stderr.write(`  [replay] ${d}`))
    const replayDone = new Promise<void>((resolve, reject) => {
      replayProc!.on('error', reject)
      replayProc!.on('exit', code => (code === 0 || code === null) ? resolve() : reject(new Error(`replay exited with code ${code}`)))
    })

    await runTour(page, { speed: SPEED, log })

    await replayDone.catch(e => log(`(replay reported: ${e.message} — continuing; the tour already captured what landed)`))

    let videoPath: string | undefined
    if (!DRY_RUN) {
      const video = page.video()
      await context.close() // finalizes the .webm — must happen before reading it
      videoPath = video ? await video.path() : undefined
      await browser.close()
    } else {
      await context.close()
      await browser.close()
    }

    if (DRY_RUN) {
      log('Dry run complete — no video recorded, no GIF written.')
      return
    }
    if (!videoPath || !fs.existsSync(videoPath)) {
      throw new Error('recording finished but no video file was found — Playwright recordVideo may have changed shape')
    }

    log(`Converting ${videoPath} → GIF…`)
    const palettePath = path.join(scratchRoot, 'palette.png')
    const scale = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`

    const pass1 = spawnSync('ffmpeg', ['-y', '-i', videoPath, '-vf', `${scale},palettegen`, palettePath], { stdio: 'inherit' })
    if (pass1.status !== 0) throw new Error('ffmpeg palette generation failed')

    const scratchGif = path.join(scratchRoot, 'demo.gif')
    const pass2 = spawnSync('ffmpeg', [
      '-y', '-i', videoPath, '-i', palettePath,
      '-filter_complex', `${scale}[x];[x][1:v]paletteuse`,
      scratchGif,
    ], { stdio: 'inherit' })
    if (pass2.status !== 0) throw new Error('ffmpeg GIF conversion failed')

    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.copyFileSync(scratchGif, OUT)
    const sizeKb = (fs.statSync(OUT).size / 1024).toFixed(0)
    log(`Wrote ${OUT} (${sizeKb} KB).`)
  } catch (e) {
    exitCode = 1
    err(String(e instanceof Error ? e.message : e))
  } finally {
    await killAndWait(replayProc)
    await killAndWait(serverProc)
    fs.rmSync(scratchRoot, { recursive: true, force: true })
  }

  process.exit(exitCode)
}

main().catch(e => {
  err(String(e))
  process.exit(1)
})
