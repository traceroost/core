/**
 * Windows-specific decisions, kept free of Electron imports so they are unit-tested on any OS.
 *
 *  - **`--quit`.** `traceroost-desktop --quit` asks a running TraceRoost to quit the way its own
 *    Quit does — stopping its collector with the owner channel's shutdown request and waiting for
 *    the flush — and then exits. It travels over Electron's single-instance lock (the second
 *    launch's argv reaches the first as `second-instance`), which is per user session, so it
 *    reaches only this user's TraceRoost. The NSIS installer and uninstaller use it before they
 *    replace or remove files (build/installer.nsh): their own fallback is `Stop-Process`, which is
 *    TerminateProcess and would kill the collector unflushed. It works on every OS; Windows is
 *    the one that needs it, since `kill <pid>` there runs no handler.
 *  - **Launch at Login** is the HKCU Run key, through Electron's login-item API. The value carries
 *    LAUNCHED_AT_LOGIN_ARG, because Electron reports `wasOpenedAtLogin` only on macOS.
 */

import { LAUNCHED_AT_LOGIN_ARG, type LaunchCommand } from './autostart'

export const QUIT_ARG = '--quit'

/** True when this launch only asks a running instance to quit. */
export function isQuitRequest(argv: readonly string[]): boolean {
  return argv.includes(QUIT_ARG)
}

/** The Run-key entry for this copy of the app: `app.setLoginItemSettings` / `getLoginItemSettings`
 *  take the same `path` and `args`, and match on both. */
export function windowsLoginItem(command: LaunchCommand): { path: string; args: string[] } {
  return { path: command.program, args: [...command.args, LAUNCHED_AT_LOGIN_ARG] }
}

/** The tray icon file in the tray asset directory. Windows draws a multi-size .ico best: it
 *  picks the frame for the notification area's DPI itself. */
export function trayIconFile(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'trayTemplate.png'
  if (platform === 'win32') return 'trayWindows.ico'
  return 'trayLinux.png'
}
