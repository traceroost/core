/**
 * Launch at Login on Linux: an XDG autostart entry, `~/.config/autostart/traceroost-desktop.desktop`.
 *
 * Electron's `app.setLoginItemSettings` is a no-op on Linux (and `getLoginItemSettings` always
 * reports `openAtLogin: false`), so the shell writes the entry itself. Every mainstream desktop —
 * GNOME, KDE Plasma, XFCE, Cinnamon, MATE — honours this directory.
 *
 * Rules, from the Linux plan:
 *
 *  - The entry is written **only when the user turns Launch at Login on**, and removed when they
 *    turn it off. Nothing writes it at install time; the .deb's maintainer scripts never touch a
 *    home directory.
 *  - It launches **this app**, never a collector. The `traceroost service install` systemd user
 *    unit is a separate startup path that this file neither creates nor edits; when that unit is
 *    enabled the app attaches to it at login instead of starting a second writer (see
 *    systemdUnit.ts).
 *  - It points at the app's **current** location. An AppImage is a file the user can move or
 *    delete, so on every start the shell rewrites an entry of its own that points somewhere else,
 *    and `TryExec` makes the session skip the entry silently if the file is gone before then.
 *
 * Only an entry carrying `X-TraceRoost-Managed=true` is ever rewritten or removed. A user who
 * copied and edited the file by hand gets to keep their copy.
 */

import * as path from 'path'
import { escapeDesktopString, execLine, parseDesktopEntry, parseExecLine, renderDesktopEntry } from './desktopEntry'

export const AUTOSTART_FILE_NAME = 'traceroost-desktop.desktop'
/** Passed by the autostart entry so the app knows it was started at login and should come up
 *  without stealing focus. The same marker the Windows build registers with its Run value. */
export const LAUNCHED_AT_LOGIN_ARG = '--launched-at-login'
const MANAGED_KEY = 'X-TraceRoost-Managed'

/** How to start this copy of the app. */
export interface LaunchCommand {
  program: string
  args: string[]
}

/**
 * The command that starts this copy of the app.
 *
 *  - From an AppImage, `process.execPath` is inside a FUSE mount that disappears when the app
 *    exits; the file to launch is `$APPIMAGE`, which the AppImage runtime sets.
 *  - Packaged otherwise (.deb, or an unpacked directory), it is the executable itself.
 *  - In development it is the Electron binary plus the app directory.
 */
export function launchCommand(opts: {
  execPath: string
  isPackaged: boolean
  appPath: string
  appImage: string | undefined
}): LaunchCommand {
  if (opts.appImage) return { program: opts.appImage, args: [] }
  if (opts.isPackaged) return { program: opts.execPath, args: [] }
  return { program: opts.execPath, args: [opts.appPath] }
}

/** `$XDG_CONFIG_HOME/autostart`, defaulting to `~/.config/autostart` as the spec requires when the
 *  variable is unset or not absolute. A Linux path whatever the host, hence `path.posix`. */
export function autostartDir(env: { XDG_CONFIG_HOME?: string }, home: string): string {
  const configHome = env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : path.posix.join(home, '.config')
  return path.posix.join(configHome, 'autostart')
}

export function renderAutostartEntry(command: LaunchCommand): string {
  return renderDesktopEntry([
    ['Type', 'Application'],
    ['Name', 'TraceRoost'],
    ['Comment', escapeDesktopString('Open TraceRoost at login so coding-agent sessions are recorded')],
    ['Exec', execLine(command.program, [...command.args, LAUNCHED_AT_LOGIN_ARG])],
    // The session skips an entry whose TryExec does not exist — the AppImage was moved or deleted
    // while the app was not running to notice.
    ['TryExec', escapeDesktopString(command.program)],
    ['Icon', 'traceroost-desktop'],
    ['Terminal', 'false'],
    ['NoDisplay', 'false'],
    ['X-GNOME-Autostart-enabled', 'true'],
    [MANAGED_KEY, 'true'],
  ])
}

export type AutostartState =
  /** No entry. */
  | { kind: 'absent' }
  /** Our entry, launching exactly this copy of the app. */
  | { kind: 'current' }
  /** Our entry, launching something else — an older path to a moved AppImage, or a different
   *  copy. It should be rewritten to point here. */
  | { kind: 'stale'; program: string | undefined }
  /** Someone else's file under our name (no managed marker), or one disabled by the desktop's own
   *  settings UI. Reported, never touched. */
  | { kind: 'foreign' }
  | { kind: 'disabled' }

export function inspectAutostartEntry(text: string | undefined, command: LaunchCommand): AutostartState {
  if (text === undefined) return { kind: 'absent' }
  const fields = parseDesktopEntry(text)
  if (fields.get(MANAGED_KEY) !== 'true') return { kind: 'foreign' }
  // GNOME Tweaks and KDE's autostart settings disable an entry in place rather than deleting it.
  if (fields.get('Hidden') === 'true' || fields.get('X-GNOME-Autostart-enabled') === 'false') return { kind: 'disabled' }
  const exec = fields.get('Exec')
  const argv = exec === undefined ? undefined : parseExecLine(exec)
  const expected = [command.program, ...command.args, LAUNCHED_AT_LOGIN_ARG]
  if (argv && argv.length === expected.length && argv.every((a, i) => a === expected[i])) return { kind: 'current' }
  return { kind: 'stale', program: argv?.[0] }
}

/** Whether Launch at Login is on, as the menu's checkbox should show it. A stale entry still
 *  counts: the shell repairs it at startup, and the user's choice was "on". */
export function isLaunchAtLoginOn(state: AutostartState): boolean {
  return state.kind === 'current' || state.kind === 'stale'
}

export interface AutostartFs {
  readFile: (p: string) => string | undefined
  writeFile: (p: string, text: string) => void
  remove: (p: string) => void
}

export class LinuxAutostart {
  readonly filePath: string

  constructor(
    dir: string,
    private readonly command: LaunchCommand,
    private readonly fsOps: AutostartFs,
  ) {
    this.filePath = path.join(dir, AUTOSTART_FILE_NAME)
  }

  state(): AutostartState {
    return inspectAutostartEntry(this.fsOps.readFile(this.filePath), this.command)
  }

  isEnabled(): boolean {
    return isLaunchAtLoginOn(this.state())
  }

  /** Turns login launch on or off. A foreign file is left alone either way and reported back. */
  setEnabled(enabled: boolean): AutostartState {
    const before = this.state()
    if (before.kind === 'foreign') return before
    if (enabled) this.fsOps.writeFile(this.filePath, renderAutostartEntry(this.command))
    else if (before.kind !== 'absent') this.fsOps.remove(this.filePath)
    return this.state()
  }

  /** Called at startup: points a stale entry of ours at this copy of the app. Returns the program
   *  it used to point at when it rewrote one. */
  repair(): { repairedFrom: string | undefined } | undefined {
    const state = this.state()
    if (state.kind !== 'stale') return undefined
    this.fsOps.writeFile(this.filePath, renderAutostartEntry(this.command))
    return { repairedFrom: state.program }
  }
}
