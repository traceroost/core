/**
 * Which parts of the extension a VS Code window runs, decided from what it knows about the shared
 * database — pure, so it can be unit-tested without an extension host (extension.ts has none).
 *
 * Every window loads traceroost.db into its own in-memory sql.js copy, but only the window holding
 * the owner lock may save it (TraceRoostDb in database/db.ts). Anything that *writes* — reading
 * agent logs into the store, git reconciliation and its revision counter, and every cloud enqueue
 * (whose payloads carry those revisions) — therefore runs in the owner window only: in any other
 * window the writes would land in a copy that is never saved, while the queued payloads, written to
 * the shared forward-queue file, would carry revision numbers nobody else allocated. The other
 * windows are viewers: they refresh from the owner's saves through the last-write signal, and take
 * the pipeline over when the owner goes away.
 */

export interface WindowState {
  /** The database opened (even read-only). */
  hasDb: boolean
  /** This window holds the owner lock on the database file. */
  isOwner: boolean
  /** The existing database file could not be loaded; saving is disabled (TraceRoostDb.loadError). */
  loadError: boolean
}

export interface PipelineDecision {
  /** Run the ingest/reconcile/forward pipeline: log ingestion and its 30 s scan, reconciliation
   *  and the background git watcher, retention, plan-usage polling and every cloud enqueue. */
  runPipeline: boolean
  /** Poll the last-write signal and refresh the view from a fresh snapshot of the owner's saves. */
  viewer: boolean
  /** On each viewer tick, try to become the owner (the previous owner may have closed). */
  tryTakeOver: boolean
}

export function decidePipeline(s: WindowState): PipelineDecision {
  const runPipeline = s.hasDb && s.isOwner && !s.loadError
  // A window whose database file didn't load has nothing to view or take over: it shows its
  // in-memory session window only, and must never become the writer of a file it couldn't read.
  const viewer = s.hasDb && !s.isOwner && !s.loadError
  return { runPipeline, viewer, tryTakeOver: viewer }
}

export interface TakeoverInput {
  isOwner: boolean
  loadError: boolean
  /** The owner lock exists and names a process that is still running. */
  lockHeldByLiveProcess: boolean
  /** The database file on disk is no longer the bytes this window loaded (mtime/size differ). */
  diskChangedSinceLoad: boolean
}

export type TakeoverStep =
  | 'already-owner'
  | 'blocked-load-error'
  | 'lock-held'
  /** The lock is free but our copy is stale: reload the file from disk, then acquire. Acquiring
   *  with the stale copy would roll the previous owner's last saves back on our first save. */
  | 'reload-then-acquire'
  | 'acquire'

export function takeoverStep(t: TakeoverInput): TakeoverStep {
  if (t.isOwner) return 'already-owner'
  if (t.loadError) return 'blocked-load-error'
  if (t.lockHeldByLiveProcess) return 'lock-held'
  return t.diskChangedSinceLoad ? 'reload-then-acquire' : 'acquire'
}
