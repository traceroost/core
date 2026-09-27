/**
 * Drains the forwarding queue to the ingest endpoint (AL 04).
 *
 * Every failure mode degrades to "stale dashboard", never to "broken client":
 *
 * | Failure               | Behaviour                                                            |
 * |-----------------------|---------------------------------------------------------------------|
 * | Service unreachable / 5xx | keep the item(s), back off, retry next tick. No UI change.     |
 * | 401, refresh transiently fails | refresh once; on failure, one dismissible notice, keep queueing. |
 * | 401, refresh token/client rejected (`invalid_grant`/`invalid_client`) | stop forwarding, clear the credential *and the queue*, tell the developer once — same as membership-gone below, since this credential will never refresh again. |
 * | 403 / install revoked  | stop forwarding, clear the credential and the queue, tell the developer once. |
 * | 400 / schema rejected  | drop the record, log locally with the error, never retry.         |
 * | 413 / too large        | split the batch and resend the halves; a single record that is    |
 * |                       | itself too large is dropped and logged, never retried.             |
 * | 429                   | back off per `Retry-After`, stop the whole drain (the server just  |
 * |                       | told us to).                                                       |
 * | Disk full             | stop queueing, keep working (handled in `queue.ts`).              |
 *
 * Clearing the queue whenever the credential is gone for good matters because every queued rollup
 * was hashed with the linked org's salt (`repoKey.ts`): kept, it would ship to whatever org this
 * machine links to next. Nothing is lost locally — after a re-link, reconciliation re-enqueues
 * whatever the new install hasn't received, hashed for the new org.
 *
 * The access token is refreshed proactively when it's about to expire (`accessTokenExpiresAt`),
 * and every refresh goes through `tokenRefresh.ts`'s locked refresh, so two hosts on the same
 * machine can't rotate the same refresh token at once and unlink it.
 *
 * Items are sent to `/api/ingest/batch` several at a time (`HTTP_BATCH_SIZE`) instead of one
 * request per item — with N queued items each paying its own public-internet round trip, a
 * large backlog drained one at a time takes visibly long (the Org panel's queued count ticking
 * down every few hundred ms to seconds per item). Batching collapses that into a handful of
 * requests; the server still validates and persists each record individually and reports a
 * per-item result, so a bad record in a batch still only drops that one record — see the batch
 * route's own doc comment on the cloud side.
 *
 * A service-unreachable or 5xx failure at the HTTP-request level backs off every item in that
 * request's batch, not just one — coarser than the old one-item-per-request isolation, but
 * bounded by keeping `HTTP_BATCH_SIZE` modest, and every backed-off item still retries
 * automatically next tick. 401 (after a failed refresh), 403 and 429 are different: they say
 * something about every subsequent request too, so those still stop the whole drain outright.
 *
 * If the batch endpoint isn't reachable (a 404 — the cloud deploy hasn't shipped it yet, or an
 * older/unexpected endpoint), this drain falls back to sending the rest of its items one at a
 * time against `/api/ingest`, the original per-item route, which never changes.
 *
 * There is no synchronous path from a session close to here — `drainQueue` is only ever called
 * on a timer, and only when an org is linked.
 */

import { ForwardQueue, type QueueItem } from './queue'
import { DeliveryLedger, scopedKey } from './deliveryLedger'
import { readForwardState, writeForwardState, clearForwardState } from './forwardState'
import { loadCredentials, clearCredentials, ensureInstallId } from '../org/credentials'
import { TokenRefreshError } from '../org/oauthClient'
import { refreshCredentials, accessTokenExpiring } from '../org/tokenRefresh'
import { ingestUrl, batchIngestUrl } from '../org/config'
import { clientVersion } from '../org/oauthClient'

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
  /** Test-only override for how many items go into one HTTP batch request (default 25) — lets a
   *  test exercise the multi-chunk-per-drain path without needing 25 real queued items. */
  httpBatchSize?: number
  /** Test-only override for `DEFAULT_MAX_BATCH_BYTES`. */
  maxBatchBytes?: number
  /** Called right after each item leaves the queue — a confirmed send or a permanent (400) drop —
   *  so a host can push a fresh queue depth to the Org panel as it happens, not just once the
   *  whole drain finishes. A backlog can take a while to drain, during which the on-disk queue
   *  depth is genuinely dropping a batch at a time; without this the panel's count sat frozen at
   *  the pre-drain total for that whole time. Never called for an item that's merely backed off
   *  for retry (still queued, so the depth hasn't changed). */
  onItemDone?: () => void
  /** Called once per drain that sent at least one item, with how many — never for a drain that
   *  sent nothing. The host's hook for recording local "traces sent" transport stats (the Org
   *  panel's transparency numbers); this module stays storage-agnostic otherwise. */
  recordSent?: (count: number, at: number) => void
  /** Ignore each item's `nextEligibleAt` backoff and attempt every queued item right now. Only
   *  for a deliberate, user-initiated retry ("Check for unsent traces") — never the automatic
   *  timer tick, which must keep respecting backoff so a genuinely down server doesn't get
   *  hammered. Fixing whatever was actually broken (e.g. a server-side bug) doesn't reset an
   *  item's `attempts`/`lastAttemptAt`, so without this a backlog that failed identically many
   *  times over can sit queued for up to an hour after the real fix has already landed, with no
   *  way for the developer to confirm it themselves other than waiting. */
  force?: boolean
}

const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 60 * 60 * 1000
const DEFAULT_HTTP_BATCH_SIZE = 25
/** Request-body budget for one batch. The ingest routes reject a body over 512 KiB with a 413
 *  (cloud `MAX_BODY_BYTES`); 25 items of a session with a long file list can exceed that, so a
 *  chunk also closes once its serialized items would pass this — comfortably under the cap. */
export const DEFAULT_MAX_BATCH_BYTES = 400 * 1024

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

  const pending = deps.force ? queue.list() : queue.list().filter(it => nextEligibleAt(it) <= now())
  if (pending.length === 0) return { ...empty, stopped: 'nothing-eligible' }

  const batch = pending.slice(0, deps.batchLimit ?? 200)
  const httpBatchSize = deps.httpBatchSize ?? DEFAULT_HTTP_BATCH_SIZE
  let sent = 0
  let droppedInvalid = 0
  let refreshedThisDrain = false
  let sawTransientFailure = false
  // Flips to false the first time the batch endpoint 404s, so the rest of this drain (and only
  // this drain — the next tick tries batching again) falls back to the original one-item-per-
  // request path instead of paying a 404 round trip per remaining chunk.
  let useBatchEndpoint = true

  // Removes a confirmed-sent item from the queue and records it delivered immediately, rather
  // than batching every success in this drain into one removal at the very end — see
  // `onItemDone` above for why. Order (remove, then record) doesn't matter for correctness: a
  // crash between the two just means a redundant, harmless resend later (idempotent both locally
  // and server-side), never a lost one.
  function recordSuccess(key: string): void {
    recordSuccesses([key])
  }

  // Several confirmed sends at once (one batch response's worth). Each still leaves the queue on
  // its own, right before its own `onItemDone` (see there), but they're recorded delivered with
  // one ledger write for the lot rather than a full rewrite of the ledger per item. Still
  // remove-then-record, so the crash window is the same harmless-resend one as above.
  function recordSuccesses(keys: string[]): void {
    if (keys.length === 0) return
    for (const key of keys) {
      queue.remove([key])
      deps.onItemDone?.()
    }
    if (installId) {
      const ledger = new DeliveryLedger(deps.baseHome)
      ledger.markDeliveredMany(keys.map(key => scopedKey(installId, key)))
    }
  }

  function dropInvalid(key: string, detail: string): void {
    dropPermanently(key, `schema rejected: ${detail.slice(0, 200)}`)
  }

  // A record the server will never accept (schema-rejected, or too large on its own) — removed,
  // counted, and logged locally with the reason, never retried.
  function dropPermanently(key: string, reason: string): void {
    queue.remove([key])
    droppedInvalid++
    writeForwardState({ lastErrorAt: new Date().toISOString(), lastError: reason }, deps.baseHome)
    deps.onItemDone?.()
  }

  function backOffAll(items: QueueItem[], error: string): void {
    queue.recordFailures(items.map(item => item.key), error)
    writeForwardState({ lastErrorAt: new Date().toISOString(), lastError: error }, deps.baseHome)
    sawTransientFailure = true
  }

  function finish(stopped: DrainResult['stopped']): DrainResult {
    // Removal and delivery-recording already happened per item in `recordSuccess`/`dropInvalid`
    // above — nothing left to do here but report the final tally. `installId` is scoped to the
    // install that actually accepted each item (see deliveryLedger.ts's scopedKey) — captured
    // before any mid-drain token refresh, but a refresh only ever changes the token, never the
    // install, so it's always the right one. If it's still unknown (the self-heal above couldn't
    // reach the server this drain), successes were still correctly removed from the queue — they
    // *were* sent — just without ledger-recording; the cost is a possible redundant resend on a
    // future restart's reconciliation (harmless, server-deduplicated), not a lost delivery.
    if (sent > 0) {
      writeForwardState({ lastSuccessAt: new Date().toISOString(), paused: false, pausedUntil: null }, deps.baseHome)
      deps.recordSent?.(sent, now())
    }
    return { attempted: batch.length, sent, droppedInvalid, remaining: queue.depth(), stopped }
  }

  // The credential is gone for good (refresh rejected, or the install revoked): stop, and drop
  // everything that was queued for it — see this file's header on why the queue can't be kept.
  function unlinkAndClear(stopped: 'auth-failed' | 'membership-revoked', message: string): DrainResult {
    const result = finish(stopped)
    queue.clear()
    clearCredentials()
    clearForwardState(deps.baseHome)
    deps.notify?.(message, 'warning')
    return { ...result, remaining: 0 }
  }

  // At most one refresh per drain, through the locked refresh in tokenRefresh.ts (which returns
  // another host's already-rotated credential rather than racing it). Returns undefined once
  // `creds` holds a usable token, or the drain's final result when it must stop.
  async function refreshOnce(): Promise<DrainResult | undefined> {
    refreshedThisDrain = true
    try {
      creds = await refreshCredentials(creds!, now)
      return undefined
    } catch (err) {
      if (err instanceof TokenRefreshError && err.permanent) {
        // The server rejected the refresh token/client itself — retrying later with the same
        // credential would just fail the same way forever. The Org panel drops back to "Unlinked"
        // with its "Link this machine" button, instead of staying stuck on "Paused".
        return unlinkAndClear('auth-failed', 'TraceRoost: your org credential is no longer valid. Re-link this machine in the Org panel to resume forwarding.')
      }
      deps.notify?.('TraceRoost: could not refresh your org credential. Rollups are queued and will retry automatically.', 'warning')
      writeForwardState({ paused: true, pausedUntil: null, lastErrorAt: new Date().toISOString(), lastError: 'token refresh failed' }, deps.baseHome)
      return finish('auth-failed')
    }
  }

  function membershipRevoked(): DrainResult {
    return unlinkAndClear('membership-revoked', 'TraceRoost: your org membership was revoked. This machine has stopped forwarding.')
  }

  // Sends one chunk to the batch endpoint. Returns 'continue' to move on to the next chunk,
  // 'fallback' if the batch endpoint isn't available (404) so the caller should retry this same
  // chunk item-by-item, or `{ stop }` when the whole drain must end now (401-after-failed-refresh,
  // 403, 429 — each says something about every subsequent request, not just this chunk's).
  async function sendChunkBatched(chunk: QueueItem[]): Promise<'continue' | 'fallback' | { stop: DrainResult }> {
    let res: Response
    try {
      res = await postBatch(creds!.accessToken, chunk)
    } catch {
      // A network-level failure tells us nothing about the *next* chunk — it may hit a warm
      // connection and succeed. Back this chunk off and keep going.
      backOffAll(chunk, 'service unreachable')
      return 'continue'
    }

    if (res.status === 404) return 'fallback'

    if (res.status === 401 && !refreshedThisDrain) {
      const stop = await refreshOnce()
      if (stop) return { stop }
      // Retry this same chunk immediately with the fresh token.
      res = await postBatch(creds!.accessToken, chunk).catch(() => res)
    }

    if (res.status === 403) return { stop: membershipRevoked() }

    if (res.status === 413) {
      // Over the server's body cap despite the byte budget (a single huge record, or a smaller
      // cap server-side). Split and resend; one record alone that's still too large can never be
      // accepted, so it's dropped and logged rather than retried forever.
      if (chunk.length === 1) {
        dropPermanently(chunk[0].key, 'payload too large (HTTP 413)')
        return 'continue'
      }
      const mid = Math.ceil(chunk.length / 2)
      for (const half of [chunk.slice(0, mid), chunk.slice(mid)]) {
        const outcome = await sendChunkBatched(half)
        if (typeof outcome === 'object') return outcome
        if (outcome === 'fallback') {
          for (const item of half) {
            const o = await sendItemSequentially(item)
            if (o) return o
          }
        }
      }
      return 'continue'
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60
      writeForwardState({ paused: true, pausedUntil: now() + retryAfter * 1000, lastErrorAt: new Date().toISOString(), lastError: 'rate limited' }, deps.baseHome)
      return { stop: finish('rate-limited') }
    }

    if (res.status !== 200) {
      // 5xx or anything else — transient, and specific to this request, not necessarily the
      // service as a whole. Back the whole chunk off and move on to the next one.
      backOffAll(chunk, `HTTP ${res.status}`)
      return 'continue'
    }

    let results: { status: number; error?: string }[] | null = null
    try {
      const body = (await res.json()) as { results?: unknown }
      if (Array.isArray(body.results)) results = body.results as { status: number; error?: string }[]
    } catch {
      /* falls through to the malformed-response handling below */
    }
    if (!results || results.length !== chunk.length) {
      // Can't tell which items landed — treat the whole chunk as transient rather than guess.
      backOffAll(chunk, 'malformed batch response')
      return 'continue'
    }

    const succeeded: string[] = []
    chunk.forEach((item, idx) => {
      const r = results![idx]
      if (r.status === 202 || r.status === 200) {
        succeeded.push(item.key)
        sent++
      } else if (r.status === 400) {
        dropInvalid(item.key, r.error ?? '')
      } else {
        queue.recordFailure(item.key, r.error ? `HTTP ${r.status}: ${r.error}` : `HTTP ${r.status}`)
        sawTransientFailure = true
      }
    })
    recordSuccesses(succeeded)
    return 'continue'
  }

  // The original one-item-per-request path — used as the fallback when the batch endpoint isn't
  // available. Mirrors `sendChunkBatched`'s status handling exactly, just for a single item.
  async function sendItemSequentially(item: QueueItem): Promise<{ stop: DrainResult } | undefined> {
    let res: Response
    try {
      res = await postPayload(creds!.accessToken, item)
    } catch {
      queue.recordFailure(item.key, 'service unreachable')
      writeForwardState({ lastErrorAt: new Date().toISOString(), lastError: 'service unreachable' }, deps.baseHome)
      sawTransientFailure = true
      return
    }

    if (res.status === 202 || res.status === 200) {
      recordSuccess(item.key)
      sent++
      return
    }

    if (res.status === 401 && !refreshedThisDrain) {
      const stop = await refreshOnce()
      if (stop) return { stop }
      res = await postPayload(creds!.accessToken, item).catch(() => res)
      if (res.status === 202 || res.status === 200) { recordSuccess(item.key); sent++; return }
    }

    if (res.status === 403) return { stop: membershipRevoked() }

    if (res.status === 413) {
      dropPermanently(item.key, 'payload too large (HTTP 413)')
      return
    }

    if (res.status === 400) {
      const detail = await safeText(res)
      dropInvalid(item.key, detail)
      return
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60
      writeForwardState({ paused: true, pausedUntil: now() + retryAfter * 1000, lastErrorAt: new Date().toISOString(), lastError: 'rate limited' }, deps.baseHome)
      return { stop: finish('rate-limited') }
    }

    queue.recordFailure(item.key, `HTTP ${res.status}`)
    writeForwardState({ lastErrorAt: new Date().toISOString(), lastError: `HTTP ${res.status}` }, deps.baseHome)
    sawTransientFailure = true
    return
  }

  // A drain's first request would otherwise go out with a token that's already expired (or about
  // to be) — refresh first instead of spending a guaranteed 401. A transient failure here isn't
  // fatal: the token may still be good for a few seconds, and a real 401 retries the refresh.
  if (accessTokenExpiring(creds, now)) {
    try {
      creds = await refreshCredentials(creds, now)
      refreshedThisDrain = true
    } catch (err) {
      if (err instanceof TokenRefreshError && err.permanent) {
        refreshedThisDrain = true
        return unlinkAndClear('auth-failed', 'TraceRoost: your org credential is no longer valid. Re-link this machine in the Org panel to resume forwarding.')
      }
    }
  }

  for (const chunk of chunkByCountAndBytes(batch, httpBatchSize, deps.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES)) {

    if (useBatchEndpoint) {
      const outcome = await sendChunkBatched(chunk)
      if (typeof outcome === 'object') return outcome.stop
      if (outcome === 'continue') continue
      useBatchEndpoint = false // 'fallback' — fall through and send this chunk item-by-item below
    }

    for (const item of chunk) {
      const outcome = await sendItemSequentially(item)
      if (outcome) return outcome.stop
    }
  }

  return finish(sawTransientFailure ? 'offline' : null)
}

async function postBatch(accessToken: string, items: QueueItem[]): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    return await fetch(batchIngestUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': `traceroost-client/${clientVersion()}`,
      },
      body: JSON.stringify({ items: items.map(it => it.payload) }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function postPayload(accessToken: string, item: QueueItem): Promise<Response> {
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

/** Splits `items` into request-sized chunks: at most `maxItems` each, and closing a chunk before
 *  its serialized payloads would pass `maxBytes` (a record larger than that on its own still gets
 *  a chunk of its own — the server's 413 decides its fate, see `sendChunkBatched`). */
export function chunkByCountAndBytes(items: QueueItem[], maxItems: number, maxBytes: number): QueueItem[][] {
  const chunks: QueueItem[][] = []
  let current: QueueItem[] = []
  let bytes = 0
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item.payload)) + 1 // + the separating comma
    if (current.length > 0 && (current.length >= maxItems || bytes + size > maxBytes)) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(item)
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
