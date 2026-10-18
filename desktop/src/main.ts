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
 *  - on Linux, it never runs unsandboxed (sandbox.ts), never leaves collection running behind a
 *    tray icon the desktop cannot show (trayHost.ts, closeBehavior.ts), and never races an
 *    enabled `traceroost service install` systemd unit for the data dir (systemdUnit.ts).
 *  - it never stops its collector with a signal it cannot be sure is handled: the stop request is
 *    the owner channel's message (collector.ts, standalone/ownerChannel.ts), which is what makes
 *    owned mode possible on Windows, where `kill` is TerminateProcess.
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
import { createTray, menuTemplate, type TrayController, type TrayHandlers } from './tray'
import { buildMenuModel } from './trayMenu'
import { createDashboardWindow } from './window'
import { autostartDir, LAUNCHED_AT_LOGIN_ARG, launchCommand, LinuxAutostart } from './autostart'
import { inspectLauncherEntry, launcherPaths, renderLauncherEntry, shouldOfferLauncher } from './appImageLauncher'
import { closeQuestion, decideCloseAction, decideStartupWindow } from './closeBehavior'
import { PrefsStore } from './prefs'
import { sandboxRefusal } from './sandbox'
import { decideWhenDirIsFree, isEnabled as isUnitEnabled, readUnitState } from './systemdUnit'
import { detectTrayHost, type TrayHost } from './trayHost'
import { isQuitRequest, windowsLoginItem } from './windows'
import * as fs from 'fs'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'

// ── Single instance ──────────────────────────────────────────────────────────
//
// Taken before anything else. A second launch must not get as far as the handshake, let alone
// spawning a collector that the first instance's lock would refuse — it should simply surface the
// window that already exists.
//
// `--quit` (windows.ts) is a message to the instance that already exists, never a launch of its
// own: with no instance running there is nothing to quit, so it exits either way.
if (!app.requestSingleInstanceLock()) {
  // Said on stderr: the desktop log is not open yet, and a launch that ends here otherwise leaves
  // no trace of why.
  if (!isQuitRequest(process.argv)) console.error('[desktop] another TraceRoost is running (or its single-instance lock in userData could not be taken) — handing over to it')
  app.exit(0)
} else if (isQuitRequest(process.argv)) {
  app.exit(0)
}

// Windows groups taskbar entries and notifications by this id; the installer's Start Menu
// shortcut carries the same one (electron-builder sets it from appId).
if (process.platform === 'win32') app.setAppUserModelId('com.traceroost.desktop')

// ── Sandbox ──────────────────────────────────────────────────────────────────
//
// Checked before anything is started. The only way this process sees --no-sandbox is an
// AppImage launcher that could not get the sandbox working (or a user passing it), and the
// dashboard renders untrusted agent output — so the answer is a clear refusal, not a degraded
// start. See sandbox.ts. Nothing below starts a collector, tray or window while this is set.
const startupRefusal = sandboxRefusal({
  platform: process.platform,
  noSandbox: app.commandLine.hasSwitch('no-sandbox') || process.argv.includes('--no-sandbox'),
  appImage: process.env.APPIMAGE,
})

const config = readServiceConfig()
const dataDir = process.env.DATA_DIR ?? config.dataDir
const log = openDesktopLog(dataDir)

let collector: OwnedCollector | undefined
let shellMode: ShellMode = { mode: 'wait', detail: 'starting up', retryInMs: 0 }
let tray: TrayController | undefined
/** The tray's click handlers; on Linux, also the window menu bar's. Set once the app is ready. */
let trayHandlers: TrayHandlers | undefined
let win: BrowserWindow | undefined
let quitting = false
let gitAvailable = true
const startedAt = Date.now()
const isLinux = process.platform === 'linux'
const isWindows = process.platform === 'win32'
/** Linux and Windows put the app's controls in the window's own menu bar too (macOS has the
 *  global menu bar and the menu bar item). */
const hasWindowMenuBar = process.platform !== 'darwin'
/** Linux only: whether the desktop can show the tray icon. Unknown until checked at startup, and
 *  re-checked on each window close. Always true elsewhere. */
let trayHost: TrayHost = isLinux ? { available: false, reason: 'not checked yet' } : { available: true, via: 'platform' }
const prefs = new PrefsStore(app.getPath('userData'))

/** Started by the login launch: macOS reports it; Linux's autostart entry and the Windows Run key
 *  pass the marker. */
const launchedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin || process.argv.includes(LAUNCHED_AT_LOGIN_ARG)

// ── Login launch ─────────────────────────────────────────────────────────────
//
// macOS uses the OS login-item API. Linux has none that Electron implements, so the shell manages
// an XDG autostart entry of its own — see autostart.ts for the rules.
const linuxAutostart = isLinux
  ? new LinuxAutostart(
      autostartDir(process.env, os.homedir()),
      launchCommand({ execPath: process.execPath, isPackaged: app.isPackaged, appPath: app.getAppPath(), appImage: process.env.APPIMAGE }),
      {
        readFile: p => { try { return fs.readFileSync(p, 'utf-8') } catch { return undefined } },
        writeFile: (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, { mode: 0o644 }) },
        remove: p => fs.rmSync(p, { force: true }),
      },
    )
  : undefined

// Windows: the HKCU Run value, matched on this copy's path and the login marker (windows.ts).
const windowsLoginItemFor = isWindows
  ? windowsLoginItem(launchCommand({ execPath: process.execPath, isPackaged: app.isPackaged, appPath: app.getAppPath(), appImage: undefined }))
  : undefined

function launchAtLoginEnabled(): boolean {
  if (linuxAutostart) return linuxAutostart.isEnabled()
  if (windowsLoginItemFor) return app.getLoginItemSettings(windowsLoginItemFor).openAtLogin
  return app.getLoginItemSettings().openAtLogin
}

// ── AppImage launcher entry ──────────────────────────────────────────────────
const appImagePath = isLinux ? process.env.APPIMAGE : undefined
const appImageLauncher = appImagePath ? launcherPaths(process.env, os.homedir()) : undefined

function appImageLauncherState() {
  if (!appImagePath || !appImageLauncher) return undefined
  let text: string | undefined
  try { text = fs.readFileSync(appImageLauncher.entry, 'utf-8') } catch { text = undefined }
  return inspectLauncherEntry(text, appImagePath)
}

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
  if (!tray && !hasWindowMenuBar) return
  const launcher = appImageLauncherState()
  const model = buildMenuModel({
    shell: shellMode,
    collector: collectorState(),
    launchAtLogin: launchAtLoginEnabled(),
    version: resources.version,
    inApplicationsMenu: launcher === undefined ? undefined : launcher === 'current' || launcher === 'stale',
  })
  tray?.update(model)
  // On Linux (and Windows) the same controls also live in the window's menu bar: on a Linux desktop
  // with no tray it is the only place they can be.
  if (hasWindowMenuBar && trayHandlers) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '&TraceRoost', submenu: menuTemplate(model, trayHandlers) },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ] satisfies MenuItemConstructorOptions[]))
  }
}

function setMode(next: ShellMode): void {
  shellMode = next
  log.write(`[desktop] mode: ${next.mode} — ${describeMode(next)}`)
  refreshTray()
  if (!trayHost.available) actWithoutTray(next)
}

/**
 * With no tray, the two modes that would otherwise only be reported in the tray menu have to be
 * put in front of the user, or the app would be running with nothing visible at all: a collector
 * that needs confirming is asked about straight away, and a blocked start explains itself and
 * quits (there is nothing of ours running to keep the app open for).
 */
function actWithoutTray(next: ShellMode): void {
  if (next.mode === 'confirm-attach') {
    if (!confirmAttach()) app.quit()
    return
  }
  if (next.mode === 'blocked' && win === undefined) {
    dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Quit'],
      message: 'TraceRoost is not collecting',
      detail: `${next.detail}\n\nDetails are in ${log.filePath}.`,
    })
    app.quit()
  }
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
  if (resolved.mode === 'own' && isLinux) {
    // An enabled systemd user unit is about to start (or is starting) a collector of its own; let
    // it, and attach once it holds the dir. See systemdUnit.ts for the table.
    const unit = await readUnitState()
    const decision = decideWhenDirIsFree(unit, { launchedAtLogin, sinceStartMs: Date.now() - startedAt })
    if (unit) log.write(`[desktop] systemd user unit: load=${unit.load} file=${unit.unitFile} active=${unit.active} — ${decision.action}: ${decision.reason}`)
    if (decision.action === 'wait') {
      setMode({ mode: 'wait', detail: decision.reason, retryInMs: 2_000 })
      setTimeout(() => { void settleOwnership() }, 2_000)
      return
    }
  }
  if (resolved.mode === 'own') {
    // On every OS, Windows included: the stop request is the owner channel's message, which the
    // collector honours with the same flush as SIGTERM (OwnedCollector.stop).
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
 * On Linux the autostart entry passes LAUNCHED_AT_LOGIN_ARG instead, and with no tray a login
 * launch still shows a (minimised) window — see decideStartupWindow.
 *
 * Also cleared around a tray-driven Start/Restart, so a background restart does not steal focus.
 */
let showWindowWhenReady = !launchedAtLogin
/** Linux login launch with no tray: the window comes up minimised instead of not at all. */
let startMinimized = false

// ── Tray assets ──────────────────────────────────────────────────────────────
//
// In development the template icons are read straight from desktop/build. Packaged, that
// directory is electron-builder's buildResources (the app icon source and the entitlements) and
// is deliberately left out of the app, so the two PNGs travel as extraResources instead —
// electron-builder.cjs puts them at <Resources>/tray, and scripts/afterPack.cjs checks
// they arrived.
const trayAssetDir = app.isPackaged
  ? path.join(process.resourcesPath, 'tray')
  : path.join(__dirname, '..', 'build')

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
    onCloseRequested: () => { void handleCloseRequested() },
    iconPath: isLinux ? path.join(trayAssetDir, 'iconLinux.png') : undefined,
    startMinimized,
  })
  startMinimized = false
  win.on('closed', () => { win = undefined })
  // Windows log-off / shutdown: the system ends this session without a Quit, and terminates the
  // collector (which has no window to be told through). Ask it to flush now; it saves in well under
  // a second. Without the window this never fires — the collector then still flushes when this
  // process goes and its owner channel closes, if Windows has not ended it first.
  win.on('session-end', () => {
    log.write('[desktop] Windows is ending the session — asking the collector to flush now')
    collector?.requestStopNow()
  })
  if (process.platform === 'darwin') void app.dock?.show()
}

function owningCollection(): boolean {
  const status = collectorState().status
  return shellMode.mode === 'own' && (status === 'running' || status === 'starting' || status === 'restarting')
}

/** The window's close button. See closeBehavior.ts: hide to the tray where there is one; on a
 *  Linux desktop with none, quit when nothing of ours is collecting and ask when something is. */
async function handleCloseRequested(): Promise<void> {
  if (isLinux) trayHost = await detectTrayHost(process.env)
  const action = decideCloseAction({ platform: process.platform, trayAvailable: trayHost.available, owningCollection: owningCollection() })
  if (action === 'hide-to-tray') {
    // Close-to-menu-bar: collection and the tray stay up.
    win?.hide()
    if (process.platform === 'darwin') app.dock?.hide()
    log.write('[desktop] window closed — collection continues in the menu bar')
    return
  }
  if (action === 'quit') {
    log.write('[desktop] window closed with no tray to keep running in, and nothing of ours collecting — quitting')
    app.quit()
    return
  }
  let choice = prefs.read().closeWithoutTray
  if (choice === undefined) {
    const q = closeQuestion(process.env.XDG_CURRENT_DESKTOP)
    const options = {
      type: 'question' as const,
      message: q.message,
      detail: q.detail,
      buttons: q.buttons,
      defaultId: 1,
      cancelId: 2,
      checkboxLabel: q.checkboxLabel,
    }
    const answer = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
    if (answer.response === 2) return
    choice = answer.response === 0 ? 'quit' : 'minimize'
    if (answer.checkboxChecked) prefs.update({ closeWithoutTray: choice })
  }
  if (choice === 'quit') {
    log.write('[desktop] window closed with no tray — quitting, which stops collection')
    app.quit()
  } else {
    log.write('[desktop] window closed with no tray — minimised, collection continues')
    win?.minimize()
  }
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

app.on('second-instance', (_event, argv) => {
  if (isQuitRequest(argv)) {
    // From the installer/uninstaller (build/installer.nsh) or a user's `--quit`. Once only: a
    // repeated Quit while the collector is flushing must not cut the flush short.
    log.write('[desktop] a second launch asked this instance to quit')
    if (!quitting) app.quit()
    return
  }
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
  if (startupRefusal) {
    log.write(`[desktop] refusing to start: ${startupRefusal.title}`)
    dialog.showErrorBox(startupRefusal.title, startupRefusal.message)
    log.close()
    app.exit(1)
    return
  }

  // No application menu beyond the standard edit menu would leave ⌘Q and copy/paste dead in the
  // dashboard window; the default template is built from Electron's own roles. (Linux gets its own
  // menu bar from refreshTray, with the app's controls in it.)
  if (!hasWindowMenuBar) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]))
  }

  trayHandlers = {
    'open-dashboard': () => openDashboard(),
    start: () => { showWindowWhenReady = false; void startOwnedCollector() },
    stop: () => { void collector?.stop().catch(e => log.write(`[desktop] stop failed: ${String(e)}`)) },
    restart: () => { showWindowWhenReady = false; void collector?.restart().catch(e => log.write(`[desktop] restart failed: ${String(e)}`)) },
    attach: () => { confirmAttach() },
    'open-logs': () => { void shell.openPath(log.filePath) },
    'launch-at-login': () => { void toggleLaunchAtLogin() },
    'applications-menu': () => toggleApplicationsMenu(),
    about: () => showAbout(),
    quit: () => app.quit(),
  }

  if (isLinux) {
    trayHost = await detectTrayHost(process.env)
    log.write(`[desktop] tray: ${trayHost.available ? `available (via ${trayHost.via})` : `unavailable — ${trayHost.reason}`}; desktop ${process.env.XDG_CURRENT_DESKTOP ?? 'unknown'}, session ${process.env.XDG_SESSION_TYPE ?? 'unknown'}`)
    const startup = decideStartupWindow({ platform: process.platform, launchedAtLogin, trayAvailable: trayHost.available })
    showWindowWhenReady = startup !== 'none'
    startMinimized = startup === 'minimized'
    const repaired = linuxAutostart?.repair()
    if (repaired) log.write(`[desktop] launch at login pointed at ${repaired.repairedFrom ?? 'an unknown program'} — repointed at this copy`)
    repairAppImageLauncher()
  }

  // Created even when the Linux check found no tray host: a host can appear later (the GNOME
  // AppIndicator extension being switched on), and an icon with no host is simply not drawn.
  tray = createTray(trayAssetDir, trayHandlers)
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

  // Asked only once collection is under way, and without blocking it: the question is about a
  // menu entry, and must not stand between a first launch and recording anything.
  if (isLinux) void offerAppImageLauncher()
}).catch(err => {
  log.write(`[desktop] startup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
})

/** Returns whether the user chose to attach. */
function confirmAttach(): boolean {
  if (shellMode.mode !== 'confirm-attach') return false
  const { identity, question } = shellMode
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Use It', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Use the collector that is already running?',
    detail: `${question}\n\nTraceRoost will show its dashboard and leave it running. Quitting this app will not stop it.`,
  })
  if (choice !== 0) return false
  setMode({ mode: 'attach', identity })
  openWindowFor(identity.uiPort)
  return true
}

async function toggleLaunchAtLogin(): Promise<void> {
  const next = !launchAtLoginEnabled()
  if (linuxAutostart) {
    const state = linuxAutostart.setEnabled(next)
    if (state.kind === 'foreign') {
      void dialog.showMessageBox({
        type: 'info',
        message: 'Launch at Login is managed by another file',
        detail: `${linuxAutostart.filePath} exists but was not written by TraceRoost, so TraceRoost has left it alone. Edit or remove it to change what starts at login.`,
      })
    } else if (next) {
      // One startup path for the collector: with the service enabled, the app attaches to it at
      // login rather than starting its own, so the two can be on together. Say so.
      const unit = await readUnitState()
      if (unit && isUnitEnabled(unit)) {
        void dialog.showMessageBox({
          type: 'info',
          message: 'The TraceRoost background service also starts at login',
          detail: 'The systemd user service you installed with `traceroost service install` starts collecting at login. TraceRoost will open its dashboard and use that collector rather than start a second one.',
        })
      }
    }
    log.write(`[desktop] launch at login ${linuxAutostart.isEnabled() ? 'enabled' : 'disabled'} (${linuxAutostart.filePath})`)
    refreshTray()
    return
  }
  if (windowsLoginItemFor) {
    app.setLoginItemSettings({ openAtLogin: next, ...windowsLoginItemFor })
    log.write(`[desktop] launch at login ${next ? 'enabled' : 'disabled'} (HKCU Run: ${windowsLoginItemFor.path})`)
    refreshTray()
    return
  }
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
    ...(isLinux ? [`Tray ${trayHost.available ? 'available' : `not available (${trayHost.reason})`}`] : []),
  ]
  dialog.showMessageBox({ type: 'info', message: 'TraceRoost', detail: lines.join('\n'), buttons: ['OK'] }).catch(() => { /* dismissed */ })
}

// ── AppImage launcher entry ──────────────────────────────────────────────────
//
// Offered once, on the first run of an AppImage; written only on a yes. See appImageLauncher.ts.

function writeAppImageLauncher(): void {
  if (!appImagePath || !appImageLauncher) return
  fs.mkdirSync(path.dirname(appImageLauncher.icon), { recursive: true })
  fs.copyFileSync(path.join(trayAssetDir, 'iconLinux.png'), appImageLauncher.icon)
  fs.mkdirSync(path.dirname(appImageLauncher.entry), { recursive: true })
  fs.writeFileSync(appImageLauncher.entry, renderLauncherEntry(appImagePath), { mode: 0o644 })
}

function removeAppImageLauncher(): void {
  if (!appImageLauncher) return
  fs.rmSync(appImageLauncher.entry, { force: true })
  fs.rmSync(appImageLauncher.icon, { force: true })
}

function repairAppImageLauncher(): void {
  if (appImageLauncherState() !== 'stale') return
  try {
    writeAppImageLauncher()
    log.write(`[desktop] applications menu entry repointed at ${appImagePath}`)
  } catch (err) {
    log.write(`[desktop] could not update the applications menu entry: ${String(err)}`)
  }
}

async function offerAppImageLauncher(): Promise<void> {
  const state = appImageLauncherState()
  if (state === undefined) return
  if (!shouldOfferLauncher({ appImage: appImagePath, answered: prefs.read().appImageLauncher, state })) return
  const { response: choice } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Add to Applications Menu', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Add TraceRoost to your applications menu?',
    detail: `TraceRoost is running from ${appImagePath}. Adding it puts a launcher entry and icon in your home directory (~/.local/share) so you can start it like any other app. You can change this later from the TraceRoost menu.`,
  })
  if (choice === 0) {
    try {
      writeAppImageLauncher()
      prefs.update({ appImageLauncher: 'added' })
      log.write(`[desktop] added an applications menu entry at ${appImageLauncher?.entry}`)
    } catch (err) {
      log.write(`[desktop] could not add the applications menu entry: ${String(err)}`)
    }
  } else {
    prefs.update({ appImageLauncher: 'declined' })
  }
  refreshTray()
}

function toggleApplicationsMenu(): void {
  const state = appImageLauncherState()
  if (state === undefined) return
  try {
    if (state === 'current' || state === 'stale') {
      removeAppImageLauncher()
      prefs.update({ appImageLauncher: 'declined' })
      log.write('[desktop] removed the applications menu entry')
    } else if (state === 'absent') {
      writeAppImageLauncher()
      prefs.update({ appImageLauncher: 'added' })
      log.write(`[desktop] added an applications menu entry at ${appImageLauncher?.entry}`)
    }
  } catch (err) {
    log.write(`[desktop] could not change the applications menu entry: ${String(err)}`)
  }
  refreshTray()
}

// ── Signals ──────────────────────────────────────────────────────────────────
//
// SIGTERM and SIGINT become an ordinary Quit. Without this, Node's default for either is an
// immediate exit that skips `before-quit` — the collector child would be orphaned, still holding
// the data-dir lock and still writing, which is exactly the second-writer situation the ownership
// handshake exists to prevent. With it, `kill <pid>`, Ctrl-C on `electron .`, and a supervisor's
// stop all take the same flush-then-exit path as ⌘Q. (macOS logout and the Dock's Quit send an
// Apple Event, which Electron already routes through app.quit().)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.write(`[desktop] received ${signal} — quitting`)
    app.quit()
  })
}

// ── Quit ─────────────────────────────────────────────────────────────────────
//
// In owned mode, quitting means flushing: the collector's SIGTERM handler writes spans.json and
// the outcomes cache before exiting, and `before-quit` is where there is still time to wait for
// it. In attached mode there is nothing of ours to stop and the other collector is left alone —
// the window and the menu bar item go away and collection carries on.
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
