/**
 * Content-Security-Policy for the standalone dashboard page (standalone/dashboardHtml.ts).
 *
 * Defense in depth for the one page that can drive the local API (clear, import, write to
 * CLAUDE.md in any recorded workspace, link/unlink the org): every `<script>` in the page carries a
 * per-response nonce and nothing else may run — no inline event handlers (`onload=`), no
 * `javascript:` URLs, no scripts from another origin. One escaping slip in trace-derived content
 * then renders as text instead of running. The VS Code webview has had the same policy since the
 * start (src/dashboardPanel.ts); this brings the standalone page level with it.
 *
 *   script-src  — only nonced scripts; 'strict-dynamic' lets a nonced script load more (and
 *                 ignores host allow-lists, so the two `src=` scripts carry the nonce too).
 *   style-src   — the page's own <style>/<link> plus inline `style=` attributes, which the
 *                 Preact bundle sets (and sets via `cssText`, which CSP doesn't govern anyway).
 *   img-src     — /mascot.png and the data: URIs the bundle uses for icons/charts.
 *   connect-src — fetch() and the EventSource, both same-origin.
 *   Downloads (CSV/JSON export via `URL.createObjectURL` + `<a download>`) are navigations CSP
 *   doesn't block. `window.open(url)` for the org link isn't governed either.
 */

import * as crypto from 'crypto'

export function generateCspNonce(): string {
  return crypto.randomBytes(16).toString('base64')
}

export function dashboardCspHeader(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** Policy for the plain 401 page (no scripts at all). */
export const UNAUTHORIZED_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"

/** `<script` opening tags in `html` — each must carry `nonce="<nonce>"` for the policy to let it run. */
export function scriptTagsOf(html: string): string[] {
  return html.match(/<script\b[^>]*>/gi) ?? []
}

/** Inline event-handler attributes (`onload=`, `onclick=`, …) in HTML markup — blocked by the
 *  policy, so there must be none. Only matches inside tags, not `el.onclick = …` in script text. */
export function inlineHandlerAttributesOf(html: string): string[] {
  const out: string[] = []
  for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    if (tag.startsWith('<script')) continue
    const attrs = tag.match(/\s(on[a-z]+)\s*=/gi)
    if (attrs) out.push(...attrs.map(a => a.trim()))
  }
  return out
}
