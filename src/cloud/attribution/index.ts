/**
 * Assembles AI-authorship attribution for a repository (AL 05).
 *
 * Free forever, local, single-developer. Produces `CommitAttribution[]` and an honest coverage
 * figure — unknown lines are excluded from the denominator, never counted as human-authored.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { scanCommits, isShallow, repoRootOf } from './commitScan'
import { joinCommitToSessions, DEFAULT_LOOKBACK_HOURS } from './sessionJoin'
import { countLinesIntroducedByCommit } from './blame'
import type { AttributionSession, CommitAttribution, AttributionCoverage } from './types'

const execFileAsync = promisify(execFile)

export interface AttributionCache {
  get(sha: string): CommitAttribution | undefined
  put(rec: CommitAttribution): void
}

export function memoryAttributionCache(): AttributionCache {
  const m = new Map<string, CommitAttribution>()
  return { get: (sha) => m.get(sha), put: (rec) => { m.set(rec.sha, rec) } }
}

export interface AttributeOptions {
  /** The developer's own local sessions (narrow view — no prompt/response text). */
  sessions?: AttributionSession[]
  sinceIso?: string
  lookbackHours?: number
  cache?: AttributionCache
  /** Restrict to commits authored by this email (the local member). Defaults to `git config
   *  user.email`. Pass `null` to attribute every author. */
  authorEmail?: string | null
  maxCommits?: number
}

export interface AttributionResult {
  repoRoot: string
  commits: CommitAttribution[]
  coverage: AttributionCoverage
  /** Set when the repository can't be attributed at all. */
  unavailable?: 'not-a-repo' | 'shallow-clone'
}

async function localGitEmail(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['config', 'user.email'], { cwd: repoRoot, timeout: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function attributeRepository(workspace: string, opts: AttributeOptions = {}): Promise<AttributionResult> {
  const repoRoot = await repoRootOf(workspace)
  if (!repoRoot) return emptyResult('', 'not-a-repo')
  if (await isShallow(repoRoot)) return emptyResult(repoRoot, 'shallow-clone')

  const cache = opts.cache
  const lookbackHours = opts.lookbackHours ?? DEFAULT_LOOKBACK_HOURS
  const authorEmail = opts.authorEmail === undefined ? await localGitEmail(repoRoot) : opts.authorEmail

  const scanned = await scanCommits(repoRoot, { sinceIso: opts.sinceIso, maxCommits: opts.maxCommits })
  const sessions: AttributionSession[] = opts.sessions ?? []

  const out: CommitAttribution[] = []
  let attributedLines = 0
  let totalMergedLines = 0

  for (const c of scanned) {
    if (authorEmail && c.authorEmail.toLowerCase() !== authorEmail.toLowerCase()) continue
    totalMergedLines += c.linesAdded

    const cached = cache?.get(c.sha)
    if (cached) {
      out.push(cached)
      if (cached.attribution !== 'unknown') attributedLines += cached.linesAdded
      continue
    }

    let rec: CommitAttribution
    if (c.isMerge) {
      rec = { sha: c.sha, authoredAt: c.authoredAt, linesAdded: c.linesAdded, linesRemoved: c.linesRemoved, aiLines: 0, attribution: 'unknown', sessionIds: [], isMerge: true }
    } else {
      const join = joinCommitToSessions(c, sessions, repoRoot, lookbackHours)
      const hasSessionMatch = join.sessionIds.length > 0
      const attribution = c.subjectHadAgentTrailer || join.withinSessionSpan
        ? 'certain'
        : hasSessionMatch
          ? 'probable'
          : 'unknown'

      let aiLines = 0
      if (attribution !== 'unknown') {
        const files = join.agentTouchedFiles.size > 0
          ? [...join.agentTouchedFiles]
          : c.subjectHadAgentTrailer
            ? Object.keys(c.files)   // trailer says the whole commit is agent-authored
            : []
        aiLines = files.length > 0 ? await countLinesIntroducedByCommit(repoRoot, c.sha, files) : 0
      }

      rec = {
        sha: c.sha,
        authoredAt: c.authoredAt,
        linesAdded: c.linesAdded,
        linesRemoved: c.linesRemoved,
        aiLines,
        attribution,
        sessionIds: join.sessionIds,
        isMerge: false,
      }
    }

    cache?.put(rec)
    out.push(rec)
    if (rec.attribution !== 'unknown') attributedLines += rec.linesAdded
  }

  return {
    repoRoot,
    commits: out,
    coverage: { attributedLines, totalMergedLines },
  }
}

function emptyResult(repoRoot: string, unavailable: AttributionResult['unavailable']): AttributionResult {
  return { repoRoot, commits: [], coverage: { attributedLines: 0, totalMergedLines: 0 }, unavailable }
}
