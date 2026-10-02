#!/usr/bin/env node
/**
 * Regenerates media/demo.gif from synthetic fixture data on a fully isolated, scratch
 * instance — no real telemetry, and none of the real machine's agent config is touched —
 * then uploads it to static.traceroost.com (the traceroost/static repo) as demo.<hash>.gif and
 * points README.md's image at that URL. Everything on static.traceroost.com is immutable: a
 * new recording is a new content-hashed name, never an overwrite.
 *
 * Prerequisites:
 *   npx playwright install chromium   (one-time)
 *   ffmpeg on PATH                    (brew install ffmpeg / apt install ffmpeg)
 *   aws + pulumi on PATH, logged in   (only for the upload; skip it with --no-upload)
 *
 * Usage:
 *   pnpm run demo:gif                       # writes media/demo.gif, uploads it, updates README.md (refuses to overwrite)
 *   pnpm run demo:gif -- --no-upload        # local file only; README.md untouched
 *   pnpm run demo:gif -- --max-mb 4         # size budget (default 4.9, GitHub's limit is 5) — drops more near-duplicate frames to fit
 *   pnpm run demo:gif -- --out /tmp/x.gif   # write elsewhere instead, for review first
 *   pnpm run demo:gif -- --force            # overwrite media/demo.gif without asking
 *   pnpm run demo:gif -- --dry-run          # run the tour, skip recording — for tuning pauses
 *   pnpm run demo:gif -- --speed 2          # faster tour -> shorter capture
 *   pnpm run demo:gif -- --headed           # show the browser while it records (debugging)
 *   pnpm run demo:gif -- --theme light      # capture in light mode instead of the dark default
 *   pnpm run demo:gif -- --edition full     # record the full edition (default: core, what releases ship)
 *   pnpm run demo:gif -- --no-outcomes      # skip the scratch git repo — no Outcome column/chart data
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
import * as crypto from 'node:crypto'
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
const EDITION  = flag('edition', 'core')
if (EDITION !== 'core' && EDITION !== 'full') {
  err(`--edition must be "core" or "full", got "${EDITION}"`)
  process.exit(1)
}
// On by default: the replay seeds a scratch git repo so Claude/Codex sessions get real merged /
// committed / uncommitted outcomes (demo/replay.ts --demo-repo), backdated past the dashboard's
// 2-minute active-session grace window so they resolve while the tour is still recording.
const OUTCOMES = !hasFlag('no-outcomes')
const OUT      = path.resolve(flag('out', path.join(__dirname, '..', 'media', 'demo.gif')))
const UPLOAD   = !DRY_RUN && !hasFlag('no-upload')
// GitHub serves README images through its camo proxy, which refuses anything over 5 MB
// ("Content length exceeded") — the GIF then just doesn't show on github.com, though the URL works.
const GITHUB_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024
const MAX_BYTES = (parseFloat(flag('max-mb', '4.9')) || 4.9) * 1024 * 1024
if (MAX_BYTES > GITHUB_IMAGE_LIMIT_BYTES) {
  err(`--max-mb is over GitHub's 5 MB image limit — the README GIF won't display on github.com`)
}

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

// Each step drops more near-duplicate frames (mpdecimate); the frames that remain are held
// longer, so the tour's timing is unchanged and only the smoothness of motion degrades. The
// tour spends most of its time paused on a view, so the first step alone removes most
// frames. The encoder tries each step in order and keeps the first result under --max-mb.
const DECIMATE_LADDER = [
  'mpdecimate',
  'mpdecimate=hi=64*24:lo=64*8:frac=0.5',
  'mpdecimate=hi=64*48:lo=64*16:frac=0.5',
]

// traceroost/static's Pulumi stack; its outputs name the bucket to upload to and its public URL.
const STATIC_STACK = 'admin-traceroost-com/traceroost-static-infra/prod'
const README       = path.join(__dirname, '..', 'README.md')
// Any earlier demo GIF link in the README, hashed or not — the one line this script rewrites.
const README_GIF_URL = /https:\/\/static\.traceroost\.com\/demo(\.[0-9a-f]+)?\.gif/

function log(msg: string) { process.stdout.write(`\x1b[36m[demo:gif]\x1b[0m ${msg}\n`) }
function err(msg: string) { process.stderr.write(`\x1b[31m[demo:gif]\x1b[0m ${msg}\n`) }

// ── Preflight ────────────────────────────────────────────────────────────────

function haveFfmpeg(): boolean {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  return r.error === undefined && r.status === 0
}

function haveCommand(cmd: string): boolean {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' })
  return r.error === undefined && r.status === 0
}

function staticStackOutput(key: string): string {
  const r = spawnSync('pulumi', ['stack', 'output', key, '--stack', STATIC_STACK], { encoding: 'utf8' })
  const value = r.stdout?.trim()
  if (r.status !== 0 || !value) {
    throw new Error(`could not read "${key}" from Pulumi stack ${STATIC_STACK} — has \`pulumi up --stack prod\` been run in traceroost/static/infra?\n${r.stderr ?? ''}`)
  }
  return value
}

// Two-pass palette encode. stats_mode=diff builds the palette from the pixels that change
// between frames, and diff_mode=rectangle re-encodes only the changed rectangle of each
// frame, so a mostly static dashboard compresses well.
function encodeGif(videoPath: string, scratchRoot: string, decimate: string): string {
  const palettePath = path.join(scratchRoot, 'palette.png')
  const filters = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,${decimate}`

  const pass1 = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', videoPath, '-vf', `${filters},palettegen=stats_mode=diff`, palettePath], { stdio: 'inherit' })
  if (pass1.status !== 0) throw new Error('ffmpeg palette generation failed')

  const gifPath = path.join(scratchRoot, 'demo.gif')
  const pass2 = spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-i', videoPath, '-i', palettePath,
    '-filter_complex', `${filters}[x];[x][1:v]paletteuse=diff_mode=rectangle`,
    gifPath,
  ], { stdio: 'inherit' })
  if (pass2.status !== 0) throw new Error('ffmpeg GIF conversion failed')

  // gifsicle's lossy LZW roughly halves a dashboard GIF with no visible change (2026-10: 5.7 MB →
  // 2.9 MB). Fetched with npx, so there's nothing to install; if it isn't available, ffmpeg's
  // file is used as is.
  const lossyPath = path.join(scratchRoot, 'demo.lossy.gif')
  const lossy = spawnSync('npx', ['--yes', 'gifsicle@7', '-O3', '--lossy=20', '-o', lossyPath, gifPath],
    { stdio: 'ignore', shell: process.platform === 'win32' })
  if (lossy.status === 0 && fs.existsSync(lossyPath) && fs.statSync(lossyPath).size < fs.statSync(gifPath).size) return lossyPath
  log('gifsicle unavailable — keeping the ffmpeg GIF uncompressed')
  return gifPath
}

// Uploads under a content-hashed name and returns its public URL. The bucket denies any write
// without If-None-Match: *, so an existing key is never replaced; S3 answers 412 when this exact
// content is already there, which just means it was published before.
function upload(file: string, bucket: string, baseUrl: string): string {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12)
  const key = `demo.${hash}.gif`
  log(`Uploading to s3://${bucket}/${key}…`)
  const put = spawnSync('aws', [
    's3api', 'put-object',
    '--bucket', bucket, '--key', key, '--body', file,
    '--content-type', 'image/gif',
    '--cache-control', 'public, max-age=31536000, immutable',
    '--if-none-match', '*',
  ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })
  if (put.status !== 0) {
    if (!put.stderr.includes('PreconditionFailed')) throw new Error(`aws s3api put-object failed:\n${put.stderr}`)
    log(`${key} is already published — identical content.`)
  }
  return `${baseUrl}/${key}`
}

function pointReadmeAt(url: string): void {
  const readme = fs.readFileSync(README, 'utf8')
  if (!README_GIF_URL.test(readme)) {
    err(`README.md has no static.traceroost.com demo GIF link to update — add ${url} by hand.`)
    return
  }
  fs.writeFileSync(README, readme.replace(README_GIF_URL, url))
  log(`Pointed README.md at ${url} — commit it to publish the new GIF.`)
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

  // Resolved before recording so a missing stack or credential fails in seconds, not after
  // a full tour.
  let bucket = ''
  let baseUrl = ''
  if (UPLOAD) {
    for (const cmd of ['aws', 'pulumi']) {
      if (!haveCommand(cmd)) {
        err(`${cmd} is not on PATH — required to upload the GIF. Pass --no-upload to only write it locally.`)
        process.exit(1)
      }
    }
    try {
      bucket = staticStackOutput('bucketName')
      baseUrl = staticStackOutput('url')
    } catch (e) {
      err(String(e instanceof Error ? e.message : e))
      process.exit(1)
    }
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
    log(`Building the standalone bundle (node esbuild.js --production --edition=${EDITION})…`)
    const build = spawnSync(process.execPath, [path.join(__dirname, '..', 'esbuild.js'), '--production', `--edition=${EDITION}`], {
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
      ...(OUTCOMES ? ['--demo-repo', path.join(scratchRoot, 'pethaven'), '--backdate-min', '5'] : []),
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

    let scratchGif: string | undefined
    for (const [i, decimate] of DECIMATE_LADDER.entries()) {
      log(`Converting ${videoPath} → GIF (${decimate})…`)
      const gif = encodeGif(videoPath, scratchRoot, decimate)
      const mb = (fs.statSync(gif).size / 1024 / 1024).toFixed(2)
      if (fs.statSync(gif).size <= MAX_BYTES) { scratchGif = gif; break }
      log(`${mb} MB is over the ${MAX_BYTES / 1024 / 1024} MB budget${i < DECIMATE_LADDER.length - 1 ? ' — dropping more near-duplicate frames' : ''}.`)
    }
    if (!scratchGif) {
      throw new Error(`could not get the GIF under ${MAX_BYTES / 1024 / 1024} MB — try a higher --speed, a lower --fps, or a larger --max-mb`)
    }

    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.copyFileSync(scratchGif, OUT)
    const sizeKb = (fs.statSync(OUT).size / 1024).toFixed(0)
    log(`Wrote ${OUT} (${sizeKb} KB).`)

    if (UPLOAD) {
      const url = upload(OUT, bucket, baseUrl)
      log(`Published ${url}`)
      pointReadmeAt(url)
    }
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
