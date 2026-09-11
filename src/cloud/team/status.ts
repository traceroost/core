/**
 * The single source of truth for "what is this machine's Pro state right now" — consumed by the
 * Team panel (AL 01), the tab-bar state dot, and `agentlens team status`.
 *
 * It is rendered from **local data only**. An unlinked install produces a complete status object
 * without making a single request; that is what lets the panel's unlinked state exist with the
 * network invariant intact.
 */

import { loadCredentials } from './credentials'
import { clientVersion } from './oauthClient'

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
  role?: 'lead' | 'member'
  perDeveloperVisibility?: boolean
  linkedAt?: string
  queueDepth?: number
  lastRollupAt?: string | null
  degradedReason?: string
}

export function getTeamStatus(queue?: QueueStats): TeamStatus {
  const creds = loadCredentials()
  const version = clientVersion()

  if (!creds) {
    return { linked: false, clientVersion: version, indicator: 'unlinked' }
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
    orgId: creds.orgId,
    orgName: creds.orgName,
    memberId: creds.memberId,
    role: creds.role,
    perDeveloperVisibility: creds.perDeveloperVisibility,
    linkedAt: creds.linkedAt,
    queueDepth: queue?.depth ?? 0,
    lastRollupAt: queue?.lastSuccessAt ?? null,
    degradedReason,
  }
}
