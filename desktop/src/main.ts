/**
 * The desktop shell's main process: work out who owns the data dir, keep collection running, and
 * put a menu bar item and one window around the dashboard the collector already serves.
 *
 * The order of startup matters and is the opposite of what a GUI app usually does. Nothing is
 * shown until the ownership question is settled, because every visible control depends on the
 * answer — a window that offered "Stop Collection" before the shell knew it was attached to
 * someone else's background service would be offering to do something it must not do.
 *
 * What this file deliberately does not do:
 *  - it registers no launchd job. "Launch at Login" registers *this app*, through the OS login
 *    item API, and never a second collector: the existing `traceroost service install` job is a
 *    separately managed thing that this app attaches to, not something it duplicates or rewrites.
 *  - it enables no crash reporter and sends nothing anywhere. Electron's crashReporter is left
 *    unstarted, so there is no upload path to configure wrongly.
 *  - it exposes no IPC to the page. See window.ts.
 */

import { app, dialog, Menu, powerMonitor, shell } from 'electron'
import { execFile } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import { readServiceConfig } from '../../src/serviceConfig'
import { detectPortOwner } from '../../src/portResolver'
import { isPidAlive } from '../../standalone/dataDirLock'
import { OwnedCollector, type CollectorState } from './collector'
import { dashboardTarget } from './dashboardUrl'
import { describeVerdict, inspectCollector, type HandshakeEnv } from './handshake'
import { openDesktopLog } from './logs'
import { describeMode, resolveMode, type ShellMode } from './mode'
import { assertRuntimeSupportsCollector, resolveCollectorResources } from './resources'
import { createTray, type TrayController } from './tray'
import { buildMenuModel } from './trayMenu'
import { createDashboardWindow } from './window'
import * as fs from 'fs'
import type { BrowserWindow } from 'electron'

// ── Single instance ──────────────────────────────────────────────────────────
//
// Taken before anything else. A second launch must not get as far as the handshake, let alone
// spawning a collector that the first instance's lock would refuse — it should simply surface the
// window that already exists.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

const config = readServiceConfig()
const dataDir = process.env.DATA_DIR ?? config.dataDir
const log = openDesktopLog(dataDir)

let collector: OwnedCollector | undefined
let shellMode: ShellMode = { mode: 'wait', detail: 'starting up', retryInMs: 0 }
let tray: TrayController | undefined
let win: BrowserWindow | undefined
let quitting = false
let gitAvailable = true

function handshakeEnv(): HandshakeEnv {
  return {
    readFile: p => { try { return fs.readFileSync(p, 'utf-8') } catch { return undefined } },
    mtimeMs: p => { try { return fs.statSync(p).mtimeMs } catch { return undefined } },
    hostname: os.hostname(),
    now: Date.now,
    isPidAlive,
    probeOtlpOwner: detectPortOwner,
  }
}

// ── Status plumbing ──────────────────────────────────────────────────────────

function collectorState(): CollectorState {
  return collector?.current() ?? { status: 'stopped' }
}

function refreshTray(): void {
  if (!tray) return
  tray.update(buildMenuModel({
    shell: shellMode,
    collector: collectorState(),
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    version: resources.version,
  }))
}

function setMode(next: ShellMode): void {
  shellMode = next
  log.write(`[desktop] mode: ${next.mode} — ${describeMode(next)}`)
  refreshTray()
}

// ── Resources and runtime ────────────────────────────────────────────────────

const resources = (() => {
  try {
    assertRuntimeSupportsCollector(process.versions.node)
    return resolveCollectorResources({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      devRoot: path.join(__dirname, '..'),
    })
  } catch (err) {
    // Nothing can work without the collector, and a dialog is the only place a user who launched
    // from the Dock would ever see why.
    const message = err instanceof Error ? err.message : String(err)
    log.write(`[desktop] cannot start: ${message}`)
    app.whenReady().then(() => {
      dialog.showErrorBox('TraceRoost cannot start', message)
      app.exit(1)
    }).catch(() => app.exit(1))
    throw err
  }
})()

// ── Ownership ────────────────────────────────────────────────────────────────

/**
 * Runs the handshake and acts on it. Re-entrant: the transient verdicts schedule another pass, and
 * sleep/wake and a collector exit both come back through here.
 */
async function settleOwnership(): Promise<void> {
  const verdict = await inspectCollector(dataDir, resources.version, handshakeEnv())
  log.write(`[desktop] handshake: ${describeVerdict(verdict)}`)
  const resolved = resolveMode(verdict)

  if (resolved.mode === 'wait') {
    setMode(resolved)
    setTimeout(() => { void settleOwnership() }, resolved.retryInMs)
    return
  }
  if (resolved.mode === 'own') {
    setMode(resolved)
    await startOwnedCollector()
    return
  }
  setMode(resolved)
  if (resolved.mode === 'attach' && showWindowWhenReady) openWindowFor(resolved.identity.uiPort)
}

async function startOwnedCollector(): Promise<void> {
  if (!collector) {
    collector = new OwnedCollector({
      serverScript: resources.serverScript,
      execPath: process.execPath,
      dataDir,
      log: log.write,
      logStream: log.stream,
    })
    collector.onStateChange(state => {
      refreshTray()
      if (state.status === 'running' && win === undefined && showWindowWhenReady) openWindowFor(state.uiPort)
    })
  }
  try {
    const state = await collector.start()
    if (state.status === 'running' && showWindowWhenReady) openWindowFor(state.uiPort)
  } catch (err) {
    log.write(`[desktop] the collector could not be started: ${err instanceof Error ? err.message : String(err)}`)
    refreshTray()
  }
}

/**
 * Whether becoming ready should also show the dashboard.
 *
 * False when macOS started the app as a login item: the point of Launch at Login is that
 * collection begins, not that a window appears over whatever the user is doing on a fresh login.
 * (Electron's old `openAsHidden` setting, which used to express this, was removed in Electron 34;
 * `wasOpenedAtLogin` is what remains, and it is the better signal anyway — it reports what
 * actually happened rather than what was requested.)
 *
 * Also cleared around a tray-driven Start/Restart, so a background restart does not steal focus.
 */
let showWindowWhenReady = !app.getLoginItemSettings().wasOpenedAtLogin

// ── Window ───────────────────────────────────────────────────────────────────

function openWindowFor(uiPort: number): void {
  if (win) {
    win.show()
    win.focus()
    return
  }
  const target = dashboardTarget({ uiPort, bindHost: config.bindHost, authToken: config.authToken })
  win = createDashboardWindow({
    initialUrl: target.initialUrl,
    origin: target.origin,
    log: log.write,
    isQuitting: () => quitting,
    onCloseRequested: () => {
      // Close-to-menu-bar: collection and the tray stay up.
      win?.hide()
      if (process.platform === 'darwin') app.dock?.hide()
      log.write('[desktop] window closed — collection continues in the menu bar')
    },
  })
  win.on('closed', () => { win = undefined })
  if (process.platform === 'darwin') void app.dock?.show()
}

function currentUiPort(): number | undefined {
  if (shellMode.mode === 'attach') return shellMode.identity.uiPort
  const state = collectorState()
  return state.status === 'running' ? state.uiPort : undefined
}

function openDashboard(): void {
  const port = currentUiPort()
  if (port === undefined) {
    log.write('[desktop] Open Dashboard with nothing serving it — ignored')
    return
  }
  openWindowFor(port)
}

// ── Git ──────────────────────────────────────────────────────────────────────

/**
 * Git is what the commit-outcome half of the dashboard needs; collection itself does not. So this
 * is detected and reported, never allowed to block startup — a machine with no Git still records
 * every session, it just cannot say what landed.
 */
function detectGit(): void {
  execFile('git', ['--version'], { timeout: 5_000 }, err => {
    gitAvailable = !err
    if (!gitAvailable) {
      log.write('[desktop] git was not found on PATH — sessions are still recorded, but commit outcomes are unavailable until Git is installed')
    }
    refreshTray()
  })
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

app.on('second-instance', () => {
  log.write('[desktop] a second launch was folded into this instance')
  const port = currentUiPort()
  if (port !== undefined) openWindowFor(port)
  else { win?.show(); win?.focus() }
})

// Dock click / reopen. On macOS this fires with no windows open, which is exactly the
// close-to-menu-bar case: bring the dashboard back.
app.on('activate', () => openDashboard())

// Closing the window must not end the app — that is what makes it a menu bar app.
app.on('window-all-closed', () => { /* stay running in the menu bar */ })

app.whenReady().then(async () => {
  // No application menu beyond the standard edit menu would leave ⌘Q and copy/paste dead in the
  // dashboard window; the default template is built from Electron's own roles.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))

  tray = createTray(path.join(__dirname, '..', 'build'), {
    'open-dashboard': () => openDashboard(),
    start: () => { showWindowWhenReady = false; void startOwnedCollector() },
    stop: () => { void collector?.stop().catch(e => log.write(`[desktop] stop failed: ${String(e)}`)) },
    restart: () => { showWindowWhenReady = false; void collector?.restart().catch(e => log.write(`[desktop] restart failed: ${String(e)}`)) },
    attach: () => confirmAttach(),
    'open-logs': () => { void shell.openPath(log.filePath) },
    'launch-at-login': () => toggleLaunchAtLogin(),
    about: () => showAbout(),
    quit: () => app.quit(),
  })
  refreshTray()

  detectGit()

  // Sleep/wake. A laptop that slept for a day wakes with its collector either fine or gone (the
  // data-dir lock's heartbeat can also have lapsed past the remote-stale window if the dir is on
  // network storage). Re-running the handshake is the cheap, correct answer in every case.
  powerMonitor.on('resume', () => {
    log.write('[desktop] woke from sleep — re-checking the collector')
    if (collectorState().status === 'running' || shellMode.mode === 'attach') {
      void settleOwnership()
    }
  })

  await settleOwnership()
}).catch(err => {
  log.write(`[desktop] startup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
})

function confirmAttach(): void {
  if (shellMode.mode !== 'confirm-attach') return
  const { identity, question } = shellMode
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Use It', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Use the collector that is already running?',
    detail: `${question}\n\nTraceRoost will show its dashboard and leave it running. Quitting this app will not stop it.`,
  })
  if (choice !== 0) return
  setMode({ mode: 'attach', identity })
  openWindowFor(identity.uiPort)
}

function toggleLaunchAtLogin(): void {
  const next = !app.getLoginItemSettings().openAtLogin
  // There is no "open hidden" option any more (removed in Electron 34). Coming up without a
  // window is handled at startup instead, from `wasOpenedAtLogin` — see showWindowWhenReady.
  app.setLoginItemSettings({ openAtLogin: next })
  log.write(`[desktop] launch at login ${next ? 'enabled' : 'disabled'}`)
  refreshTray()
}

function showAbout(): void {
  const state = collectorState()
  const lines = [
    `Version ${resources.version}`,
    `Runtime Electron ${process.versions.electron}, Node ${process.versions.node}`,
    `Data directory ${dataDir}`,
    `Mode ${shellMode.mode === 'attach' ? 'attached to a collector this app does not manage' : shellMode.mode === 'own' ? 'running its own collector' : shellMode.mode}`,
    `Collector ${state.status}`,
    `Git ${gitAvailable ? 'available' : 'not found — commit outcomes unavailable'}`,
  ]
  dialog.showMessageBox({ type: 'info', message: 'TraceRoost', detail: lines.join('\n'), buttons: ['OK'] }).catch(() => { /* dismissed */ })
}

// ── Quit ─────────────────────────────────────────────────────────────────────
//
// In owned mode, quitting means flushing: closing the collector's stdin runs its shutdown handler,
// which writes spans.json and the outcomes cache before exiting, and `before-quit` is where there
// is still time to wait for it. In attached mode there is nothing of ours to stop and the other
// collector is left alone — the window and the menu bar item go away and collection carries on.
app.on('before-quit', event => {
  if (quitting) return
  if (!collector?.isOwning()) {
    quitting = true
    log.write(shellMode.mode === 'attach'
      ? '[desktop] quitting — the attached collector keeps running'
      : '[desktop] quitting')
    log.close()
    return
  }
  event.preventDefault()
  quitting = true
  log.write('[desktop] quitting — stopping and flushing the collector first')
  collector.stop()
    .catch(err => log.write(`[desktop] the collector did not stop cleanly: ${String(err)}`))
    .finally(() => { log.close(); app.quit() })
})
