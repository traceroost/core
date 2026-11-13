/**
 * `traceroost churn --repo <hash|name> --merged <YYYY-MM> [--window 30|90]` (AL 09; `cohort` was
 * its first name and still runs). "Churn" is the user-facing word for what the engine calls
 * turnover, and a "cohort" is the month's merged commits: neither engine term is printed.
 *
 * The hand-off: the hosted service holds counts, not code, so "turnover is 31%, show me an
 * example" cannot be answered there — but it can be answered here, on a machine that has the
 * repository. Repository hashes resolve locally because the client re-derives the key from the
 * clone. The service hands over a hash and never learns a name.
 *
 * The turnover engine itself is free and local (src/turnover/) — `--repo <name>` works on any
 * install. Resolving a cloud `repo_hash` is the one cloud step, injected as `resolveHash`
 * (see repoResolve.ts).
 */

import { loadAllSessions } from './sessionLoader'
import { resolveRepoArg, repoHeaderLines, type RepoHashResolver } from './repoResolve'
import { resolveOriginUrl } from '../../src/repoRemote'
import { computeTurnover, type TurnoverReport, type TurnoverResult } from '../../src/turnover'
import { DEFAULT_LOOKBACK_HOURS } from '../../src/attribution/sessionJoin'
import { toAttributionSessions } from '../../src/attribution/fromSessions'
import { commandUsage, isCloudEdition } from '../cliArgs'

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const MONTH_RE = /^\d{4}-\d{2}$/

const pct = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The measured block of the output, split out for testing. It says what was counted and how firm
 * that is, and leaves the judgment to the reader:
 *  - the count beside the percentage is the churned lines, the same thing the percentage names;
 *  - "lines in agent-edited files", not "AI lines": attribution is per file (sessionJoin.ts), so a
 *    line typed by hand into a file an agent session changed is counted too;
 *  - the certain/probable split (attribution/index.ts) and the repo's coverage are printed;
 *  - the published range is context from elsewhere, measured another way, so no verdict word.
 */
export function churnLines(result: TurnoverResult, coverage: TurnoverReport['coverage']): string[] {
  const churned = result.aiLinesAuthored - result.aiLinesSurviving
  const lines = [
    `Churn:             ${pct(result.turnoverRate, 1)}   (${churned} of ${plural(result.aiLinesAuthored, 'line')} in agent-edited files rewritten or removed)`,
    `Commits:           ${result.commitCount}, merged ${result.mergeRange.fromIso.slice(0, 10)}–${result.mergeRange.toIso.slice(0, 10)}`,
  ]
  if (result.commits) {
    const part = (label: 'certain' | 'probable') => {
      const cs = result.commits!.filter(c => c.attribution === label)
      return `${label} for ${plural(cs.length, 'commit')} (${plural(cs.reduce((n, c) => n + c.aiLines, 0), 'line')})`
    }
    lines.push(`Attribution:       ${part('certain')}, ${part('probable')}`)
  }
  if (coverage.totalMergedLines > 0) {
    lines.push(`Coverage:          ${pct(coverage.attributedLines / coverage.totalMergedLines)} of the lines you merged in this repo, across all months, are in commits tied to an agent`)
  }
  lines.push(
    `Published range:   ${pct(result.benchmark.low)}–${pct(result.benchmark.high)} at ${result.windowDays} days, from write-ups that measured it another way: context, not a verdict`,
    '',
    'How to read this:',
    '  Every line a commit adds to a file an agent trace changed is counted, including lines edited by hand.',
    '  Certain: the commit has an agent trailer, or was made while a trace was running.',
    `  Probable: a trace changed the file in the ${DEFAULT_LOOKBACK_HOURS} hours before the commit.`,
    '  A line counts as rewritten whatever the reason: a planned refactor and a bug fix look the same.',
  )
  return lines
}

export async function runCohortCli(args: string[], resolveHash?: RepoHashResolver): Promise<number> {
  const repoArg = (valueAfter(args, '--repo') ?? '').trim()
  const merged = (valueAfter(args, '--merged') ?? '').trim()
  const window = (valueAfter(args, '--window') ?? '90').trim()

  if (!repoArg || !MONTH_RE.test(merged) || (window !== '30' && window !== '90')) {
    console.log(`Usage: ${commandUsage('churn', isCloudEdition())}`)
    return 1
  }

  const sessions = loadAllSessions()
  const workspaces = [...new Set(sessions.map(s => s.workspace).filter(Boolean))]
  const root = await resolveRepoArg(repoArg, workspaces, resolveHash)
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
    console.log(`No commits merged in ${merged} found in ${root}.`)
    return 1
  }

  console.log(`\n${repoHeaderLines(root, await resolveOriginUrl(root)).join('\n')}`)
  console.log(`Merged in:         ${merged}  ·  ${windowDays}-day window\n`)

  if (result.kind === 'insufficient') {
    console.log(`Not measurable: ${result.reason}${result.measurableAtIso ? ` (available ${result.measurableAtIso.slice(0, 10)})` : ''}`)
    return 0
  }

  for (const line of churnLines(result, report.coverage)) console.log(line)
  console.log('')
  console.log('The commits behind this number (resolved to real SHAs locally):')
  for (const sha of result.cohortShas.slice(0, 40)) console.log(`  ${sha}`)
  console.log('\nOpen the Outcomes tab in the editor for the file- and trace-level breakdown.')
  return 0
}
