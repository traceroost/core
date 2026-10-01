/**
 * Cross-process advisory lock for the shared per-machine files under `~/.traceroost`
 * (`forward-queue.jsonl`, `delivered.json`). More than one TraceRoost host can be running on the
 * same machine at once (the editor extension and the standalone server, potentially a CLI
 * invocation too) and, unlike the SQLite trace-revision store, these two files are not
 * per-process — every host reads and writes the same path. Their write path is read-the-whole-
 * file, mutate in memory, then atomically replace it (write a tmp file, `rename` over the
 * original) — the rename itself can't produce a torn file, but the read-modify-write as a whole
 * is not atomic: two hosts racing this on the same file can each read before either writes, and
 * whichever writes second silently discards the first's update. `withFileLock` wraps that whole
 * read-modify-write in a synchronous mutual-exclusion section so only one host is ever inside it
 * for a given file at a time.
 *
 * Synchronous (busy-waits via `Atomics.wait`, Node's only synchronous sleep) because every call
 * site here already is — these critical sections are a handful of filesystem calls, not network
 * I/O, so blocking briefly is cheap and simpler than threading async through call sites that were
 * never designed for it.
 */

import * as fs from 'fs'
import * as path from 'path'

const ACQUIRE_TIMEOUT_MS = 2_000
// A lock file older than this is presumed abandoned by a holder that crashed (or was killed)
// before releasing it, rather than a slow legitimate holder -- these critical sections are a few
// filesystem calls, nowhere near this long in the success case.
const STALE_LOCK_MS = 30_000
const RETRY_DELAY_MS = 20

/**
 * Runs `fn` while holding an exclusive lock on `targetPath` (a sibling `<targetPath>.lock` file),
 * so a concurrent call to this function for the same path -- in this process or another -- cannot
 * run its own `fn` at the same time. Falls back to running `fn` unlocked if the lock can't be
 * acquired within `ACQUIRE_TIMEOUT_MS` (a wedged or unkillable lock holder) rather than hanging the
 * caller forever -- that leaves exactly the pre-existing lost-update race this function exists to
 * close, never something worse, so it's a safe degrade rather than a new failure mode.
 */
export function withFileLock<T>(targetPath: string, fn: () => T): T {
  const lockPath = `${targetPath}.lock`
  // The target's directory may not exist yet on a brand-new install (its first write is what
  // normally creates it, inside the caller's own writeAll) -- the lock file needs it to exist
  // first, since it's created before that.
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const acquired = acquireLock(lockPath)
  try {
    return fn()
  } finally {
    if (acquired) {
      try { fs.rmSync(lockPath, { force: true }) } catch { /* already gone */ }
    }
  }
}

function acquireLock(lockPath: string): boolean {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return true
    } catch (err) {
      if (!isLockContention((err as NodeJS.ErrnoException).code)) throw err
    }
    // Someone else holds it. A stale lock (its holder crashed without cleaning up) is stolen
    // immediately rather than waited out.
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
        fs.rmSync(lockPath, { force: true })
        continue
      }
    } catch { /* lock disappeared between our failed create and this stat -- just retry */ }
    if (Date.now() >= deadline) return false
    sleepSync(RETRY_DELAY_MS)
  }
}

/**
 * True when a failed exclusive create of the lock file means "another process holds (or is just
 * releasing) it" — retry — rather than a real error. EEXIST everywhere; on Windows also EPERM /
 * EACCES / EBUSY, which is what CreateFile reports for a file another process has open or has
 * deleted but not yet closed ("delete pending") — i.e. exactly the moment a holder releases the
 * lock while we race to take it. Treating those as fatal crashed concurrent enqueues on Windows.
 */
export function isLockContention(code: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (code === 'EEXIST') return true
  return platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// A holder of the async lock below does network I/O inside its critical section (a token refresh
// round trip, bounded by oauthClient's own 15 s request timeout), so a waiter has to be willing to
// wait longer than the synchronous lock's 2 s -- and must not busy-block the event loop doing it.
const ASYNC_ACQUIRE_TIMEOUT_MS = 20_000

/**
 * `withFileLock`'s asynchronous counterpart, for a critical section that has to await something
 * -- the credential file's refresh-then-save (see `org/tokenRefresh.ts`), where two TraceRoost
 * hosts rotating the same refresh token at once would leave one of them holding a pair the server
 * has already replaced. Same lock file and stale-lock rules as `withFileLock`, and the same safe
 * degrade: if the lock can't be acquired within `ASYNC_ACQUIRE_TIMEOUT_MS`, `fn` runs unlocked.
 * Waits with timers instead of `Atomics.wait`, so a waiting host keeps serving its event loop.
 */
export async function withFileLockAsync<T>(targetPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${targetPath}.lock`
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + ASYNC_ACQUIRE_TIMEOUT_MS
  let acquired = false
  for (;;) {
    if (tryAcquire(lockPath)) { acquired = true; break }
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * 5))
  }
  try {
    return await fn()
  } finally {
    if (acquired) {
      try { fs.rmSync(lockPath, { force: true }) } catch { /* already gone */ }
    }
  }
}

/** One non-blocking attempt at `acquireLock`'s create-or-steal-if-stale step. */
function tryAcquire(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx')
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return true
  } catch (err) {
    // Same contention test as the synchronous path — on Windows a lock file being released
    // ("delete pending") fails the create with EPERM/EACCES/EBUSY, not EEXIST.
    if (!isLockContention((err as NodeJS.ErrnoException).code)) throw err
  }
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
      fs.rmSync(lockPath, { force: true })
      return tryAcquire(lockPath)
    }
  } catch { /* lock disappeared between our failed create and this stat -- next attempt retries */ }
  return false
}
