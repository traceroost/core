/**
 * One-shot loopback HTTP server for the PKCE redirect (AL 01).
 *
 * Binds `127.0.0.1:0` (a random free port — the callback port is never hardcoded), waits for a
 * single `GET /callback?code=…&state=…`, responds to the browser *before* resolving so the tab
 * never hangs, and then closes. It cannot outlive success, failure, or timeout: every exit path
 * runs `close()`.
 */

import * as http from 'http'
import { AddressInfo } from 'net'

export interface CallbackResult {
  code: string
  state: string | null
}

export interface CallbackServer {
  /** e.g. `http://127.0.0.1:53219/callback` — pass verbatim as the OAuth `redirect_uri`. */
  redirectUri: string
  /** Resolves with the query params of the first callback hit; rejects on timeout or a bad request. */
  waitForCallback(): Promise<CallbackResult>
  /** Idempotent. Safe to call from any exit path. */
  close(): void
}

/**
 * `teamUrl`, when present, is a link straight to the org's page on the web app (built by
 * `/oauth/authorize`'s approve action, which is the one place that already knows both the site's
 * own domain and which org the machine just joined). It arrives as an untrusted query param on a
 * request to a loopback listener that anyone briefly sharing this machine's network namespace
 * could in principle hit during the ~5-minute link window, so the caller must have already
 * checked its origin against the endpoint this CLI is actually configured to trust — see
 * `isTrustedTeamUrl` — before it ever reaches this function. An absent or untrusted URL falls back
 * to the plain static message, never a guess.
 */
function successHtml(teamUrl?: string): string {
  const cta = teamUrl
    ? `<p style="margin-top:12px"><a href="${teamUrl}" style="color:#0969da">Open your team →</a></p>
<meta http-equiv="refresh" content="2;url=${teamUrl}">`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>TraceRoost</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;color:#1f2328;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#f6f8fa}
.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:32px 40px;text-align:center;max-width:360px}
h1{font-size:16px;margin:0 0 8px}p{color:#656d76;margin:0}</style></head>
<body><div class="card"><h1>Machine linked</h1><p>You can close this tab and return to TraceRoost.</p>${cta}</div></body></html>`
}

/** Only ever trust a `team_url` whose origin matches the endpoint this CLI is configured against
 *  (`teamOrigin`, passed by `link.ts` from `teamEndpoint()`) — never an arbitrary redirect target
 *  supplied by whoever hit the loopback port. Malformed input (not a URL, wrong protocol) is
 *  rejected the same as a mismatched origin: silently, falling back to the plain success page. */
function isTrustedTeamUrl(raw: string | null, teamOrigin: string | undefined): string | undefined {
  if (!raw || !teamOrigin) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.origin === teamOrigin ? url.toString() : undefined
  } catch {
    return undefined
  }
}

const ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>TraceRoost</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;color:#1f2328;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#f6f8fa}
.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:32px 40px;text-align:center;max-width:360px}
h1{font-size:16px;margin:0 0 8px}p{color:#656d76;margin:0}</style></head>
<body><div class="card"><h1>Link failed</h1><p>Something went wrong. Return to TraceRoost and try again.</p></div></body></html>`

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/** `callbackPath` defaults to `/callback`; overridable for tests. `timeoutMs` bounds the wait.
 *  `teamOrigin` (e.g. `https://test.traceroost.com`, from `teamEndpoint()`) is the only origin a
 *  `team_url` query param on the callback is ever trusted to link to — see `isTrustedTeamUrl`. */
export async function startCallbackServer(opts: {
  callbackPath?: string
  timeoutMs?: number
  teamOrigin?: string
} = {}): Promise<CallbackServer> {
  const callbackPath = opts.callbackPath ?? '/callback'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let settle: ((r: CallbackResult) => void) | undefined
  let fail: ((e: Error) => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  // The redirect can land before `waitForCallback()` has registered its handlers (a fast
  // `openUrl`, or a test). Buffer whichever comes first so nothing is lost.
  let pendingResult: CallbackResult | undefined
  let pendingError: Error | undefined

  const deliverResult = (r: CallbackResult) => { if (settle) settle(r); else pendingResult = r }
  const deliverError = (e: Error) => { if (fail) fail(e); else pendingError = e }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== callbackPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (error || !code) {
      // Respond to the browser first, *then* reject — otherwise the tab spins.
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(ERROR_HTML)
      deliverError(new Error(error ? `authorization server returned "${error}"` : 'callback missing authorization code'))
      return
    }
    const teamUrl = isTrustedTeamUrl(url.searchParams.get('team_url'), opts.teamOrigin)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(successHtml(teamUrl))
    deliverResult({ code, state: url.searchParams.get('state') })
  })

  const close = () => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    server.close()
    // Drop any keep-alive sockets so the process can exit promptly.
    server.closeAllConnections?.()
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const { port } = server.address() as AddressInfo
  const redirectUri = `http://127.0.0.1:${port}${callbackPath}`

  const waitForCallback = () =>
    new Promise<CallbackResult>((resolve, reject) => {
      settle = (r) => { close(); resolve(r) }
      fail = (e) => { close(); reject(e) }
      if (pendingResult) { settle(pendingResult); return }
      if (pendingError) { fail(pendingError); return }
      timer = setTimeout(() => {
        close()
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser redirect`))
      }, timeoutMs)
      // `unref` so a forgotten link attempt never keeps a CLI process alive.
      timer.unref?.()
    })

  return { redirectUri, waitForCallback, close }
}
