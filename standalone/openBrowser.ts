/**
 * Opens a URL in the user's default browser without a shell. The previous `exec(\`open "${url}"\`)`
 * form interpolated the URL into a shell command line — every URL this server opens is built by
 * code (the dashboard URL, an OAuth authorize URL, the org view URL from the credential file), so
 * nothing attacker-controlled reached it, but an argument array needs no quoting to get right.
 * Mirrors src/cloud/org/browser.ts, which the Cloud link code uses (the core edition can't
 * import from src/cloud/, hence the copy here).
 */

import { spawn } from 'child_process'

/** The launcher and its arguments for `url` on `platform` — exported for tests. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [url] }
  // `start` is a cmd.exe builtin; its first quoted argument is the window title, so an empty one
  // keeps a URL from being taken as the title.
  if (platform === 'win32') return { file: 'cmd', args: ['/c', 'start', '', url] }
  return { file: 'xdg-open', args: [url] }
}

/** Fire-and-forget; `onError` runs when the launcher can't be spawned or exits non-zero. */
export function openInBrowser(url: string, onError?: (err: Error) => void): void {
  const { file, args } = browserCommand(url)
  try {
    const child = spawn(file, args, { stdio: 'ignore', detached: false, windowsHide: true })
    child.on('error', err => onError?.(err))
    child.on('exit', code => { if (code !== 0 && code !== null) onError?.(new Error(`${file} exited with code ${code}`)) })
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}
