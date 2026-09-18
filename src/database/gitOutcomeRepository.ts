/**
 * SQLite-backed cache for per-session git-outcome classification (the Sessions tab's outcome
 * pill — see gitOutcome.ts). Recompute is skipped when the cache key stored against a row (see
 * resolveOutcomeCacheKey — a commit touching that session's own files, or the trunk branch's tip)
 * still matches. Holds only counts/enums, never diff or file content.
 */

import type { GitOutcome } from '../gitOutcome'

interface WriteableDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

export class GitOutcomeRepository {
  constructor(private readonly db: WriteableDb) {}

  /** Returns the cached outcome, or undefined if there's no row or the cache key has moved since
   *  it was computed (both mean: recompute). */
  get(sessionId: string, cacheKey: string): GitOutcome | undefined {
    const escaped = sessionId.replace(/'/g, "''")
    const rows = this.db.exec(
      `SELECT head_sha, overall, files_json, reason FROM git_outcome WHERE session_id = '${escaped}'`,
    )
    if (!rows[0] || rows[0].values.length === 0) return undefined
    const [storedCacheKey, overall, filesJson, reason] = rows[0].values[0] as [string, string, string, string]
    if (storedCacheKey !== cacheKey) return undefined
    try {
      return { overall: overall as GitOutcome['overall'], files: JSON.parse(filesJson), reason }
    } catch {
      return undefined
    }
  }

  put(sessionId: string, repoRoot: string, cacheKey: string, outcome: GitOutcome): void {
    this.db.run(
      `INSERT OR REPLACE INTO git_outcome (session_id, repo_root, head_sha, overall, files_json, reason, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, repoRoot, cacheKey, outcome.overall, JSON.stringify(outcome.files), outcome.reason, Date.now()],
    )
  }
}
