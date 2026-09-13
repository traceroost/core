import * as fs from 'fs'
import * as path from 'path'

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
  }

  // Blob eviction: collect all span IDs still in timeline_entries, then delete orphans.
  try {
    const result = db.exec('SELECT DISTINCT span_id FROM timeline_entries')
    const knownSpanIds = new Set<string>(
      result[0]?.values.map(row => row[0] as string) ?? []
    )

    if (!fs.existsSync(blobsDir)) return

    const files = fs.readdirSync(blobsDir)
    let deleted = 0
    for (const filename of files) {
      // Filenames: <spanId>-response.txt  or  <spanId>-<editIdx>-old.txt  etc.
      // spanId is the portion before the first recognised suffix token.
      const spanId = extractSpanId(filename)
      if (spanId && !knownSpanIds.has(spanId)) {
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
