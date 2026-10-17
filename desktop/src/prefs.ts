/**
 * The shell's own few preferences — answers the user gave to questions the app asked, so it does
 * not ask again. Kept in Electron's `userData` directory (`~/.config/TraceRoost` on Linux) beside
 * Chromium's own state, not in `~/.traceroost`: they are about this app, not the collector's data,
 * and removing the app's settings should not touch trace data or the reverse.
 *
 * Corrupt or unreadable prefs are treated as empty. Losing a remembered answer means the question
 * is asked once more, which is the right failure.
 */

import * as fs from 'fs'
import * as path from 'path'
import { type RememberedCloseChoice } from './closeBehavior'

export interface DesktopPrefs {
  /** Linux with no tray: what closing the window does once the user said "remember". */
  closeWithoutTray?: Exclude<RememberedCloseChoice, undefined>
  /** AppImage: whether the user was asked about a launcher entry, and what they said. */
  appImageLauncher?: 'added' | 'declined'
}

export const PREFS_FILE_NAME = 'desktop-prefs.json'

export function parsePrefs(text: string | undefined): DesktopPrefs {
  if (text === undefined) return {}
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const prefs: DesktopPrefs = {}
    if (raw.closeWithoutTray === 'quit' || raw.closeWithoutTray === 'minimize') prefs.closeWithoutTray = raw.closeWithoutTray
    if (raw.appImageLauncher === 'added' || raw.appImageLauncher === 'declined') prefs.appImageLauncher = raw.appImageLauncher
    return prefs
  } catch {
    return {}
  }
}

export class PrefsStore {
  readonly filePath: string

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, PREFS_FILE_NAME)
  }

  read(): DesktopPrefs {
    try { return parsePrefs(fs.readFileSync(this.filePath, 'utf-8')) } catch { return {} }
  }

  update(patch: Partial<DesktopPrefs>): void {
    const next = { ...this.read(), ...patch }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, this.filePath)
    } catch {
      // Not remembered; the question comes back next time.
    }
  }
}
