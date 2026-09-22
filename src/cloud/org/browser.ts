/**
 * Opens a URL in the user's default browser. Two callers: the CLI (`child_process`) and the
 * VS Code extension (which passes its own opener so `vscode.env.openExternal` is used instead).
 */

import { exec } from 'child_process'

export type UrlOpener = (url: string) => void | Promise<void>

export const systemBrowserOpener: UrlOpener = (url: string) => {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`
  exec(cmd, () => { /* if this fails the caller has already printed the URL to paste manually */ })
}
