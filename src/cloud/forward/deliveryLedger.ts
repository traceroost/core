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

export const DEFAULT_MAX_ENTRIES = 20_000

export function ledgerPath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.traceroost', 'delivered.json')
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

export class DeliveryLedger {
  private readonly file: string
  private readonly maxEntries: number

  constructor(baseHome?: string, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.file = ledgerPath(baseHome)
    this.maxEntries = maxEntries
  }

  private readAll(): string[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch {
      return []
    }
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  isDelivered(key: string): boolean {
    return this.readAll().includes(key)
  }

  /** Idempotent. A no-op if `key` is already recorded. */
  markDelivered(key: string): void {
    const existing = this.readAll()
    if (existing.includes(key)) return
    const next = [...existing, key]
    this.writeAll(next.length > this.maxEntries ? next.slice(next.length - this.maxEntries) : next)
  }

  private writeAll(keys: string[]): void {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(keys), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}
