/**
 * Opens a URL in the user's default browser. Two callers: the CLI (`child_process`) and the
 * VS Code extension (which passes its own opener so `vscode.env.openExternal` is used instead).
 */

import { exec } from 'child_process'
import { recordAction } from '../../actionLog'

export type UrlOpener = (url: string) => void | Promise<void>

export const systemBrowserOpener: UrlOpener = async (url: string) => {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`
  await recordAction('system', 'Opening your browser to sign in', cmd, () => new Promise<void>(resolve => {
    // if this fails the caller has already printed the URL to paste manually
    exec(cmd, () => resolve())
  }))
}
