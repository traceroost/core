/**
 * AgentLens Pro — team link configuration and credential shape.
 *
 * Everything in `src/team/` is the *client* half of AgentLens Pro. None of it runs, makes a
 * request, or reads anything unless a team has been explicitly linked (see `credentials.ts`).
 * An unlinked install never touches the network — that is the invariant AL 01 exists to protect,
 * and it is enforced structurally here: `teamEndpoint()` is only ever read after `loadCredentials()`
 * has returned a non-null value.
 */

/** The hosted AgentLens Pro service. Overridable for self-hosted/staging via env; there is no
 *  setting for it, because a linked machine already trusts whatever server issued its token. */
export const DEFAULT_TEAM_ENDPOINT = 'https://app.agentlens.dev'

export function teamEndpoint(): string {
  const fromEnv = process.env.AGENTLENS_TEAM_URL?.trim()
  return (fromEnv && stripTrailingSlash(fromEnv)) || DEFAULT_TEAM_ENDPOINT
}

function stripTrailingSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u
}

/** OAuth endpoints on the Pro service, per SA 03 (the PKCE authorization server). */
export function authorizeUrl(endpoint = teamEndpoint()): string {
  return `${endpoint}/oauth/authorize`
}
export function tokenUrl(endpoint = teamEndpoint()): string {
  return `${endpoint}/oauth/token`
}
export function deviceCodeUrl(endpoint = teamEndpoint()): string {
  return `${endpoint}/oauth/device`
}
export function revokeUrl(endpoint = teamEndpoint()): string {
  return `${endpoint}/oauth/revoke`
}
/** The ingest endpoint AL 04 drains its queue to. Named here so there is one list of every
 *  URL the client can ever contact — a reviewer auditing "what can this thing reach" reads
 *  this file and nothing else. */
export function ingestUrl(endpoint = teamEndpoint()): string {
  return `${endpoint}/api/ingest`
}

/** The OAuth client id the CLI/extension identifies as. Public by design — PKCE is what
 *  secures the exchange, not a client secret (there is none). */
export const OAUTH_CLIENT_ID = 'agentlens-client'

/** Scope requested at link time. Read-only membership + write-only rollup ingest; nothing
 *  that could read another member's data or a repository. */
export const OAUTH_SCOPE = 'rollup.write roster.read'

/**
 * The on-disk credential for a linked machine. Written only by `credentials.ts`, only after a
 * completed link, with user-only permissions. Contains no key material — `repo_key` (AL 02) is
 * derived from the local clone on demand and never stored.
 */
export interface TeamCredentials {
  /** Base URL of the service that issued this credential. */
  endpoint: string
  /** Organisation the machine is linked to. Opaque; assigned by the service. */
  orgId: string
  /** Human-readable org name, cached from the link response for offline display. */
  orgName: string
  /** This member's id, assigned by the service at link time — never chosen locally (AL 02). */
  memberId: string
  /** This member's role in the org, cached for offline display. The server is authoritative. */
  role: 'lead' | 'member'
  /** Whether this org lets a member see their own numbers in the team view. Display-only cache. */
  perDeveloperVisibility: boolean
  /** OAuth tokens. `accessToken` is short-lived; `refreshToken` is used by AL 04's sender. */
  accessToken: string
  refreshToken: string
  /** Unix ms at which `accessToken` expires. */
  accessTokenExpiresAt: number
  /** When this machine was linked, ISO 8601. */
  linkedAt: string
}
