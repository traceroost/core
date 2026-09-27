/**
 * `computeTurnover` with a "recompute only when something it depends on moved" rule wired to
 * SQLite (AL 06). The inputs a report depends on are HEAD, today's date (a cohort window elapses
 * with no new commit at all, and `now` decides which windows are measurable), and the local
 * sessions attribution joins against (a session ingested after the report can turn an `unknown`
 * commit into an attributed one). All three go into the cache key.
 */

import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { computeTurnover, type TurnoverReport, type ComputeTurnoverOptions } from './'
import type { TurnoverRepository } from '../database/turnoverRepository'
import type { AttributionCache } from '../attribution'
import type { AttributionSession } from '../attribution/types'
import type { FileBlameCache } from './survival'

const execFileAsync = promisify(execFile)

async function headSha(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

export interface CachedTurnoverDeps extends ComputeTurnoverOptions {
  turnoverRepo: TurnoverRepository
  attributionCache?: AttributionCache
  fileBlameCache?: FileBlameCache
  repoRoot: string
}

/** Fingerprint of the session set attribution joins against — ids, end times and changed-file
 *  counts, so a newly ingested or still-growing session changes it. */
export function sessionsFingerprint(sessions: AttributionSession[] | undefined): string {
  const h = createHash('sha256')
  for (const s of [...(sessions ?? [])].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    h.update(`${s.sessionId}:${s.endMs}:${s.filesChanged.length}\n`)
  }
  return h.digest('hex').slice(0, 16)
}

/** HEAD + UTC day + session fingerprint. */
export function turnoverCacheKey(head: string, nowMs: number, sessions: AttributionSession[] | undefined): string {
  return `${head}|${new Date(nowMs).toISOString().slice(0, 10)}|${sessionsFingerprint(sessions)}`
}

/** Returns the persisted report untouched when its cache key (HEAD, UTC day, session set) is
 *  unchanged — no git work beyond the one `rev-parse`. Otherwise recomputes, reusing every
 *  measured result whose measurement commit hasn't changed (see `ComputeTurnoverOptions.previous`)
 *  and every commit attribution in `attributionCache`, and persists. */
export async function computeTurnoverCached(workspace: string, deps: CachedTurnoverDeps): Promise<TurnoverReport> {
  const currentHead = await headSha(deps.repoRoot)
  const key = currentHead ? turnoverCacheKey(currentHead, deps.now ?? Date.now(), deps.sessions) : null
  const cached = deps.turnoverRepo.load()
  if (key && cached && cached.cacheKey === key && deps.turnoverRepo.storedHeadSha() === currentHead) {
    return cached
  }

  const report = await computeTurnover(workspace, { ...deps, cache: deps.attributionCache, previous: cached })
  if (key && report.headSha === currentHead) report.cacheKey = key
  deps.turnoverRepo.save(report)
  return report
}
