/**
 * `computeTurnover` with the "recompute only when HEAD has moved" rule wired to SQLite (AL 06).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { computeTurnover, type TurnoverReport, type ComputeTurnoverOptions } from './'
import type { TurnoverRepository } from '../../database/turnoverRepository'
import type { AttributionCache } from '../attribution'

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
  repoRoot: string
}

/** Returns persisted results untouched when `HEAD` is unchanged; otherwise recomputes and
 *  persists. Re-running with an unchanged `HEAD` does no git work beyond the one `rev-parse`. */
export async function computeTurnoverCached(workspace: string, deps: CachedTurnoverDeps): Promise<TurnoverReport> {
  const currentHead = await headSha(deps.repoRoot)
  const stored = deps.turnoverRepo.storedHeadSha()
  if (currentHead && stored && currentHead === stored) {
    const cached = deps.turnoverRepo.load()
    if (cached) return cached
  }

  const report = await computeTurnover(workspace, { ...deps, cache: deps.attributionCache })
  deps.turnoverRepo.save(report)
  return report
}
