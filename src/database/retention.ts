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

  // The blob sweep below reads every timeline row (over a second on a large history), so it runs
  // on a later turn of the event loop: everything above has already happened, synchronously, by
  // the time runRetention() returns its promise — activation doesn't wait for the sweep.
  await new Promise<void>(resolve => setImmediate(resolve))

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
