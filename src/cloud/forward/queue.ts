/**
 * Disk-backed forwarding queue (AL 04).
 *
 * The cloud is a read-only mirror. If the service is down no developer is blocked; a lead's
 * dashboard is stale for an hour. So there is no synchronous path from a session close to the
 * network — rollups are built, appended here, and drained on a timer.
 *
 * - Stored in `~/.traceroost/forward-queue.jsonl`, one JSON object per line, user-only (0600),
 *   surviving restarts and sleep.
 * - Idempotent on the item key (`session:<uuid>`, `commits:<fp>:<digest>`,
 *   `turnover:<fp>:<digest>`, `instructions:<fp>:<digest>`), so the same record is never queued
 *   twice; a retry after an ambiguous failure is free because the server deduplicates on its own,
 *   per-record receipt keys (see `itemKey`).
 * - Hard cap on entries with oldest-first eviction, so an install that never reconnects does
 *   not grow without bound.
 * - Holds built rollups only — records that have already passed through AL 03's hashing. There
 *   is no intermediate on-disk form containing paths.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import type { RollupPayload } from './schema'
import { withFileLock } from './fileLock'

export interface QueueItem {
  /** Idempotency key. The server deduplicates on the same value. */
  key: string
  payload: RollupPayload
  enqueuedAt: number
  attempts: number
  lastAttemptAt: number | null
  lastError: string | null
}

export const DEFAULT_MAX_ITEMS = 5000

// 3 failed attempts means the item has already been backed off and retried twice more (per
// `nextEligibleAt`'s exponential schedule) and failed the same way each time — long enough to
// rule out "just a single bad network blip," short enough to surface a real problem quickly
// rather than waiting out the full hour-long backoff ceiling first.
export const STUCK_ATTEMPTS_THRESHOLD = 3

export function queuePath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.traceroost', 'forward-queue.jsonl')
}

/** Derives this queue's own dedupe key for a payload. Not the server's idempotency key: cloud's
 *  `receiptKeys()` (persist.ts) keys each record separately and scopes it to the org (and, for a
 *  session, to its revision), so this only has to be stable enough that the same record isn't
 *  queued twice — the server is what makes a resend harmless. An instruction-telemetry payload is
 *  keyed on its instruction-file state, so a changed state queues behind (rather than being
 *  dropped as a duplicate of) an older one still waiting to send. */
export function itemKey(payload: RollupPayload): string {
  if (payload.session) return `session:${payload.session.session_id}`
  if (payload.commits && payload.commits.length > 0) {
    return `commits:${payload.repo_key_fp}:${digest(payload.commits.map(c => c.commit_hash))}`
  }
  if (payload.turnover && payload.turnover.length > 0) {
    return `turnover:${payload.repo_key_fp}:${digest(payload.turnover.map(t => `${t.commit_hash}:${t.window_days}`))}`
  }
  if (payload.instruction_files && payload.instruction_files.length > 0) {
    return `instructions:${payload.repo_key_fp}:${digest(payload.instruction_files.map(f => JSON.stringify(f)))}`
  }
  return `empty:${payload.repo_key_fp}`
}

function digest(parts: string[]): string {
  return crypto.createHash('sha256').update([...parts].sort().join('\n')).digest('hex').slice(0, 16)
}

export class ForwardQueue {
  private readonly file: string
  private readonly maxItems: number
  private readonly log?: (m: string) => void

  /** `log`, if given, is used to surface a loud line when `enqueue` evicts to stay under
   *  `maxItems` — without it, an install whose backlog outgrows the cap (a sustained 5xx, an
   *  offline stretch, a slow network) silently drops undelivered work, indistinguishable from
   *  "still queued, just slow". See .staged-issues/reconcile-gap-and-latency.md. */
  constructor(baseHome?: string, maxItems = DEFAULT_MAX_ITEMS, log?: (m: string) => void) {
    this.file = queuePath(baseHome)
    this.maxItems = maxItems
    this.log = log
  }

  /** Every item currently pending, oldest first. */
  list(): QueueItem[] {
    return this.readCached().items.slice()
  }

  /**
   * `list()`'s parse, reused while the file hasn't changed underneath it. Every queue operation
   * used to re-read and re-`JSON.parse` the whole file (up to `DEFAULT_MAX_ITEMS` rollups, ~10MB)
   * — an enqueue near the cap took ~140ms, filling an empty queue to the cap was O(n²) (minutes),
   * and a 200-item drain spent ~30s blocked in per-item `remove`s. Same approach as
   * `deliveryLedger.ts`'s `readCached`: a `statSync` is far cheaper than the read + parse, and the
   * cache is keyed on the file's identity (inode, size, mtime) so a write by any other host on
   * the machine — always a whole-file `rename` or an append — invalidates it.
   */
  private readCached(): QueueCache {
    let stat: fs.Stats
    try {
      stat = fs.statSync(this.file)
    } catch {
      readCache.delete(this.file)
      return EMPTY_CACHE
    }
    const cached = readCache.get(this.file)
    if (cached && sameFile(cached.stat, stat)) return cached
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch {
      return EMPTY_CACHE
    }
    const items: QueueItem[] = []
    let lineCount = 0
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      lineCount++
      try {
        const parsed = JSON.parse(trimmed) as QueueItem
        if (parsed && typeof parsed.key === 'string' && parsed.payload) {
          items.push(parsed)
          serialized.set(parsed, trimmed)
        }
      } catch {
        /* skip a torn final line */
      }
    }
    // De-dup by key, newest wins (an item re-enqueued after a failed send replaces the old row).
    const byKey = new Map<string, QueueItem>()
    for (const it of items) byKey.set(it.key, it)
    const entry: QueueCache = {
      stat,
      items: [...byKey.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt),
      endsWithNewline: raw.length === 0 || raw.endsWith('\n'),
      lineCount,
    }
    readCache.set(this.file, entry)
    return entry
  }

  depth(): number {
    return this.list().length
  }

  /** Items that have failed at least `STUCK_ATTEMPTS_THRESHOLD` times in a row — failing
   *  deterministically (a schema mismatch, a server-side bug) rather than hitting a one-off
   *  network blip. See `currentQueueStats.ts`'s `stuckCount`/`stuckError` for why this needs to be
   *  visible separately from `lastErrorAt`/`lastSuccessAt`: an unrelated item elsewhere in the
   *  queue succeeding keeps bumping `lastSuccessAt`, which otherwise hides a subset of the queue
   *  that is never going to send on its own. */
  stuckItems(): QueueItem[] {
    return this.list().filter(it => it.attempts >= STUCK_ATTEMPTS_THRESHOLD)
  }

  /** Appends a payload if its key is not already queued. If one already is, replaces it in place
   *  — keeping its original `enqueuedAt`/`attempts`/retry identity — when the new payload carries
   *  a strictly newer `session.revision` than the queued one (staged feature 10): an unsent
   *  snapshot that's since been superseded by a real outcome change must not sit frozen at its
   *  first-queued values until it's sent. A payload with no revision, or a revision no greater
   *  than what's already queued, is treated as the legacy/no-op case and dropped (same as
   *  before this feature) — there's nothing here to confirm it's actually newer. Returns whether
   *  the queue changed. */
  // Locked (see fileLock.ts): this file is shared by every TraceRoost host on the machine, not
  // per-process, so the read-list-then-write-all below must run as one atomic section across
  // hosts -- otherwise two hosts enqueuing around the same time can each read before either
  // writes, and whichever writes second silently discards the first's addition.
  enqueue(payload: RollupPayload): boolean {
    return withFileLock(this.file, () => {
      const key = itemKey(payload)
      const cache = this.readCached()
      const existing = cache.items
      const idx = existing.findIndex(it => it.key === key)
      if (idx === -1) {
        return this.appendNew(payload, key, cache)
      }
      const incomingRevision = payload.session?.revision
      const queuedRevision = existing[idx].payload.session?.revision
      if (incomingRevision === undefined || (queuedRevision !== undefined && incomingRevision <= queuedRevision)) {
        return false
      }
      const next = [...existing]
      next[idx] = { ...next[idx], payload }
      this.writeAll(next)
      return true
    })
  }

  private appendNew(payload: RollupPayload, key: string, cache: QueueCache): boolean {
    const existing = cache.items
    const item: QueueItem = {
      key,
      payload,
      enqueuedAt: Date.now(),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    }
    // Common case — room left, and the file on disk is one this module wrote (user-only, every
    // line a distinct item): append one line instead of rewriting every queued item. Reads the
    // same through `list()` as the full rewrite below would. Anything else (at the cap, a file
    // with stale/torn/duplicate rows to compact, or permissions to restore) takes the rewrite.
    if (
      cache.stat &&
      cache.lineCount === existing.length &&
      existing.length + 1 <= this.maxItems &&
      (process.platform === 'win32' || (cache.stat.mode & 0o777) === 0o600)
    ) {
      this.appendLine(item, cache)
      return true
    }
    const next = [...existing, item]
    // Oldest-first eviction past the cap.
    if (next.length > this.maxItems) {
      const evicted = next.length - this.maxItems
      this.log?.(`[TraceRoost] forward queue at capacity (${this.maxItems}) — evicting ${evicted} oldest unsent item(s) to make room; they will not be sent`)
      this.writeAll(next.slice(evicted))
    } else {
      this.writeAll(next)
    }
    return true
  }

  /** Removes items by key (called after a 2xx or a permanent 400 drop). Locked, same reason as
   *  `enqueue` -- see fileLock.ts. */
  remove(keys: string[]): void {
    withFileLock(this.file, () => {
      const drop = new Set(keys)
      const items = this.readCached().items
      if (!items.some(it => drop.has(it.key))) return
      this.writeAll(items.filter(it => !drop.has(it.key)))
    })
  }

  /** Records a failed attempt (bumps `attempts`, stores the error) without removing the item.
   *  Locked, same reason as `enqueue` -- see fileLock.ts. */
  recordFailure(key: string, error: string): void {
    this.recordFailures([key], error)
  }

  /** `recordFailure` for several keys in one locked rewrite — a failed HTTP batch backs off every
   *  item in it at once (see sender.ts's `backOffAll`). */
  recordFailures(keys: string[], error: string): void {
    withFileLock(this.file, () => {
      const failed = new Set(keys)
      const now = Date.now()
      this.writeAll(this.readCached().items.map(it =>
        failed.has(it.key)
          ? { ...it, attempts: it.attempts + 1, lastAttemptAt: now, lastError: error }
          : it,
      ))
    })
  }

  clear(): void {
    readCache.delete(this.file)
    try {
      fs.rmSync(this.file, { force: true })
    } catch {
      /* already gone */
    }
  }

  private writeAll(items: QueueItem[]): void {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const body = items.map(serialize).join('\n') + (items.length ? '\n' : '')
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    // Keep the cache in step with our own write, so the next operation doesn't re-read it.
    this.setCache(items, true, items.length)
  }

  private appendLine(item: QueueItem, cache: QueueCache): void {
    // A torn final line (no trailing newline) must not swallow the new row into itself.
    fs.appendFileSync(this.file, (cache.endsWithNewline ? '' : '\n') + serialize(item) + '\n')
    this.setCache([...cache.items, item], true, cache.lineCount + 1)
  }

  private setCache(items: QueueItem[], endsWithNewline: boolean, lineCount: number): void {
    try {
      const stat = fs.statSync(this.file)
      readCache.set(this.file, { stat, items: [...items].sort((a, b) => a.enqueuedAt - b.enqueuedAt), endsWithNewline, lineCount })
    } catch {
      readCache.delete(this.file)
    }
  }
}

/** Per-process, per-file cache of `ForwardQueue`'s parse — see `readCached`. Module-level (not
 *  per-instance) because every call site constructs a fresh `ForwardQueue`. */
interface QueueCache {
  /** Null only for `EMPTY_CACHE` (no file). */
  stat: fs.Stats | null
  /** De-duplicated, oldest first — exactly what `list()` returns. Never mutated in place. */
  items: QueueItem[]
  endsWithNewline: boolean
  /** Non-blank lines in the file, parseable or not. Equal to `items.length` only when every line
   *  is a distinct, valid item — the precondition for appending rather than rewriting. */
  lineCount: number
}
const readCache = new Map<string, QueueCache>()
const EMPTY_CACHE: QueueCache = { stat: null, items: [], endsWithNewline: true, lineCount: 0 }

/** Each cached item's JSON line, so rewriting the queue after removing or updating a few items
 *  doesn't re-serialize every unchanged one. Items are never mutated in place (an update is always
 *  a fresh object — see `recordFailures`/`enqueue`), so an entry can't go stale. */
const serialized = new WeakMap<QueueItem, string>()

function serialize(item: QueueItem): string {
  let line = serialized.get(item)
  if (line === undefined) {
    line = JSON.stringify(item)
    serialized.set(item, line)
  }
  return line
}

function sameFile(a: fs.Stats | null, b: fs.Stats): boolean {
  return a !== null && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}
