/**
 * SQLite-backed store for canonical trace revisions (live trace reconciliation) --
 * see schema.ts's `trace_revision` / `trace_revision_counter` tables for the storage shape. A
 * revision advances when either of two independent dimensions changes: the classified git outcome
 * (`recordCheck`) or the content of the full allowlisted cloud-forwarded projection
 * (`recordPayloadHash`, see reconcile/payloadHash.ts). Both share one revision counter per
 * session; each write preserves the other dimension's last-recorded value rather than clobbering
 * it, so a session reconciled for outcome and one reconciled for content drift never race each
 * other's comparison state.
 */

interface WriteableDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

export interface TraceRevisionRow {
  revision: number
  lifecycle: string
  fingerprint: string
  outcomeOverall: string | null
  payloadHash: string | null
  checkedAt: number
  changedAt: number
  /** Source rank of the last content-hashed snapshot (src/traceIdentity.ts), or null. */
  sourceRank: number | null
}

/** Revisions are seconds since this instant (2026-01-01T00:00:00Z), floored by the store's own
 *  counter: `max(lastRevision + 1, secondsSinceEpoch)`. A per-store counter alone restarted at 1
 *  after a database reset, or on a move from the editor extension to the background service, and
 *  the cloud — which keeps the highest revision it has seen per key — ignored every update until
 *  the new counter caught up. Wall-clock seconds are monotonic per machine across stores. Seconds,
 *  not milliseconds: the cloud stores `revision` as a Postgres `int` (max 2^31 − 1), which these
 *  values stay under until 2094 (ms since 1970 would overflow it today). Every value is far above
 *  any counter an older build reached, so an upgrade only ever moves revisions forward. */
export const REVISION_EPOCH_MS = Date.UTC(2026, 0, 1)

export function revisionClock(nowMs: number): number {
  return Math.max(1, Math.floor((nowMs - REVISION_EPOCH_MS) / 1000))
}

let defaultClock: () => number = Date.now

/** Test seam: the clock every repository built without its own reads (undefined restores
 *  Date.now). Pinning it to REVISION_EPOCH_MS makes revisions count 1, 2, 3… as a bare counter. */
export function setRevisionClockForTests(clock: (() => number) | undefined): void {
  defaultClock = clock ?? Date.now
}

export class TraceRevisionRepository {
  constructor(private readonly db: WriteableDb, private readonly now: () => number = () => defaultClock()) {}

  get(sessionId: string): TraceRevisionRow | undefined {
    const escaped = sessionId.replace(/'/g, "''")
    const rows = this.db.exec(
      `SELECT revision, lifecycle, fingerprint, outcome_overall, payload_hash, checked_at, changed_at, source_rank
       FROM trace_revision WHERE session_id = '${escaped}'`,
    )
    if (!rows[0] || rows[0].values.length === 0) return undefined
    const [revision, lifecycle, fingerprint, outcomeOverall, payloadHash, checkedAt, changedAt, sourceRank] = rows[0].values[0] as
      [number, string, string, string | null, string | null, number, number, number | null]
    return { revision, lifecycle, fingerprint, outcomeOverall, payloadHash, checkedAt, changedAt, sourceRank: sourceRank ?? null }
  }

  /** Allocates the next global revision number: `max(counter, revisionClock(now))`, so it is
   *  monotonic per machine, not just per store (see REVISION_EPOCH_MS). Not safe across processes
   *  sharing one database file -- see this table's schema.ts doc comment. */
  private allocateRevision(): number {
    this.db.run('INSERT OR IGNORE INTO trace_revision_counter (id, next) VALUES (1, 1)')
    const rows = this.db.exec('SELECT next FROM trace_revision_counter WHERE id = 1')
    const counter = (rows[0]?.values[0]?.[0] as number | undefined) ?? 1
    const revision = Math.max(counter, revisionClock(this.now()))
    this.db.run('UPDATE trace_revision_counter SET next = ? WHERE id = 1', [revision + 1])
    return revision
  }

  /** Records a fresh classification. Only allocates (and returns) a new revision when
   *  `outcomeOverall` differs from the last-stored value for this session, or there was no prior
   *  row -- an unchanged verdict from a re-check (fingerprint moved but the classified outcome
   *  didn't) just refreshes `checked_at` and reuses the existing revision, matching the
   *  reconciliation contract's "a repeated parse of identical evidence must not create a new revision" and its
   *  narrower cousin, "an unchanged semantic outcome updates checked time without creating a
   *  revision." Returns the row's revision and whether it changed, so callers can decide whether
   *  this is forwarding-worthy. */
  recordCheck(sessionId: string, fingerprint: string, outcomeOverall: string | null): { revision: number; changed: boolean } {
    const existing = this.get(sessionId)
    const now = Date.now()
    if (existing && existing.outcomeOverall === outcomeOverall) {
      this.db.run(
        'UPDATE trace_revision SET fingerprint = ?, checked_at = ? WHERE session_id = ?',
        [fingerprint, now, sessionId],
      )
      return { revision: existing.revision, changed: false }
    }
    const revision = this.allocateRevision()
    this.db.run(
      `INSERT OR REPLACE INTO trace_revision
         (session_id, revision, lifecycle, fingerprint, outcome_overall, payload_hash, checked_at, changed_at, source_rank)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [sessionId, revision, fingerprint, outcomeOverall, existing?.payloadHash ?? null, now, now, existing?.sourceRank ?? null],
    )
    return { revision, changed: true }
  }

  /** Symmetric to `recordCheck`, for the content-hash dimension (live reconciliation's
   *  generalization beyond outcome-only): allocates a new revision only when `hash` -- a
   *  canonical hash of the full allowlisted rollup, see payloadHash.ts -- differs from the last
   *  one recorded for this session. Covers duration/tokens/tool-calls/model-mix/etc. growing or
   *  changing after a session's first send, independent of whether its git outcome also moved.
   *  `fingerprint` is NOT NULL in the schema; a session with no prior git-outcome check yet
   *  (this dimension write reaching the row first) stores '' rather than leaving that dimension
   *  looking checked. */
  recordPayloadHash(sessionId: string, hash: string, sourceRank?: number): { revision: number; changed: boolean; downgrade?: boolean } {
    const plan = this.planPayloadHash(sessionId, hash, sourceRank)
    if (plan.changed) this.commitPayloadHash(sessionId, hash, plan.revision, sourceRank)
    return plan
  }

  /** `recordPayloadHash`'s decision without its write: whether `hash` is a change, and if so a
   *  freshly allocated revision for it — recorded only by `commitPayloadHash`, once the snapshot
   *  carrying it was actually queued (a failed enqueue must not mark the content as sent). */
  planPayloadHash(sessionId: string, hash: string, sourceRank?: number): { revision: number; changed: boolean; downgrade?: boolean } {
    const existing = this.get(sessionId)
    const now = Date.now()
    // Source precedence (src/traceIdentity.ts): a snapshot from a lower-rank source (a transcript
    // re-scan after the OTEL card was sent) never becomes a newer revision of the same key.
    if (existing && sourceRank !== undefined && existing.sourceRank !== null && sourceRank < existing.sourceRank) {
      this.db.run('UPDATE trace_revision SET checked_at = ? WHERE session_id = ?', [now, sessionId])
      return { revision: existing.revision, changed: false, downgrade: true }
    }
    if (existing && existing.payloadHash === hash) {
      this.db.run('UPDATE trace_revision SET checked_at = ? WHERE session_id = ?', [now, sessionId])
      return { revision: existing.revision, changed: false }
    }
    return { revision: this.allocateRevision(), changed: true }
  }

  /** Records `hash` as sent under `revision` (from `planPayloadHash`). */
  commitPayloadHash(sessionId: string, hash: string, revision: number, sourceRank?: number): void {
    const existing = this.get(sessionId)
    const now = Date.now()
    this.db.run(
      `INSERT OR REPLACE INTO trace_revision
         (session_id, revision, lifecycle, fingerprint, outcome_overall, payload_hash, checked_at, changed_at, source_rank)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [sessionId, Math.max(revision, existing?.revision ?? 0), existing?.fingerprint ?? '', existing?.outcomeOverall ?? null, hash, now, now, sourceRank ?? existing?.sourceRank ?? null],
    )
  }
}
