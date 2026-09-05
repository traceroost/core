/**
 * `agentlens cohort --repo <hash|name> --merged <YYYY-MM> [--window 30|90]` (AL 09).
 *
 * The hand-off: the hosted service holds counts, not code, so "turnover is 31%, show me an
 * example" cannot be answered there — but it can be answered here, on a machine that has the
 * repository. Repository hashes resolve locally because the client re-derives the key from the
 * clone. The service hands over a hash and never learns a name.
 */

import * as path from 'path'
import { loadAllSessions } from './sessionLoader'
import { resolveRepoHash } from '../src/team/resolveRepoHash'
import { repoRootOf } from '../src/attribution/commitScan'
import { computeTurnover } from '../src/turnover'
import { toAttributionSessions } from '../src/attribution/fromSessions'

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const HASH_RE = /^[a-f0-9]{64}$/
const MONTH_RE = /^\d{4}-\d{2}$/

async function resolveRepo(repoArg: string, sessionWorkspaces: string[]): Promise<string | null> {
  if (HASH_RE.test(repoArg)) {
    return resolveRepoHash(repoArg, sessionWorkspaces)
  }
  // A name: match a session workspace whose path contains it, then resolve to the repo root.
  const match = sessionWorkspaces.find(w => w.toLowerCase().includes(repoArg.toLowerCase()))
  if (match) return repoRootOf(match.replace(/^file:\/\//, ''))
  // Or the cwd if it looks right.
  const cwdRoot = await repoRootOf(process.cwd())
  if (cwdRoot && path.basename(cwdRoot).toLowerCase() === repoArg.toLowerCase()) return cwdRoot
  return null
}

export async function runCohortCli(args: string[]): Promise<number> {
  const repoArg = (valueAfter(args, '--repo') ?? '').trim()
  const merged = (valueAfter(args, '--merged') ?? '').trim()
  const window = (valueAfter(args, '--window') ?? '90').trim()

  if (!repoArg || !MONTH_RE.test(merged) || (window !== '30' && window !== '90')) {
    console.log('Usage: agentlens cohort --repo <hash|name> --merged <YYYY-MM> [--window 30|90]')
    return 1
  }

  const sessions = loadAllSessions()
  const workspaces = [...new Set(sessions.map(s => s.workspace).filter(Boolean))]
  const root = await resolveRepo(repoArg, workspaces)
  if (!root) {
    console.log('Not a repository on this machine. Nothing was requested from anywhere.')
    return 1
  }

  const windowDays = Number(window) as 30 | 90
  const report = await computeTurnover(root, {
    sessions: toAttributionSessions(sessions),
    windows: [windowDays],
  })

  const result = report.results.find(r => r.cohortLabel === merged && r.windowDays === windowDays)
  if (!result) {
    console.log(`No ${merged} cohort found in ${root}.`)
    return 1
  }

  console.log(`\nRepository: ${root}`)
  console.log(`Cohort:     ${merged}  ·  ${windowDays}-day window\n`)

  if (result.kind === 'insufficient') {
    console.log(`Not measurable: ${result.reason}${result.measurableAtIso ? ` (available ${result.measurableAtIso.slice(0, 10)})` : ''}`)
    return 0
  }

  console.log(`Turnover:   ${(result.turnoverRate * 100).toFixed(1)}%   (${result.aiLinesSurviving}/${result.aiLinesAuthored} AI lines still stand)`)
  console.log(`Commits:    ${result.commitCount}, merged ${result.mergeRange.fromIso.slice(0, 10)}–${result.mergeRange.toIso.slice(0, 10)}`)
  console.log(`Benchmark:  ${(result.benchmark.low * 100).toFixed(0)}–${(result.benchmark.high * 100).toFixed(0)}% — ${result.benchmark.verdict}\n`)
  console.log('The commits behind this number (resolved to real SHAs locally):')
  for (const sha of result.cohortShas.slice(0, 40)) console.log(`  ${sha}`)
  console.log('\nOpen the Outcomes tab in the editor for the file- and session-level breakdown.')
  return 0
}
