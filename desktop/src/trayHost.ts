/**
 * Is there anywhere on this Linux desktop for a tray icon to appear?
 *
 * Electron's `Tray` on Linux is a StatusNotifierItem: it registers with whoever owns
 * `org.kde.StatusNotifierWatcher` on the session bus. KDE Plasma, Cinnamon, XFCE (with its
 * status-notifier plugin, the default), MATE, Budgie and Ubuntu's GNOME (which ships the
 * AppIndicator extension) all own that name. Stock GNOME on Fedora and Debian does not, and there
 * `new Tray()` succeeds and draws nothing — the app would be "running in the tray" with no tray.
 *
 * The plan is explicit that this must never be the default anywhere, so the shell asks the bus
 * before deciding what closing the window means (see closeBehavior.ts). The answer can change
 * while the app runs — the user enables the AppIndicator extension, or logs into a different
 * session — so it is asked again on each close rather than cached for the life of the process.
 *
 * Asked through `dbus-send` (in `dbus`/`dbus-bin`, present wherever a desktop session bus is) and
 * then `gdbus` (in `libglib2.0-bin`). If neither can answer, the answer is "no": guessing "yes"
 * is the one mistake that leaves collection running invisibly.
 */

import { execFile } from 'child_process'

export const WATCHER_NAME = 'org.kde.StatusNotifierWatcher'

export type TrayHost =
  | { available: true; via: string }
  | { available: false; reason: string }

/** `dbus-send --print-reply=literal … NameHasOwner` prints `   boolean true`. */
export function parseDbusSendReply(stdout: string): boolean | undefined {
  const m = /\bboolean\s+(true|false)\b/.exec(stdout)
  return m ? m[1] === 'true' : undefined
}

/** `gdbus call … NameHasOwner` prints `(true,)`. */
export function parseGdbusReply(stdout: string): boolean | undefined {
  const m = /^\s*\((true|false),?\)\s*$/m.exec(stdout)
  return m ? m[1] === 'true' : undefined
}

type Run = (file: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>

const run: Run = (file, args) => new Promise(resolve => {
  execFile(file, args, { timeout: 2_000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '') }))
})

/** Asks the session bus whether a StatusNotifierWatcher is present. `runner` is injectable for
 *  tests. */
export async function detectTrayHost(env: { DBUS_SESSION_BUS_ADDRESS?: string; XDG_RUNTIME_DIR?: string }, runner: Run = run): Promise<TrayHost> {
  if (!env.DBUS_SESSION_BUS_ADDRESS && !env.XDG_RUNTIME_DIR) {
    return { available: false, reason: 'no session bus (DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR are unset)' }
  }
  const viaDbusSend = await runner('dbus-send', [
    '--session', '--print-reply=literal', '--reply-timeout=1500', '--dest=org.freedesktop.DBus',
    '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', `string:${WATCHER_NAME}`,
  ])
  const a = viaDbusSend.ok ? parseDbusSendReply(viaDbusSend.stdout) : undefined
  if (a !== undefined) {
    return a ? { available: true, via: 'dbus-send' } : { available: false, reason: `nothing owns ${WATCHER_NAME} on the session bus` }
  }
  const viaGdbus = await runner('gdbus', [
    'call', '--session', '--timeout', '2', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
    '--method', 'org.freedesktop.DBus.NameHasOwner', WATCHER_NAME,
  ])
  const b = viaGdbus.ok ? parseGdbusReply(viaGdbus.stdout) : undefined
  if (b !== undefined) {
    return b ? { available: true, via: 'gdbus' } : { available: false, reason: `nothing owns ${WATCHER_NAME} on the session bus` }
  }
  return { available: false, reason: 'could not ask the session bus (neither dbus-send nor gdbus answered)' }
}
