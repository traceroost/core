/**
 * SQLite-backed cache for per-session git-outcome classification (the Sessions tab's outcome
 * pill — see gitOutcome.ts). Recompute is skipped when the repo's HEAD has not moved since the
 * stored row, same convention as TurnoverRepository. Holds only counts/enums, never diff or
 * file content.
 */

import type { GitOutcome } from '../gitOutcome'

interface WriteableDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

export class GitOutcomeRepository {
  constructor(private readonly db: WriteableDb) {}

  /** Returns the cached outcome, or undefined if there's no row or the repo has moved since it
   *  was computed (both mean: recompute). */
  get(sessionId: string, headSha: string): GitOutcome | undefined {
    const escaped = sessionId.replace(/'/g, "''")
    const rows = this.db.exec(
      `SELECT head_sha, overall, files_json, reason FROM git_outcome WHERE session_id = '${escaped}'`,
    )
    if (!rows[0] || rows[0].values.length === 0) return undefined
    const [storedHeadSha, overall, filesJson, reason] = rows[0].values[0] as [string, string, string, string]
    if (storedHeadSha !== headSha) return undefined
    try {
      return { overall: overall as GitOutcome['overall'], files: JSON.parse(filesJson), reason }
    } catch {
      return undefined
    }
  }

  put(sessionId: string, repoRoot: string, headSha: string, outcome: GitOutcome): void {
    this.db.run(
      `INSERT OR REPLACE INTO git_outcome (session_id, repo_root, head_sha, overall, files_json, reason, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, repoRoot, headSha, outcome.overall, JSON.stringify(outcome.files), outcome.reason, Date.now()],
    )
  }
}
