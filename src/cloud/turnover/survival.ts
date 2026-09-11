/**
 * "Still present" (AL 06): a line survives if `git blame` on `HEAD` attributes it to one of the
 * cohort's commits. A moved line survives; an edited line does not — an edited line is rework,
 * which is the intended reading.
 *
 * One `git blame` per file currently in `HEAD`, bucketed by originating commit — far cheaper
 * than a blame per cohort commit, and the reason this is fast enough to run on first launch.
 * Blame content stays in memory; only counts are persisted.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 15_000
const MAX_FILES = 4000
const MAX_BUFFER = 128 * 1024 * 1024

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout, maxBuffer: MAX_BUFFER })
    return stdout
  } catch {
    return null
  }
}

export interface SurvivalIndex {
  /** originating commit SHA → number of its lines still present in HEAD. */
  bySha: Map<string, number>
  /** HEAD SHA the index was computed at — persisted so a recompute is skipped when HEAD hasn't moved. */
  headSha: string
  filesBlamed: number
}

export async function buildSurvivalIndex(repoRoot: string): Promise<SurvivalIndex | null> {
  const headSha = (await git(repoRoot, ['rev-parse', 'HEAD']))?.trim()
  if (!headSha) return null

  const listing = await git(repoRoot, ['ls-files', '-z'])
  if (listing === null) return null
  const files = listing.split('\0').filter(Boolean).slice(0, MAX_FILES)

  const bySha = new Map<string, number>()
  let filesBlamed = 0
  for (const file of files) {
    const out = await git(repoRoot, ['blame', '--line-porcelain', 'HEAD', '--', file], 10_000)
    if (!out) continue
    filesBlamed++
    for (const line of out.split('\n')) {
      const m = line.match(/^([0-9a-f]{40}) \d+ \d+/)
      if (m) bySha.set(m[1], (bySha.get(m[1]) ?? 0) + 1)
    }
  }
  return { bySha, headSha, filesBlamed }
}

/** Estimated AI-authored lines from `commit` still present in HEAD. We know how many of the
 *  commit's lines survive, and what fraction were AI-authored, but not which specific lines —
 *  so this is proportional, which is more honest than a floor. */
export function survivingAiLines(
  index: SurvivalIndex,
  commit: { sha: string; aiLines: number; linesAdded: number },
): number {
  const surviving = index.bySha.get(commit.sha) ?? 0
  if (surviving === 0 || commit.aiLines === 0) return 0
  const aiFraction = commit.linesAdded > 0 ? commit.aiLines / commit.linesAdded : 1
  return Math.min(commit.aiLines, Math.round(surviving * aiFraction))
}
