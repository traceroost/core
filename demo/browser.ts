#!/usr/bin/env node
/**
 * TraceRoost browser demo — opens a headed Chromium window and runs the replay
 * script in parallel so the dashboard populates live in front of you.
 *
 * Prerequisites:
 *   pnpm run local                   (OTLP + UI servers)
 *   npx playwright install chromium       (one-time, installs browser)
 *
 * Usage:
 *   pnpm run demo:show -- --scenario story          # 10-session petstore build-out
 *   pnpm run demo:show -- --scenario story --agents codex  # ...just its 3 Codex chapters
 *   pnpm run demo:show                    # open browser + replay all scenarios
 *   pnpm run demo:tour                    # also navigate between tabs automatically
 *   pnpm run demo:show -- --speed 4       # pass speed flag through to replay
 *   pnpm run demo:show -- --scenario loop --tour
 *   pnpm run demo:show -- --cdp           # reuse an already-open demo browser instead
 *                                          # of launching a new window (see below)
 *
 * The browser window stays open after replay finishes — close it manually
 * or press Ctrl+C in the terminal.
 *
 * --cdp: by default every run launches a brand new Chromium window. Pass --cdp to
 * instead attach over the Chrome DevTools Protocol to a browser this script itself
 * already launched with --cdp — no manual port-hunting needed, since it always uses
 * the same fixed CDP_PORT (override with --cdp-port). The first --cdp run finds
 * nothing listening yet, so it launches a fresh window anyway (with the debug port
 * open for next time); every run after that reuses the same window/tab. This can
 * only attach to a browser that was started with that debug port open — it can't
 * reach into an arbitrary already-running Chrome you didn't launch this way.
 */

import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as http from 'node:http'

// ── CLI ────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function flag(name: string, fallback: string): string {
  const i = args.indexOf('--' + name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const TOUR     = args.includes('--tour')
const UI_PORT  = parseInt(flag('ui-port', '3000')) || 3000
const OTLP_PORT = parseInt(flag('port', '4318')) || 4318
const SPEED    = flag('speed', '1')
const SCENARIO = flag('scenario', 'all')
const AGENTS   = flag('agents', '')
const CDP      = args.includes('--cdp')
const CDP_PORT = parseInt(flag('cdp-port', '9223')) || 9223

function log(msg: string) { process.stdout.write(`\x1b[35m[browser]\x1b[0m ${msg}\n`) }
function err(msg: string) { process.stderr.write(`\x1b[31m[browser]\x1b[0m ${msg}\n`) }

// ── Server health check ────────────────────────────────────────────────────────

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

// ── Replay child process ───────────────────────────────────────────────────────

function startReplay(): Promise<void> {
  return new Promise((resolve, reject) => {
    const replayArgs = [
      path.join(__dirname, 'replay.ts'),
      '--speed', SPEED,
      '--port', String(OTLP_PORT),
      '--scenario', SCENARIO,
      ...(AGENTS ? ['--agents', AGENTS] : []),
    ]
    log(`Starting replay: node demo/run-ts.js demo/replay.ts --speed ${SPEED} --scenario ${SCENARIO}${AGENTS ? ` --agents ${AGENTS}` : ''}`)
    const child = spawn(process.execPath, [path.join(__dirname, 'run-ts.js'), ...replayArgs], {
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: false,
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0 || code === null) resolve()
      else reject(new Error(`replay exited with code ${code}`))
    })
  })
}

// ── Guided tab tour ────────────────────────────────────────────────────────────

// The real top-level tab bar (media/src/App.tsx TABS) — sessions/analytics/patterns/
// export/import, selected via `button[data-tab="${id}"]`. The previous list here
// (efficiency/tokens/files/summaries/recommendations/errors/agents/timeline/traces/
// latency/tools/automation) didn't match any current `data-tab` value, so every
// step's isVisible() check silently failed and the tour clicked nothing at all —
// none of those are top-level tabs; most are sections *inside* Sessions' expand-in-
// place detail view or Analytics' scrolling page, and Automation/Alerts live in the
// Settings (gear) panel. See tourSessionDetail() and tourSettingsPanel() below for
// those.
const TOUR_TABS = [
  { id: 'sessions',  label: 'Sessions',  pauseMs: 3000 },
  { id: 'analytics', label: 'Analytics', pauseMs: 5000 },
  { id: 'patterns',  label: 'Advisor',   pauseMs: 5000 },
  { id: 'export',    label: 'Export',    pauseMs: 3000 },
  { id: 'import',    label: 'Import',    pauseMs: 3000 },
]

// Expands the most recent session (Sessions tab's expand-in-place row) and walks its
// internal Overview/Trace/Flow/Tools/Files nav — these are plain buttons with no
// data-tab attribute, so matched by accessible name instead. Counts like "Trace (12)"
// are appended dynamically, hence the regex match rather than exact text.
async function tourSessionDetail(page: import('playwright').Page, speed: number): Promise<void> {
  const rows = page.locator('#sessions-content table tbody tr')
  try {
    await rows.first().waitFor({ state: 'visible', timeout: 15000 })
  } catch {
    log('  (no sessions rendered yet — skipping session detail walkthrough)')
    return
  }

  log('  → expanding most recent session')
  await rows.first().click()
  await page.waitForTimeout(600 / speed)

  const sections: Array<{ name: RegExp; label: string }> = [
    { name: /^Overview$/, label: 'Overview' },
    { name: /^Trace/,     label: 'Trace' },
    { name: /^Flow/,      label: 'Flow' },
    { name: /^Tools/,     label: 'Tools' },
    { name: /^Files/,     label: 'Files' },
  ]
  const detail = page.locator('#sessions-content')
  for (const { name, label } of sections) {
    const btn = detail.getByRole('button', { name })
    const visible = await btn.first().isVisible().catch(() => false)
    if (!visible) continue
    await btn.first().click()
    log(`  → session detail: ${label} (2.5s)`)
    await page.waitForTimeout(2500 / speed)
  }

  // Collapse — click the same row again
  await rows.first().click()
  await page.waitForTimeout(300 / speed)
}

// Automation and Alerts aren't top-level tabs — they live in the Settings panel
// behind the gear icon (App.tsx GearButton, title is the stable selector since the
// button has no other data-* attribute).
async function tourSettingsPanel(page: import('playwright').Page, speed: number): Promise<void> {
  const gear = page.getByTitle('Settings — Alerts & Automation')
  const visible = await gear.isVisible().catch(() => false)
  if (!visible) return

  log('  → Settings panel (Alerts & Automation, 5s)')
  await gear.click()
  await page.waitForTimeout(5000 / speed)
  await gear.click() // close
  await page.waitForTimeout(300 / speed)
}

// ── Browser: launch fresh, or attach to an already-open one ────────────────────

// --cdp always targets the same fixed CDP_PORT, so there's nothing to hunt for: the
// first --cdp run finds no debug port open yet, falls through to launching a fresh
// browser (with that port now open), and every run after that attaches to it
// instead of opening a new window. Without --cdp, behavior is unchanged — a fresh
// window every time, no debug port exposed.
async function connectOrLaunch(chromium: import('playwright').BrowserType): Promise<{
  browser: import('playwright').Browser
  page: import('playwright').Page
  attached: boolean
}> {
  if (CDP) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 2000 })
      log(`Attached to existing browser on CDP port ${CDP_PORT}.`)
      const ctx = browser.contexts()[0] ?? await browser.newContext()
      const dashboardUrl = `http://localhost:${UI_PORT}`
      const existing = ctx.pages().find(p => p.url().startsWith(dashboardUrl))
      if (existing) {
        log('Reusing existing dashboard tab.')
        await existing.bringToFront()
        return { browser, page: existing, attached: true }
      }
      return { browser, page: await ctx.newPage(), attached: true }
    } catch {
      log(`No browser found on CDP port ${CDP_PORT} — launching a new one (left open on that port for next time).`)
    }
  }

  const browser = await chromium.launch({
    headless: false,
    args: CDP ? ['--start-maximized', `--remote-debugging-port=${CDP_PORT}`] : ['--start-maximized'],
  })
  const ctx = await browser.newContext({ viewport: null }) // null = use maximized window size
  return { browser, page: await ctx.newPage(), attached: false }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Preflight
  const uiAlive = await checkServer(UI_PORT)
  if (!uiAlive) {
    err(`Cannot reach dashboard at http://127.0.0.1:${UI_PORT}`)
    err('Start the standalone server first:  pnpm run local')
    process.exit(1)
  }

  // Dynamic import so a missing playwright gives a clear message
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

  log(`Opening dashboard at http://localhost:${UI_PORT}`)
  const { browser, page } = await connectOrLaunch(chromium)
  // In --cdp mode the whole point is leaving the browser open for the next run to
  // reuse — including the very first run, which launches it fresh with the debug
  // port on. Only close it on exit when we're not managing a --cdp-reusable window.
  const keepOpenOnExit = CDP

  await page.goto(`http://localhost:${UI_PORT}`)
  await page.waitForLoadState('domcontentloaded')
  log('Browser open. Starting replay in parallel…')

  // Kick off replay (don't await yet — let it run alongside the tour)
  const replayDone = startReplay().catch(e => {
    err(`Replay error: ${e.message}`)
  })

  if (TOUR) {
    log('Tour mode: navigating tabs as data arrives…')
    const speed = parseFloat(SPEED) || 1

    // Give the first batch of spans a moment to land before switching tabs
    await page.waitForTimeout(3000)

    for (const { id, label, pauseMs } of TOUR_TABS) {
      const btn = page.locator(`button[data-tab="${id}"]`)
      const visible = await btn.isVisible().catch(() => false)
      if (!visible) continue

      await btn.click()
      log(`  → ${label} tab (${pauseMs / 1000}s)`)
      await page.waitForTimeout(pauseMs / speed)

      // Sessions: also expand a card and walk its Overview/Trace/Flow/Tools/Files
      // detail nav — those live inside the row, not the top-level tab bar.
      if (id === 'sessions') await tourSessionDetail(page, speed)

      // Analytics is the natural point to also surface Automation/Alerts, which
      // live in the Settings (gear) panel rather than a tab of their own.
      if (id === 'analytics') await tourSettingsPanel(page, speed)
    }

    // Return to Sessions after the tour — the most useful default landing tab
    await page.locator('button[data-tab="sessions"]').click().catch(() => {})
    log('Tour complete — leaving browser open for exploration')
  } else {
    log('No --tour flag. Dashboard is live — explore tabs manually.')
    log(keepOpenOnExit ? 'Press Ctrl+C to exit — the browser stays open for the next --cdp run.' : 'Press Ctrl+C to close the browser and exit.')
  }

  await replayDone
  log('Replay finished. Browser stays open until you close it or press Ctrl+C.')

  // Keep the process alive so the browser stays open
  await new Promise<void>(resolve => {
    process.on('SIGINT', () => {
      if (keepOpenOnExit) { resolve(); return } // leave the CDP-debuggable browser running
      browser.close().finally(resolve)
    })
  })
}

main().catch(e => {
  err(String(e))
  process.exit(1)
})
