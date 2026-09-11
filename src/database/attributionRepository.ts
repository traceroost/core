/**
 * SQLite-backed cache for AI-authorship attribution (AL 05).
 *
 * A commit's attribution never changes once computed, so this is written once per commit for
 * the life of the install. Only counts and an enum are stored — never commit message text,
 * never blame output.
 */

import type { AttributionCache } from '../attribution'
import type { CommitAttribution } from '../attribution/types'

interface WriteableDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

export class AttributionRepository implements AttributionCache {
  constructor(private readonly db: WriteableDb, private readonly repoRoot: string) {}

  get(sha: string): CommitAttribution | undefined {
    const escapedRoot = this.repoRoot.replace(/'/g, "''")
    const escapedSha = sha.replace(/'/g, "''")
    const rows = this.db.exec(
      `SELECT sha, authored_at, lines_added, lines_removed, ai_lines, attribution, session_ids, is_merge
         FROM commit_attribution WHERE repo_root = '${escapedRoot}' AND sha = '${escapedSha}'`,
    )
    if (!rows[0] || rows[0].values.length === 0) return undefined
    const { columns, values } = rows[0]
    const row = values[0]
    const get = (c: string): unknown => row[columns.indexOf(c)]
    let sessionIds: string[] = []
    try { sessionIds = JSON.parse(String(get('session_ids') ?? '[]')) as string[] } catch { /* keep [] */ }
    return {
      sha: String(get('sha') ?? ''),
      authoredAt: String(get('authored_at') ?? ''),
      linesAdded: Number(get('lines_added') ?? 0),
      linesRemoved: Number(get('lines_removed') ?? 0),
      aiLines: Number(get('ai_lines') ?? 0),
      attribution: (String(get('attribution') ?? 'unknown') as CommitAttribution['attribution']),
      sessionIds,
      isMerge: Boolean(get('is_merge')),
    }
  }

  put(rec: CommitAttribution): void {
    this.db.run(
      `INSERT OR REPLACE INTO commit_attribution
         (repo_root, sha, authored_at, lines_added, lines_removed, ai_lines, attribution, session_ids, is_merge, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.repoRoot, rec.sha, rec.authoredAt, rec.linesAdded, rec.linesRemoved,
        rec.aiLines, rec.attribution, JSON.stringify(rec.sessionIds), rec.isMerge ? 1 : 0, Date.now(),
      ],
    )
  }
}
