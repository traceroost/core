/**
 * TraceRoost Pro — team link configuration and credential shape.
 *
 * Everything in `src/cloud/team/` is the *client* half of TraceRoost Pro. None of it runs, makes
 * a request, or reads anything unless a team has been explicitly linked (see `credentials.ts`).
 * An unlinked install never touches the network — that is the invariant AL 01 exists to protect,
 * and it is enforced structurally here: `teamEndpoint()` is only ever read after `loadCredentials()`
 * has returned a non-null value.
 */

/** The hosted TraceRoost Pro service's real environments — mirrors `alsaas/infra`'s Pulumi
 *  stacks exactly (`Pulumi.test.yaml`, `Pulumi.stage.yaml`, `Pulumi.prod.yaml`). Production has
 *  no subdomain: `alsaas`'s prod stack CNAMEs the bare apex, not `app.`. */
export type TeamEnvironment = 'production' | 'stage' | 'test'

const TEAM_ENDPOINTS: Record<TeamEnvironment, string> = {
  production: 'https://traceroost.com',
  stage: 'https://stage.traceroost.com',
  test: 'https://test.traceroost.com',
}

const DEFAULT_TEAM_ENVIRONMENT: TeamEnvironment = 'production'

function isTeamEnvironment(v: string): v is TeamEnvironment {
  return v === 'production' || v === 'stage' || v === 'test'
}

/**
 * Resolves in order: an explicit full URL (`TRACEROOST_TEAM_URL`, for pointing at `alsaas`'s own
 * `pnpm dev` on localhost, or any other one-off target), then a named environment
 * (`TRACEROOST_TEAM_ENV=test|stage|production`), then production. Unset in a normal install —
 * there is no user-facing setting for this, because a linked machine already trusts whatever
 * server issued its token.
 */
export function teamEndpoint(): string {
  const fromUrl = process.env.TRACEROOST_TEAM_URL?.trim()
  if (fromUrl) return stripTrailingSlash(fromUrl)
  const fromEnvName = process.env.TRACEROOST_TEAM_ENV?.trim().toLowerCase()
  if (fromEnvName && isTeamEnvironment(fromEnvName)) return TEAM_ENDPOINTS[fromEnvName]
  return TEAM_ENDPOINTS[DEFAULT_TEAM_ENVIRONMENT]
}

/** Back-compat export — prefer `teamEndpoint()`, which is environment-aware. */
export const DEFAULT_TEAM_ENDPOINT = TEAM_ENDPOINTS[DEFAULT_TEAM_ENVIRONMENT]

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
  // Matches `alsaas/src/app/oauth/device/code/route.ts` — not `/oauth/device` (that path 404s;
  // `/oauth/device` is only the browser-facing verification page).
  return `${endpoint}/oauth/device/code`
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
export const OAUTH_CLIENT_ID = 'traceroost-client'

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
