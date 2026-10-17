/**
 * What closing the dashboard window does, and whether a login launch shows a window at all.
 *
 * On macOS and Windows the menu bar / notification area always exists, so closing the window
 * hides it and collection carries on behind a visible icon. On Linux that icon may have nowhere to
 * appear (trayHost.ts), and then "closed to the tray" means a collector running with no visible
 * trace of the app at all. The Linux plan rules that out as a default anywhere, so without a tray:
 *
 *  - if closing would leave nothing of ours collecting (attached to someone else's collector, or
 *    our own collector is not running), the window's close simply quits the app — nothing is lost
 *    and nothing is left behind;
 *  - if our own collector is running, closing asks: quit (which stops collection, and says so) or
 *    keep running in a minimised window. The user can make that choice stick.
 *
 * A login launch normally comes up with no window. Without a tray it comes up minimised instead,
 * because a window is the only thing that tells the user the app is running.
 */

export type CloseAction =
  /** Hide the window; the tray icon keeps the app reachable. */
  | 'hide-to-tray'
  /** Quit outright: nothing of ours is collecting, so there is nothing to confirm. */
  | 'quit'
  /** Our collector is running and there is no tray: ask (or apply the remembered answer). */
  | 'ask'

export type RememberedCloseChoice = 'quit' | 'minimize' | undefined

export function decideCloseAction(opts: {
  platform: NodeJS.Platform
  trayAvailable: boolean
  /** True only when this app's own collector is running or (re)starting. */
  owningCollection: boolean
}): CloseAction {
  if (opts.platform !== 'linux' || opts.trayAvailable) return 'hide-to-tray'
  return opts.owningCollection ? 'ask' : 'quit'
}

export interface CloseQuestion {
  message: string
  detail: string
  buttons: [quit: string, minimize: string, cancel: string]
  checkboxLabel: string
}

export function closeQuestion(desktop: string | undefined): CloseQuestion {
  const where = desktop ? `This desktop (${desktop})` : 'This desktop'
  return {
    message: 'Quit TraceRoost and stop collecting?',
    detail:
      `${where} has no system tray for TraceRoost to keep running in, so closing the window can ` +
      'either quit — which stops recording your coding-agent sessions until TraceRoost is opened ' +
      'again — or leave TraceRoost running in a minimised window.\n\n' +
      'On GNOME, the "AppIndicator and KStatusNotifierItem Support" extension adds a tray, and ' +
      'TraceRoost will then close to it. To collect with no window at all, run the collector as a ' +
      'background service instead: `traceroost service install` (from npm or Homebrew).',
    buttons: ['Quit and Stop Collecting', 'Keep Running Minimised', 'Cancel'],
    checkboxLabel: 'Remember my choice',
  }
}

export type StartupWindow = 'show' | 'minimized' | 'none'

export function decideStartupWindow(opts: {
  platform: NodeJS.Platform
  launchedAtLogin: boolean
  trayAvailable: boolean
}): StartupWindow {
  if (!opts.launchedAtLogin) return 'show'
  if (opts.platform === 'linux' && !opts.trayAvailable) return 'minimized'
  return 'none'
}
