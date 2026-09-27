/**
 * The join (AL 05): a file in a commit is agent-touched if a candidate session lists it in
 * `filesChanged`.
 *
 * Candidate sessions are those whose workspace resolves to this repo and whose time span ends
 * at or before the commit timestamp, within a bounded lookback (default 72h — a session's work
 * is normally committed the same day, and an unbounded window turns every old session into a
 * candidate for every commit).
 */

import * as fs from 'fs'
import * as path from 'path'
import type { AttributionSession, ScannedCommit } from './types'

export const DEFAULT_LOOKBACK_HOURS = 72

// Native realpath: on Windows it also expands 8.3 short names (`C:\Users\RUNNER~1\…`) to the long
// form `git rev-parse --show-toplevel` reports, which the JS implementation leaves as-is — the two
// sides would otherwise never compare equal. A path that doesn't exist (a deleted file) resolves
// its nearest existing ancestor.
// `memo` caches resolutions for the duration of one join — every candidate session re-resolves the
// same repo root and mostly the same workspace/file paths, one realpath syscall chain each.
function realpathBestEffort(p: string, memo?: Map<string, string>): string {
  const hit = memo?.get(p)
  if (hit !== undefined) return hit
  const abs = path.resolve(p)
  const rest: string[] = []
  let resolved = abs
  for (let dir = abs; ; dir = path.dirname(dir)) {
    try {
      resolved = path.join(fs.realpathSync.native(dir), ...rest)
      break
    } catch {
      if (path.dirname(dir) === dir) break
      rest.unshift(path.basename(dir))
    }
  }
  memo?.set(p, resolved)
  return resolved
}

function workspaceToPath(workspace: string, memo?: Map<string, string>): string {
  let p = workspace
  if (p.startsWith('file://')) {
    try { p = decodeURIComponent(new URL(p).pathname) } catch { /* leave as-is */ }
  }
  return realpathBestEffort(p, memo)
}

/** True when `session.workspace` is inside (or equal to) `repoRoot`. */
export function sessionIsInRepo(session: AttributionSession, repoRoot: string, memo?: Map<string, string>): boolean {
  const ws = workspaceToPath(session.workspace, memo)
  const root = realpathBestEffort(repoRoot, memo)
  const rel = path.relative(root, ws)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** repo-relative POSIX path of an absolute file path under `repoRoot`, or null. */
export function repoRelative(repoRoot: string, absPath: string, memo?: Map<string, string>): string | null {
  const rel = path.relative(realpathBestEffort(repoRoot, memo), realpathBestEffort(absPath, memo))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

export interface JoinResult {
  /** repo-relative POSIX paths in the commit that a candidate session also changed. */
  agentTouchedFiles: Set<string>
  /** ids of the sessions that made it agent-touched. */
  sessionIds: string[]
  /** true if any candidate session's own time span contains the commit timestamp. */
  withinSessionSpan: boolean
}

export function joinCommitToSessions(
  commit: ScannedCommit,
  sessions: AttributionSession[],
  repoRoot: string,
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
): JoinResult {
  const commitMs = Date.parse(commit.authoredAt)
  const lookbackMs = lookbackHours * 3600_000
  const commitFiles = new Set(Object.keys(commit.files))

  const agentTouchedFiles = new Set<string>()
  const sessionIds = new Set<string>()
  let withinSessionSpan = false

  const memo = new Map<string, string>()
  for (const s of sessions) {
    // The commit must land at or after the session ends, within the lookback window …
    const endsBefore = s.endMs <= commitMs && commitMs - s.endMs <= lookbackMs
    // … or the commit lands inside the session's own span (a stronger signal).
    const insideSpan = s.startMs <= commitMs && commitMs <= s.endMs
    if (!endsBefore && !insideSpan) continue
    // Checked after the time window: it touches the filesystem, the window doesn't.
    if (!sessionIsInRepo(s, repoRoot, memo)) continue

    let matched = false
    for (const abs of s.filesChanged) {
      const rel = repoRelative(repoRoot, abs, memo)
      if (rel && commitFiles.has(rel)) {
        agentTouchedFiles.add(rel)
        matched = true
      }
    }
    if (matched) {
      sessionIds.add(s.sessionId)
      if (insideSpan) withinSessionSpan = true
    }
  }

  return { agentTouchedFiles, sessionIds: [...sessionIds], withinSessionSpan }
}
