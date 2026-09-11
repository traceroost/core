/**
 * Maps AL 06's cohort turnover results into `TurnoverSample[]` (AL 03).
 *
 * A `TurnoverSample` is emitted only for a cohort whose window has fully elapsed and that
 * cleared the minimum-sample floor — AL 06 returns `InsufficientData` otherwise, and this
 * builder simply never sees those.
 */

import { commitHash, type RepoKeyContext } from './repoKey'
import type { TurnoverSample } from './schema'

export interface TurnoverInput {
  /** Raw commit SHA of the cohort's representative commit — hashed here, never emitted. */
  sha: string
  windowDays: 30 | 90
  aiLinesAuthored: number
  aiLinesSurviving: number
}

export function buildTurnoverSamples(samples: TurnoverInput[], ctx: RepoKeyContext): TurnoverSample[] {
  return samples.slice(0, 500).map((s): TurnoverSample => ({
    commit_hash: commitHash(ctx, s.sha),
    window_days: s.windowDays,
    ai_lines_authored: nonNegInt(s.aiLinesAuthored),
    ai_lines_surviving: nonNegInt(s.aiLinesSurviving),
  }))
}

function nonNegInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}
