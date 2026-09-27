/**
 * Shared HTTP hardening for the three standalone servers (UI, OTLP, MCP). Two independent
 * defenses:
 *
 *   - Host-header validation: rejects requests whose Host header isn't a loopback alias or
 *     the configured bindHost, which defeats DNS-rebinding (an attacker page that gets a
 *     hostname to resolve to 127.0.0.1 still sends its own hostname as the Host header, not
 *     "localhost" — the browser doesn't rewrite it). Enforced on all three servers, except when
 *     bound to a wildcard address (0.0.0.0 / ::), where the token below is mandatory instead.
 *   - Bearer-token auth: a token generated at first run (`ensureAuthToken` in serviceConfig.ts),
 *     checked via `Authorization: Bearer`, a `?token=` query param, or a `traceroost_token`
 *     cookie. None of the three servers require it while bound to loopback — only another
 *     process on this machine can reach 127.0.0.1 at all, so the token would only ever be
 *     defending against a malicious webpage open in the same browser, not another machine
 *     (that's the deliberate trade — see REQUIRE_TOKEN_EVERYWHERE in standalone/server.ts).
 *     Once BIND_HOST is exposed beyond loopback, the network boundary is gone and the token
 *     becomes load-bearing on all three, uniformly.
 */

import * as crypto from 'crypto'
import type { IncomingMessage } from 'http'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(host)
}

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    return end === -1 ? hostHeader : hostHeader.slice(1, end)
  }
  const idx = hostHeader.lastIndexOf(':')
  return idx === -1 ? hostHeader : hostHeader.slice(0, idx)
}

const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '[::]', '::0'])

/** `0.0.0.0` / `::` — listening on every interface (LAN / Docker mode). */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_BIND_HOSTS.has(host)
}

export function isAllowedHostHeader(hostHeader: string | undefined, bindHost: string): boolean {
  if (!hostHeader) return false
  // Bound to every interface, clients legitimately arrive under any name (LAN IP, hostname,
  // Docker service name) — there is no single "right" Host to compare against. Rebinding is
  // still defeated there because a non-loopback bind makes the bearer token mandatory on every
  // request (REQUIRE_TOKEN_EVERYWHERE in standalone/server.ts), and a rebinding page never has it.
  if (isWildcardHost(bindHost)) return true
  const hostname = hostnameOf(hostHeader)
  return isLoopbackHost(hostname) || hostname === bindHost
}

/**
 * Browsers attach `Origin` to every cross-origin POST (and to same-origin non-GET requests);
 * non-browser clients — agents' OTLP exporters, MCP clients like Claude Code — don't send it at
 * all. So a request is allowed when it carries no Origin, or an Origin that is itself on this
 * machine (loopback) or a VS Code webview. Anything else is some website the user happens to have
 * open, trying to read or write local data through the browser (the MCP spec asks servers to
 * validate Origin for exactly this reason).
 */
export function isAllowedOrigin(origin: string | string[] | undefined, hostHeader?: string): boolean {
  if (origin === undefined) return true
  if (Array.isArray(origin)) return origin.every(o => isAllowedOrigin(o, hostHeader))
  let url: URL
  try { url = new URL(origin) } catch { return false } // includes the opaque "null" origin
  if (url.protocol === 'vscode-webview:') return true
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  // Same-origin: the dashboard's own page calling back to the server that served it (matters in
  // LAN mode, where that page's origin is the LAN address rather than localhost).
  if (hostHeader !== undefined && url.host === hostHeader.toLowerCase()) return true
  return isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ''))
}

const OTLP_CONTENT_TYPES = new Set([
  'application/json', 'application/x-protobuf', 'application/protobuf', 'application/octet-stream',
])

/**
 * OTLP/HTTP bodies are JSON or protobuf. Anything else — above all `text/plain`,
 * `application/x-www-form-urlencoded` and `multipart/form-data`, the "simple" types a web page
 * can POST cross-origin without a CORS preflight — is refused. A missing Content-Type is let
 * through for plain HTTP clients; a browser sending one also sends Origin (see isAllowedOrigin).
 */
export function isAllowedOtlpContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return true
  const mediaType = contentType.split(';')[0].trim().toLowerCase()
  return OTLP_CONTENT_TYPES.has(mediaType)
}

export const AUTH_COOKIE_NAME = 'traceroost_token'

export function authCookieHeader(token: string): string {
  return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
}

export function extractCookieToken(req: Pick<IncomingMessage, 'headers'>): string | null {
  const cookie = req.headers['cookie']
  if (typeof cookie !== 'string') return null
  const match = new RegExp(`(?:^|;\\s*)${AUTH_COOKIE_NAME}=([^;]+)`).exec(cookie)
  return match ? decodeURIComponent(match[1]) : null
}

export function extractToken(req: Pick<IncomingMessage, 'headers' | 'url'>): string | null {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7)
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const qToken = url.searchParams.get('token')
    if (qToken) return qToken
  } catch { /* malformed URL — fall through to cookie */ }
  return extractCookieToken(req)
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/** `expectedToken === ''` means auth isn't configured yet (shouldn't happen once
 *  `ensureAuthToken` has run) — fail open rather than lock everyone out. */
export function isAuthorized(req: Pick<IncomingMessage, 'headers' | 'url'>, expectedToken: string): boolean {
  if (!expectedToken) return true
  const provided = extractToken(req)
  return provided !== null && timingSafeStringEqual(provided, expectedToken)
}
