/**
 * Opens a URL in the user's default browser. Two callers: the CLI (`child_process`) and the
 * VS Code extension (which passes its own opener so `vscode.env.openExternal` is used instead).
 *
 * No shell, and no launcher that re-parses its command line: `open`/`xdg-open` get the URL as one
 * argv entry (`spawn` with an array), and on Windows so does rundll32's FileProtocolHandler. The
 * obvious Windows form, `cmd /c start "" <url>`, is wrong for an OAuth URL even without a shell in
 * between: cmd.exe parses its own command line, so an unquoted `&` in the query string ends the
 * command (the browser opened on everything before the first `&`, minus redirect_uri and state),
 * and quoting doesn't rescue `%`-escapes, which cmd expands even inside double quotes. The authorize
 * URL is built with the WHATWG URL API and the org view URL comes from the credential file, but
 * neither should ever be interpolated into a command line. standalone/openBrowser.ts is the same
 * logic for the server itself (the core edition can't import from src/cloud/).
 */

import { spawn } from 'child_process'
import { recordAction } from '../../actionLog'

export type UrlOpener = (url: string) => void | Promise<void>

/** The launcher and its arguments for `url` on `platform` — exported for tests. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [url] }
  // Not `cmd /c start`: see the header. rundll32 hands the URL to the shell's URL handler as a
  // single argument, so `&`, `%` and `=` survive untouched.
  if (platform === 'win32') return { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { file: 'xdg-open', args: [url] }
}

export const systemBrowserOpener: UrlOpener = async (url: string) => {
  const { file, args } = browserCommand(url)
  await recordAction('system', 'Opening your browser to sign in', `${file} ${args.map(a => JSON.stringify(a)).join(' ')}`, () => new Promise<void>(resolve => {
    // if this fails the caller has already printed the URL to paste manually
    try {
      const child = spawn(file, args, { stdio: 'ignore', windowsHide: true })
      child.on('error', () => resolve())
      child.on('exit', () => resolve())
    } catch {
      resolve()
    }
  }))
}
