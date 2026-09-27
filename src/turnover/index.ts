/**
 * The cohort turnover engine (AL 06) — free forever, local, one developer's own repositories.
 *
 * ```
 * turnover = 1 − (AI-authored lines from that cohort still present at the window's end)
 *                ──────────────────────────────────────────────────────────────────
 *                (AI-authored lines that cohort introduced)
 * ```
 *
 * "The window's end" is real history, not HEAD: a 30-day figure blames the last first-parent
 * commit on HEAD's history dated before `cohort end + 30 days`, a 90-day figure the one before
 * `cohort end + 90 days`. Measuring both at HEAD would make them the same number (churn-to-date)
 * and compare it against window-specific benchmarks it doesn't describe.
 *
 * A cohort whose window has not fully elapsed produces **no result** — not zero, not a partial
 * figure. The return type is `TurnoverResult | InsufficientData`, and `InsufficientData` carries
 * why and, where it applies, the date the cohort becomes measurable. The day-one screen is built
 * entirely from that structure. The engine has no transport.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { attributeRepository, type AttributeOptions, type AttributionResult } from '../attribution'
import type { Confidence } from '../attribution/types'
import { buildCohorts, isWindowElapsed, measurableAt, type Cohort } from './cohorts'
import { survivalAt, survivingAiLines, type SurvivalIndex, type FileBlameCache } from './survival'
import { benchmarkFor, benchmarkVerdict } from './benchmarks'

/** Coarse stages a caller (a progress UI) can show while a turnover report is computed. */
export type TurnoverStage = 'attributing' | 'blaming'
export interface TurnoverProgress {
  stage: TurnoverStage
  done: number
  total: number
}

/** Below this many attributed lines a cohort's percentage swings on a single edit and reads as
 *  noise. */
export const MIN_ATTRIBUTED_LINES = 200

/** One commit's contribution to a measured cohort — the drill-down behind the aggregate
 *  percentage. No message text: `commitScan.ts` reads a commit's message only to detect an
 *  agent trailer and discards it before returning, by design — that boundary holds here too, so
 *  this identifies a commit by sha/date/counts only. Never sent — the wire payload (AL 03) carries
 *  `commit_hash` (a further HMAC of this sha), not this record. */
export interface CommitDetail {
  sha: string
  authoredAt: string
  linesAdded: number
  aiLines: number
  aiLinesSurviving: number
  attribution: Confidence
}

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
  /** The commit survival was measured at — the last first-parent commit before the window ended.
   *  Optional only because a report cached before this field existed round-trips without it. */
  measuredAtSha?: string
  /** Sorted worst-survival-first, so the drill-down opens on what's actually driving the number.
   *  Always set by evaluateCohort — optional only because a `cohort_turnover` row cached before
   *  this field existed round-trips through this same type with it absent (see cached.ts; HEAD
   *  hasn't moved, so it won't recompute on its own). */
  commits?: CommitDetail[]
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
  /** Set by `computeTurnoverCached` — what the persisted report was computed against. */
  cacheKey?: string
}

export interface ComputeTurnoverOptions extends Omit<AttributeOptions, 'onProgress'> {
  /** Which windows to compute for each cohort. Default both. */
  windows?: (30 | 90)[]
  now?: number
  /** Unused by computeTurnover since turnover is measured at each window's end rather than HEAD —
   *  kept so existing callers' options still type-check. See `survival.ts`'s `buildSurvivalIndex`. */
  fileBlameCache?: FileBlameCache
  /** A previously computed report. A measured result whose measurement commit, cohort commits and
   *  attributed line count are unchanged is reused as-is — a blame at a fixed past commit can't
   *  change — so only newly elapsed windows cost any blame work. */
  previous?: TurnoverReport | null
  /** Stage-tagged progress across both the commit-attribution pass and the survival-index blame
   *  pass — the two expensive parts of a turnover computation. */
  onProgress?: (progress: TurnoverProgress) => void
}

const execFileAsync = promisify(execFile)

async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

/** The last first-parent commit on HEAD's history committed before `beforeMs` — the tree as it
 *  stood when the window ended. */
async function measurementCommit(repoRoot: string, beforeMs: number): Promise<string | null> {
  const out = await gitOut(repoRoot, ['rev-list', '-1', '--first-parent', `--before=${Math.floor(beforeMs / 1000)}`, 'HEAD'])
  return out?.trim() || null
}

/** Repo-relative paths a commit touched (post-image). */
async function filesTouched(repoRoot: string, sha: string, memo: Map<string, string[]>): Promise<string[]> {
  const hit = memo.get(sha)
  if (hit) return hit
  const out = await gitOut(repoRoot, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', sha])
  const files = (out ?? '').split('\0').filter(Boolean)
  memo.set(sha, files)
  return files
}

/** Where each of `files` (as of commit `from`) lives at commit `to`: renames are followed commit
 *  by commit (so a rename with edits on either side of it is still caught), deletions dropped.
 *  One `git log` per commit/window pair, not per file. */
async function pathsAt(repoRoot: string, from: string, to: string, files: Set<string>): Promise<string[]> {
  if (from === to) return [...files]
  const out = await gitOut(repoRoot, ['log', '--reverse', '--format=', '--name-status', '-M', '-z', `${from}..${to}`])
  if (out === null) return [...files]
  const current = new Map<string, string>([...files].map(f => [f, f]))  // original → current path
  const byCurrent = new Map<string, string>([...files].map(f => [f, f]))  // current → original
  const parts = out.split('\0')
  for (let i = 0; i < parts.length;) {
    const status = parts[i].trim()
    if (!status) { i++; continue }
    if (status.startsWith('R') || status.startsWith('C')) {
      const [oldPath, newPath] = [parts[i + 1], parts[i + 2]]
      const orig = byCurrent.get(oldPath)
      if (status.startsWith('R') && orig !== undefined) {
        byCurrent.delete(oldPath)
        byCurrent.set(newPath, orig)
        current.set(orig, newPath)
      }
      i += 3
    } else {
      const orig = byCurrent.get(parts[i + 1])
      if (status === 'D' && orig !== undefined) {
        byCurrent.delete(parts[i + 1])
        current.delete(orig)
      }
      i += 2
    }
  }
  return [...current.values()]
}

function sameShas(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every(x => set.has(x))
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
  const details: CommitDetail[] = attributed.map(c => ({
    sha: c.sha,
    authoredAt: c.authoredAt,
    linesAdded: c.linesAdded,
    aiLines: c.aiLines,
    aiLinesSurviving: survivingAiLines(index, c),
    attribution: c.attribution,
  }))
  const authored = details.reduce((s, c) => s + c.aiLines, 0)
  const surviving = details.reduce((s, c) => s + c.aiLinesSurviving, 0)
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
    measuredAtSha: index.headSha,
    // Worst survival fraction first (fewest surviving lines relative to what it introduced) —
    // opens the drill-down on whatever is actually driving the number.
    commits: [...details].sort((x, y) => {
      const fx = x.aiLines > 0 ? x.aiLinesSurviving / x.aiLines : 1
      const fy = y.aiLines > 0 ? y.aiLinesSurviving / y.aiLines : 1
      return fx - fy
    }),
  }
}

export async function computeTurnover(workspace: string, opts: ComputeTurnoverOptions = {}): Promise<TurnoverReport> {
  const now = opts.now ?? Date.now()
  const attribution = await attributeRepository(workspace, {
    ...opts,
    onProgress: opts.onProgress ? (done, total) => opts.onProgress!({ stage: 'attributing', done, total }) : undefined,
  })
  if (attribution.unavailable) {
    return { repoRoot: attribution.repoRoot, headSha: null, results: [], coverage: attribution.coverage, unavailable: attribution.unavailable }
  }

  const headSha = (await gitOut(attribution.repoRoot, ['rev-parse', 'HEAD']))?.trim()
  if (!headSha) {
    return { repoRoot: attribution.repoRoot, headSha: null, results: [], coverage: attribution.coverage }
  }

  const repoStartMs = Math.min(
    now,
    ...attribution.commits.map(c => Date.parse(c.authoredAt)).filter(n => !Number.isNaN(n)),
  )
  const cohorts = buildCohorts(attribution.commits)
  const windows = opts.windows ?? [30, 90]
  const blameMemo = new Map<string, Record<string, number> | null>()
  const touchedMemo = new Map<string, string[]>()
  const empty: SurvivalIndex = { bySha: new Map(), headSha, filesBlamed: 0 }

  // Only (cohort, window) pairs that will actually be measured need a blame — everything else
  // resolves to InsufficientData from dates and counts alone.
  const pending: Array<{ cohort: Cohort; window: 30 | 90 }> = []
  for (const cohort of cohorts) {
    for (const w of windows) pending.push({ cohort, window: w })
  }
  let done = 0
  const results: CohortTurnover[] = []
  for (const { cohort, window: w } of pending) {
    const probe = evaluateCohort(cohort, w, empty, repoStartMs, now)
    opts.onProgress?.({ stage: 'blaming', done: ++done, total: pending.length })
    if (probe.kind !== 'measured') { results.push(probe); continue }

    const at = await measurementCommit(attribution.repoRoot, measurableAt(cohort, w))
    if (!at) { results.push(probe); continue }

    const prev = opts.previous?.results.find(r => r.kind === 'measured' && r.cohortLabel === cohort.label && r.windowDays === w)
    if (prev && prev.kind === 'measured' && prev.measuredAtSha === at
      && prev.aiLinesAuthored === probe.aiLinesAuthored && sameShas(prev.cohortShas, probe.cohortShas)) {
      results.push(prev)
      continue
    }

    const cohortCommits = cohort.commits.filter(c => !c.isMerge && c.attribution !== 'unknown' && c.aiLines > 0)
    const bySha = new Map<string, number>()
    // Group by the commit's own tree, so a rename after the commit is followed to its path at `at`.
    for (const c of cohortCommits) {
      const files = new Set(await filesTouched(attribution.repoRoot, c.sha, touchedMemo))
      if (files.size === 0) continue
      const paths = await pathsAt(attribution.repoRoot, c.sha, at, files)
      const counts = await survivalAt(attribution.repoRoot, at, paths, new Set([c.sha]), blameMemo)
      bySha.set(c.sha, counts.get(c.sha) ?? 0)
    }
    results.push(evaluateCohort(cohort, w, { bySha, headSha: at, filesBlamed: 0 }, repoStartMs, now))
  }

  return { repoRoot: attribution.repoRoot, headSha, results, coverage: attribution.coverage }
}
