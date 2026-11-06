/**
 * macOS: installing by double-click. The DMG invites the user to open the app straight from the
 * disk image; on that launch the app offers to move itself to /Applications, and a yes copies it
 * there, relaunches the copy and ejects the image — one double-click ends with the app installed
 * *and* running, where drag-to-Applications ends with the user hunting for it in Finder. Dragging
 * still works; that path just does not open the app.
 *
 * The move itself is Electron's `app.moveToApplicationsFolder()`. Two of its behaviours shape the
 * code in main.ts:
 *
 *  - With a copy already in /Applications and *running*, it focuses that copy and quits itself
 *    rather than replacing it — so an upgrade from the new DMG would leave the old version
 *    running. The conflict handler refuses that case and main.ts quits the running copy first
 *    (SIGTERM, which every version turns into the flush-then-quit path), then moves.
 *  - It must run before the single-instance lock is taken: with an older copy running, the lock
 *    would fail and hand this launch over to it before the question could be asked.
 *
 * Offered only for launches from a disk image or from App Translocation (where Gatekeeper runs a
 * quarantined app that has not been moved), never for an app the user put somewhere on purpose,
 * nor for a build run from the repo's `dist/` (development, the smoke test, CI). "Not Now" asks
 * again on the next launch; the dialog's "Don't ask again" checkbox is what stops it.
 */

export interface MoveOfferInput {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** `app.isInApplicationsFolder()`: /Applications or ~/Applications. */
  inApplicationsFolder: boolean
  /** The .app bundle this process runs from. */
  bundlePath: string
  /** The user ticked "Don't ask again". */
  declined: boolean
  launchedAtLogin: boolean
}

/** Where the bundle is running from, as far as the move offer cares. */
export function launchLocation(bundlePath: string): 'disk-image' | 'translocated' | 'elsewhere' {
  if (bundlePath.includes('/AppTranslocation/')) return 'translocated'
  if (bundlePath.startsWith('/Volumes/')) return 'disk-image'
  return 'elsewhere'
}

export function shouldOfferMove(input: MoveOfferInput): boolean {
  if (input.platform !== 'darwin' || !input.isPackaged) return false
  if (input.inApplicationsFolder || input.declined || input.launchedAtLogin) return false
  return launchLocation(input.bundlePath) !== 'elsewhere'
}

/** `<x>.app` from the main executable's path (`<x>.app/Contents/MacOS/<name>`). */
export function bundleOf(execPath: string): string {
  const marker = '.app/Contents/MacOS/'
  const at = execPath.lastIndexOf(marker)
  return at === -1 ? execPath : execPath.slice(0, at + '.app'.length)
}

/**
 * Pids of the app processes running from `<bundle>` — `<bundle>/Contents/MacOS/<anything>` — from
 * `ps -axo pid=,ppid=,args=` output. Only the top-level ones: the collector is started with the
 * app's own executable (ELECTRON_RUN_AS_NODE), so it matches too, but it is the app's child and
 * the app stops it on quit; a signal of its own would race that. Helpers live under
 * Contents/Frameworks and do not match.
 */
export function pidsRunningBundle(psOutput: string, bundle: string): number[] {
  const prefix = `${bundle}/Contents/MacOS/`
  const matches: Array<{ pid: number; ppid: number }> = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match && match[3].startsWith(prefix)) matches.push({ pid: Number(match[1]), ppid: Number(match[2]) })
  }
  const pids = new Set(matches.map(m => m.pid))
  return matches.filter(m => !pids.has(m.ppid)).map(m => m.pid)
}
