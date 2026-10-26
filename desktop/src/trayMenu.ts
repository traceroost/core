/**
 * The menu bar menu, as data.
 *
 * Built as a plain model rather than straight into Electron's `Menu` so the part worth checking —
 * which items exist, which are enabled, and what the status line says — can be asserted without a
 * running app. tray.ts turns this into a real menu.
 *
 * Two labelling rules the plan is explicit about, both easy to get wrong:
 *
 *  - "Stopped" means *no collection is happening*. The dashboard already has an OTEL ingestion
 *    toggle, which pauses one input while the collector keeps running; reusing that word here for
 *    a global stop (or that toggle's wording for this state) would tell the user their agents are
 *    being recorded when they are not. These labels describe the collector process only.
 *  - In attached mode the collector belongs to someone else, so Start/Stop/Restart are absent
 *    rather than present-and-disabled. A greyed-out Stop invites the reading "I could stop it if I
 *    enabled something", when the truthful statement is that stopping it is not this app's to do.
 */

import { type CollectorState } from './collector'
import { type ShellMode } from './mode'

export type MenuItemId =
  | 'status'
  | 'error-summary'
  | 'show-error'
  | 'open-dashboard'
  | 'start'
  | 'stop'
  | 'restart'
  | 'attach'
  | 'open-logs'
  | 'launch-at-login'
  | 'applications-menu'
  | 'about'
  | 'quit'

export interface MenuItemModel {
  id: MenuItemId
  label: string
  enabled: boolean
  /** Set for the checkbox items. */
  checked?: boolean
  /** Rendered as a non-interactive line. */
  isStatus?: boolean
  /** Spoken by VoiceOver in place of a label that reads poorly out of context. */
  accessibilityLabel?: string
}

export interface MenuModel {
  /** Short text for the tray tooltip. */
  tooltip: string
  items: (MenuItemModel | { separator: true })[]
}

/** The status line for an owned collector. Deliberately concrete about what is and is not being
 *  recorded; `uiPort` is the port actually bound, not the one configured. */
export function describeCollectorState(state: CollectorState): { label: string; accessibilityLabel: string } {
  switch (state.status) {
    case 'stopped':
      return {
        label: 'Collection stopped',
        accessibilityLabel: 'Collection is stopped. Nothing is being recorded.',
      }
    case 'starting':
      return { label: 'Starting collection…', accessibilityLabel: 'Collection is starting.' }
    case 'running':
      return {
        label: `Collecting — dashboard on port ${state.uiPort}`,
        accessibilityLabel: `Collecting. The dashboard is on port ${state.uiPort}.`,
      }
    case 'restarting':
      return {
        label: `Collection stopped — retrying in ${Math.round(state.nextAttemptInMs / 1000)}s`,
        accessibilityLabel: `Collection stopped after an error and will retry in ${Math.round(state.nextAttemptInMs / 1000)} seconds. Attempt ${state.attempt}.`,
      }
    case 'failed':
      return {
        label: 'Collection failed — not collecting',
        accessibilityLabel: `Collection failed and will not retry. Nothing is being recorded. ${state.lastError}`,
      }
  }
}

/** Why nothing is being collected, when something went wrong: an owned collector that failed or
 *  is between retries (its last error, which can run to many lines of the collector's own output),
 *  or a data dir this app may neither attach to nor take over. Undefined otherwise. */
export function collectionProblem(shell: ShellMode, collector: CollectorState): { title: string; detail: string } | undefined {
  if (shell.mode === 'own' && (collector.status === 'failed' || collector.status === 'restarting')) {
    return {
      title: collector.status === 'failed' ? 'Collection failed' : 'Collection stopped after an error',
      detail: collector.lastError,
    }
  }
  if (shell.mode === 'blocked') return { title: 'Not collecting', detail: shell.detail }
  return undefined
}

/** The first line of `detail`, short enough for a menu line. */
export function shortErrorText(detail: string, max = 60): string {
  const first = detail.split('\n').map(l => l.trim()).find(l => l !== '') ?? 'Unknown error'
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

export function buildMenuModel(input: {
  shell: ShellMode
  collector: CollectorState
  launchAtLogin: boolean
  version: string
  /** Running from an AppImage: whether its applications-menu entry exists. Undefined everywhere
   *  else, and the item is then absent — a .deb or a macOS app is in the launcher by installation. */
  inApplicationsMenu?: boolean
}): MenuModel {
  const { shell, collector, launchAtLogin, version, inApplicationsMenu } = input
  const owned = shell.mode === 'own'
  const attached = shell.mode === 'attach'

  const status = owned
    ? describeCollectorState(collector)
    : attached
      ? {
          label: shell.identity.service
            ? `Collecting — attached to the background service (port ${shell.identity.uiPort})`
            : `Collecting — attached to pid ${shell.identity.pid} (port ${shell.identity.uiPort})`,
          accessibilityLabel: `Collecting. Attached to a collector this app does not manage, on port ${shell.identity.uiPort}.`,
        }
      : shell.mode === 'confirm-attach'
        ? { label: 'A collector is already running', accessibilityLabel: shell.question }
        : shell.mode === 'wait'
          ? { label: 'Waiting for a collector that is starting…', accessibilityLabel: shell.detail }
          : { label: 'Not collecting — needs attention', accessibilityLabel: shell.detail }

  // The dashboard is only reachable once something is actually serving it.
  const dashboardReachable =
    (owned && collector.status === 'running') || attached

  const items: (MenuItemModel | { separator: true })[] = [
    { id: 'status', label: status.label, enabled: false, isStatus: true, accessibilityLabel: status.accessibilityLabel },
  ]
  // The reason, visibly — not only in the accessibility label — with the whole text one click away.
  const problem = collectionProblem(shell, collector)
  if (problem) {
    items.push(
      { id: 'error-summary', label: shortErrorText(problem.detail), enabled: false, isStatus: true },
      { id: 'show-error', label: 'Show Error…', enabled: true },
    )
  }
  items.push(
    { separator: true },
    {
      id: 'open-dashboard',
      label: 'Open Dashboard',
      enabled: dashboardReachable,
      accessibilityLabel: dashboardReachable ? undefined : 'Open Dashboard. Unavailable until a collector is running.',
    },
  )

  if (owned) {
    const running = collector.status === 'running'
    const transitional = collector.status === 'starting' || collector.status === 'restarting'
    items.push(
      { id: 'start', label: 'Start Collection', enabled: !running && !transitional },
      { id: 'stop', label: 'Stop Collection', enabled: running },
      { id: 'restart', label: 'Restart Collection', enabled: running || collector.status === 'failed' },
    )
  } else if (shell.mode === 'confirm-attach') {
    items.push({ id: 'attach', label: 'Use the Running Collector…', enabled: true, accessibilityLabel: shell.question })
  }

  items.push(
    { separator: true },
    { id: 'open-logs', label: 'Open Logs', enabled: true },
    {
      id: 'launch-at-login',
      label: 'Launch at Login',
      enabled: true,
      checked: launchAtLogin,
      accessibilityLabel: 'Launch at Login. Off by default; turning it on opens TraceRoost when you log in.',
    },
  )
  if (inApplicationsMenu !== undefined) {
    items.push({
      id: 'applications-menu',
      label: 'Show in Applications Menu',
      enabled: true,
      checked: inApplicationsMenu,
      accessibilityLabel: 'Show in Applications Menu. Adds or removes a launcher entry for this AppImage.',
    })
  }
  items.push(
    { separator: true },
    { id: 'about', label: `TraceRoost ${version}`, enabled: true },
    { id: 'quit', label: owned ? 'Quit TraceRoost' : 'Quit TraceRoost (leaves the collector running)', enabled: true },
  )

  return { tooltip: `TraceRoost — ${status.label}`, items }
}
