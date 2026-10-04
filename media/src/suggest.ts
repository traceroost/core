/**
 * The header's "Make a suggestion" link (App.tsx's SuggestButton). It opens TraceRoost Cloud's
 * public `/suggest` page — a plain web page that works without an account — in the user's browser.
 * Nothing is sent from here: the webview only navigates a link, the same way Help's external links
 * do (VS Code hands an https link clicked in a webview to `env.openExternal`; the standalone
 * dashboard opens it in a new browser tab).
 *
 * Deliberately not under `cloud/` and not the Org panel's resolved endpoint: this ships in the core
 * edition too, which bundles no Cloud code, so it is one fixed public URL. scripts/check-edition.mjs
 * allows exactly this URL and still fails on any other Cloud hostname or endpoint.
 */
export const SUGGEST_URL = 'https://traceroost.com/suggest'

/**
 * `context` is only the app version and the tab name (e.g. `core 1.2.3 · Traces`) — never a
 * workspace path, repo name, prompt or anything else from the user's data. Both inputs are
 * constants of the build and the UI, which is what keeps it that way.
 */
export function suggestionUrl(version: string | undefined, tabLabel: string): string {
  const context = `${version ? `core ${version}` : 'core'} · ${tabLabel}`
  return `${SUGGEST_URL}?${new URLSearchParams({ from: 'core', context }).toString()}`
}
