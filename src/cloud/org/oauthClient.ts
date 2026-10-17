/**
 * HTTP client for the TraceRoost Cloud OAuth + roster endpoints (AL 01).
 *
 * Every function here is only ever reached from an explicit user action (`org link`, a token
 * refresh inside AL 04's sender, `org leave`) or from the linked Org panel refreshing itself.
 * None of it runs on an unlinked install. The contract mirrors `cloud/src/app/oauth/*` and
 * `cloud/src/app/api/*` exactly.
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  OAUTH_CLIENT_ID,
  authorizeUrl,
  tokenUrl,
  revokeUrl,
  deviceCodeUrl,
  orgEndpoint,
} from './config'
import { buildAuthorizeUrl } from './pkce'

export interface TokenResponse {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
  memberId: string
  orgId: string
  /** This install's id — a fresh one is minted on every link, even a re-link to the same org
   *  from the same machine. See `deliveryLedger.ts`'s `scopedKey`. */
  installId: string
}

interface RawTokenBody {
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  member_id?: string
  org_id?: string
  install_id?: string
  error?: string
  /** RFC 6749 §5.2's human-readable detail — the cloud's machine-cap refusal puts its message here
   *  (`error: "access_denied"`). */
  error_description?: string
}

/** `error_description` when the server gave one (the human message — e.g. the free tier's machine
 *  cap), else the bare `error` code, else the HTTP status. */
export function describeOAuthError(raw: { error?: unknown; error_description?: unknown }, status: number): string {
  if (typeof raw.error_description === 'string' && raw.error_description.trim()) return raw.error_description.trim()
  if (typeof raw.error === 'string' && raw.error) return raw.error
  return `HTTP ${status}`
}

const REQUEST_TIMEOUT_MS = 15_000

/** Thrown by `refreshTokens` when the token endpoint rejects the request. `permanent` is true
 *  only when the server told us the refresh token/client itself is bad (`invalid_grant` —
 *  expired, revoked, or already used; `invalid_client`) — that credential will never refresh
 *  successfully again, no matter how many times it's retried. Anything else (a 5xx, a timeout,
 *  a malformed body) says something about the network or the service, not the credential, so
 *  `permanent` is false and callers should keep it and retry later. */
export class TokenRefreshError extends Error {
  /** `upgradeRequired`: the cloud answered 426 `client_upgrade_required` — this TraceRoost
   *  version is too old; nothing is wrong with the credential (not permanent). */
  /** `unanswered`: the request may have reached the cloud but no definite answer came back (a
   *  timeout, a reset, a gateway error or a body that isn't the cloud's) — the token may or may
   *  not have been rotated server-side. Never set when no connection was made (offline, DNS,
   *  refused): see `isUnansweredPresentation`. */
  constructor(message: string, public readonly permanent: boolean, public readonly upgradeRequired = false, public readonly unanswered = false) {
    super(message)
  }
}

/**
 * The refresh token was already presented `MAX_UNANSWERED_PRESENTATIONS` times without an answer,
 * so it is never sent again. Not `permanent`: that is a local inference, not the cloud's
 * `invalid_grant` — the cloud may well still hold this machine's install. The sender
 * (`sender.ts`, `holdForRelink`; thrown by `tokenRefresh.ts`) therefore asks for a re-link but keeps the queued traces, where a
 * permanent error drops them.
 */
export class RefreshReplayExhaustedError extends TokenRefreshError {
  constructor() {
    super('token refresh failed: this refresh token was already presented twice without an answer — re-link this machine', false)
  }
}

/** Error codes (on a thrown error or anywhere down its `cause` chain — Node's fetch throws
 *  `TypeError('fetch failed')` with the socket/DNS error as `cause`) that mean no connection to
 *  the server was ever made, so the request — and the refresh token in it — never left this
 *  machine: DNS failed, the connection was refused, there is no route or no network, or the TCP
 *  connect itself timed out (undici's `UND_ERR_CONNECT_TIMEOUT`). `UND_ERR_PRX_TLS` is the TLS
 *  handshake to a proxy failing, before anything is forwarded. */
const NEVER_CONNECTED_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_PRX_TLS',
])
/** undici's message when an HTTPS proxy refuses the CONNECT tunnel (a 403/407 from the proxy) —
 *  the request was never forwarded to the server. */
const PROXY_TUNNEL_REFUSED = /^Proxy response \(\d{3}\) !== 200 when HTTP Tunneling/

function neverConnected(err: unknown, depth: number): boolean {
  if (depth > 8 || !err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown }
  if (typeof e.code === 'string' && NEVER_CONNECTED_CODES.has(e.code)) return true
  if (typeof e.message === 'string' && PROXY_TUNNEL_REFUSED.test(e.message)) return true
  // Happy-eyeballs connects fail with an AggregateError of one error per address tried: none of
  // them connected only if every one of them says so.
  if (Array.isArray(e.errors) && e.errors.length > 0 && e.errors.every(x => neverConnected(x, depth + 1))) return true
  return neverConnected(e.cause, depth + 1)
}

/** How a refresh request ended without tokens: it threw (`thrown`), or the server — or something
 *  in front of it — answered `status` with `oauthError` as the body's `error` field (absent when
 *  the body wasn't the cloud's OAuth JSON). */
export type RefreshFailure =
  | { thrown: unknown }
  | { status: number; oauthError: unknown }

/**
 * Whether a failed refresh is an *unanswered presentation*: the refresh token may have reached the
 * cloud — which may then have rotated it — but no definite answer came back. Those are counted
 * (`tokenRefresh.ts`, `MAX_UNANSWERED_PRESENTATIONS`), because the cloud honours a replay of the
 * just-rotated token only once.
 *
 * - Unanswered: a timeout or abort (we can't tell whether it connected first, so it counts), a
 *   connection reset or close after connecting, any other thrown error, and an HTTP error whose
 *   body has no OAuth `error` code (a gateway's 502/503/504 page — the cloud itself always
 *   answers with one).
 * - Not unanswered: no connection was ever made (`NEVER_CONNECTED_CODES` anywhere in the cause
 *   chain, or a refused proxy tunnel); a 407 from an HTTP proxy (it refused before forwarding);
 *   and the cloud's own OAuth error, which is a definite answer.
 *
 * This is the one place this is decided — an offline laptop must never use up its replay.
 */
export function isUnansweredPresentation(failure: RefreshFailure): boolean {
  if ('thrown' in failure) return !neverConnected(failure.thrown, 0)
  if (typeof failure.oauthError === 'string') return false
  return failure.status !== 407
}

function describeThrown(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const e = cur as { message?: unknown; code?: unknown; cause?: unknown }
    const bit = typeof e.code === 'string' ? `${String(e.message ?? '')} (${e.code})` : String(e.message ?? '')
    if (bit.trim()) parts.push(bit.trim())
    cur = e.cause
  }
  return parts.join(': ') || String(err)
}

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent(),
      },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

function userAgent(): string {
  return `traceroost-client/${clientVersion()}`
}

let cachedVersion: string | undefined
export function clientVersion(): string {
  if (cachedVersion) return cachedVersion
  // Read at runtime rather than importing package.json — the module is bundled (esbuild) into
  // several entry points whose depth relative to the repo root differs, so a static import path
  // would be wrong in at least one of them.
  for (const rel of ['..', '../..', '../../..']) {
    try {
      const v = versionFromPackageJson(fs.readFileSync(path.join(__dirname, rel, 'package.json'), 'utf-8'))
      if (v) { cachedVersion = v; return cachedVersion }
    } catch { /* try the next candidate */ }
  }
  cachedVersion = '0.0.0'
  return cachedVersion
}

/** The extension ships as `agentlens-dashboard`, the npm/standalone package as `traceroost`; any
 *  other package.json found on the way up (a host project's) is not ours. */
const OUR_PACKAGE_NAMES = new Set(['agentlens-dashboard', 'traceroost'])

/** The version in a package.json body, if it is one of ours. Exported for tests. */
export function versionFromPackageJson(raw: string): string | undefined {
  const v = JSON.parse(raw) as { name?: string; version?: string }
  return v.name && OUR_PACKAGE_NAMES.has(v.name) && v.version ? v.version : undefined
}

/** RFC 6749 §5.2: a refresh rejected with `invalid_grant` or `invalid_client` will never succeed
 *  on retry. Matches on the code before any space or parenthesis, so a server that appends detail
 *  to `error` (`invalid_grant (refresh token expired)`) is still read as permanent. */
export function isPermanentRefreshError(error: unknown): boolean {
  if (typeof error !== 'string') return false
  const code = error.trim().split(/[\s(]/, 1)[0]
  return code === 'invalid_grant' || code === 'invalid_client'
}

function parseTokenBody(raw: RawTokenBody): TokenResponse {
  if (!raw.access_token || !raw.refresh_token || !raw.member_id || !raw.org_id || !raw.install_id) {
    throw new Error(`token endpoint returned an incomplete response${raw.error ? ` (${raw.error})` : ''}`)
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresInSeconds: typeof raw.expires_in === 'number' ? raw.expires_in : 3600,
    memberId: raw.member_id,
    orgId: raw.org_id,
    installId: raw.install_id,
  }
}

/** The URL to open in a browser for the interactive PKCE flow. */
export function interactiveAuthorizeUrl(opts: {
  redirectUri: string
  challenge: string
  state: string
  hostnameLabel: string
}): string {
  const base = buildAuthorizeUrl({
    authorizeEndpoint: authorizeUrl(),
    clientId: OAUTH_CLIENT_ID,
    redirectUri: opts.redirectUri,
    challenge: opts.challenge,
    state: opts.state,
  })
  const u = new URL(base)
  u.searchParams.set('label', opts.hostnameLabel)
  u.searchParams.set('client_version', clientVersion())
  return u.toString()
}

/** Exchange an authorization code + PKCE verifier for tokens. */
export async function exchangeCode(opts: {
  code: string
  verifier: string
  redirectUri: string
}): Promise<TokenResponse> {
  const res = await postForm(tokenUrl(), {
    grant_type: 'authorization_code',
    client_id: OAUTH_CLIENT_ID,
    code: opts.code,
    code_verifier: opts.verifier,
    redirect_uri: opts.redirectUri,
  })
  const raw = (await res.json().catch(() => ({}))) as RawTokenBody
  if (!res.ok) throw new Error(`link failed: ${describeOAuthError(raw, res.status)}`)
  return parseTokenBody(raw)
}

/** Refresh an access token. Used by AL 04's sender on a 401. */
export async function refreshTokens(refreshToken: string, endpoint = orgEndpoint()): Promise<TokenResponse> {
  let res: Response
  try {
    res = await postForm(tokenUrl(endpoint), {
      grant_type: 'refresh_token',
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    })
  } catch (err) {
    // A network failure: whether it counts against the token depends on whether the request could
    // have reached the cloud at all (offline, DNS, refused — it couldn't).
    throw new TokenRefreshError(`token refresh failed: ${describeThrown(err)}`, false, false, isUnansweredPresentation({ thrown: err }))
  }
  const raw = (await res.json().catch(() => ({}))) as RawTokenBody
  if (!res.ok) {
    if (res.status === 426 && raw.error === 'client_upgrade_required') {
      throw new TokenRefreshError('token refresh failed: client_upgrade_required', false, true)
    }
    const permanent = isPermanentRefreshError(raw.error)
    // The cloud always answers with an OAuth `error` code (a database failure is `server_error`, a
    // definite "nothing rotated"); a bare 5xx is a gateway's, and says nothing about the token.
    throw new TokenRefreshError(`token refresh failed: ${raw.error ?? `HTTP ${res.status}`}`, permanent, false, isUnansweredPresentation({ status: res.status, oauthError: raw.error }))
  }
  return parseTokenBody(raw)
}

/** RFC 7009 revoke. Best-effort — leaving is local-first and must not depend on this. Returns
 *  whether the server acknowledged; a `false` is not an error (the local credential is already
 *  gone by the time this is called). */
export async function revokeToken(token: string, endpoint = orgEndpoint()): Promise<boolean> {
  try {
    const res = await postForm(revokeUrl(endpoint), { token, client_id: OAUTH_CLIENT_ID })
    return res.ok
  } catch {
    return false
  }
}

// ── Device authorization grant (RFC 8628) — the documented CI / devcontainer fallback ──

export interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresInSeconds: number
  intervalSeconds: number
}

export async function startDeviceFlow(hostnameLabel: string): Promise<DeviceCodeResponse> {
  // `client_version` as the auth-code flow sends it (interactiveAuthorizeUrl) — the approval page
  // shows it next to the label.
  const res = await postForm(deviceCodeUrl(), { label: hostnameLabel, client_id: OAUTH_CLIENT_ID, client_version: clientVersion() })
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || typeof raw.device_code !== 'string' || typeof raw.user_code !== 'string') {
    throw new Error(`device flow could not start: ${describeOAuthError(raw, res.status)}`)
  }
  return {
    deviceCode: raw.device_code,
    userCode: raw.user_code,
    verificationUri: String(raw.verification_uri ?? `${orgEndpoint()}/oauth/device`),
    verificationUriComplete: typeof raw.verification_uri_complete === 'string' ? raw.verification_uri_complete : undefined,
    expiresInSeconds: typeof raw.expires_in === 'number' ? raw.expires_in : 900,
    intervalSeconds: typeof raw.interval === 'number' ? raw.interval : 5,
  }
}

export type DevicePollResult =
  | { status: 'authorized'; tokens: TokenResponse }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied'; message?: string }
  /** Approved, but refused for now — the org's free tier has no machine slot left (HTTP 403
   *  `access_denied`, the reason in `error_description`). The cloud keeps the code pending, so the
   *  same code links once the org upgrades or frees a machine: keep polling. */
  | { status: 'blocked'; message: string }
  | { status: 'expired' }

export async function pollDeviceFlow(deviceCode: string): Promise<DevicePollResult> {
  const res = await postForm(`${orgEndpoint()}/oauth/device/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: OAUTH_CLIENT_ID,
  })
  const raw = (await res.json().catch(() => ({}))) as RawTokenBody
  if (res.ok) return { status: 'authorized', tokens: parseTokenBody(raw) }
  const description = typeof raw.error_description === 'string' && raw.error_description.trim() ? raw.error_description.trim() : undefined
  switch (raw.error) {
    case 'authorization_pending': return { status: 'pending' }
    case 'slow_down': return { status: 'slow_down' }
    // RFC 8628 answers a denial with 400. The cap gate answers 403 and leaves the code pending.
    case 'access_denied':
      return res.status === 403 ? { status: 'blocked', message: description ?? 'This org has no machine slot left.' } : { status: 'denied', message: description }
    case 'expired_token': return { status: 'expired' }
    default: throw new Error(`device flow failed: ${describeOAuthError(raw, res.status)}`)
  }
}

// ── Roster self-lookup ──────────────────────────────────────────────────────
//
// The token response gives us org_id and member_id but not the org's *name*, this member's
// *role* or *email*, or the org's per-developer-visibility setting — all of which the linked
// panel states as fact. `cloud` exposes these to a bearer token at `GET /api/roster/me`; if
// that ever fails (network, a token revoked mid-flight, a future server issue) this degrades
// cleanly — the panel shows the ids and a "checking…" note rather than inventing a value.

export interface RosterSelf {
  orgName: string
  role: 'admin' | 'developer'
  perDeveloperVisibility: boolean
  /** This member's own login email — reading it back is not a roster leak (AL 02): the server
   *  scopes `/api/roster/me` to the bearer token's own member row, never another member's. */
  email: string
  /** The org's own "who sees what about you" paragraph, from its teammate-visibility switches
   *  (cloud `teammateVisibilitySummary`) — shown instead of the generic `whoSeesWhat` line when
   *  present. Absent from an older cloud. */
  teammateVisibilitySummary?: string
}

export async function fetchRosterSelf(accessToken: string, endpoint = orgEndpoint()): Promise<RosterSelf | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const res = await fetch(`${endpoint}/api/roster/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': userAgent() },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    if (!res.ok) return null
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return {
      orgName: typeof raw.org_name === 'string' ? raw.org_name : '',
      // `admin` / `developer` since cloud's 0031 rename; an older server's `lead` is the same role.
      role: raw.role === 'admin' || raw.role === 'lead' ? 'admin' : 'developer',
      perDeveloperVisibility: raw.per_developer_visibility === true,
      email: typeof raw.email === 'string' ? raw.email : '',
      ...(typeof raw.teammate_visibility_summary === 'string' && raw.teammate_visibility_summary.trim()
        ? { teammateVisibilitySummary: raw.teammate_visibility_summary.trim().slice(0, 1000) }
        : {}),
    }
  } catch {
    return null
  }
}

// ── This install's own trace count ──────────────────────────────────────────
//
// `traceroost org verify` answers "does the server have everything I see locally" — this is
// the server-side half of that comparison. Scoped to this machine's own install by the bearer
// token server-side (AL 02: never another install's count), same trust boundary as roster/me.

export interface InstallStats {
  sessions: number
  lastAt: string | null
}

export async function fetchInstallStats(accessToken: string, endpoint = orgEndpoint()): Promise<InstallStats | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const res = await fetch(`${endpoint}/api/installs/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': userAgent() },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    if (!res.ok) return null
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return {
      sessions: typeof raw.sessions === 'number' ? raw.sessions : 0,
      lastAt: typeof raw.last_at === 'string' ? raw.last_at : null,
    }
  } catch {
    return null
  }
}
