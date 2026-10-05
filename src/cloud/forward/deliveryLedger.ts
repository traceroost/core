/**
 * Records which forwarding-queue items have already been confirmed delivered (AL 04).
 *
 * Without this, the local-log rediscovery that runs on every process restart (see
 * `enqueueSession.ts`) had nothing to distinguish "never sent" from "sent successfully in a
 * previous run" — so it re-enqueued, and re-transmitted, a machine's entire history every time the
 * process restarted. The server deduplicates by key, so this was never a correctness bug — just a
 * wasteful, alarming-looking one: a linked-but-idle install could show dozens of sessions
 * "queued" on every single restart, forever.
 *
 * Stored in `~/.traceroost/delivered.json`, a flat JSON array of *scoped* keys — see `scopedKey`
 * below — user-only (0600). Capped with oldest-first eviction — see `DEFAULT_MAX_ENTRIES` — so a
 * long-lived install doesn't grow this file without bound. Falling out of the cap just means that
 * one item becomes eligible to be sent (and re-deduplicated server-side, for free) once more on
 * some future restart — never lost data, just the wasted-resend problem this file exists to
 * avoid, recurring at a much lower rate than "every restart."
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { withFileLock } from './fileLock'

export const DEFAULT_MAX_ENTRIES = 20_000

export function ledgerPath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.traceroost', 'delivered.json')
}

/** The dropped-keys record (`DroppedLedger`), beside the delivery ledger. */
export function droppedLedgerPath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.traceroost', 'dropped.json')
}

/**
 * "Delivered" only means anything relative to a specific *install*, not a specific org. The
 * server tracks delivery per-install (`/api/installs/me` counts `rollups` by `install_id`), and
 * a fresh install is minted on every link — even a re-link to the same org from the same
 * machine (see `cloud/src/lib/oauth.ts`'s `exchangeCode`/`pollDeviceFlow`, both of which
 * unconditionally `installs.insert(...)`). Org-scoping (an earlier version of this comment,
 * before entries were rescoped to install) got this one level too coarse: a session delivered
 * under install A, then reconciled after a leave+relink to install B of the *same* org, still
 * read as "already delivered" and was silently never sent to B at all — install B's own count
 * stayed wherever it was at the moment of relink, forever. Every entry is now scoped by the
 * install id the delivery was actually confirmed to; a pre-rescoping entry just never matches a
 * scoped lookup again, so the next reconciliation or restart re-sends it once (idempotent,
 * deduplicated server-side) and re-records it correctly — a one-time cost per pre-existing
 * entry, not a repeating one. */
export function scopedKey(installId: string, itemKey: string): string {
  return `${installId}:${itemKey}`
}

/** Per-process, per-file cache of the parsed ledger, keyed off the file's mtime — see `readAll`
 *  below for why this exists. Module-level (not per-instance) because every call site does
 *  `new DeliveryLedger()` fresh rather than holding one around. */
interface LedgerCache { mtimeMs: number; keys: string[]; set: Set<string> }
const readCache = new Map<string, LedgerCache>()

export class DeliveryLedger {
  private readonly file: string
  private readonly maxEntries: number

  constructor(baseHome?: string, maxEntries = DEFAULT_MAX_ENTRIES, file: string = ledgerPath(baseHome)) {
    this.file = file
    this.maxEntries = maxEntries
  }

  /** Every recorded (scoped) key — for a reader that has to enumerate, not look one up. */
  all(): readonly string[] {
    return this.readCached().keys
  }

  /**
   * Re-parsing this file (up to `DEFAULT_MAX_ENTRIES` entries) on every call used to be exactly
   * what it looked like: reconciliation and the post-send delivery recording (`sender.ts`) both
   * call `isDelivered`/`markDelivered` once per session, in a loop, and each call built a fresh
   * `DeliveryLedger()` — so a "Check for unsent traces" over a machine's full history re-read and
   * re-JSON.parsed the entire ledger file once per session. That's the real reason it was slow,
   * not just perceived-slow: an `fs.statSync` (below) is orders of magnitude cheaper than a
   * `readFileSync` + `JSON.parse` of a large array, so reusing the parse when the file's mtime
   * hasn't moved turns an O(sessions × ledger size) reconcile into O(sessions) statSyncs plus one
   * real parse.
   */
  private readCached(): LedgerCache {
    let stat: fs.Stats
    try {
      stat = fs.statSync(this.file)
    } catch {
      readCache.delete(this.file)
      return { mtimeMs: -1, keys: [], set: new Set() }
    }
    const cached = readCache.get(this.file)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch {
      return { mtimeMs: -1, keys: [], set: new Set() }
    }
    let keys: string[]
    try {
      const parsed = JSON.parse(raw)
      keys = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      keys = []
    }
    const entry: LedgerCache = { mtimeMs: stat.mtimeMs, keys, set: new Set(keys) }
    readCache.set(this.file, entry)
    return entry
  }

  isDelivered(key: string): boolean {
    return this.readCached().set.has(key)
  }

  /** Idempotent. A no-op if `key` is already recorded. Locked (see fileLock.ts): this file is
   *  shared by every TraceRoost host on the machine, not per-process, so the
   *  read-then-write-the-whole-array below must run as one atomic section across hosts --
   *  otherwise two hosts marking different keys delivered around the same time can each read
   *  before either writes, and whichever writes second silently discards the first's key. */
  markDelivered(key: string): void {
    this.markDeliveredMany([key])
  }

  /** `markDelivered` for several keys in one locked read-modify-write — see sender.ts, which
   *  records a whole batch response's confirmed sends at once. */
  markDeliveredMany(keys: string[]): void {
    withFileLock(this.file, () => {
      const existing = this.readCached()
      const added = new Set<string>()
      for (const key of keys) {
        if (!existing.set.has(key)) added.add(key)
      }
      if (added.size === 0) return
      const next = [...existing.keys, ...added]
      this.writeAll(next.length > this.maxEntries ? next.slice(next.length - this.maxEntries) : next)
    })
  }

  /** Removes every recorded key `drop` matches, in one locked read-modify-write. */
  forget(drop: (key: string) => boolean): void {
    withFileLock(this.file, () => {
      const existing = this.readCached().keys
      const kept = existing.filter(key => !drop(key))
      if (kept.length !== existing.length) this.writeAll(kept)
    })
  }

  private writeAll(keys: string[]): void {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(keys), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    // Keep the cache in step with our own write so a `markDelivered` loop (sender.ts sends
    // several keys per drain) doesn't immediately re-read what it just wrote.
    const stat = fs.statSync(this.file)
    readCache.set(this.file, { mtimeMs: stat.mtimeMs, keys, set: new Set(keys) })
  }
}

/**
 * Session rollups the cloud refused for good — a 400 (schema-rejected) or a 413 (too large on its
 * own) — and that it never held under any revision (`sender.ts`'s `dropPermanently`). Same file
 * shape, scoping and cap as the delivery ledger, in `~/.traceroost/dropped.json`.
 *
 * It exists for the trace manifest (`traceManifest.ts`): the local store still holds such a trace,
 * so its key would be listed, and a key the cloud has never seen gates the whole day's chunk as
 * `missing_keys` — a gate meant for "not delivered *yet*", re-sent with growing backoff, which
 * for a key that will never arrive wedges that day's manifest for good. Listing the key is
 * pointless (the cloud has no row to keep) so the manifest leaves it out. An entry is forgotten
 * the moment a later revision of the same session is accepted: the key is then a delivered one.
 */
export class DroppedLedger {
  private readonly ledger: DeliveryLedger

  constructor(baseHome?: string, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.ledger = new DeliveryLedger(baseHome, maxEntries, droppedLedgerPath(baseHome))
  }

  isDropped(key: string): boolean {
    return this.ledger.isDelivered(key)
  }

  markDropped(key: string): void {
    this.ledger.markDeliveredMany([key])
  }

  /** The wire `session_id`s dropped for `installId` — what a manifest leaves out. */
  sessionIds(installId: string): Set<string> {
    const prefix = `${installId}:session:`
    const out = new Set<string>()
    for (const key of this.ledger.all()) {
      if (key.startsWith(prefix)) out.add(key.slice(prefix.length))
    }
    return out
  }

  /** Removes every recorded key `drop` matches. */
  forget(drop: (key: string) => boolean): void {
    if (this.ledger.all().length === 0) return
    this.ledger.forget(drop)
  }
}
