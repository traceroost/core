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
      if (file.agentKey === 'opencode') continue
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

export function loadSessionsForWorkspace(workspace: string): SessionSummaryCard[] {
  const abs = path.resolve(workspace)
  return loadAllSessions().filter(s => {
    const ws = (s.workspace ?? '').replace(/^file:\/\//, '')
    return ws === abs || ws.startsWith(abs + path.sep) || abs.startsWith(ws)
  })
}
