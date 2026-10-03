import type { SessionSummaryCard } from '../types'
import { calcSessionCost } from '../sessionMetrics'
import { LANGUAGE_IDS, type SessionLanguage } from '../language'

/** One row of Analytics' "Language breakdown": every trace in view grouped by its PRIMARY
 *  language (media/src/language.ts). Traces stored before language tracking existed have no
 *  language and are grouped under `unrecorded` (shown "—"). */
export interface LanguageBreakdownRow {
  language: SessionLanguage | 'unrecorded'
  sessions: number
  /** Input + output tokens, excluding cache reads — same measure as the outcome trend. */
  tokens: number
  costUsd: number
  /** Traces with at least one loop/behavior signal. */
  withSignals: number
  /** Agent-authored change size (src/editStats.ts), summed over traces that recorded it. */
  filesChanged: number
  linesAdded: number
  linesRemoved: number
}

export function buildLanguageBreakdown(sessions: SessionSummaryCard[]): LanguageBreakdownRow[] {
  const rows = new Map<LanguageBreakdownRow['language'], LanguageBreakdownRow>()
  for (const s of sessions) {
    const key = s.language ?? 'unrecorded'
    const row = rows.get(key) ?? { language: key, sessions: 0, tokens: 0, costUsd: 0, withSignals: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0 }
    row.sessions++
    row.tokens += (s.inputTokens || 0) + (s.outputTokens || 0)
    row.costUsd += calcSessionCost(s).totalUsd || 0
    if ((s.loopSignals ?? []).length > 0) row.withSignals++
    row.filesChanged += s.filesChangedCount ?? 0
    row.linesAdded += s.linesAdded ?? 0
    row.linesRemoved += s.linesRemoved ?? 0
    rows.set(key, row)
  }
  const order = (l: LanguageBreakdownRow['language']) => l === 'unrecorded' ? LANGUAGE_IDS.length : LANGUAGE_IDS.indexOf(l)
  return [...rows.values()].sort((a, b) => (b.sessions - a.sessions) || (order(a.language) - order(b.language)))
}
