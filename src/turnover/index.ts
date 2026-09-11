/**
 * The cohort turnover engine (AL 06) — free forever, local, one developer's own repositories.
 *
 * ```
 * turnover = 1 − (AI-authored lines from that cohort still present in HEAD)
 *                ────────────────────────────────────────────────────────
 *                (AI-authored lines that cohort introduced)
 * ```
 *
 * A cohort whose window has not fully elapsed produces **no result** — not zero, not a partial
 * figure. The return type is `TurnoverResult | InsufficientData`, and `InsufficientData` carries
 * why and, where it applies, the date the cohort becomes measurable. The day-one screen is built
 * entirely from that structure. The engine has no transport.
 */

import { attributeRepository, type AttributeOptions, type AttributionResult } from '../attribution'
import { buildCohorts, isWindowElapsed, measurableAt, type Cohort } from './cohorts'
import { buildSurvivalIndex, survivingAiLines, type SurvivalIndex } from './survival'
import { benchmarkFor, benchmarkVerdict } from './benchmarks'

/** Below this many attributed lines a cohort's percentage swings on a single edit and reads as
 *  noise. */
export const MIN_ATTRIBUTED_LINES = 200

export interface TurnoverResult {
  kind: 'measured'
  cohortLabel: string
  windowDays: 30 | 90
  turnoverRate: number          // 0..1
  aiLinesAuthored: number
  aiLinesSurviving: number
  commitCount: number
  mergeRange: { fromIso: string; toIso: string }
  benchmark: { low: number; high: number; healthyUnder: number; verdict: 'healthy' | 'typical' | 'elevated' }
  /** The representative commit SHA, for the AL 03 `TurnoverSample` and the local hand-off. */
  cohortShas: string[]
}

export interface InsufficientData {
  kind: 'insufficient'
  cohortLabel: string
  windowDays: 30 | 90
  reason: 'window-not-elapsed' | 'too-few-attributed-lines' | 'repository-younger-than-window' | 'no-commits'
  /** When the cohort becomes measurable (window-not-elapsed only). */
  measurableAtIso?: string
  attributedAiLines?: number
}

export type CohortTurnover = TurnoverResult | InsufficientData

export interface TurnoverReport {
  repoRoot: string
  headSha: string | null
  results: CohortTurnover[]
  coverage: AttributionResult['coverage']
  unavailable?: AttributionResult['unavailable']
}

export interface ComputeTurnoverOptions extends AttributeOptions {
  /** Which windows to compute for each cohort. Default both. */
  windows?: (30 | 90)[]
  now?: number
  /** A prebuilt survival index (skip the blame pass — pass the persisted one when HEAD is unmoved). */
  survivalIndex?: SurvivalIndex | null
}

function evaluateCohort(
  cohort: Cohort,
  windowDays: 30 | 90,
  index: SurvivalIndex,
  repoStartMs: number,
  now: number,
): CohortTurnover {
  const base = { cohortLabel: cohort.label, windowDays }

  if (cohort.startMs < repoStartMs) {
    // Shouldn't happen (a cohort is built from real commits), kept for totality.
  }
  if (cohort.commitCount === 0) return { kind: 'insufficient', ...base, reason: 'no-commits' }

  if (now - repoStartMs < windowDays * 86_400_000) {
    return { kind: 'insufficient', ...base, reason: 'repository-younger-than-window' }
  }
  if (!isWindowElapsed(cohort, windowDays, now)) {
    return {
      kind: 'insufficient', ...base,
      reason: 'window-not-elapsed',
      measurableAtIso: new Date(measurableAt(cohort, windowDays)).toISOString(),
      attributedAiLines: cohort.attributedAiLines,
    }
  }
  if (cohort.attributedAiLines < MIN_ATTRIBUTED_LINES) {
    return { kind: 'insufficient', ...base, reason: 'too-few-attributed-lines', attributedAiLines: cohort.attributedAiLines }
  }

  const attributed = cohort.commits.filter(c => !c.isMerge && c.attribution !== 'unknown')
  const authored = attributed.reduce((s, c) => s + c.aiLines, 0)
  const surviving = attributed.reduce((s, c) => s + survivingAiLines(index, c), 0)
  const rate = authored > 0 ? Math.max(0, Math.min(1, 1 - surviving / authored)) : 0
  const b = benchmarkFor(windowDays)

  const times = attributed.map(c => Date.parse(c.authoredAt)).filter(n => !Number.isNaN(n)).sort((a, z) => a - z)
  return {
    kind: 'measured',
    ...base,
    turnoverRate: rate,
    aiLinesAuthored: authored,
    aiLinesSurviving: surviving,
    commitCount: attributed.length,
    mergeRange: {
      fromIso: new Date(times[0] ?? cohort.startMs).toISOString(),
      toIso: new Date(times[times.length - 1] ?? cohort.endMs).toISOString(),
    },
    benchmark: { low: b.low, high: b.high, healthyUnder: b.healthyUnder, verdict: benchmarkVerdict(rate, windowDays) },
    cohortShas: attributed.map(c => c.sha),
  }
}

export async function computeTurnover(workspace: string, opts: ComputeTurnoverOptions = {}): Promise<TurnoverReport> {
  const now = opts.now ?? Date.now()
  const attribution = await attributeRepository(workspace, opts)
  if (attribution.unavailable) {
    return { repoRoot: attribution.repoRoot, headSha: null, results: [], coverage: attribution.coverage, unavailable: attribution.unavailable }
  }

  const index = opts.survivalIndex ?? (await buildSurvivalIndex(attribution.repoRoot))
  if (!index) {
    return { repoRoot: attribution.repoRoot, headSha: null, results: [], coverage: attribution.coverage }
  }

  const repoStartMs = Math.min(
    now,
    ...attribution.commits.map(c => Date.parse(c.authoredAt)).filter(n => !Number.isNaN(n)),
  )
  const cohorts = buildCohorts(attribution.commits)
  const windows = opts.windows ?? [30, 90]

  const results: CohortTurnover[] = []
  for (const cohort of cohorts) {
    for (const w of windows) {
      results.push(evaluateCohort(cohort, w, index, repoStartMs, now))
    }
  }

  return { repoRoot: attribution.repoRoot, headSha: index.headSha, results, coverage: attribution.coverage }
}

/** The measured results as AL 03 `TurnoverInput`s (for the forwarding queue). Only fully-elapsed,
 *  above-floor cohorts appear here — `InsufficientData` never reaches the wire. */
export function toTurnoverInputs(report: TurnoverReport): Array<{ sha: string; windowDays: 30 | 90; aiLinesAuthored: number; aiLinesSurviving: number }> {
  const out: Array<{ sha: string; windowDays: 30 | 90; aiLinesAuthored: number; aiLinesSurviving: number }> = []
  for (const r of report.results) {
    if (r.kind !== 'measured' || r.cohortShas.length === 0) continue
    out.push({ sha: r.cohortShas[0], windowDays: r.windowDays, aiLinesAuthored: r.aiLinesAuthored, aiLinesSurviving: r.aiLinesSurviving })
  }
  return out
}
