import * as fs from 'fs'
import * as path from 'path'
import { bumpSessionsVersion } from './sessionsVersion'

interface RetentionDb {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
}

export async function runRetention(
  db: RetentionDb,
  retentionDays: number,
  blobsDir: string,
  log: (msg: string) => void,
): Promise<void> {
  const cutoffMs = Date.now() - retentionDays * 86_400_000

  // Delete old sessions; CASCADE handles timeline_entries and edit_details.
  try {
    db.run('DELETE FROM sessions WHERE start_time < ? AND is_sidechain = 0', [cutoffMs])
    // Sidechain sessions without a corresponding main session in the retained range.
    db.run(
      `DELETE FROM sessions
       WHERE is_sidechain = 1
         AND start_time < ?`,
      [cutoffMs],
    )
    log(`TraceRoost retention: deleted sessions older than ${retentionDays} days`)
  } catch (err) {
    log(`TraceRoost retention: delete error — ${err}`)
    return
  } finally {
    bumpSessionsVersion(db)
  }

  pruneOrphanedOutcomeRows(db, log)
  compactTraceSends(db, Date.now(), log)

  // The blob sweep below reads every timeline row (over a second on a large history), so it runs
  // on a later turn of the event loop: everything above has already happened, synchronously, by
  // the time runRetention() returns its promise — activation doesn't wait for the sweep.
  await new Promise<void>(resolve => setImmediate(resolve))

  vacuumIfMostlyFree(db, log)

  // Blob eviction: collect all span IDs still in timeline_entries, then delete orphans.
  try {
    if (!fs.existsSync(blobsDir)) return

    // Filenames: <spanId>-response.txt  or  <spanId>-<editIdx>-old.txt  etc.
    // spanId is the portion before the first recognised suffix token.
    const candidates = fs.readdirSync(blobsDir)
      .map(filename => ({ filename, spanId: extractSpanId(filename) }))
      .filter((c): c is { filename: string; spanId: string } => c.spanId !== null)
    if (candidates.length === 0) return

    // No DISTINCT: the Set dedupes, and DISTINCT made SQLite sort every row first (~2x slower).
    const result = db.exec('SELECT span_id FROM timeline_entries')
    const knownSpanIds = new Set<string>(
      result[0]?.values.map(row => row[0] as string) ?? []
    )

    let deleted = 0
    for (const { filename, spanId } of candidates) {
      if (!knownSpanIds.has(spanId)) {
        try {
          fs.unlinkSync(path.join(blobsDir, filename))
          deleted++
        } catch { /* ignore individual delete errors */ }
      }
    }
    if (deleted > 0) {
      log(`TraceRoost retention: evicted ${deleted} orphaned blob file(s)`)
    }
  } catch (err) {
    log(`TraceRoost retention: blob eviction error — ${err}`)
  }
}

/**
 * The per-session git-outcome caches (git_outcome, git_outcome_key) and the cloud revision ledger
 * (trace_revision) have no foreign key to `sessions`, so a session removed by retention (or as a
 * retired log key) left its rows behind for the life of the install. Nothing reads them for a
 * session that's gone: a session that comes back is classified again, and its next forward takes a
 * fresh, higher revision — which Cloud orders after anything it holds (rank first, then
 * revision), so a resend replaces the same row and never outranks a better one.
 */
function pruneOrphanedOutcomeRows(db: RetentionDb, log: (msg: string) => void): void {
  for (const table of ['git_outcome', 'git_outcome_key', 'trace_revision']) {
    try {
      db.run(`DELETE FROM ${table} WHERE session_id NOT IN (SELECT session_id FROM sessions)`)
    } catch (err) {
      log(`TraceRoost retention: could not prune ${table} — ${err}`)
    }
  }
}

/** The narrowest window DatabaseReader.queryTraceSendStats sums over, besides all time. */
const TRACE_SEND_WINDOW_MS = 60 * 60_000

/**
 * trace_sends gains one row per forwarding drain, forever, and the Team panel's all-time count
 * sums all of them. Rows older than the last-hour window only ever feed that all-time sum, so they
 * are folded into a single row (at the newest of their timestamps — still outside every window):
 * every count the panel shows stays exactly the same.
 */
export function compactTraceSends(db: RetentionDb, now: number, log: (msg: string) => void = () => { /* silent */ }): void {
  const cutoff = Math.floor(now - TRACE_SEND_WINDOW_MS)
  try {
    const row = db.exec(`SELECT COUNT(*), COALESCE(SUM(count), 0), MAX(sent_at) FROM trace_sends WHERE sent_at < ${cutoff}`)[0]?.values[0]
    if (!row || Number(row[0]) <= 1) return
    db.run('BEGIN')
    try {
      db.run('DELETE FROM trace_sends WHERE sent_at < ?', [cutoff])
      db.run('INSERT INTO trace_sends (sent_at, count) VALUES (?, ?)', [Number(row[2]), Number(row[1])])
      db.run('COMMIT')
    } catch (err) {
      try { db.run('ROLLBACK') } catch { /* ignore */ }
      throw err
    }
  } catch (err) {
    log(`TraceRoost retention: could not compact trace_sends — ${err}`)
  }
}

// VACUUM only when at least this share of the file is free pages, and at least this many of them.
const VACUUM_FREE_RATIO = 0.25
const VACUUM_MIN_FREE_PAGES = 2_048

/**
 * Deleted rows leave free pages that every save still serializes and writes (sql.js exports the
 * whole file). New rows reuse them, so in steady state — a day's worth deleted, a day's worth
 * added — there are few. After a large one-off delete (a shorter retention setting, a long idle
 * gap) there can be many, and they would otherwise be copied on every save until refilled; VACUUM
 * (a second or two on a large history, once) shrinks the file instead.
 */
function vacuumIfMostlyFree(db: RetentionDb, log: (msg: string) => void): void {
  try {
    const pages = Number(db.exec('PRAGMA page_count')[0]?.values[0]?.[0] ?? 0)
    const free = Number(db.exec('PRAGMA freelist_count')[0]?.values[0]?.[0] ?? 0)
    if (free < VACUUM_MIN_FREE_PAGES || free < pages * VACUUM_FREE_RATIO) return
    db.run('VACUUM')
    log(`TraceRoost retention: compacted the database (${free} of ${pages} pages were free)`)
  } catch (err) {
    log(`TraceRoost retention: vacuum skipped — ${err}`)
  }
}

function extractSpanId(filename: string): string | null {
  // Suffixes produced by DatabaseWriter (in order of specificity):
  const suffixes = [
    '-response.txt',
    '-thinking.txt',
    '-tool-input.txt',
    '-full-result.txt',
  ]
  for (const suffix of suffixes) {
    if (filename.endsWith(suffix)) {
      return filename.slice(0, filename.length - suffix.length)
    }
  }
  // Edit blobs: <spanId>-<index>-old.txt  /  <spanId>-<index>-new.txt
  const editMatch = filename.match(/^(.+)-\d+-(?:old|new)\.txt$/)
  if (editMatch) return editMatch[1]
  return null
}
