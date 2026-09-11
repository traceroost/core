/**
 * OAuth 2.0 PKCE (RFC 7636) + CSRF-state helpers for the team link flow (AL 01).
 *
 * Pure crypto, no I/O — unit-tested directly. The verifier never leaves the process; only the
 * S256 challenge is put in the authorize URL, and the verifier is presented once at token
 * exchange over TLS.
 */

import * as crypto from 'crypto'

/** RFC 7636 §4.1: 43–128 chars from the unreserved set. 32 random bytes → 43 base64url chars. */
export function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(32))
}

/** RFC 7636 §4.2, S256: BASE64URL(SHA256(ASCII(verifier))). */
export function deriveCodeChallenge(verifier: string): string {
  return base64UrlEncode(crypto.createHash('sha256').update(verifier, 'ascii').digest())
}

/** Opaque value echoed back on the redirect and compared byte-for-byte to defeat CSRF. */
export function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(16))
}

export interface PkcePair {
  verifier: string
  challenge: string
  method: 'S256'
  state: string
}

export function createPkcePair(): PkcePair {
  const verifier = generateCodeVerifier()
  return { verifier, challenge: deriveCodeChallenge(verifier), method: 'S256', state: generateState() }
}

/** Constant-time-ish state comparison. `crypto.timingSafeEqual` throws on length mismatch, so
 *  guard that first (a length mismatch is already a definite non-match). */
export function statesMatch(expected: string, received: string | undefined | null): boolean {
  if (!received || expected.length !== received.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))
}

export function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Builds the authorize URL. `redirectUri` is the loopback callback the one-shot server listens
 * on (random port — never hardcoded). `127.0.0.1`, not `localhost`, to avoid a DNS hop.
 */
export function buildAuthorizeUrl(opts: {
  authorizeEndpoint: string
  clientId: string
  redirectUri: string
  scope: string
  challenge: string
  state: string
}): string {
  const u = new URL(opts.authorizeEndpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', opts.clientId)
  u.searchParams.set('redirect_uri', opts.redirectUri)
  u.searchParams.set('scope', opts.scope)
  u.searchParams.set('code_challenge', opts.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', opts.state)
  return u.toString()
}
