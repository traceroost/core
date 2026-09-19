/**
 * TraceRoost Pro — team link configuration and credential shape.
 *
 * Everything in `src/cloud/team/` is the *client* half of TraceRoost Pro. None of it runs, makes
 * a request, or reads anything unless a team has been explicitly linked (see `credentials.ts`).
 * An unlinked install never touches the network — that is the invariant AL 01 exists to protect,
 * and it is enforced structurally here: `teamEndpoint()` is only ever read after `loadCredentials()`
 * has returned a non-null value.
 */

import { loadSelectedEnvironment } from './environmentSelection'

/** The hosted TraceRoost Pro service's real environments — mirrors `alsaas/infra`'s Pulumi
 *  stacks exactly (`Pulumi.test.yaml`, `Pulumi.stage.yaml`, `Pulumi.prod.yaml`). Production has
 *  no subdomain: `alsaas`'s prod stack CNAMEs the bare apex, not `app.`. */
export type TeamEnvironment = 'production' | 'stage' | 'test'

export const TEAM_ENDPOINTS: Record<TeamEnvironment, string> = {
  production: 'https://traceroost.com',
  stage: 'https://stage.traceroost.com',
  test: 'https://test.traceroost.com',
}

const DEFAULT_TEAM_ENVIRONMENT: TeamEnvironment = 'test'

export function isTeamEnvironment(v: string): v is TeamEnvironment {
  return v === 'production' || v === 'stage' || v === 'test'
}

/** Where `resolveTeamEnvironment()` got its answer from, surfaced so the Team panel can explain
 *  itself (e.g. "test — set by .env" vs "test — chosen in this panel") and know whether its own
 *  picker should even be enabled (it can't override `env-url`/`env-var`/`release`). */
export type EnvironmentSource = 'env-url' | 'env-var' | 'selected' | 'default' | 'release'

export interface ResolvedEnvironment {
  endpoint: string
  /** The known environment this endpoint matches, or `'custom'` when `TRACEROOST_TEAM_URL` points
   *  somewhere outside `TEAM_ENDPOINTS` (e.g. `alsaas`'s own `pnpm dev` on localhost). */
  environment: TeamEnvironment | 'custom'
  source: EnvironmentSource
}

/**
 * Resolves in order: a release build (locked to production, full stop — see below), then an
 * explicit full URL (`TRACEROOST_TEAM_URL`, for pointing at `alsaas`'s own `pnpm dev` on
 * localhost, or any other one-off target), then a named environment
 * (`TRACEROOST_TEAM_ENV=test|stage|production`, settable via `.env` for `npm run local`), then a
 * selection persisted from the Team panel (`environmentSelection.ts`), then production.
 *
 * Only ever consulted pre-link (every call site for a linked machine passes `creds.endpoint`
 * explicitly instead) — so this, and the picker behind step four, only ever affects an unlinked
 * install, matching AL 01: a linked machine already trusts whatever server issued its token.
 */
export function resolveTeamEnvironment(): ResolvedEnvironment {
  // Environment selection (the picker, TRACEROOST_TEAM_ENV, TRACEROOST_TEAM_URL) exists for
  // developing and testing TraceRoost Pro itself, never for a real install. `TRACEROOST_RELEASE_BUILD`
  // is baked in by esbuild.js at build time for both real release paths (`vscode:prepublish` and
  // `prepublishOnly`, both → `pnpm run package`) — not read from the real environment at runtime —
  // so a shipped install can't be pointed anywhere but production by setting a shell/`.env` var.
  if (process.env.TRACEROOST_RELEASE_BUILD) {
    return { endpoint: TEAM_ENDPOINTS.production, environment: 'production', source: 'release' }
  }
  const fromUrl = process.env.TRACEROOST_TEAM_URL?.trim()
  if (fromUrl) {
    const endpoint = stripTrailingSlash(fromUrl)
    const known = (Object.keys(TEAM_ENDPOINTS) as TeamEnvironment[]).find(
      (k) => TEAM_ENDPOINTS[k] === endpoint,
    )
    return { endpoint, environment: known ?? 'custom', source: 'env-url' }
  }
  const fromEnvName = process.env.TRACEROOST_TEAM_ENV?.trim().toLowerCase()
  if (fromEnvName && isTeamEnvironment(fromEnvName)) {
    return { endpoint: TEAM_ENDPOINTS[fromEnvName], environment: fromEnvName, source: 'env-var' }
  }
  const selected = loadSelectedEnvironment()
  if (selected) {
    return { endpoint: TEAM_ENDPOINTS[selected], environment: selected, source: 'selected' }
  }
  return { endpoint: TEAM_ENDPOINTS[DEFAULT_TEAM_ENVIRONMENT], environment: DEFAULT_TEAM_ENVIRONMENT, source: 'default' }
}

export function teamEndpoint(): string {
  return resolveTeamEnvironment().endpoint
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

/** The org's own pricing table (rates.read) — see pricingSync.ts. */
export function ratesUrl(endpoint = teamEndpoint()): string {
  return `${endpoint}/api/rates/effective`
}

/** Resolves a Repeat work cluster's repo hash + key (clusters.read) back to its raw session ids —
 *  see clusterResolve.ts and the `traceroost cluster` CLI command. */
export function clusterResolveUrl(endpoint = teamEndpoint()): string {
  return `${endpoint}/api/clusters/resolve`
}

/** The OAuth client id the CLI/extension identifies as. Public by design — PKCE is what
 *  secures the exchange, not a client secret (there is none). */
export const OAUTH_CLIENT_ID = 'traceroost-client'

/** Scope requested at link time. Read-only membership, write-only rollup ingest, read-only access
 *  to the org's own pricing table (rates.read — see pricingSync.ts), and read-only resolution of a
 *  Repeat work cluster's own session ids (clusters.read — see clusterResolve.ts); nothing that
 *  could read another member's data or a repository. */
export const OAUTH_SCOPE = 'rollup.write roster.read rates.read clusters.read'

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
  /** This specific linked install's id, assigned by the service at link time — a fresh one is
   *  minted on every link, even a re-link to the same org from the same machine (see
   *  `deliveryLedger.ts`'s `scopedKey`, which is keyed on this, not `orgId`, for exactly that
   *  reason). Optional: a credential written before this field existed simply lacks it until
   *  `ensureInstallId` (`credentials.ts`) backfills it via a token refresh — never a reason to
   *  reject an otherwise-valid credential file. */
  installId?: string
  /** Human-readable org name, cached from the link response for offline display. */
  orgName: string
  /** This member's id, assigned by the service at link time — never chosen locally (AL 02). */
  memberId: string
  /** This member's own login email, cached from the link response for offline display. Reading
   *  it back is not a roster leak — it's always this machine's own member row (AL 02). Optional:
   *  a credential written before this field existed simply lacks it until `refreshOrgNameIfStale`
   *  backfills it — never a reason to reject an otherwise-valid credential file. */
  email?: string
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
