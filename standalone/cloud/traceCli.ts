/**
 * The trace/session-id half of `traceroost find` (findCli.ts) — the local half of the cloud
 * Traces table's Trace ID hand-off (traces-table.tsx's HashHandoff, verb="find"). Not reachable
 * as its own CLI verb; `find` dispatches here once `findSessionById` confirms the hash matches a
 * recorded session. Unlike repo_hash, the `session_id` cloud holds is the raw, unhashed id (a
 * plain rollups column) — not a one-way hash needing resolution — so this is a direct match
 * against locally recorded sessions, not a hash reversal.
 */

import { loadAllSessions } from './sessionLoader'
import type { SessionSummaryCard } from '../../src/summarizers/summarizerTypes'

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

/** Pure lookup, split out for testing: the first local session whose sessionId or traceId
 *  matches the given id exactly. */
export function findSessionById(sessions: SessionSummaryCard[], id: string): SessionSummaryCard | undefined {
  return sessions.find(s => s.sessionId === id || s.traceId === id)
}

export async function runTraceCli(args: string[]): Promise<number> {
  const id = (valueAfter(args, '--id') ?? '').trim()
  if (!id) {
    console.log('Usage: traceroost trace --id <sessionId>')
    return 1
  }

  const found = findSessionById(loadAllSessions(), id)
  if (!found) {
    console.log(`No trace matching "${id}" on this machine — try a machine that recorded this session.`)
    return 1
  }

  console.log(`\n${found.startTime}  ${found.source}  ${found.workspace || '(no workspace)'}\n`)
  console.log(`"${found.userRequest.slice(0, 200)}${found.userRequest.length > 200 ? '…' : ''}"\n`)
  console.log(`Duration: ${(found.durationMs / 1000).toFixed(1)}s   Turns: ${found.turns}   Errors: ${found.errors}`)
  if (found.filesChanged.length > 0) {
    const shown = found.filesChanged.slice(0, 10).join(', ')
    console.log(`Files changed: ${shown}${found.filesChanged.length > 10 ? ', …' : ''}`)
  }
  console.log('\nOpen the Traces tab in the editor and paste the id into search to jump to it directly.')
  return 0
}
