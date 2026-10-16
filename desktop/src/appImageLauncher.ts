/**
 * The AppImage's applications-menu entry: opt-in, never silent.
 *
 * An AppImage is a single file the user runs from wherever they saved it; nothing puts it in the
 * desktop's application launcher. The Linux plan asks for that integration to be *offered* on
 * first run and done only on a yes. A yes writes two files the user owns, both in the standard
 * per-user locations every desktop reads:
 *
 *   ~/.local/share/applications/traceroost-appimage.desktop
 *   ~/.local/share/icons/hicolor/512x512/apps/traceroost-appimage.png
 *
 * (`traceroost-appimage` rather than the .deb's `traceroost-desktop`, so the two cannot shadow
 * each other on a machine that has both.)
 *
 * Like the autostart entry, the launcher entry is pointed at the AppImage's current path on every
 * start, so moving the file and running it once from its new place fixes the menu; and `TryExec`
 * hides the entry if the file is deleted. "Remove from Applications Menu" in the app menu deletes
 * both files again.
 */

import * as path from 'path'
import { escapeDesktopString, execLine, parseDesktopEntry, parseExecLine, renderDesktopEntry } from './desktopEntry'

export const LAUNCHER_ID = 'traceroost-appimage'
const MANAGED_KEY = 'X-TraceRoost-Managed'

export interface LauncherPaths {
  entry: string
  icon: string
}

/** `$XDG_DATA_HOME`, defaulting to `~/.local/share`. */
export function launcherPaths(env: { XDG_DATA_HOME?: string }, home: string): LauncherPaths {
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : path.join(home, '.local', 'share')
  return {
    entry: path.join(dataHome, 'applications', `${LAUNCHER_ID}.desktop`),
    icon: path.join(dataHome, 'icons', 'hicolor', '512x512', 'apps', `${LAUNCHER_ID}.png`),
  }
}

export function renderLauncherEntry(appImage: string): string {
  return renderDesktopEntry([
    ['Type', 'Application'],
    ['Name', 'TraceRoost'],
    ['GenericName', 'Coding agent observability'],
    ['Comment', escapeDesktopString('See what your coding agents did, what it cost, and what landed')],
    ['Exec', execLine(appImage)],
    ['TryExec', escapeDesktopString(appImage)],
    ['Icon', LAUNCHER_ID],
    ['Terminal', 'false'],
    ['Categories', 'Development;'],
    // The app_id / WM_CLASS Electron takes from desktop/package.json's desktopName.
    ['StartupWMClass', 'traceroost-desktop'],
    [MANAGED_KEY, 'true'],
  ])
}

export type LauncherState = 'absent' | 'current' | 'stale' | 'foreign'

export function inspectLauncherEntry(text: string | undefined, appImage: string): LauncherState {
  if (text === undefined) return 'absent'
  const fields = parseDesktopEntry(text)
  if (fields.get(MANAGED_KEY) !== 'true') return 'foreign'
  const exec = fields.get('Exec')
  const argv = exec === undefined ? undefined : parseExecLine(exec)
  return argv && argv.length === 1 && argv[0] === appImage ? 'current' : 'stale'
}

/** Whether to ask at this start. Only from an AppImage, only once an answer is not on record, and
 *  never when a menu entry already exists (it was added on an earlier run, perhaps from another
 *  copy, and is repaired instead). */
export function shouldOfferLauncher(opts: {
  appImage: string | undefined
  answered: 'added' | 'declined' | undefined
  state: LauncherState
}): boolean {
  return opts.appImage !== undefined && opts.answered === undefined && opts.state === 'absent'
}
