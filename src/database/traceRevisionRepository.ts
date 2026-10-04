/**
 * SQLite-backed store for canonical trace revisions (staged feature 10, Stage 1, generalized) --
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
  /** Source rank of the last content-hashed snapshot (staged feature 11), or null. */
  sourceRank: number | null
}

export class TraceRevisionRepository {
  constructor(private readonly db: WriteableDb) {}

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

  /** Allocates the next global revision number. Not safe across processes sharing one database
   *  file -- see this table's schema.ts doc comment. */
  private allocateRevision(): number {
    this.db.run('INSERT OR IGNORE INTO trace_revision_counter (id, next) VALUES (1, 1)')
    const rows = this.db.exec('SELECT next FROM trace_revision_counter WHERE id = 1')
    const next = (rows[0]?.values[0]?.[0] as number | undefined) ?? 1
    this.db.run('UPDATE trace_revision_counter SET next = ? WHERE id = 1', [next + 1])
    return next
  }

  /** Records a fresh classification. Only allocates (and returns) a new revision when
   *  `outcomeOverall` differs from the last-stored value for this session, or there was no prior
   *  row -- an unchanged verdict from a re-check (fingerprint moved but the classified outcome
   *  didn't) just refreshes `checked_at` and reuses the existing revision, matching the staged
   *  feature's "a repeated parse of identical evidence must not create a new revision" and its
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

  /** Symmetric to `recordCheck`, for the content-hash dimension (staged feature 10's
   *  generalization beyond outcome-only): allocates a new revision only when `hash` -- a
   *  canonical hash of the full allowlisted rollup, see payloadHash.ts -- differs from the last
   *  one recorded for this session. Covers duration/tokens/tool-calls/model-mix/etc. growing or
   *  changing after a session's first send, independent of whether its git outcome also moved.
   *  `fingerprint` is NOT NULL in the schema; a session with no prior git-outcome check yet
   *  (this dimension write reaching the row first) stores '' rather than leaving that dimension
   *  looking checked. */
  recordPayloadHash(sessionId: string, hash: string, sourceRank?: number): { revision: number; changed: boolean; downgrade?: boolean } {
    const existing = this.get(sessionId)
    const now = Date.now()
    // Source precedence (staged feature 11): a snapshot from a lower-rank source (a transcript
    // re-scan after the OTEL card was sent) never becomes a newer revision of the same key.
    if (existing && sourceRank !== undefined && existing.sourceRank !== null && sourceRank < existing.sourceRank) {
      this.db.run('UPDATE trace_revision SET checked_at = ? WHERE session_id = ?', [now, sessionId])
      return { revision: existing.revision, changed: false, downgrade: true }
    }
    if (existing && existing.payloadHash === hash) {
      this.db.run('UPDATE trace_revision SET checked_at = ? WHERE session_id = ?', [now, sessionId])
      return { revision: existing.revision, changed: false }
    }
    const revision = this.allocateRevision()
    this.db.run(
      `INSERT OR REPLACE INTO trace_revision
         (session_id, revision, lifecycle, fingerprint, outcome_overall, payload_hash, checked_at, changed_at, source_rank)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [sessionId, revision, existing?.fingerprint ?? '', existing?.outcomeOverall ?? null, hash, now, now, sourceRank ?? existing?.sourceRank ?? null],
    )
    return { revision, changed: true }
  }
}
