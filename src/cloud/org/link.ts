/**
 * Org link / leave / status orchestration (AL 01).
 *
 * `linkInteractive` runs the whole PKCE dance: temp loopback server → browser → callback →
 * token exchange → credential written to disk. `linkViaDevice` is the RFC 8628 fallback for
 * headless boxes. `leave` is local-first: it deletes the credential and stops forwarding
 * *before* it attempts the server-side revoke, so it works with the machine offline.
 *
 * The one thing this module guarantees: the loopback listener cannot outlive the attempt.
 * Success, failure, timeout, thrown error — `close()` runs on every path.
 */

import * as os from 'os'
import { createPkcePair, statesMatch } from './pkce'
import { startCallbackServer } from './callbackServer'
import {
  exchangeCode,
  interactiveAuthorizeUrl,
  revokeToken,
  fetchRosterSelf,
  startDeviceFlow,
  pollDeviceFlow,
  type TokenResponse,
} from './oauthClient'
import { loadCredentials, saveCredentials, clearCredentials } from './credentials'
import { orgEndpoint } from './config'
import type { OrgCredentials } from './config'
import { systemBrowserOpener, type UrlOpener } from './browser'

export interface LinkResult {
  orgId: string
  orgName: string
  memberId: string
  role: 'lead' | 'member'
}

function hostnameLabel(): string {
  return (os.hostname() || 'unnamed machine').slice(0, 60)
}

/**
 * Best-effort self-heal for a credential whose `orgName` never resolved at link time (fell back
 * to the raw `orgId`) or whose `email` was never populated at all (a credential written before
 * that field existed) — the roster fetch in `persistFromTokens` failed, returned nothing, or
 * simply didn't exist yet server-side, and nothing retried it until this.
 *
 * Cheap to call opportunistically (every status push, see `panelController.ts`'s `pushStatus`):
 * it's a no-op the instant both are resolved, i.e. as soon as it has ever once succeeded —
 * either here or at link time.
 */
export async function refreshOrgNameIfStale(log?: (m: string) => void): Promise<boolean> {
  const creds = loadCredentials()
  if (!creds || (creds.orgName !== creds.orgId && creds.email)) return false
  const self = await fetchRosterSelf(creds.accessToken, creds.endpoint)
  if (!self?.orgName) {
    log?.('[TraceRoost] could not refresh org name (roster fetch failed or returned none) — will retry')
    return false
  }
  saveCredentials({
    ...creds,
    orgName: self.orgName,
    role: self.role,
    perDeveloperVisibility: self.perDeveloperVisibility,
    email: self.email || creds.email,
  })
  return true
}

async function persistFromTokens(tokens: TokenResponse): Promise<LinkResult> {
  // Best-effort enrichment — the panel degrades gracefully if this is unavailable.
  const self = await fetchRosterSelf(tokens.accessToken)
  const creds: OrgCredentials = {
    endpoint: orgEndpoint(),
    orgId: tokens.orgId,
    installId: tokens.installId,
    orgName: self?.orgName || tokens.orgId,
    memberId: tokens.memberId,
    email: self?.email || undefined,
    role: self?.role ?? 'member',
    perDeveloperVisibility: self?.perDeveloperVisibility ?? false,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: Date.now() + tokens.expiresInSeconds * 1000,
    linkedAt: new Date().toISOString(),
  }
  saveCredentials(creds)
  return { orgId: creds.orgId, orgName: creds.orgName, memberId: creds.memberId, role: creds.role }
}

export interface InteractiveLinkOptions {
  /** Called with the authorize URL so the caller can open it (browser) and/or print it. */
  openUrl?: UrlOpener
  /** Called with the URL as text, always — so a failed auto-open still leaves a pasteable link. */
  onUrl?: (url: string) => void
  timeoutMs?: number
}

export async function linkInteractive(opts: InteractiveLinkOptions = {}): Promise<LinkResult> {
  if (loadCredentials()) {
    throw new Error('this machine is already linked — run `traceroost org leave` first to re-link')
  }
  const pkce = createPkcePair()
  const server = await startCallbackServer({
    timeoutMs: opts.timeoutMs,
    orgOrigin: new URL(orgEndpoint()).origin,
  })
  try {
    const url = interactiveAuthorizeUrl({
      redirectUri: server.redirectUri,
      challenge: pkce.challenge,
      state: pkce.state,
      hostnameLabel: hostnameLabel(),
    })
    opts.onUrl?.(url)
    await (opts.openUrl ?? systemBrowserOpener)(url)

    const cb = await server.waitForCallback()
    if (!statesMatch(pkce.state, cb.state)) {
      server.finish(false)
      throw new Error('state mismatch on the OAuth callback — link aborted (possible CSRF)')
    }
    // The browser tab's response is still open at this point (see callbackServer.ts) — finish()
    // only once the exchange below has actually created the install row, so an org_url
    // auto-redirect never beats the very thing its destination page checks for.
    let result: LinkResult
    try {
      const tokens = await exchangeCode({
        code: cb.code,
        verifier: pkce.verifier,
        redirectUri: server.redirectUri,
      })
      result = await persistFromTokens(tokens)
    } catch (err) {
      server.finish(false)
      throw err
    }
    server.finish(true)
    return result
  } finally {
    server.close()
  }
}

export interface DeviceLinkOptions {
  /** Called once with the user code + verification URL to display. */
  onPrompt: (info: { userCode: string; verificationUri: string; verificationUriComplete?: string }) => void
  /** Poll ceiling; defaults to the server-provided `expires_in`. */
  timeoutMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

export async function linkViaDevice(opts: DeviceLinkOptions): Promise<LinkResult> {
  if (loadCredentials()) {
    throw new Error('this machine is already linked — run `traceroost org leave` first to re-link')
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const start = await startDeviceFlow(hostnameLabel())
  opts.onPrompt({
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    verificationUriComplete: start.verificationUriComplete,
  })

  const deadline = Date.now() + (opts.timeoutMs ?? start.expiresInSeconds * 1000)
  let intervalMs = start.intervalSeconds * 1000
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    const result = await pollDeviceFlow(start.deviceCode)
    if (result.status === 'authorized') return await persistFromTokens(result.tokens)
    if (result.status === 'denied') throw new Error('the link request was denied in the browser')
    if (result.status === 'expired') throw new Error('the device code expired before it was approved')
    if (result.status === 'slow_down') intervalMs += 5_000
  }
  throw new Error('timed out waiting for the device code to be approved')
}

export interface LeaveResult {
  wasLinked: boolean
  serverRevoked: boolean
}

/**
 * Local-first, immediate. The credential is deleted and forwarding stops before any network
 * call. The server-side revoke is attempted afterwards and its failure is not an error — a
 * developer who decides to leave while offline still leaves.
 */
export async function leave(): Promise<LeaveResult> {
  const creds = loadCredentials()
  clearCredentials()
  if (!creds) return { wasLinked: false, serverRevoked: false }
  const [a, b] = await Promise.all([
    revokeToken(creds.refreshToken, creds.endpoint),
    revokeToken(creds.accessToken, creds.endpoint),
  ])
  return { wasLinked: true, serverRevoked: a && b }
}
