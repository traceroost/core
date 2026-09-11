/**
 * Enumerates measurable cohorts for a repository (AL 06).
 *
 * A cohort is the set of commits merged inside a calendar month. It can only be *measured* once
 * its window has fully elapsed — a 90-day figure computed today describes commits that are
 * themselves at least 90 days old.
 */

import type { CommitAttribution } from '../attribution/types'

export interface Cohort {
  /** `YYYY-MM`. */
  label: string
  /** Inclusive start / exclusive end of the calendar month, ms. */
  startMs: number
  endMs: number
  commits: CommitAttribution[]
  /** Sum of `aiLines` across attributed, non-merge commits in the cohort. */
  attributedAiLines: number
  commitCount: number
}

function monthKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthBounds(key: string): { startMs: number; endMs: number } {
  const [y, m] = key.split('-').map(Number)
  return {
    startMs: Date.UTC(y, m - 1, 1),
    endMs: Date.UTC(y, m, 1),
  }
}

/** Groups attributed commits into monthly cohorts, newest month first. */
export function buildCohorts(commits: CommitAttribution[]): Cohort[] {
  const byMonth = new Map<string, CommitAttribution[]>()
  for (const c of commits) {
    const ms = Date.parse(c.authoredAt)
    if (Number.isNaN(ms)) continue
    const key = monthKey(ms)
    const arr = byMonth.get(key) ?? []
    arr.push(c)
    byMonth.set(key, arr)
  }

  return [...byMonth.entries()]
    .map(([label, cohortCommits]) => {
      const { startMs, endMs } = monthBounds(label)
      const attributed = cohortCommits.filter(c => !c.isMerge && c.attribution !== 'unknown')
      return {
        label,
        startMs,
        endMs,
        commits: cohortCommits,
        attributedAiLines: attributed.reduce((s, c) => s + c.aiLines, 0),
        commitCount: cohortCommits.length,
      }
    })
    .sort((a, b) => b.startMs - a.startMs)
}

/** When a cohort becomes measurable for a given window: the day after `window` days past the
 *  cohort's last day. */
export function measurableAt(cohort: Cohort, windowDays: 30 | 90): number {
  return cohort.endMs + windowDays * 86_400_000
}

export function isWindowElapsed(cohort: Cohort, windowDays: 30 | 90, now = Date.now()): boolean {
  return measurableAt(cohort, windowDays) <= now
}
