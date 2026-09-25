/**
 * One-shot loopback HTTP server for the PKCE redirect (AL 01).
 *
 * Binds `127.0.0.1:0` (a random free port — the callback port is never hardcoded), waits for a
 * single `GET /callback?code=…&state=…`. A bad request (missing code, an `error` param) is
 * answered immediately — nothing further to wait for. A good one is *not* answered immediately:
 * `waitForCallback()` resolves as soon as the request lands, but the actual HTTP response is held
 * open until the caller calls `finish()` — see the note there for why.
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
  /** Resolves with the query params of the first callback hit; rejects on timeout or a bad
   *  request. The browser's own HTTP response is still open at this point — see `finish()`. */
  waitForCallback(): Promise<CallbackResult>
  /**
   * Completes the deferred response to the browser tab that hit the callback. Call this once
   * you know what the tab should be told — after the token exchange (and whatever it creates
   * server-side, e.g. the `installs` row a linked-machine check reads) has actually settled, not
   * before. `ok: true` sends the browser straight to `org_url` (a 302) if the original request
   * carried a trusted one, or the static "Machine linked" page otherwise, since there's nowhere
   * to send it; `ok: false` shows the same failure page an in-flight error does. A no-op if the
   * callback never landed, or this has already been called.
   *
   * Responding immediately (the previous behaviour) raced a `org_url` auto-redirect against the
   * exchange that creates the very row the destination page checks for — a tab could bounce back
   * to the "link your machine" onboarding view because the install didn't exist yet. Holding the
   * response open until the caller says the async work is done removes the race by construction;
   * the exchange is one HTTP round trip plus a couple of inserts, so the tab sees at most a brief
   * pause, not a hang — and a safety timer answers anyway if `finish()` is never reached.
   */
  finish(ok: boolean): void
  /** Idempotent. Safe to call from any exit path — completes any still-open response with the
   *  plain failure page first, so a forgotten `finish()` can never hang the browser tab. */
  close(): void
}

/**
 * `orgUrl`, when present, is a link straight to the org's page on the web app (built by
 * `/oauth/authorize`'s approve action, which is the one place that already knows both the site's
 * own domain and which org the machine just joined). It arrives as an untrusted query param on a
 * request to a loopback listener that anyone briefly sharing this machine's network namespace
 * could in principle hit during the ~5-minute link window, so it's checked against the endpoint
 * this CLI is actually configured to trust — see `isTrustedOrgUrl` — the moment the request
 * lands, before any of it reaches this function. An absent or untrusted URL falls back to the
 * plain static message, never a guess.
 */
/** Shown only when there's no trusted `org_url` to send the browser to directly. */
const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>TraceRoost</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;color:#1f2328;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#f6f8fa}
.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:32px 40px;text-align:center;max-width:360px}
h1{font-size:16px;margin:0 0 8px}p{color:#656d76;margin:0}</style></head>
<body><div class="card"><h1>Machine linked</h1><p>You can close this tab and return to TraceRoost.</p></div></body></html>`

/** Only ever trust a `org_url` whose origin matches the endpoint this CLI is configured against
 *  (`orgOrigin`, passed by `link.ts` from `orgEndpoint()`) — never an arbitrary redirect target
 *  supplied by whoever hit the loopback port. Malformed input (not a URL, wrong protocol) is
 *  rejected the same as a mismatched origin: silently, falling back to the plain success page. */
function isTrustedOrgUrl(raw: string | null, orgOrigin: string | undefined): string | undefined {
  if (!raw || !orgOrigin) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.origin === orgOrigin ? url.toString() : undefined
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
// Bounds how long a good callback's response stays open waiting for finish() — comfortably above
// a real token exchange (one HTTP round trip, a couple of DB writes), so this only ever fires on
// a caller bug, not normal latency.
const FINISH_SAFETY_TIMEOUT_MS = 20_000

/** `callbackPath` defaults to `/callback`; overridable for tests. `timeoutMs` bounds the wait for
 *  the browser redirect to land at all. `orgOrigin` (e.g. `https://test.traceroost.com`, from
 *  `orgEndpoint()`) is the only origin a `org_url` query param on the callback is ever trusted
 *  to link to — see `isTrustedOrgUrl`. */
export async function startCallbackServer(opts: {
  callbackPath?: string
  timeoutMs?: number
  orgOrigin?: string
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

  // The good-request response, held open until finish() — see the interface doc above.
  let pendingRes: http.ServerResponse | undefined
  let pendingOrgUrl: string | undefined
  let finishTimer: ReturnType<typeof setTimeout> | undefined

  const finish = (ok: boolean) => {
    if (!pendingRes) return
    const res = pendingRes
    pendingRes = undefined
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = undefined }
    if (ok && pendingOrgUrl) {
      // Skip the interstitial page entirely — the response was already held open until the
      // caller confirmed the token exchange (and the DB rows it creates) settled, so it's safe
      // to send the browser straight to the org now instead of showing a "Machine linked" card
      // that then auto-redirects a moment later.
      res.writeHead(302, { Location: pendingOrgUrl })
      res.end()
    } else {
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html' })
      res.end(ok ? SUCCESS_HTML : ERROR_HTML)
    }
    close()
  }

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
      // Nothing further to wait for — respond immediately, same as always.
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(ERROR_HTML)
      deliverError(new Error(error ? `authorization server returned "${error}"` : 'callback missing authorization code'))
      return
    }
    pendingRes = res
    pendingOrgUrl = isTrustedOrgUrl(url.searchParams.get('org_url'), opts.orgOrigin)
    finishTimer = setTimeout(() => finish(true), FINISH_SAFETY_TIMEOUT_MS)
    finishTimer.unref?.()
    deliverResult({ code, state: url.searchParams.get('state') })
  })

  const close = () => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    // A still-open good-request response would otherwise hang forever once the listening socket
    // stops accepting new connections below — finish it first, plainly, rather than leave the
    // browser tab spinning.
    finish(false)
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
      // Unlike before, settling here does NOT close the server — the good-request response is
      // still open, waiting on finish(). Only the failure path (no response left pending) closes
      // immediately.
      settle = (r) => resolve(r)
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

  return { redirectUri, waitForCallback, finish, close }
}
