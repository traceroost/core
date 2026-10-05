import * as fs from 'fs'
import * as path from 'path'
import type { FileState, LogReader } from './logReader'
import { writeFileAtomic, quarantineCorruptFile } from './fsAtomic'

// ── Log-reader file-state persistence ────────────────────────────────────────
//
// Without this, every extension activation re-parses every historical source-tool log file from
// scratch — LogReader.fileState is an in-memory Map that starts empty on every process start. This
// is pure waste today, at current scale, for anyone with more than a few weeks of log history, so
// it's fixed unconditionally rather than gated behind the stress-test in scalability.md. See
// .staged-issues/scalability.md, risk #1.

export const LOG_FILE_STATE_FILENAME = 'log-file-state.json'

/**
 * Bumped when a parser fix needs some already-ingested files read again. The file was a bare
 * `{ [filePath]: FileState }` map up to version 1; from version 2 it is `{ version, files }`.
 *
 * 2: Codex output tokens used to be `output_tokens + reasoning_output_tokens` — but reasoning is
 *    already part of output_tokens, so every reasoning token was counted (and priced) twice. The
 *    stored rows keep only the inflated total (no reasoning count, no raw usage), so they can't
 *    be corrected in the database; re-parsing the Codex rollout files re-derives them, and the
 *    writer's INSERT OR REPLACE rewrites each row with the corrected tokens and cost.
 * 4: Stable trace identity (staged feature 11): every log source is read one turn per trace,
 *    keyed by the agent's own turn id. The trace store is rebuilt empty (database/traceStore.ts),
 *    so every file within retention is read again. (3 was an interim development format.)
 * 5: Each file's state carries the trace keys its last read produced (FileState.keys), so a key a
 *    file stops producing is removed from the store (LogReader.takeRetiredKeys). The trace store
 *    is rebuilt again (TRACE_STORE_VERSION 2) to drop keys earlier builds kept that way; every file
 *    within retention is read again to record its keys.
 */
export const LOG_FILE_STATE_VERSION = 5

export function readLogFileState(storageDir: string, log?: (msg: string) => void): { version: number; files: Record<string, FileState> } {
  const file = path.join(storageDir, LOG_FILE_STATE_FILENAME)
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return { version: LOG_FILE_STATE_VERSION, files: {} } } // missing — start empty
  try {
    const raw = JSON.parse(text) as unknown
    if (raw && typeof raw === 'object') {
      const obj = raw as { version?: unknown; files?: unknown }
      if (typeof obj.version === 'number' && obj.files && typeof obj.files === 'object') {
        return { version: obj.version, files: obj.files as Record<string, FileState> }
      }
      return { version: 1, files: raw as Record<string, FileState> }
    }
  } catch { /* unreadable — quarantined below, then start empty */ }
  // A file that exists but doesn't parse (a torn write from a crash) is moved aside rather than
  // overwritten by the next writeLogFileState, so it can still be inspected; every file within
  // retention is re-parsed, as it would be after a fresh install.
  const aside = quarantineCorruptFile(file)
  log?.(`[TraceRoost] ${LOG_FILE_STATE_FILENAME} could not be parsed${aside ? ` — moved it to ${aside}` : ''}; re-reading every log file within retention.`)
  return { version: LOG_FILE_STATE_VERSION, files: {} }
}

/** Only called once the parsed sessions are on disk, so an interrupted upgrade (re-parse) is
 *  simply redone on the next activation: the old-version file is still there. Written atomically
 *  (temp + rename): a torn file here would otherwise cost a full re-parse of the whole history. */
export function writeLogFileState(storageDir: string, files: Record<string, FileState>): void {
  try {
    writeFileAtomic(path.join(storageDir, LOG_FILE_STATE_FILENAME),
      JSON.stringify({ version: LOG_FILE_STATE_VERSION, files }), { mode: 0o600 })
  } catch { /* non-fatal — worst case, the next activation re-parses from scratch */ }
}

/**
 * Restores the persisted file state into `lr` before its first scan, applying any upgrade the
 * stored version predates. Returns how many files the upgrade forgot (they're re-parsed).
 * Files last modified before the retention cutoff are left alone: re-parsing them would only
 * bring back sessions retention already deleted.
 */
export function restoreLogFileState(lr: LogReader, storageDir: string, retentionDays: number, log?: (msg: string) => void): number {
  const { version, files } = readLogFileState(storageDir, log)
  let forgotten = 0
  // Version 5 re-reads every file within retention, which covers every earlier upgrade's re-read.
  if (version < 5) {
    const cutoffMs = Date.now() - retentionDays * 86_400_000
    for (const [filePath, state] of Object.entries(files)) {
      if (state.mtimeMs >= cutoffMs) {
        delete files[filePath]
        forgotten++
      }
    }
  }
  lr.importFileState(files)
  return forgotten
}
