/**
 * Drains the forwarding queue to the ingest endpoint (AL 04).
 *
 * Every failure mode degrades to "stale dashboard", never to "broken client":
 *
 * | Failure               | Behaviour                                                            |
 * |-----------------------|---------------------------------------------------------------------|
 * | Service unreachable / 5xx | keep the item(s), back off, retry next tick. No UI change.     |
 * | 401, refresh transiently fails | refresh once; on failure, one dismissible notice (once per streak), keep queueing; the scheduler retries the refresh within ~30 s, backing off. |
 * | 401, refresh token/client rejected (`invalid_grant`/`invalid_client`, re-checked once after another host had a chance to rotate — tokenRefresh.ts) | stop forwarding, clear the credential *and the queue*, tell the developer with a "Re-link" action and a persistent notice (forwardState.ts) — same as membership-gone below, since this credential will never refresh again. |
 * | 401, refresh token already presented `MAX_UNANSWERED_PRESENTATIONS` times without an answer (tokenRefresh.ts — a local inference, not the cloud's word) | stop forwarding, clear the credential (it must never be presented again) but *keep the queue*, tell the developer with a "Re-link" action and the persistent notice. The next link keeps the queue only for the same org and member (link.ts). |
 * | 403 `{error:"install revoked"}` | stop forwarding, clear the credential and the queue, tell the developer once. |
 * | 403 from anything else (a proxy or WAF page, a body that isn't the cloud's) | transient: back off, keep the credential and the queue. |
 * | 426 `{error:"client_upgrade_required"}` | pause forwarding (the queue is kept), tell the developer to update TraceRoost. |
 * | 400 / schema rejected (the cloud's own JSON error) | drop the record, log locally with the error, never retry. A 400 without one is transient. |
 * | 413 / too large        | split the batch and resend the halves; a single record that is    |
 * |                       | itself too large (the cloud's own "payload too large") is dropped  |
 * |                       | and logged, never retried. A dropped session the cloud never held |
 * |                       | is recorded (`DroppedLedger`) so the trace manifest stops listing |
 * |                       | it (see traceManifest.ts).                                         |
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

import { gzipSync } from 'node:zlib'
import { ForwardQueue, type QueueItem } from './queue'
import { DeliveryLedger, DroppedLedger, scopedKey } from './deliveryLedger'
import { readForwardState, writeForwardState, clearForwardState, type ForwardNotice } from './forwardState'
import { loadCredentials, clearCredentials, ensureInstallId } from '../org/credentials'
import { TokenRefreshError } from '../org/oauthClient'
import { refreshCredentials, accessTokenExpiring, RefreshReplayExhaustedError } from '../org/tokenRefresh'
import { ingestUrl, batchIngestUrl, type OrgCredentials } from '../org/config'
import { clientVersion } from '../org/oauthClient'

export interface DrainResult {
  attempted: number
  sent: number
  droppedInvalid: number
  remaining: number
  stopped: null | 'not-linked' | 'membership-revoked' | 'auth-failed' | 'rate-limited' | 'offline' | 'nothing-eligible' | 'upgrade-required'
}

/** What a notice asks the developer to do — the host turns it into a button ("Re-link",
 *  "Update"), or ignores it. */
export type NoticeAction = 'relink' | 'update'

export const RELINK_MESSAGE = 'TraceRoost Cloud sign-in expired — re-link this machine to resume sending. Nothing local is lost: traces not yet sent are sent again after you re-link.'
export const REVOKED_MESSAGE = 'TraceRoost: this machine was unlinked from TraceRoost Cloud (its install was revoked, or your membership ended) and has stopped forwarding. Re-link it to resume.'
export const RELINK_HELD_MESSAGE = 'TraceRoost Cloud could not confirm this machine\'s sign-in (its refresh went unanswered twice) — re-link this machine to resume sending. Traces not yet sent are kept and sent after you re-link.'
export const UPGRADE_MESSAGE = 'Update TraceRoost to keep sending to TraceRoost Cloud — this version is no longer accepted. Traces stay queued and are sent after the update.'

/** How long a 426 pauses forwarding before one more try (the cloud may have relaxed its floor);
 *  a newer client version lifts it at once. */
export const UPGRADE_PAUSE_MS = 6 * 60 * 60 * 1000

/** The `error` codes the cloud answers a revoked install's token with (cloud `resolveBearer`).
 *  Only one of these, in the cloud's own JSON body, unlinks the machine and drops its queue — a
 *  403 from a corporate proxy or WAF must never do that. */
const REVOKED_ERRORS = new Set(['install revoked', 'install_revoked'])
/** The per-record 400s the cloud's ingest routes answer (cloud `/api/ingest`) — the record itself
 *  is bad, so it's dropped. Any other 400 (an intermediary's) is transient. */
const RECORD_REJECTED_ERRORS = new Set(['schema validation failed', 'invalid JSON'])
const TOO_LARGE_ERRORS = new Set(['payload too large'])
export const UPGRADE_REQUIRED_ERROR = 'client_upgrade_required'

/** The cloud's own `{ error }` from a JSON error body, or null when the body isn't one (an HTML
 *  page from a proxy, empty, unparseable). Reads a clone — the response stays readable. */
export async function cloudErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { error?: unknown } | null
    if (body && typeof body === 'object' && typeof body.error === 'string') return body.error
  } catch { /* not JSON */ }
  return null
}

/** One `/api/ingest/batch` round trip, for measuring: how big the body was before and after gzip,
 *  and how long the server took. Local only — never sent anywhere. */
export interface BatchRequestStat {
  items: number
  rawBytes: number
  wireBytes: number
  ms: number
  status: number
}

export interface DrainDeps {
  /** Called after every batch request with its size and latency (the scheduler logs it at debug). */
  onBatchRequest?: (stat: BatchRequestStat) => void
  /** Surface a single, dismissible notice to the developer (401 refresh failed, membership revoked,
   *  client too old). `action`, when given, is what the developer should do about it. */
  notify?: (message: string, kind: 'info' | 'warning', action?: NoticeAction) => void
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

const REFRESH_FAILED = 'token refresh failed'
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

  let state = readForwardState(deps.baseHome)
  // An upgrade notice raised for another version is stale: TraceRoost has been updated since (or
  // the notice predates version stamping), so the 426 pause that came with it is lifted here and
  // now, not waited out — this drain tries the new version. If the cloud still refuses it,
  // `upgradeRequired()` re-pauses with a notice for *this* version and tells the developer again
  // (the old notice is already hidden as stale — forwardState.ts `currentForwardNotice`).
  if (state.notice?.kind === 'upgrade' && state.notice.version !== clientVersion()) {
    const lifted = { paused: false, pausedUntil: null, notice: null }
    writeForwardState(lifted, deps.baseHome)
    state = { ...state, ...lifted }
  }
  if (state.notice?.kind === 'upgrade' && state.paused && state.pausedUntil !== null && state.pausedUntil > now()) {
    return { ...empty, stopped: 'upgrade-required' }
  }
  if (state.paused && state.pausedUntil !== null && state.pausedUntil > now()) {
    return { ...empty, stopped: 'rate-limited' }
  }

  const pending = deps.force ? queue.list() : queue.list().filter(it => nextEligibleAt(it) <= now())
  if (pending.length === 0) return { ...empty, stopped: 'nothing-eligible' }

  const batch = pending.slice(0, deps.batchLimit ?? 200)
  const httpBatchSize = deps.httpBatchSize ?? learnedMaxItems ?? DEFAULT_HTTP_BATCH_SIZE
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
  function recordSuccess(item: QueueItem): void {
    recordSuccesses([item])
  }

  // Several confirmed sends at once (one batch response's worth). Each still leaves the queue on
  // its own, right before its own `onItemDone` (see there), but they're recorded delivered with
  // one ledger write for the lot rather than a full rewrite of the ledger per item. Still
  // remove-then-record, so the crash window is the same harmless-resend one as above.
  // Removal goes through `removeSent`, never by key alone: an item replaced in place by a newer
  // revision while this one was in flight stays queued for the next drain (see there).
  function recordSuccesses(items: QueueItem[]): void {
    if (items.length === 0) return
    const keys = items.map(item => item.key)
    for (const item of items) {
      queue.removeSent([item])
      deps.onItemDone?.()
    }
    if (installId) {
      const ledger = new DeliveryLedger(deps.baseHome)
      const scoped = keys.map(key => scopedKey(installId, key))
      ledger.markDeliveredMany(scoped)
      // A session the cloud now holds is no longer one it refused for good.
      const accepted = new Set(scoped)
      new DroppedLedger(deps.baseHome).forget(key => accepted.has(key))
    }
  }

  function dropInvalid(item: QueueItem, detail: string): void {
    dropPermanently(item, `schema rejected: ${detail.slice(0, 200)}`)
  }

  // A record the server will never accept (schema-rejected, or too large on its own) — removed,
  // counted, and logged locally with the reason, never retried.
  function dropPermanently(item: QueueItem, reason: string): void {
    // Only the rejected payload: a newer revision queued since is a different record.
    queue.removeSent([item])
    droppedInvalid++
    // A session the cloud has never accepted under any revision would gate its day's trace
    // manifest (`missing_keys`) for good — recorded so the manifest leaves its key out. One the
    // cloud already holds (an earlier revision was delivered) still has a row there: not recorded.
    if (item.payload.session && installId) {
      const key = scopedKey(installId, item.key)
      if (!new DeliveryLedger(deps.baseHome).isDelivered(key)) new DroppedLedger(deps.baseHome).markDropped(key)
    }
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
      // A send that went through also ends an upgrade notice (the cloud accepts this version now).
      // (Not when this very drain just hit a 426: some items went through, the rest wait.)
      writeForwardState(stopped === 'upgrade-required'
        ? { lastSuccessAt: new Date().toISOString() }
        : { lastSuccessAt: new Date().toISOString(), paused: false, pausedUntil: null, ...(state.notice?.kind === 'upgrade' ? { notice: null } : {}) }, deps.baseHome)
      deps.recordSent?.(sent, now())
    }
    return { attempted: batch.length, sent, droppedInvalid, remaining: queue.depth(), stopped }
  }

  // The credential is gone for good (refresh rejected, or the install revoked): stop, and drop
  // everything that was queued for it — see this file's header on why the queue can't be kept.
  // The developer is told twice: a toast with a "Re-link" action where the host has one (the
  // editor), and a notice kept in the forward state (`notice`) that every host's Org panel shows
  // until the next link clears it — the standalone server has no toast at all. After a re-link the
  // catch-up pass (org/reconcileUnsent.ts) re-queues every local trace the new install hasn't
  // received, so nothing is lost.
  function unlinkAndClear(stopped: 'auth-failed' | 'membership-revoked', message: string): DrainResult {
    const result = finish(stopped)
    queue.clear()
    clearCredentials()
    const notice: ForwardNotice = { kind: 'relink', message, at: new Date(now()).toISOString() }
    clearForwardState(deps.baseHome, notice)
    deps.notify?.(message, 'warning', 'relink')
    return { ...result, remaining: 0 }
  }

  // The refresh token ran out of unanswered replays (tokenRefresh.ts `RefreshReplayExhaustedError`):
  // it can never be presented again, so this credential is cleared and the machine needs a
  // re-link — but the cloud never said the credential was dead, so the queue is not destroyed on
  // a local inference. It is kept, marked in the notice with the endpoint/org/member it was built
  // for: its hashes are salted with that org (`repoKey.ts`) and carry that member's author
  // fingerprint, so link.ts `persistFromTokens` keeps it only when the re-link is the same org as
  // the same member, and clears it (at re-link time, not before) otherwise. With no credential,
  // nothing drains it until then (`not-linked`).
  function holdForRelink(): DrainResult {
    const result = finish('auth-failed')
    const held = creds ? { endpoint: creds.endpoint, orgId: creds.orgId, memberId: creds.memberId } : undefined
    if (!held) queue.clear() // no owner to check a re-link against — never ship it blind
    clearCredentials()
    const notice: ForwardNotice = { kind: 'relink', message: RELINK_HELD_MESSAGE, at: new Date(now()).toISOString(), ...(held ? { heldQueueFor: held } : {}) }
    clearForwardState(deps.baseHome, notice)
    deps.notify?.(RELINK_HELD_MESSAGE, 'warning', 'relink')
    return result
  }

  // HTTP 426 `client_upgrade_required`: this version is too old for the cloud. Nothing is dropped
  // — the queue waits for an update (or UPGRADE_PAUSE_MS, then one more try).
  function upgradeRequired(): DrainResult {
    const version = clientVersion()
    const already = state.notice?.kind === 'upgrade' && state.notice.version === version
    const notice: ForwardNotice = { kind: 'upgrade', message: UPGRADE_MESSAGE, at: new Date(now()).toISOString(), version }
    writeForwardState({ paused: true, pausedUntil: now() + UPGRADE_PAUSE_MS, lastErrorAt: new Date().toISOString(), lastError: 'TraceRoost update required', notice }, deps.baseHome)
    if (!already) deps.notify?.(UPGRADE_MESSAGE, 'warning', 'update')
    return finish('upgrade-required')
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
      if (err instanceof TokenRefreshError && err.upgradeRequired) return upgradeRequired()
      if (err instanceof RefreshReplayExhaustedError) return holdForRelink()
      if (err instanceof TokenRefreshError && err.permanent) {
        // The server rejected the refresh token/client itself — retrying later with the same
        // credential would just fail the same way forever. The Org panel drops back to "Unlinked"
        // with its "Link this machine" button, instead of staying stuck on "Paused".
        return unlinkAndClear('auth-failed', RELINK_MESSAGE)
      }
      // Once per streak of failures, not on every retry (the scheduler retries within ~30 s).
      const alreadyTold = state.paused && state.lastError === REFRESH_FAILED
      if (!alreadyTold) deps.notify?.('TraceRoost: could not refresh your org credential. Rollups are queued and will retry automatically.', 'warning')
      writeForwardState({ paused: true, pausedUntil: null, lastErrorAt: new Date().toISOString(), lastError: REFRESH_FAILED }, deps.baseHome)
      return finish('auth-failed')
    }
  }

  function membershipRevoked(): DrainResult {
    return unlinkAndClear('membership-revoked', REVOKED_MESSAGE)
  }

  // A 403. Only the cloud's own "install revoked" answer means the credential is gone for good;
  // anything else (a proxy's or WAF's page) leaves the credential and queue alone and backs off.
  async function forbidden(res: Response, items: QueueItem[]): Promise<{ stop: DrainResult }> {
    const code = await cloudErrorCode(res)
    if (code !== null && REVOKED_ERRORS.has(code)) return { stop: membershipRevoked() }
    backOffAll(items, `HTTP 403${code ? ` (${code.slice(0, 80)})` : ' (not from TraceRoost Cloud)'}`)
    return { stop: finish('offline') }
  }

  async function isUpgradeRequired(res: Response): Promise<boolean> {
    return res.status === 426 && (await cloudErrorCode(res)) === UPGRADE_REQUIRED_ERROR
  }

  // Sends one chunk to the batch endpoint. Returns 'continue' to move on to the next chunk,
  // 'fallback' if the batch endpoint isn't available (404) so the caller should retry this same
  // chunk item-by-item, or `{ stop }` when the whole drain must end now (401-after-failed-refresh,
  // 403, 429 — each says something about every subsequent request, not just this chunk's).
  async function sendChunkBatched(chunk: QueueItem[]): Promise<'continue' | 'fallback' | { stop: DrainResult }> {
    let res: Response
    try {
      res = await postBatch(creds!, chunk, deps.onBatchRequest)
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
      res = await postBatch(creds!, chunk, deps.onBatchRequest).catch(() => res)
    }

    if (res.status === 403) return forbidden(res, chunk)
    if (await isUpgradeRequired(res)) return { stop: upgradeRequired() }

    if (res.status === 413) {
      // Over the server's body cap despite the byte budget (a single huge record, or a smaller
      // cap server-side). Split and resend; one record alone that's still too large can never be
      // accepted, so it's dropped and logged rather than retried forever — when the cloud itself
      // said so (an intermediary's 413 is backed off like any other transient failure).
      if (chunk.length === 1) {
        if (TOO_LARGE_ERRORS.has((await cloudErrorCode(res)) ?? '')) dropPermanently(chunk[0], 'payload too large (HTTP 413)')
        else backOffAll(chunk, 'HTTP 413 (not from TraceRoost Cloud)')
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
      const body = (await res.json()) as { results?: unknown; limits?: unknown }
      if (Array.isArray(body.results)) results = body.results as { status: number; error?: string }[]
      learnLimits(body.limits)
    } catch {
      /* falls through to the malformed-response handling below */
    }
    if (!results || results.length !== chunk.length) {
      // Can't tell which items landed — treat the whole chunk as transient rather than guess.
      backOffAll(chunk, 'malformed batch response')
      return 'continue'
    }

    const succeeded: QueueItem[] = []
    // Per-item transient failures, grouped by error so each group is one locked queue rewrite
    // rather than one per item (a database-busy batch defers most of its items with the same 500).
    const failedByError = new Map<string, string[]>()
    let upgrade = false
    chunk.forEach((item, idx) => {
      const r = results![idx]
      if (r.status === 202 || r.status === 200) {
        succeeded.push(item)
        sent++
      } else if (r.status === 400) {
        dropInvalid(item, r.error ?? '')
      } else if (r.status === 426 && r.error === UPGRADE_REQUIRED_ERROR) {
        // Kept, untouched: it goes out after the update.
        upgrade = true
      } else {
        const error = r.error ? `HTTP ${r.status}: ${r.error}` : `HTTP ${r.status}`
        failedByError.set(error, [...(failedByError.get(error) ?? []), item.key])
        sawTransientFailure = true
      }
    })
    for (const [error, keys] of failedByError) queue.recordFailures(keys, error)
    recordSuccesses(succeeded)
    if (upgrade) return { stop: upgradeRequired() }
    return 'continue'
  }

  // The original one-item-per-request path — used as the fallback when the batch endpoint isn't
  // available. Mirrors `sendChunkBatched`'s status handling exactly, just for a single item.
  async function sendItemSequentially(item: QueueItem): Promise<{ stop: DrainResult } | undefined> {
    let res: Response
    try {
      res = await postPayload(creds!, item)
    } catch {
      queue.recordFailure(item.key, 'service unreachable')
      writeForwardState({ lastErrorAt: new Date().toISOString(), lastError: 'service unreachable' }, deps.baseHome)
      sawTransientFailure = true
      return
    }

    if (res.status === 202 || res.status === 200) {
      recordSuccess(item)
      sent++
      return
    }

    if (res.status === 401 && !refreshedThisDrain) {
      const stop = await refreshOnce()
      if (stop) return { stop }
      res = await postPayload(creds!, item).catch(() => res)
      if (res.status === 202 || res.status === 200) { recordSuccess(item); sent++; return }
    }

    if (res.status === 403) return forbidden(res, [item])
    if (await isUpgradeRequired(res)) return { stop: upgradeRequired() }

    const code = res.status === 413 || res.status === 400 ? await cloudErrorCode(res) : null
    if (res.status === 413 && code !== null && TOO_LARGE_ERRORS.has(code)) {
      dropPermanently(item, 'payload too large (HTTP 413)')
      return
    }

    if (res.status === 400 && code !== null && RECORD_REJECTED_ERRORS.has(code)) {
      const detail = await safeText(res)
      dropInvalid(item, detail)
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
      if (err instanceof TokenRefreshError && err.upgradeRequired) return upgradeRequired()
      if (err instanceof RefreshReplayExhaustedError) return holdForRelink()
      if (err instanceof TokenRefreshError && err.permanent) {
        refreshedThisDrain = true
        return unlinkAndClear('auth-failed', RELINK_MESSAGE)
      }
    }
  }

  for (const chunk of chunkByCountAndBytes(batch, httpBatchSize, deps.maxBatchBytes ?? learnedMaxBytes ?? DEFAULT_MAX_BATCH_BYTES)) {

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

/** Bodies under this aren't worth the CPU/header overhead of gzip. */
const GZIP_MIN_BYTES = 1024
/** Set once a cloud that predates gzip support answers a gzipped body with "invalid JSON" / 415:
 *  from then on this process sends plain JSON, so a new client never loses records to an old cloud. */
let gzipUnsupported = false

/** Batch limits the server advertised in its last successful `/api/ingest/batch` response. Until
 *  one arrives (an older cloud never sends it) the conservative defaults above apply, so a new
 *  client can never overshoot an old server's `items must not exceed 25` 400. */
let learnedMaxItems: number | null = null
let learnedMaxBytes: number | null = null

/** Test seam: forget what we learned about the server (gzip support and advertised limits). */
export function resetServerCapabilities(): void {
  gzipUnsupported = false
  learnedMaxItems = null
  learnedMaxBytes = null
}

/** Reads `limits: { max_items, max_bytes }` off a batch response body, clamped to sane bounds. */
function learnLimits(limits: unknown): void {
  const l = limits as { max_items?: unknown; max_bytes?: unknown } | null
  if (!l || typeof l !== 'object') return
  if (typeof l.max_items === 'number' && Number.isFinite(l.max_items)) {
    learnedMaxItems = Math.min(100, Math.max(1, Math.floor(l.max_items)))
  }
  if (typeof l.max_bytes === 'number' && Number.isFinite(l.max_bytes)) {
    // Our chunk budget is measured on the serialized payloads, so leave headroom for the envelope.
    learnedMaxBytes = Math.min(4 * 1024 * 1024, Math.max(64 * 1024, Math.floor(l.max_bytes * 0.75)))
  }
}

/** POSTs a JSON body, gzipped when large enough and the server is known (or presumed) to accept it.
 *  Rollup JSON repeats the same keys and hashes in every record, so it compresses several-fold.
 *  The server caps the *inflated* size, so `chunkByCountAndBytes`'s uncompressed budget still holds. */
async function postJson(url: string, accessToken: string, json: string, signal: AbortSignal, meta?: { wireBytes: number }): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `traceroost-client/${clientVersion()}`,
  }
  const plain = () => {
    if (meta) meta.wireBytes = Buffer.byteLength(json)
    return fetch(url, { method: 'POST', headers, body: json, signal })
  }
  if (gzipUnsupported || Buffer.byteLength(json) < GZIP_MIN_BYTES) return plain()

  const zipped = new Uint8Array(gzipSync(json))
  if (meta) meta.wireBytes = zipped.byteLength
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Encoding': 'gzip' },
    body: zipped,
    signal,
  })
  if (res.status !== 415 && res.status !== 400) return res
  // 400 is also a real schema rejection, so only an "invalid JSON" 400 (an old cloud parsing gzip
  // bytes) or an "invalid gzip body" one (the body was mangled in transit, or by a proxy that
  // re-encodes it) means "send it plain". Never read the real response's body: clone first.
  const code = res.status === 415 ? null : ((await res.clone().json().catch(() => null)) as { error?: string } | null)?.error
  const unsupported = res.status === 415 || code === 'invalid JSON'
  if (!unsupported && code !== 'invalid gzip body') return res
  // Only an old cloud's refusal turns gzip off for good; a mangled body is retried plain once.
  if (!unsupported) return plain()
  gzipUnsupported = true
  return plain()
}

// Always the endpoint that issued the credential, never `orgEndpoint()`'s current resolution: an
// environment picked or set after linking must not send this credential's token (or its
// org-salted rollups) to a different server.
async function postBatch(creds: Pick<OrgCredentials, 'accessToken' | 'endpoint'>, items: QueueItem[], onStat?: (s: BatchRequestStat) => void): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const json = JSON.stringify({ items: items.map(it => it.payload) })
    const meta = { wireBytes: 0 }
    const started = Date.now()
    const res = await postJson(batchIngestUrl(creds.endpoint), creds.accessToken, json, controller.signal, meta)
    onStat?.({ items: items.length, rawBytes: Buffer.byteLength(json), wireBytes: meta.wireBytes, ms: Date.now() - started, status: res.status })
    return res
  } finally {
    clearTimeout(timer)
  }
}

async function postPayload(creds: Pick<OrgCredentials, 'accessToken' | 'endpoint'>, item: QueueItem): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    return await postJson(ingestUrl(creds.endpoint), creds.accessToken, JSON.stringify(item.payload), controller.signal)
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
