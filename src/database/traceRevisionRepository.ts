/**
 * SQLite-backed store for canonical trace revisions (staged feature 10, Stage 1) -- see
 * schema.ts's `trace_revision` / `trace_revision_counter` tables for the storage shape and why a
 * revision only advances on a real outcome change.
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
  checkedAt: number
  changedAt: number
}

export class TraceRevisionRepository {
  constructor(private readonly db: WriteableDb) {}

  get(sessionId: string): TraceRevisionRow | undefined {
    const escaped = sessionId.replace(/'/g, "''")
    const rows = this.db.exec(
      `SELECT revision, lifecycle, fingerprint, outcome_overall, checked_at, changed_at
       FROM trace_revision WHERE session_id = '${escaped}'`,
    )
    if (!rows[0] || rows[0].values.length === 0) return undefined
    const [revision, lifecycle, fingerprint, outcomeOverall, checkedAt, changedAt] = rows[0].values[0] as
      [number, string, string, string | null, number, number]
    return { revision, lifecycle, fingerprint, outcomeOverall, checkedAt, changedAt }
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
         (session_id, revision, lifecycle, fingerprint, outcome_overall, checked_at, changed_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`,
      [sessionId, revision, fingerprint, outcomeOverall, now, now],
    )
    return { revision, changed: true }
  }
}
