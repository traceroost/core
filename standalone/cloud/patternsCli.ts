/**
 * The repo-hash half of `traceroost find` (findCli.ts) — the local half of the cloud Traces
 * table's repo-hash hand-off (traces-table.tsx's HashHandoff, verb="find"). Not reachable as its
 * own CLI verb; `find` dispatches here once it's determined the hash isn't a recorded session.
 * TraceRoost Cloud only ever holds a one-way repo_hash (privacy.ts's NEVER_SENT) and per-trace
 * counts — never a filename, a repo name, or which files were actually touched. This resolves
 * the hash locally (same trick as cohortCli.ts) and prints what cloud can't: the files these
 * sessions actually touched and the loop/behavioral patterns detected in them.
 */

import { loadSessionsForWorkspace, loadAllSessions } from './sessionLoader'
import { resolveRepoHash } from '../../src/cloud/org/resolveRepoHash'
import { repoRootOf } from '../../src/cloud/attribution/commitScan'
import { detectLoopSignals, PATTERN_NAMES, LOOP_SIGNAL_ACTIONS } from '../../src/loopDetector'
import type { LoopSignalType } from '../../src/types'
import type { SessionSummaryCard } from '../../src/summarizers/summarizerTypes'
import path from 'path'

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const HASH_RE = /^[a-f0-9]{64}$/

// Same resolution order cohortCli.ts uses: a real repo_hash resolves via resolveRepoHash (the
// only thing that can turn a one-way hash back into a path — it re-derives the key from each
// candidate local clone rather than reversing the hash); anything else is treated as a
// human-typed repo name/substring match against known session workspaces, falling back to cwd.
async function resolveRepo(repoArg: string, sessionWorkspaces: string[]): Promise<string | null> {
  if (HASH_RE.test(repoArg)) return resolveRepoHash(repoArg, sessionWorkspaces)
  const match = sessionWorkspaces.find(w => w.toLowerCase().includes(repoArg.toLowerCase()))
  if (match) return repoRootOf(match.replace(/^file:\/\//, ''))
  const cwdRoot = await repoRootOf(process.cwd())
  if (cwdRoot && path.basename(cwdRoot).toLowerCase() === repoArg.toLowerCase()) return cwdRoot
  return null
}

export type FileTouch = { path: string; count: number }
export type SignalGroup = { type: LoopSignalType; count: number; sessions: number }

/** Top files by read/changed/written frequency across a repo's local sessions — pure aggregation
 *  so it's testable without touching disk. Matches the explain text shown in the cloud UI
 *  ("can list which files these traces actually touch"). */
export function topTouchedFiles(sessions: SessionSummaryCard[], limit = 15): FileTouch[] {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    for (const f of [...s.filesRead, ...s.filesChanged, ...s.filesWritten]) {
      counts.set(f, (counts.get(f) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, limit)
}

/** Behavioral/loop signals across a repo's local sessions, grouped by type — worst (most
 *  sessions affected) first. Recomputes via detectLoopSignals rather than trusting
 *  session.loopSignals, since log-sourced sessions aren't guaranteed to have it pre-populated. */
export function groupedSignals(sessions: SessionSummaryCard[]): SignalGroup[] {
  const byType = new Map<LoopSignalType, { count: number; sessions: Set<string> }>()
  for (const s of sessions) {
    const signals = detectLoopSignals(s)
    for (const sig of signals) {
      const g = byType.get(sig.type) ?? { count: 0, sessions: new Set<string>() }
      g.count++
      g.sessions.add(s.sessionId)
      byType.set(sig.type, g)
    }
  }
  return [...byType.entries()]
    .map(([type, g]) => ({ type, count: g.count, sessions: g.sessions.size }))
    .sort((a, b) => b.sessions - a.sessions || b.count - a.count)
}

export async function runPatternsCli(args: string[]): Promise<number> {
  const repoArg = (valueAfter(args, '--repo') ?? '').trim()
  if (!repoArg) {
    console.log('Usage: traceroost patterns --repo <hash|name>')
    return 1
  }

  const allSessions = loadAllSessions()
  const workspaces = [...new Set(allSessions.map(s => s.workspace).filter(Boolean))]
  const root = await resolveRepo(repoArg, workspaces)
  if (!root) {
    console.log('Not a repository on this machine. Nothing was requested from anywhere.')
    return 1
  }

  const sessions = loadSessionsForWorkspace(root)
  if (sessions.length === 0) {
    console.log(`\nRepository: ${root}\nNo recorded sessions for this repo on this machine yet.`)
    return 0
  }

  console.log(`\nRepository: ${root}`)
  console.log(`${sessions.length} recorded session${sessions.length === 1 ? '' : 's'} on this machine\n`)

  const files = topTouchedFiles(sessions)
  console.log('Most-touched files (read + changed + written):')
  if (files.length === 0) {
    console.log('  (none recorded)')
  } else {
    for (const f of files) console.log(`  ${String(f.count).padStart(3)}  ${f.path}`)
  }

  const signals = groupedSignals(sessions)
  console.log('\nBehavioral patterns detected:')
  if (signals.length === 0) {
    console.log('  None — no loop or malfunction signals across these sessions.')
  } else {
    for (const g of signals) {
      console.log(`\n  ${PATTERN_NAMES[g.type]} (${g.type})`)
      console.log(`    ${g.sessions} session${g.sessions === 1 ? '' : 's'}, ${g.count} occurrence${g.count === 1 ? '' : 's'}`)
      console.log(`    ${LOOP_SIGNAL_ACTIONS[g.type]}`)
    }
  }
  console.log('\nOpen the Advisor tab in the editor for the interactive view.')
  return 0
}
