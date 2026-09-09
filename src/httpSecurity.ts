/**
 * Shared HTTP hardening for the three standalone servers (UI, OTLP, MCP) — see
 * .staged-issues/01-enterprise-readiness.md phase 1. Two independent defenses:
 *
 *   - Host-header validation: rejects requests whose Host header isn't a loopback alias or
 *     the configured bindHost, which defeats DNS-rebinding (an attacker page that gets a
 *     hostname to resolve to 127.0.0.1 still sends its own hostname as the Host header, not
 *     "localhost" — the browser doesn't rewrite it).
 *   - Bearer-token auth: a token generated at first run (`ensureAuthToken` in serviceConfig.ts),
 *     checked via `Authorization: Bearer`, a `?token=` query param, or an `traceroost_token`
 *     cookie. Enforced everywhere on the UI server (the CLI hands the token to the browser when
 *     it opens the dashboard); on OTLP/MCP it only activates once BIND_HOST is non-loopback,
 *     so today's default loopback setup and existing agent auto-configuration keep working
 *     unauthenticated exactly as before.
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

export function isAllowedHostHeader(hostHeader: string | undefined, bindHost: string): boolean {
  if (!hostHeader) return false
  const hostname = hostnameOf(hostHeader)
  return isLoopbackHost(hostname) || hostname === bindHost
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
