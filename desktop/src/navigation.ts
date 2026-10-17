/**
 * What the dashboard window is allowed to load, and where a link is allowed to go.
 *
 * The window renders a page served by the local collector, and that page displays trace content:
 * prompts, tool calls and tool output captured from coding agents. None of that is trusted input.
 * In a browser it is just a page on localhost with a restrictive CSP; in a desktop shell the
 * difference is that a navigation can replace the whole window, and `window.open` can open a frame
 * with no chrome around it. So navigation is decided here, by origin, rather than left to default
 * Electron behaviour:
 *
 *   - in-window navigation: only the one dashboard origin the shell validated at startup.
 *   - anything else http(s): handed to the system browser if its host is on the allowlist below,
 *     and otherwise dropped. A real browser is the right place for the web, and it is also the
 *     place where the user can see the address of what they are about to open.
 *   - every other scheme (`file:`, `vscode:`, `javascript:`, custom handlers): dropped. `file:`
 *     would hand trace content a reader for the local disk, and the OS-handler schemes are an
 *     invitation to launch an arbitrary registered application.
 *
 * The allowlist is hosts the dashboard actually links to (the agent vendors' docs, GitHub, this
 * project's own site) — not a general "https is fine" rule, which would let injected trace content
 * exfiltrate by getting a URL opened.
 */

/** Hosts the dashboard links to, and their subdomains. Derived from the links in `media/src/` and
 *  `standalone/dashboardHtml.ts`; keep in step when a new outbound link is added there. */
const ALLOWED_EXTERNAL_HOSTS = [
  'traceroost.com',
  'github.com',
  'docs.github.com',
  'platform.claude.com',
  'developers.openai.com',
  'learn.chatgpt.com',
  'opencode.ai',
  'ai.google.dev',
  'marketplace.visualstudio.com',
  'www.npmjs.com',
]

export type NavigationDecision =
  /** Load it in the dashboard window. */
  | { action: 'allow-in-window' }
  /** Hand it to the system browser; never to this window. */
  | { action: 'open-externally' }
  /** Do nothing, and say why in the log. */
  | { action: 'block'; reason: string }

function hostMatches(host: string, allowed: string): boolean {
  return host === allowed || host.endsWith(`.${allowed}`)
}

export function isAllowedExternalHost(host: string): boolean {
  const normalized = host.toLowerCase()
  return ALLOWED_EXTERNAL_HOSTS.some(allowed => hostMatches(normalized, allowed))
}

/**
 * `target` is the URL being navigated to; `dashboardOrigin` is the origin the shell validated and
 * loaded (e.g. `http://127.0.0.1:3000`).
 */
export function decideNavigation(target: string, dashboardOrigin: string): NavigationDecision {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return { action: 'block', reason: `not a URL: ${target.slice(0, 80)}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { action: 'block', reason: `scheme ${url.protocol} is not allowed` }
  }
  if (url.origin === dashboardOrigin) {
    return { action: 'allow-in-window' }
  }
  if (url.protocol === 'https:' && isAllowedExternalHost(url.hostname)) {
    return { action: 'open-externally' }
  }
  return { action: 'block', reason: `${url.origin} is neither the dashboard nor an allowed external host` }
}

/** A `window.open`/target=_blank request. Same rules, except that nothing may open a *new window*:
 *  an allowed external URL goes to the system browser and the rest is dropped. */
export function decideWindowOpen(target: string, dashboardOrigin: string): NavigationDecision {
  const decision = decideNavigation(target, dashboardOrigin)
  if (decision.action === 'allow-in-window') {
    // Same-origin popups are not something the dashboard uses, and a chromeless same-origin window
    // is a convincing surface for a spoofed prompt. Keep it in the one window.
    return { action: 'block', reason: 'the dashboard does not open extra windows' }
  }
  return decision
}
