/**
 * HTTP client for the AgentLens Pro OAuth + roster endpoints (AL 01).
 *
 * Every function here is only ever reached from an explicit user action (`team link`, a token
 * refresh inside AL 04's sender, `team leave`) or from the linked Team panel refreshing itself.
 * None of it runs on an unlinked install. The contract mirrors `alsaas/src/app/oauth/*` and
 * `alsaas/src/app/api/*` exactly.
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  authorizeUrl,
  tokenUrl,
  revokeUrl,
  deviceCodeUrl,
  teamEndpoint,
} from './config'
import { buildAuthorizeUrl } from './pkce'

export interface TokenResponse {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
  memberId: string
  orgId: string
}

interface RawTokenBody {
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  member_id?: string
  org_id?: string
  error?: string
}

const REQUEST_TIMEOUT_MS = 15_000

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
  return `agentlens-client/${clientVersion()}`
}

let cachedVersion: string | undefined
export function clientVersion(): string {
  if (cachedVersion) return cachedVersion
  // Read at runtime rather than importing package.json — the module is bundled (esbuild) into
  // several entry points whose depth relative to the repo root differs, so a static import path
  // would be wrong in at least one of them.
  for (const rel of ['..', '../..', '../../..']) {
    try {
      const raw = fs.readFileSync(path.join(__dirname, rel, 'package.json'), 'utf-8')
      const v = (JSON.parse(raw) as { name?: string; version?: string })
      if (v.name === 'agentlens-dashboard' && v.version) { cachedVersion = v.version; return cachedVersion }
    } catch { /* try the next candidate */ }
  }
  cachedVersion = '0.0.0'
  return cachedVersion
}

function parseTokenBody(raw: RawTokenBody): TokenResponse {
  if (!raw.access_token || !raw.refresh_token || !raw.member_id || !raw.org_id) {
    throw new Error(`token endpoint returned an incomplete response${raw.error ? ` (${raw.error})` : ''}`)
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresInSeconds: typeof raw.expires_in === 'number' ? raw.expires_in : 3600,
    memberId: raw.member_id,
    orgId: raw.org_id,
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
    scope: OAUTH_SCOPE,
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
  if (!res.ok) throw new Error(`link failed: ${raw.error ?? `HTTP ${res.status}`}`)
  return parseTokenBody(raw)
}

/** Refresh an access token. Used by AL 04's sender on a 401. */
export async function refreshTokens(refreshToken: string, endpoint = teamEndpoint()): Promise<TokenResponse> {
  const res = await postForm(tokenUrl(endpoint), {
    grant_type: 'refresh_token',
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  })
  const raw = (await res.json().catch(() => ({}))) as RawTokenBody
  if (!res.ok) throw new Error(`token refresh failed: ${raw.error ?? `HTTP ${res.status}`}`)
  return parseTokenBody(raw)
}

/** RFC 7009 revoke. Best-effort — leaving is local-first and must not depend on this. Returns
 *  whether the server acknowledged; a `false` is not an error (the local credential is already
 *  gone by the time this is called). */
export async function revokeToken(token: string, endpoint = teamEndpoint()): Promise<boolean> {
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
  const res = await postForm(deviceCodeUrl(), { label: hostnameLabel, client_id: OAUTH_CLIENT_ID })
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || typeof raw.device_code !== 'string' || typeof raw.user_code !== 'string') {
    throw new Error(`device flow could not start: ${(raw.error as string) ?? `HTTP ${res.status}`}`)
  }
  return {
    deviceCode: raw.device_code,
    userCode: raw.user_code,
    verificationUri: String(raw.verification_uri ?? `${teamEndpoint()}/oauth/device`),
    verificationUriComplete: typeof raw.verification_uri_complete === 'string' ? raw.verification_uri_complete : undefined,
    expiresInSeconds: typeof raw.expires_in === 'number' ? raw.expires_in : 900,
    intervalSeconds: typeof raw.interval === 'number' ? raw.interval : 5,
  }
}

export type DevicePollResult =
  | { status: 'authorized'; tokens: TokenResponse }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied' }
  | { status: 'expired' }

export async function pollDeviceFlow(deviceCode: string): Promise<DevicePollResult> {
  const res = await postForm(`${teamEndpoint()}/oauth/device/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: OAUTH_CLIENT_ID,
  })
  const raw = (await res.json().catch(() => ({}))) as RawTokenBody
  if (res.ok) return { status: 'authorized', tokens: parseTokenBody(raw) }
  switch (raw.error) {
    case 'authorization_pending': return { status: 'pending' }
    case 'slow_down': return { status: 'slow_down' }
    case 'access_denied': return { status: 'denied' }
    case 'expired_token': return { status: 'expired' }
    default: throw new Error(`device flow failed: ${raw.error ?? `HTTP ${res.status}`}`)
  }
}

// ── Roster self-lookup ──────────────────────────────────────────────────────
//
// The token response gives us org_id and member_id but not the org's *name*, this member's
// *role*, or the org's per-developer-visibility setting — all of which the linked panel states
// as fact. `alsaas` exposes these to a bearer token at `GET /api/roster/me` once the repos are
// reconciled; until then this degrades cleanly (the panel shows the ids and a "checking…" note
// rather than inventing a value).

export interface RosterSelf {
  orgName: string
  role: 'lead' | 'member'
  perDeveloperVisibility: boolean
}

export async function fetchRosterSelf(accessToken: string, endpoint = teamEndpoint()): Promise<RosterSelf | null> {
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
      role: raw.role === 'lead' ? 'lead' : 'member',
      perDeveloperVisibility: raw.per_developer_visibility === true,
    }
  } catch {
    return null
  }
}
