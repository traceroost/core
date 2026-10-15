/**
 * The dashboard window.
 *
 * The renderer gets no privileges at all: sandboxed, context-isolated, no Node integration, no
 * preload. That last one is the important one and it is a deliberate omission rather than an
 * oversight — a preload script is the only way IPC reaches a renderer, so not having one means
 * there is no channel for trace content to reach the main process through, and therefore nothing
 * to validate. The tray is where the app's own controls live, which is what makes that possible.
 *
 * Everything the window does with the outside world is decided in navigation.ts. Downloads are
 * refused: the dashboard's exports are served as ordinary responses by the local collector, and a
 * window that can write files chosen by page content is a surface this app does not need.
 */

import { BrowserWindow, shell, type WebContents } from 'electron'
import { decideNavigation, decideWindowOpen } from './navigation'

export interface DashboardWindowOptions {
  initialUrl: string
  /** The one origin allowed in this window. */
  origin: string
  log: (line: string) => void
  /** True once the app is actually quitting. Without this the close below would cancel the very
   *  close `app.quit()` performs on its way out, and the app would hang in a half-quit state:
   *  collector flushed and stopped, window still on screen, process never exiting. */
  isQuitting: () => boolean
  /** Called when the user closes the window. Collection keeps running; the app stays in the menu
   *  bar. The shell hides the window rather than destroying it so reopening is instant. */
  onCloseRequested: () => void
  /** The window's own icon (title bar, taskbar, Alt-Tab) on Windows and Linux. macOS takes the
   *  app icon from the bundle and ignores this, so it is left unset there. */
  iconPath?: string
}

export function createDashboardWindow(opts: DashboardWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'TraceRoost',
    backgroundColor: '#1e1e1e',
    ...(opts.iconPath === undefined ? {} : { icon: opts.iconPath }),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      // No preload: see the note above.
      spellcheck: false,
      // The dashboard is a local page; there is nothing to gain from letting it run an
      // out-of-process plugin or read the clipboard through experimental APIs.
      experimentalFeatures: false,
    },
  })

  hardenWebContents(win.webContents, opts.origin, opts.log)

  win.once('ready-to-show', () => win.show())

  // Close keeps the app alive in the menu bar (the plan's close-to-menu-bar requirement) — except
  // while quitting, when the close has to be allowed through for the app to exit at all.
  win.on('close', event => {
    if (opts.isQuitting()) return
    event.preventDefault()
    opts.onCloseRequested()
  })

  void win.loadURL(opts.initialUrl)
  return win
}

/** The navigation, popup and permission rules. Exported so a reload or a new window gets the same
 *  treatment, and so main.ts can apply it to any `web-contents-created`. */
export function hardenWebContents(contents: WebContents, origin: string, log: (line: string) => void): void {
  contents.on('will-navigate', (event, url) => {
    const decision = decideNavigation(url, origin)
    if (decision.action === 'allow-in-window') return
    event.preventDefault()
    if (decision.action === 'open-externally') {
      log(`[desktop] opening ${url} in the system browser`)
      void shell.openExternal(url)
      return
    }
    log(`[desktop] blocked navigation — ${decision.reason}`)
  })

  contents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, origin)
    if (decision.action === 'open-externally') {
      log(`[desktop] opening ${url} in the system browser`)
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    if (decision.action === 'block') log(`[desktop] blocked window.open — ${decision.reason}`)
    return { action: 'deny' }
  })

  // A redirect can land somewhere `will-navigate` already approved the start of.
  contents.on('will-redirect', (event, url) => {
    if (decideNavigation(url, origin).action === 'allow-in-window') return
    event.preventDefault()
    log(`[desktop] blocked redirect to ${url}`)
  })

  contents.on('will-attach-webview', event => {
    event.preventDefault()
    log('[desktop] blocked a webview attachment')
  })

  // The dashboard needs no camera, microphone, location, notifications or clipboard read. Refusing
  // every permission request outright is both correct and the only answer that cannot drift as the
  // page changes.
  contents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    log(`[desktop] denied the "${permission}" permission request`)
    callback(false)
  })
  contents.session.setPermissionCheckHandler(() => false)
}
