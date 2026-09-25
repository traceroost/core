/**
 * The single source of truth for "what is this machine's Pro state right now" — consumed by the
 * Org panel (AL 01), the tab-bar state dot, and `traceroost org status`.
 *
 * It is rendered from **local data only**. An unlinked install produces a complete status object
 * without making a single request; that is what lets the panel's unlinked state exist with the
 * network invariant intact.
 */

import { loadCredentials } from './credentials'
import { clientVersion } from './oauthClient'
import { resolveOrgEnvironment, ORG_ENDPOINTS, type OrgEnvironment, type EnvironmentSource } from './config'
import { getCloudRateOverrides, type ModelRates } from '../../pricing'

/** Forwarding-queue health, supplied by AL 04. Absent until that lands (and always absent on an
 *  unlinked install, where there is no queue). */
export interface QueueStats {
  depth: number
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastError: string | null
  paused: boolean
  /** Count of queued items that have failed `STUCK_ATTEMPTS_THRESHOLD`-or-more times in a row
   *  (queue.ts) — failing deterministically rather than hitting a transient blip. Tracked
   *  separately from `lastErrorAt`/`lastSuccessAt` because those are drain-wide: an unrelated
   *  item elsewhere in the same queue succeeding bumps `lastSuccessAt` and would otherwise mask a
   *  subset that is never going to send on its own (see getOrgStatus below). */
  stuckCount: number
  /** The most recent error among the stuck items, if any — shown in `degradedReason`. */
  stuckError: string | null
}

/** Transport transparency stats — how many hashed traces this machine has actually sent, over a
 *  few windows. Absent on a host that hasn't wired up `OrgPanelDeps.traceSendStats` (or before
 *  the panel's first status push resolves it). */
export interface TraceSendStats {
  last5Min: number
  lastHour: number
  allTime: number
}

export type OrgIndicator = 'unlinked' | 'reporting' | 'queued' | 'degraded'

export interface OrgStatus {
  linked: boolean
  clientVersion: string
  indicator: OrgIndicator
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
   * environment its own credential's `endpoint` (above) resolves to, not `resolveOrgEnvironment()`
   * (which a linked machine never consults — see `config.ts`).
   */
  environment: OrgEnvironment | 'custom'
  /** Where `environment` came from. The panel's environment picker is only meaningful — and
   *  should only be shown as editable — when this is `'selected'` or `'default'`; `'env-url'` and
   *  `'env-var'` come from outside the app (`.env` or the shell) and win regardless of what's
   *  picked there. Always `'env-url'`/`'env-var'`-blind to linking: a linked machine's `endpoint`
   *  reports back as whichever of these three names its actual endpoint matches, or `'custom'`. */
  environmentSource: EnvironmentSource | 'linked'
  /** True while `environment`/`environmentSource` above reflect a live credential rather than
   *  `resolveOrgEnvironment()` — i.e. whenever `linked` is true. */
  environmentEditable: boolean
  /** Whichever org-provided model rates (pricingSync.ts) are currently overriding the local
   *  `RATES` table, keyed by normalizeCostKey — empty on an unlinked install or before the first
   *  successful sync. Lets the Pricing tab mark a row "Remote" vs "Local" without a dedicated
   *  round trip: this is local in-memory state, same invariant as the rest of this file. */
  cloudRateOverrides: Record<string, ModelRates>
  /** Absent on an unlinked install (there is nothing to have sent) or on a host that doesn't
   *  supply `OrgPanelDeps.traceSendStats`. */
  traceSendStats?: TraceSendStats
  /** True while a drain attempt is actually in flight right now (scheduler.ts's
   *  `isForwardQueueDraining`) — the only thing the state dot should blink for. Always false on an
   *  unlinked install, and false between drains even when `indicator` is `'reporting'`: a healthy,
   *  fully-synced state is a solid dot, not a pulsing one. */
  sending: boolean
}

function describeEndpoint(endpoint: string): OrgEnvironment | 'custom' {
  const known = (Object.keys(ORG_ENDPOINTS) as OrgEnvironment[]).find(
    (env) => ORG_ENDPOINTS[env] === endpoint,
  )
  return known ?? 'custom'
}

export function getOrgStatus(queue?: QueueStats, traceSendStats?: TraceSendStats, sending = false): OrgStatus {
  const creds = loadCredentials()
  const version = clientVersion()

  if (!creds) {
    const resolved = resolveOrgEnvironment()
    return {
      linked: false,
      clientVersion: version,
      indicator: 'unlinked',
      endpoint: resolved.endpoint,
      environment: resolved.environment,
      environmentSource: resolved.source,
      environmentEditable: resolved.source === 'selected' || resolved.source === 'default',
      cloudRateOverrides: getCloudRateOverrides(),
      sending: false,
    }
  }

  let indicator: OrgIndicator = 'reporting'
  let degradedReason: string | undefined
  if (queue) {
    if (queue.stuckCount > 0) {
      // Checked ahead of the lastErrorAt/lastSuccessAt comparison below — that comparison only
      // sees the single most recent outcome across the whole queue, so a healthy item sending
      // fine elsewhere (bumping lastSuccessAt) would otherwise hide these being stuck forever.
      indicator = 'degraded'
      const plural = queue.stuckCount === 1 ? 'trace has' : 'traces have'
      degradedReason = `${queue.stuckCount} ${plural} failed repeatedly: ${queue.stuckError ?? 'unknown error'}`
    } else if (queue.lastErrorAt && (!queue.lastSuccessAt || queue.lastErrorAt > queue.lastSuccessAt)) {
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
    cloudRateOverrides: getCloudRateOverrides(),
    sending,
    traceSendStats,
  }
}
