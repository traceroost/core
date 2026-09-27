/**
 * Per-session record of what its git-outcome cache key was last built from (see schema.ts's
 * `git_outcome_key` table and gitOutcome.ts's resolveOutcomeCacheKey). Lets a reconcile pass reuse
 * a session's file sha — skipping its `git log` — when the repo's HEAD and the session's file list
 * are unchanged since. Holds only the repo root, shas and hashes — never file paths or content.
 */

import type { OutcomeCacheKeyParts } from '../gitOutcome'

interface WriteableDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

export type StoredOutcomeKey = Pick<OutcomeCacheKeyParts, 'root' | 'headSha' | 'trunkSha' | 'relPathsHash' | 'fileSha' | 'cacheKey'>

export class OutcomeKeyRepository {
  constructor(private readonly db: WriteableDb) {}

  get(sessionId: string): StoredOutcomeKey | undefined {
    const escaped = sessionId.replace(/'/g, "''")
    const rows = this.db.exec(
      `SELECT repo_root, head_sha, trunk_sha, rel_paths_hash, file_sha, cache_key FROM git_outcome_key WHERE session_id = '${escaped}'`,
    )
    if (!rows[0] || rows[0].values.length === 0) return undefined
    const [root, headSha, trunkSha, relPathsHash, fileSha, cacheKey] = rows[0].values[0] as string[]
    return { root, headSha, trunkSha, relPathsHash, fileSha, cacheKey }
  }

  /** Stores `key` unless it's identical to `prior` (the row already there) — an unchanged warm pass
   *  writes nothing. Keys not pinned to a HEAD sha are never reusable, so they aren't stored. */
  putIfChanged(sessionId: string, prior: StoredOutcomeKey | undefined, key: StoredOutcomeKey): void {
    if (!key.headSha) return
    if (prior && prior.cacheKey === key.cacheKey && prior.headSha === key.headSha && prior.root === key.root
      && prior.relPathsHash === key.relPathsHash && prior.fileSha === key.fileSha && prior.trunkSha === key.trunkSha) return
    this.db.run(
      `INSERT OR REPLACE INTO git_outcome_key (session_id, repo_root, head_sha, trunk_sha, rel_paths_hash, file_sha, cache_key, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, key.root, key.headSha, key.trunkSha, key.relPathsHash, key.fileSha, key.cacheKey, Date.now()],
    )
  }
}
