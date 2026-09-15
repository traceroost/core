/**
 * The single source of truth for "what is this machine's Pro state right now" — consumed by the
 * Team panel (AL 01), the tab-bar state dot, and `traceroost team status`.
 *
 * It is rendered from **local data only**. An unlinked install produces a complete status object
 * without making a single request; that is what lets the panel's unlinked state exist with the
 * network invariant intact.
 */

import { loadCredentials } from './credentials'
import { clientVersion } from './oauthClient'
import { resolveTeamEnvironment, TEAM_ENDPOINTS, type TeamEnvironment, type EnvironmentSource } from './config'

/** Forwarding-queue health, supplied by AL 04. Absent until that lands (and always absent on an
 *  unlinked install, where there is no queue). */
export interface QueueStats {
  depth: number
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastError: string | null
  paused: boolean
}

export type TeamIndicator = 'unlinked' | 'reporting' | 'queued' | 'degraded'

export interface TeamStatus {
  linked: boolean
  clientVersion: string
  indicator: TeamIndicator
  endpoint?: string
  orgId?: string
  orgName?: string
  memberId?: string
  /** This member's own login email — absent for a credential written before this field existed,
   *  until `refreshOrgNameIfStale` backfills it (see `link.ts`). */
  email?: string
  role?: 'lead' | 'member'
  perDeveloperVisibility?: boolean
  linkedAt?: string
  queueDepth?: number
  lastRollupAt?: string | null
  degradedReason?: string
  /**
   * Which TraceRoost Pro environment this machine would talk to. Populated unconditionally —
   * including on an unlinked install, where it's the only way to see where linking would even
   * point — so the panel never has to guess or hide this. On a linked machine it echoes back the
   * environment its own credential's `endpoint` (above) resolves to, not `resolveTeamEnvironment()`
   * (which a linked machine never consults — see `config.ts`).
   */
  environment: TeamEnvironment | 'custom'
  /** Where `environment` came from. The panel's environment picker is only meaningful — and
   *  should only be shown as editable — when this is `'selected'` or `'default'`; `'env-url'` and
   *  `'env-var'` come from outside the app (`.env` or the shell) and win regardless of what's
   *  picked there. Always `'env-url'`/`'env-var'`-blind to linking: a linked machine's `endpoint`
   *  reports back as whichever of these three names its actual endpoint matches, or `'custom'`. */
  environmentSource: EnvironmentSource | 'linked'
  /** True while `environment`/`environmentSource` above reflect a live credential rather than
   *  `resolveTeamEnvironment()` — i.e. whenever `linked` is true. */
  environmentEditable: boolean
}

function describeEndpoint(endpoint: string): TeamEnvironment | 'custom' {
  const known = (Object.keys(TEAM_ENDPOINTS) as TeamEnvironment[]).find(
    (env) => TEAM_ENDPOINTS[env] === endpoint,
  )
  return known ?? 'custom'
}

export function getTeamStatus(queue?: QueueStats): TeamStatus {
  const creds = loadCredentials()
  const version = clientVersion()

  if (!creds) {
    const resolved = resolveTeamEnvironment()
    return {
      linked: false,
      clientVersion: version,
      indicator: 'unlinked',
      environment: resolved.environment,
      environmentSource: resolved.source,
      environmentEditable: resolved.source === 'selected' || resolved.source === 'default',
    }
  }

  let indicator: TeamIndicator = 'reporting'
  let degradedReason: string | undefined
  if (queue) {
    if (queue.lastErrorAt && (!queue.lastSuccessAt || queue.lastErrorAt > queue.lastSuccessAt)) {
      indicator = 'degraded'
      degradedReason = queue.lastError ?? 'the last send failed'
    } else if (queue.depth > 0) {
      indicator = 'queued'
    }
  }

  return {
    linked: true,
    clientVersion: version,
    indicator,
    endpoint: creds.endpoint,
    environment: describeEndpoint(creds.endpoint),
    environmentSource: 'linked',
    environmentEditable: false,
    orgId: creds.orgId,
    orgName: creds.orgName,
    memberId: creds.memberId,
    email: creds.email,
    role: creds.role,
    perDeveloperVisibility: creds.perDeveloperVisibility,
    linkedAt: creds.linkedAt,
    queueDepth: queue?.depth ?? 0,
    lastRollupAt: queue?.lastSuccessAt ?? null,
    degradedReason,
  }
}
