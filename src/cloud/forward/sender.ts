/**
 * Drains the forwarding queue to the ingest endpoint (AL 04).
 *
 * Every failure mode degrades to "stale dashboard", never to "broken client":
 *
 * | Failure               | Behaviour                                                            |
 * |-----------------------|---------------------------------------------------------------------|
 * | Service unreachable / 5xx | keep the item, back off, retry next tick. No UI change.        |
 * | 401, refresh transiently fails | refresh once; on failure, one dismissible notice, keep queueing. |
 * | 401, refresh token/client rejected (`invalid_grant`/`invalid_client`) | stop forwarding, clear the credential, tell the developer once — same as membership-gone below, since this credential will never refresh again. |
 * | 403 / membership gone  | stop forwarding, clear the credential, tell the developer once.   |
 * | 400 / schema rejected  | drop the record, log locally with the error, never retry.         |
 * | 429                   | back off per `Retry-After`, stop the whole batch (the server just  |
 * |                       | told us to).                                                       |
 * | Disk full             | stop queueing, keep working (handled in `queue.ts`).              |
 *
 * A service-unreachable or 5xx failure only backs off the *item* that hit it — the rest of the
 * batch is still attempted this tick. One flaky request (a dropped connection, a cold-started
 * server) shouldn't leave everything behind it waiting for the next 5-minute tick when it would
 * otherwise have gone through fine. 401 (after a failed refresh), 403 and 429 are different: they
 * say something about every subsequent request too, so those still stop the batch outright.
 *
 * There is no synchronous path from a session close to here — `drainQueue` is only ever called
 * on a timer, and only when a team is linked.
 */

import { ForwardQueue, type QueueItem } from './queue'
import { DeliveryLedger, scopedKey } from './deliveryLedger'
import { readForwardState, writeForwardState, clearForwardState } from './forwardState'
import { loadCredentials, saveCredentials, clearCredentials, ensureInstallId } from '../team/credentials'
import { refreshTokens, TokenRefreshError } from '../team/oauthClient'
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
  /** Called right after each item leaves the queue — a confirmed send or a permanent (400) drop —
   *  so a host can push a fresh queue depth to the Team panel as it happens, not just once the
   *  whole batch finishes. A backlog can take minutes to drain (one network round trip per item),
   *  during which the on-disk queue depth is genuinely dropping one at a time; without this the
   *  panel's count sat frozen at the pre-drain total for that whole time. Never called for an item
   *  that's merely backed off for retry (still queued, so the depth hasn't changed). */
  onItemDone?: () => void
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
  // Self-heal for a credential written before `installId` existed (see `ensureInstallId`) — a
  // no-op the instant it has ever once succeeded. This is the one place in the send path that
  // already does network I/O every drain, so it's the natural home for this, rather than
  // `enqueueSession.ts`, which stays local-only by design.
  if (!creds.installId) creds = await ensureInstallId(creds)
  // Install never changes within one drain (only the token does, on a mid-drain refresh) —
  // captured once so `finish()`'s closure doesn't need TS to re-prove `creds` is non-null
  // through it. May still be undefined if the self-heal above couldn't reach the server —
  // `finish()` degrades to "sent but not locally recorded as delivered" in that case (see there).
  const installId = creds.installId

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
  let sawTransientFailure = false

  // Removes a confirmed-sent item from the queue and records it delivered immediately, rather
  // than batching every success in this drain into one removal at the very end — see
  // `onItemDone` above for why. Order (remove, then record) doesn't matter for correctness: a
  // crash between the two just means a redundant, harmless resend later (idempotent both locally
  // and server-side), never a lost one.
  function recordSuccess(key: string): void {
    queue.remove([key])
    if (installId) {
      const ledger = new DeliveryLedger(deps.baseHome)
      ledger.markDelivered(scopedKey(installId, key))
    }
    deps.onItemDone?.()
  }

  for (const item of batch) {
    let res: Response
    try {
      res = await postPayload(creds.accessToken, item, deps.baseHome)
    } catch {
      // A network-level failure (DNS, dropped connection, our own 20s timeout) tells us nothing
      // about the *next* item — it may hit a warm connection and succeed. Back this one off and
      // keep going, rather than abandoning the rest of the batch on one flaky request.
      queue.recordFailure(item.key, 'service unreachable')
      writeForwardState({ lastErrorAt: new Date().toISOString(), lastError: 'service unreachable' }, deps.baseHome)
      sawTransientFailure = true
      continue
    }

    if (res.status === 202 || res.status === 200) {
      recordSuccess(item.key)
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
        if (res.status === 202 || res.status === 200) { recordSuccess(item.key); sent++; continue }
      } catch (err) {
        if (err instanceof TokenRefreshError && err.permanent) {
          // The server rejected the refresh token/client itself — retrying later with the same
          // credential would just fail the same way forever. Clear it (like the 403 branch
          // below) so the Team panel drops back to "Unlinked" with its "Link this machine"
          // button, instead of staying stuck on "Paused" with no way forward short of "Leave
          // team" first. The queue is left intact — the locally queued rollups are still good
          // data, just waiting on a fresh credential to send them with.
          const result = finish('auth-failed')
          clearCredentials()
          clearForwardState(deps.baseHome)
          deps.notify?.('TraceRoost: your team credential is no longer valid. Re-link this machine in the Team panel to resume forwarding.', 'warning')
          return result
        }
        deps.notify?.('TraceRoost: could not refresh your team credential. Rollups are queued and will retry automatically.', 'warning')
        writeForwardState({ paused: true, pausedUntil: null, lastErrorAt: new Date().toISOString(), lastError: 'token refresh failed' }, deps.baseHome)
        return finish('auth-failed')
      }
    }

    if (res.status === 403) {
      queue.clear()
      clearCredentials()
      clearForwardState(deps.baseHome)
      deps.notify?.('TraceRoost: your team membership was revoked. This machine has stopped forwarding.', 'warning')
      return { attempted: batch.length, sent, droppedInvalid, remaining: 0, stopped: 'membership-revoked' }
    }

    if (res.status === 400) {
      // The server will never accept this record. Retrying it is a loop.
      const detail = await safeText(res)
      queue.remove([item.key])
      droppedInvalid++
      writeForwardState({ lastErrorAt: new Date().toISOString(), lastError: `schema rejected: ${detail.slice(0, 200)}` }, deps.baseHome)
      deps.onItemDone?.()
      continue
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60
      writeForwardState({ paused: true, pausedUntil: now() + retryAfter * 1000, lastErrorAt: new Date().toISOString(), lastError: 'rate limited' }, deps.baseHome)
      return finish('rate-limited')
    }

    // 5xx or anything else — transient, and specific to this item's request, not the service as
    // a whole. Back off and move on to the rest of the batch.
    queue.recordFailure(item.key, `HTTP ${res.status}`)
    writeForwardState({ lastErrorAt: new Date().toISOString(), lastError: `HTTP ${res.status}` }, deps.baseHome)
    sawTransientFailure = true
  }

  return finish(sawTransientFailure ? 'offline' : null)

  function finish(stopped: DrainResult['stopped']): DrainResult {
    // Removal and delivery-recording already happened per item in `recordSuccess`/the 400 branch
    // above — nothing left to do here but report the final tally. `installId` is scoped to the
    // install that actually accepted each item (see deliveryLedger.ts's scopedKey) — captured
    // before any mid-drain token refresh, but a refresh only ever changes the token, never the
    // install, so it's always the right one. If it's still unknown (the self-heal above couldn't
    // reach the server this drain), successes were still correctly removed from the queue — they
    // *were* sent — just without ledger-recording; the cost is a possible redundant resend on a
    // future restart's reconciliation (harmless, server-deduplicated), not a lost delivery.
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
        'User-Agent': `traceroost-client/${clientVersion()}`,
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
