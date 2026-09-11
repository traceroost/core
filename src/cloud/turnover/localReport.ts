/**
 * Assembles the free local turnover report (AL 07) — AL 06's number, per repository this install
 * has seen, for the developer's own commits.
 *
 * Nothing here has a network path. It is computed and rendered locally, with no account and no
 * telemetry.
 */

import * as fs from 'fs'
import * as path from 'path'
import { computeTurnoverCached } from './cached'
import { computeTurnover, type TurnoverReport } from './'
import { toAttributionSessions } from '../attribution/fromSessions'
import { AttributionRepository } from '../../database/attributionRepository'
import { TurnoverRepository } from '../../database/turnoverRepository'
import { repoRootOf } from '../attribution/commitScan'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

interface WriteableDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

export interface RepoTurnover {
  /** A short, non-identifying label derived from the folder name — the UI shows this, and the
   *  share affordance omits it unless the user opts in. */
  label: string
  report: TurnoverReport
}

export interface LocalTurnoverReport {
  repos: RepoTurnover[]
  /** true when at least one cohort is measurable — used for first-run routing. */
  hasMeasurableCohort: boolean
  generatedAt: string
}

function workspaceToPath(ws: string): string {
  if (ws.startsWith('file://')) {
    try { return decodeURIComponent(new URL(ws).pathname) } catch { return ws }
  }
  return ws
}

/** Distinct existing repo roots among the sessions, newest activity first, capped. */
async function repoRootsFromSessions(cards: SessionSummaryCard[], max: number): Promise<Map<string, SessionSummaryCard[]>> {
  const byWorkspace = new Map<string, SessionSummaryCard[]>()
  for (const c of cards) {
    if (!c.workspace) continue
    const arr = byWorkspace.get(c.workspace) ?? []
    arr.push(c)
    byWorkspace.set(c.workspace, arr)
  }
  const roots = new Map<string, SessionSummaryCard[]>()
  for (const [ws, group] of byWorkspace) {
    const p = workspaceToPath(ws)
    if (!fs.existsSync(p)) continue
    const root = await repoRootOf(p)
    if (!root) continue
    const existing = roots.get(root) ?? []
    roots.set(root, [...existing, ...group])
    if (roots.size >= max) break
  }
  return roots
}

export interface LocalReportOptions {
  db?: WriteableDb
  now?: number
  maxRepos?: number
}

export async function buildLocalTurnoverReport(
  sessions: SessionSummaryCard[],
  opts: LocalReportOptions = {},
): Promise<LocalTurnoverReport> {
  const roots = await repoRootsFromSessions(sessions, opts.maxRepos ?? 8)
  const repos: RepoTurnover[] = []

  for (const [root, group] of roots) {
    const attributionSessions = toAttributionSessions(group)
    let report: TurnoverReport
    if (opts.db) {
      report = await computeTurnoverCached(root, {
        repoRoot: root,
        turnoverRepo: new TurnoverRepository(opts.db, root),
        attributionCache: new AttributionRepository(opts.db, root),
        sessions: attributionSessions,
        now: opts.now,
      })
    } else {
      report = await computeTurnover(root, { sessions: attributionSessions, now: opts.now })
    }
    repos.push({ label: path.basename(root) || 'repository', report })
  }

  // Sort repos by whether they have a measured result, then by name.
  repos.sort((a, b) => {
    const am = a.report.results.some(r => r.kind === 'measured') ? 0 : 1
    const bm = b.report.results.some(r => r.kind === 'measured') ? 0 : 1
    return am - bm || a.label.localeCompare(b.label)
  })

  return {
    repos,
    hasMeasurableCohort: repos.some(r => r.report.results.some(x => x.kind === 'measured')),
    generatedAt: new Date().toISOString(),
  }
}
