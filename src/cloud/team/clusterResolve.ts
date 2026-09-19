/**
 * Resolves a Repeat work cluster (cloud) back to real local sessions — the client half of AL 08's
 * `traceroost cluster --repo <hash> --id <id>` command. Cloud groups sessions by repo hash + file
 * hash set + tool histogram (alsaas `lib/clusters/`), but can never say what the cluster is *about*
 * — no filename, no prompt, ever reached it. The one thing cloud can safely hand back is the raw
 * session ids that belong to it (opaque UUIDs, not content); only the machine that actually
 * produced one of those sessions can turn it back into a real workspace, prompt, and file list,
 * because only it ever had that information to begin with.
 *
 * Same resilience philosophy as pricingSync.ts's fetchAndCacheRates: every failure mode (unlinked,
 * offline, 401/5xx, malformed body) returns `null` rather than throwing — there's no cached
 * fallback to fall back to here (unlike pricing), so the caller just reports "couldn't resolve"
 * and exits, never a stale or a guessed answer.
 */

import { loadCredentials } from './credentials'
import { clusterResolveUrl } from './config'
import { clientVersion } from './oauthClient'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

export interface ClusterResolution {
  sessionIds: string[]
  sessions: number
  members: number
  files: number
  topTools: string[]
}

/** One fetch attempt against the cloud service's cluster-resolve endpoint. */
export async function fetchClusterResolution(
  repoHash: string,
  clusterId: string,
): Promise<ClusterResolution | null> {
  const creds = loadCredentials()
  if (!creds) return null // AL 01 — an unlinked install never touches the network

  const url = new URL(clusterResolveUrl(creds.endpoint))
  url.searchParams.set('repo', repoHash)
  url.searchParams.set('id', clusterId)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'User-Agent': `traceroost-client/${clientVersion()}`,
      },
      signal: controller.signal,
    })
  } catch {
    return null // offline / DNS / dropped connection
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) return null // 401/404/429/5xx — no refresh-and-retry here, same call as pricingSync

  let body: Partial<ClusterResolution>
  try {
    body = (await res.json()) as Partial<ClusterResolution>
  } catch {
    return null // malformed response
  }
  if (!Array.isArray(body.sessionIds)) return null

  return {
    sessionIds: body.sessionIds,
    sessions: body.sessions ?? body.sessionIds.length,
    members: body.members ?? 0,
    files: body.files ?? 0,
    topTools: body.topTools ?? [],
  }
}

export interface ResolvedLocalSession {
  sessionId: string
  workspace: string
  userRequest: string
  filesChanged: string[]
  startTime: string
}

/**
 * Matches a cluster's session ids against sessions actually recorded on this machine. A session id
 * this machine doesn't recognize isn't an error — it belongs to a teammate's clone, which is
 * exactly why the cluster crossed people in the first place (repeat-work's own minimum: at least
 * two distinct members). Every matched session already carries its real workspace/prompt/files —
 * no re-hashing or re-matching against the cluster's file-hash set needed, since local session ids
 * are already precise.
 */
export function matchLocalSessions(
  resolution: ClusterResolution,
  localSessions: SessionSummaryCard[],
): { matched: ResolvedLocalSession[]; unmatchedCount: number } {
  const bySessionId = new Map(localSessions.map((s) => [s.sessionId, s]))
  const matched: ResolvedLocalSession[] = []
  for (const id of resolution.sessionIds) {
    const s = bySessionId.get(id)
    if (s) {
      matched.push({
        sessionId: s.sessionId,
        workspace: s.workspace,
        userRequest: s.userRequest,
        filesChanged: s.filesChanged,
        startTime: s.startTime,
      })
    }
  }
  return { matched, unmatchedCount: resolution.sessionIds.length - matched.length }
}
