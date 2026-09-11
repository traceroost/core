/**
 * Maps AL 05's attribution results into `CommitRecord[]` (AL 03).
 *
 * Field-by-field, by name. The input is a narrow structural type — the raw commit SHA is hashed
 * here and is never carried onto the wire (a raw SHA identifies the exact diff and filenames of
 * a public repository).
 */

import { commitHash, repoHash, type RepoKeyContext } from './repoKey'
import { toWireAttribution } from './wireAttribution'
import type { CommitRecord } from './schema'

export interface CommitAttributionInput {
  /** Raw commit SHA — hashed here, never emitted. */
  sha: string
  authoredAt: string
  linesAdded: number
  linesRemoved: number
  aiLines: number
  attribution: 'certain' | 'probable' | 'unknown'
}

export function buildCommitRecords(commits: CommitAttributionInput[], ctx: RepoKeyContext): CommitRecord[] {
  const repo_hash = repoHash(ctx)
  return commits.slice(0, 500).map((c): CommitRecord => ({
    commit_hash: commitHash(ctx, c.sha),
    repo_hash,
    authored_at: normalizeTimestamp(c.authoredAt),
    lines_added: nonNegInt(c.linesAdded),
    lines_removed: nonNegInt(c.linesRemoved),
    ai_lines: nonNegInt(c.aiLines),
    attribution: toWireAttribution(c.attribution),
  }))
}

function nonNegInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}
function normalizeTimestamp(t: string): string {
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString()
}
