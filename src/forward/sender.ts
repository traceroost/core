/**
 * Drains the forwarding queue to the ingest endpoint (AL 04).
 *
 * Every failure mode degrades to "stale dashboard", never to "broken client":
 *
 * | Failure               | Behaviour                                                            |
 * |-----------------------|---------------------------------------------------------------------|
 * | Service unreachable   | keep the item, back off, retry next tick. No UI change.            |
 * | 401 / token expired   | refresh once; on failure, one dismissible notice, keep queueing.  |
 * | 403 / membership gone  | stop forwarding, clear the credential, tell the developer once.   |
 * | 400 / schema rejected  | drop the record, log locally with the error, never retry.         |
 * | 429                   | back off per `Retry-After`.                                        |
 * | Disk full             | stop queueing, keep working (handled in `queue.ts`).              |
 *
 * There is no synchronous path from a session close to here — `drainQueue` is only ever called
 * on a timer, and only when a team is linked.
 */

import { ForwardQueue, type QueueItem } from './queue'
import { readForwardState, writeForwardState, clearForwardState } from './forwardState'
import { loadCredentials, saveCredentials, clearCredentials } from '../team/credentials'
import { refreshTokens } from '../team/oauthClient'
import { ingestUrl } from '../team/config'
import { clientVersion } from '../team/oauthClient'

export interface DrainResult {
  attempted: number
  sent: number
  droppedInvalid: number
  remaining: number
  stopped: null | 'not-linked' | 'membership-revoked' | 'auth-failed' | 'rate-limited' | 'offline' | 'nothing-eligible'
}

export interface DrainDeps {
  /** Surface a single, dismissible notice to the developer (401 refresh failed, membership revoked). */
  notify?: (message: string, kind: 'info' | 'warning') => void
  /** Injectable clock/sleep for tests. */
  now?: () => number
  baseHome?: string
  /** Max items per drain, so a huge backlog doesn't block the timer. */
  batchLimit?: number
}

const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 60 * 60 * 1000

/** When an item with `attempts` failures becomes eligible to retry again. */
export function nextEligibleAt(item: QueueItem): number {
  if (item.attempts === 0 || item.lastAttemptAt === null) return 0
  const raw = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (item.attempts - 1))
  const jitter = raw * 0.2 * Math.random()
  return item.lastAttemptAt + raw + jitter
}

export async function drainQueue(deps: DrainDeps = {}): Promise<DrainResult> {
  const now = deps.now ?? Date.now
  const queue = new ForwardQueue(deps.baseHome)
  const empty: DrainResult = { attempted: 0, sent: 0, droppedInvalid: 0, remaining: queue.depth(), stopped: null }

  let creds = loadCredentials()
  if (!creds) return { ...empty, stopped: 'not-linked' }

  const state = readForwardState(deps.baseHome)
  if (state.paused && state.pausedUntil !== null && state.pausedUntil > now()) {
    return { ...empty, stopped: 'rate-limited' }
  }

  const pending = queue.list().filter(it => nextEligibleAt(it) <= now())
  if (pending.length === 0) return { ...empty, stopped: 'nothing-eligible' }

  const batch = pending.slice(0, deps.batchLimit ?? 200)
  let sent = 0
  let droppedInvalid = 0
  let refreshedThisDrain = false
  const succeeded: string[] = []
  const droppedKeys: string[] = []

  for (const item of batch) {
    let res: Response
    try {
      res = await postPayload(creds.accessToken, item, deps.baseHome)
    } catch {
      queue.recordFailure(item.key, 'service unreachable')
      writeForwardState({ lastErrorAt: new Date().toISOString(), lastError: 'service unreachable' }, deps.baseHome)
      return finish('offline')
    }

    if (res.status === 202 || res.status === 200) {
      succeeded.push(item.key)
      sent++
      continue
    }

    if (res.status === 401 && !refreshedThisDrain) {
      refreshedThisDrain = true
      try {
        const t = await refreshTokens(creds.refreshToken, creds.endpoint)
        creds = { ...creds, accessToken: t.accessToken, refreshToken: t.refreshToken, accessTokenExpiresAt: now() + t.expiresInSeconds * 1000 }
        saveCredentials(creds)
        // Retry this same item immediately with the fresh token.
        res = await postPayload(creds.accessToken, item, deps.baseHome).catch(() => res)
        if (res.status === 202 || res.status === 200) { succeeded.push(item.key); sent++; continue }
      } catch {
        deps.notify?.('AgentLens: could not refresh your team credential. Rollups are queued and will send once you re-link.', 'warning')
        writeForwardState({ paused: true, pausedUntil: null, lastErrorAt: new Date().toISOString(), lastError: 'token refresh failed' }, deps.baseHome)
        return finish('auth-failed')
      }
    }

    if (res.status === 403) {
      queue.clear()
      clearCredentials()
      clearForwardState(deps.baseHome)
      deps.notify?.('AgentLens: your team membership was revoked. This machine has stopped forwarding.', 'warning')
      return { attempted: batch.length, sent, droppedInvalid, remaining: 0, stopped: 'membership-revoked' }
    }

    if (res.status === 400) {
      // The server will never accept this record. Retrying it is a loop.
      const detail = await safeText(res)
      droppedKeys.push(item.key)
      droppedInvalid++
      writeForwardState({ lastErrorAt: new Date().toISOString(), lastError: `schema rejected: ${detail.slice(0, 200)}` }, deps.baseHome)
      continue
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60
      writeForwardState({ paused: true, pausedUntil: now() + retryAfter * 1000, lastErrorAt: new Date().toISOString(), lastError: 'rate limited' }, deps.baseHome)
      return finish('rate-limited')
    }

    // 5xx or anything else — transient. Back off.
    queue.recordFailure(item.key, `HTTP ${res.status}`)
    writeForwardState({ lastErrorAt: new Date().toISOString(), lastError: `HTTP ${res.status}` }, deps.baseHome)
    return finish('offline')
  }

  return finish(null)

  function finish(stopped: DrainResult['stopped']): DrainResult {
    if (succeeded.length > 0) queue.remove(succeeded)
    if (droppedKeys.length > 0) queue.remove(droppedKeys)
    if (sent > 0) {
      writeForwardState({ lastSuccessAt: new Date().toISOString(), paused: false, pausedUntil: null }, deps.baseHome)
    }
    return { attempted: batch.length, sent, droppedInvalid, remaining: queue.depth(), stopped }
  }
}

async function postPayload(accessToken: string, item: QueueItem, _baseHome?: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    return await fetch(ingestUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': `agentlens-client/${clientVersion()}`,
      },
      body: JSON.stringify(item.payload),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
