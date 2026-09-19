/**
 * Empirically checks whether each loop/malfunction signal actually correlates with a bad session
 * outcome, using this machine's own recorded session history as ground truth. See
 * runbooks/SIGNAL_CALIBRATION.md for what this is, when to re-run it, and how to read the output —
 * this file is deliberately just the mechanics.
 *
 * Not wired into any build step or CI check — run manually via the runbook. Bundle with esbuild
 * (this repo has no ts-node) and execute the bundle with node:
 *
 *   npx esbuild scripts/calibrateSignals.ts --bundle --platform=node --format=cjs \
 *     --outfile=/tmp/calibrateSignals.js && node /tmp/calibrateSignals.js
 */

import { loadAllSessions } from '../standalone/cloud/sessionLoader'
import { detectLoopSignals } from '../src/loopDetector'
import { detectSessionRiskSignals } from '../src/sessionRiskSignals'
import { classifySessionOutcome, GitOutcome } from '../src/gitOutcome'
import type { LoopSignalType } from '../src/types'
import type { SessionSummaryCard } from '../src/summarizers/summarizerTypes'

function normalizeWorkspace(ws: string): string {
  return (ws ?? '').replace(/^file:\/\//, '')
}

const BAD_OUTCOMES = new Set<GitOutcome['overall']>(['abandoned', 'ambiguous'])

interface SignalStats {
  fired: number
  knownOutcome: number
  bad: number
  warning: number
  critical: number
}

async function main(): Promise<void> {
  const all = loadAllSessions()
  const results: Array<{ session: SessionSummaryCard; outcome: GitOutcome | null }> = []

  for (const session of all) {
    const workspace = normalizeWorkspace(session.workspace)
    const outcome = await classifySessionOutcome(workspace, session.filesChanged ?? [])
    results.push({ session, outcome })
  }

  const classifiable = results.filter(r => r.outcome !== null)
  const baselineBad = classifiable.filter(r => BAD_OUTCOMES.has(r.outcome!.overall)).length
  const baselineRate = classifiable.length > 0 ? baselineBad / classifiable.length : 0

  const counts = new Map<LoopSignalType, number[]>()
  const perSignal = new Map<LoopSignalType, SignalStats>()
  const bump = (type: LoopSignalType, knownOutcome: boolean, bad: boolean, severity: 'warning' | 'critical') => {
    const s = perSignal.get(type) ?? { fired: 0, knownOutcome: 0, bad: 0, warning: 0, critical: 0 }
    s.fired++
    if (knownOutcome) { s.knownOutcome++; if (bad) s.bad++ }
    if (severity === 'critical') { s.critical++ } else { s.warning++ }
    perSignal.set(type, s)
  }

  for (const { session, outcome } of results) {
    const workspace = normalizeWorkspace(session.workspace)
    const signals = [
      ...detectLoopSignals(session),
      ...detectSessionRiskSignals(session, workspace),
    ]
    // One LoopSignal object per type per session already (each detector pushes at most one), so
    // no dedup needed here — unlike the fired-types Set this replaces, severity must come from
    // the actual object, not be assumed.
    for (const sig of signals) {
      bump(sig.type, outcome !== null, outcome !== null && BAD_OUTCOMES.has(outcome.overall), sig.severity)
      const arr = counts.get(sig.type) ?? []
      arr.push(sig.count)
      counts.set(sig.type, arr)
    }
  }

  console.log(`Sessions loaded: ${all.length}`)
  console.log(`Sessions with a resolvable git outcome: ${classifiable.length}`)
  console.log(`Baseline bad-outcome rate (abandoned/ambiguous, no signal considered): ${(baselineRate * 100).toFixed(1)}%\n`)

  const rows = [...perSignal.entries()].map(([type, s]) => {
    const rate = s.knownOutcome > 0 ? s.bad / s.knownOutcome : null
    const lift = rate !== null ? rate - baselineRate : null
    return { type, ...s, rate, lift }
  }).sort((a, b) => b.fired - a.fired)

  const col = (s: string, w: number) => s.padEnd(w)
  console.log(
    col('signal', 24) + col('fired', 7) + col('%all', 7) + col('warn', 6) + col('crit', 6)
    + col('known', 7) + col('bad-rate', 10) + 'lift-vs-baseline',
  )
  for (const r of rows) {
    const rateStr = r.rate !== null ? `${(r.rate * 100).toFixed(0)}%` : 'n/a'
    const liftStr = r.lift !== null
      ? `${r.lift >= 0 ? '+' : ''}${(r.lift * 100).toFixed(0)}pp${r.knownOutcome < 5 ? '  (n<5, noisy)' : ''}`
      : 'n/a'
    const pctAll = `${(r.fired / all.length * 100).toFixed(0)}%`
    console.log(
      col(r.type, 24) + col(String(r.fired), 7) + col(pctAll, 7) + col(String(r.warning), 6) + col(String(r.critical), 6)
      + col(String(r.knownOutcome), 7) + col(rateStr, 10) + liftStr,
    )
  }

  console.log('\ncount distribution among fired sessions (the `count` field on each signal):')
  for (const [type, arr] of counts.entries()) {
    const sorted = [...arr].sort((a, b) => a - b)
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
    console.log(
      `  ${type.padEnd(22)} n=${sorted.length}  min=${sorted[0]}  p50=${pct(0.5)}  p75=${pct(0.75)}  `
      + `p90=${pct(0.9)}  p95=${pct(0.95)}  max=${sorted[sorted.length - 1]}`,
    )
  }
}

main().catch(err => { console.error(err); process.exit(1) })
