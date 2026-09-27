/**
 * Loads recorded sessions (OTEL spans + local logs) without starting the dashboard server —
 * shared by `--explain-payload` and `advise` (AL 03 / AL 08).
 */

import * as fs from 'fs'
import * as path from 'path'
import { summarizeSpans } from '../../src/spanSummarizer'
import { LogReader } from '../../src/logReader'
import { computeOneShotStats } from '../../src/oneShotRate'
import { defaultDataDir } from '../../src/serviceConfig'
import type { Span } from '../../src/types'
import type { SessionSummaryCard } from '../../src/summarizers/summarizerTypes'

export function loadAllSessions(): SessionSummaryCard[] {
  return loadSessions(() => true)
}

/** `loadAllSessions()` narrowed to what could match `id` as a sessionId or traceId — every OTEL
 *  session, but only the log files whose name can produce that id, instead of parsing every
 *  transcript on the machine (seconds, at tens of thousands of them). A log card's id is its file
 *  name (a Copilot CLI session's: its directory name), plus `#<n>` for the n-th segment of a file
 *  split on a long gap — except a legacy Copilot Chat `.json` session, whose id is read from the
 *  file, so those are always parsed. Every card that could match is in here, in the same relative
 *  order, so the first match after sorting is the one `loadAllSessions()` would give. */
export function loadSessionsMatchingId(id: string): SessionSummaryCard[] {
  const names = new Set([id, id.replace(/#\d+$/, '')])
  return loadSessions(file => {
    if (file.agentKey === 'copilot_vscode_json') return true
    const name = file.agentKey === 'copilot'
      ? path.basename(path.dirname(file.filePath))
      : path.basename(file.filePath, '.jsonl')
    return names.has(name)
  })
}

function loadSessions(includeFile: (file: { filePath: string; agentKey: string }) => boolean): SessionSummaryCard[] {
  // Was hardcoded to `~/.agentlens` — silently found zero sessions on any install created
  // after the rebrand, since the real default data dir moved to `~/.traceroost`.
  const dataDir = process.env.DATA_DIR ?? defaultDataDir()
  const sessions: SessionSummaryCard[] = []

  try {
    const spans = JSON.parse(fs.readFileSync(path.join(dataDir, 'spans.json'), 'utf-8')) as Span[]
    sessions.push(...summarizeSpans(spans).sessions)
  } catch { /* no OTEL spans persisted */ }

  try {
    const reader = new LogReader()
    for (const file of reader.collectFileMeta()) {
      if (file.agentKey === 'opencode' || !includeFile(file)) continue
      try {
        for (const { card } of reader.parseFile(file.filePath, file.agentKey)) {
          card.oneShotStats = computeOneShotStats(card)
          sessions.push(card)
        }
      } catch { /* skip bad file */ }
    }
  } catch { /* no logs */ }

  return sessions
    .filter(s => s.startTime)
    .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
}

/** `all` lets a caller that already ran `loadAllSessions()` filter that instead of re-reading and
 *  re-parsing every log file a second time. */
export function loadSessionsForWorkspace(workspace: string, all: SessionSummaryCard[] = loadAllSessions()): SessionSummaryCard[] {
  const abs = path.resolve(workspace)
  return all.filter(s => {
    const ws = (s.workspace ?? '').replace(/^file:\/\//, '')
    return ws === abs || ws.startsWith(abs + path.sep) || abs.startsWith(ws)
  })
}
