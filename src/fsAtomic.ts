/**
 * Crash-safe file replacement for every store TraceRoost keeps on disk.
 *
 * `fs.writeFileSync(file, data)` truncates the live file first and then writes — a SIGKILL, an
 * OOM or a power cut in between leaves a torn file that the next start can't parse, and the next
 * save then overwrites the only copy. `writeFileAtomic` writes a sibling temp file, fsyncs it and
 * renames it over the original: readers see either the old contents or the new ones, never a
 * mix (same pattern as `TraceRoostDb.save()` in src/database/db.ts, generalized).
 *
 * `quarantineCorruptFile` is the read-side counterpart: a store that fails to parse is moved
 * aside as `<name>.corrupt-<timestamp>` instead of being overwritten by the next save, so what
 * was there can still be inspected or recovered by hand.
 */

import * as fs from 'fs'
import * as crypto from 'crypto'

export interface WriteFileAtomicOptions {
  /** File mode for the new file (applied to the temp file, which the rename carries over —
   *  so an existing file with looser permissions is tightened too). Ignored on Windows. */
  mode?: number
}

/**
 * Replaces `file` with `data` atomically: temp sibling + fsync + rename. The temp file is removed
 * on any failure, and the original is left untouched. Throws what `fs` throws.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts: WriteFileAtomicOptions = {}): void {
  // Unique per call: two writers in one process (or a leftover from a crashed one) can't collide.
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    const fd = fs.openSync(tmp, 'w', opts.mode)
    try {
      if (typeof data === 'string') fs.writeSync(fd, data, null, 'utf-8')
      else fs.writeSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (opts.mode !== undefined) {
      // `openSync`'s mode is masked by the umask; make the requested mode exact.
      try { fs.chmodSync(tmp, opts.mode) } catch { /* best effort (Windows) */ }
    }
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw err
  }
}

/**
 * Moves a file that failed to load aside as `<file>.corrupt-<ISO timestamp>` so the next save
 * doesn't overwrite it. Returns the new path, or null when there was nothing to move (or the
 * rename itself failed — in which case the caller proceeds exactly as before this existed).
 */
export function quarantineCorruptFile(file: string, now: Date = new Date()): string | null {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const aside = `${file}.corrupt-${stamp}`
  try {
    fs.renameSync(file, aside)
    return aside
  } catch {
    return null
  }
}
