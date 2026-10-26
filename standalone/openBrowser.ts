/**
 * Opens a URL in the user's default browser without a shell. The previous `exec(\`open "${url}"\`)`
 * form interpolated the URL into a shell command line — every URL this server opens is built by
 * code (the dashboard URL, an OAuth authorize URL, the org view URL from the credential file), so
 * nothing attacker-controlled reached it, but an argument array needs no quoting to get right.
 * On Windows that argument array must not go to `cmd /c start`: cmd.exe re-parses its own command
 * line, so an unquoted `&` in a query string ends the command (the browser opened on everything
 * before the first `&`), and quoting doesn't rescue `%`-escapes, which cmd expands even inside
 * double quotes. rundll32's FileProtocolHandler takes the URL as one plain argument instead.
 * Mirrors src/cloud/org/browser.ts, which the Cloud link code uses (the core edition can't
 * import from src/cloud/, hence the copy here).
 */

import { spawn } from 'child_process'

/** The launcher and its arguments for `url` on `platform` — exported for tests. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [url] }
  // Not `cmd /c start`: see the header. rundll32 hands the URL to the shell's URL handler as a
  // single argument, so `&`, `%` and `=` survive untouched.
  if (platform === 'win32') return { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { file: 'xdg-open', args: [url] }
}

/** Fire-and-forget; `onError` runs when the launcher can't be spawned or exits non-zero. (On
 *  Windows, rundll32 exits 0 whatever the URL handler did, so only a failed spawn reaches it —
 *  which is why every caller has already printed the URL to open by hand.) */
export function openInBrowser(url: string, onError?: (err: Error) => void): void {
  const { file, args } = browserCommand(url)
  try {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- an argument array, no shell; the URL is one argv entry
    const child = spawn(file, args, { stdio: 'ignore', detached: false, windowsHide: true })
    child.on('error', err => onError?.(err))
    child.on('exit', code => { if (code !== 0 && code !== null) onError?.(new Error(`${file} exited with code ${code}`)) })
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}

/** Whether a one-off command (`traceroost service install`) should open the dashboard for you.
 *  Not when asked not to (`--no-open`, or `TRACEROOST_NO_OPEN=1`); not when nobody is at a
 *  terminal to see it (stdout not a TTY: CI, a pipe, a script); not over SSH, where the browser
 *  would open on the far machine or nowhere; and on Linux only with a graphical session to open
 *  it in. */
export function shouldAutoOpen(opts: {
  args: string[]
  env: NodeJS.ProcessEnv
  stdoutIsTty: boolean
  platform?: NodeJS.Platform
}): boolean {
  const { args, env, stdoutIsTty } = opts
  const platform = opts.platform ?? process.platform
  if (args.includes('--no-open')) return false
  if (env.TRACEROOST_NO_OPEN === '1' || env.TRACEROOST_NO_OPEN === 'true') return false
  if (!stdoutIsTty) return false
  if (env.SSH_CONNECTION || env.SSH_TTY) return false
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false
  return true
}
