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
      writeAllSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf-8') : data)
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
 * Writes every byte of `data` to `fd`, or throws. `fs.writeSync` makes one write(2) call and returns
 * how many bytes it wrote; on a nearly full disk that can be fewer than asked, with no error. A
 * short write here used to be fsynced and renamed over the good file — a truncated database or
 * spans.json in place of the user's history. `write` is injectable for tests.
 */
export function writeAllSync(
  fd: number,
  data: Uint8Array,
  write: (fd: number, buf: Uint8Array, offset: number, length: number) => number = (f, b, o, l) => fs.writeSync(f, b, o, l),
): void {
  let offset = 0
  while (offset < data.byteLength) {
    const n = write(fd, data, offset, data.byteLength - offset)
    if (!(n > 0)) {
      const err = new Error(`short write: ${offset} of ${data.byteLength} bytes written (disk full?)`) as NodeJS.ErrnoException
      err.code = 'ENOSPC'
      throw err
    }
    offset += n
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
