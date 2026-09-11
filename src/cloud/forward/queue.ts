/**
 * Disk-backed forwarding queue (AL 04).
 *
 * The cloud is a read-only mirror. If the service is down no developer is blocked; a lead's
 * dashboard is stale for an hour. So there is no synchronous path from a session close to the
 * network — rollups are built, appended here, and drained on a timer.
 *
 * - Stored in `~/.agentlens/forward-queue.jsonl`, one JSON object per line, user-only (0600),
 *   surviving restarts and sleep.
 * - Idempotent on the item key (`session:<uuid>`, `commits:<fp>:<digest>`,
 *   `turnover:<fp>:<digest>`), so a retry after an ambiguous failure is free and the server
 *   deduplicates.
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

export function queuePath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.agentlens', 'forward-queue.jsonl')
}

/** Derives the idempotency key for a payload — matches `alsaas` `receiptKeys()`. */
export function itemKey(payload: RollupPayload): string {
  if (payload.session) return `session:${payload.session.session_id}`
  if (payload.commits && payload.commits.length > 0) {
    return `commits:${payload.repo_key_fp}:${digest(payload.commits.map(c => c.commit_hash))}`
  }
  if (payload.turnover && payload.turnover.length > 0) {
    return `turnover:${payload.repo_key_fp}:${digest(payload.turnover.map(t => `${t.commit_hash}:${t.window_days}`))}`
  }
  return `empty:${payload.repo_key_fp}`
}

function digest(parts: string[]): string {
  return crypto.createHash('sha256').update([...parts].sort().join('\n')).digest('hex').slice(0, 16)
}

export class ForwardQueue {
  private readonly file: string
  private readonly maxItems: number

  constructor(baseHome?: string, maxItems = DEFAULT_MAX_ITEMS) {
    this.file = queuePath(baseHome)
    this.maxItems = maxItems
  }

  /** Every item currently pending, oldest first. */
  list(): QueueItem[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch {
      return []
    }
    const items: QueueItem[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as QueueItem
        if (parsed && typeof parsed.key === 'string' && parsed.payload) items.push(parsed)
      } catch {
        /* skip a torn final line */
      }
    }
    // De-dup by key, newest wins (an item re-enqueued after a failed send replaces the old row).
    const byKey = new Map<string, QueueItem>()
    for (const it of items) byKey.set(it.key, it)
    return [...byKey.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt)
  }

  depth(): number {
    return this.list().length
  }

  /** Appends a payload if its key is not already queued. Returns whether it was added. */
  enqueue(payload: RollupPayload): boolean {
    const key = itemKey(payload)
    const existing = this.list()
    if (existing.some(it => it.key === key)) return false
    const item: QueueItem = {
      key,
      payload,
      enqueuedAt: Date.now(),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    }
    const next = [...existing, item]
    // Oldest-first eviction past the cap.
    this.writeAll(next.length > this.maxItems ? next.slice(next.length - this.maxItems) : next)
    return true
  }

  /** Removes items by key (called after a 2xx or a permanent 400 drop). */
  remove(keys: string[]): void {
    const drop = new Set(keys)
    this.writeAll(this.list().filter(it => !drop.has(it.key)))
  }

  /** Records a failed attempt (bumps `attempts`, stores the error) without removing the item. */
  recordFailure(key: string, error: string): void {
    this.writeAll(this.list().map(it =>
      it.key === key
        ? { ...it, attempts: it.attempts + 1, lastAttemptAt: Date.now(), lastError: error }
        : it,
    ))
  }

  clear(): void {
    try {
      fs.rmSync(this.file, { force: true })
    } catch {
      /* already gone */
    }
  }

  private writeAll(items: QueueItem[]): void {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const body = items.map(it => JSON.stringify(it)).join('\n') + (items.length ? '\n' : '')
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}
