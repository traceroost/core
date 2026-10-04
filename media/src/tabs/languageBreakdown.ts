import type { SessionSummaryCard } from '../types'
import { calcSessionCost } from '../sessionMetrics'
import { LANGUAGE_IDS, type SessionLanguage } from '../language'
import { hasLineData } from './codeChanges'

/** Agent-authored change size (src/editStats.ts) summed over the traces that recorded line counts
 *  (`sessionsReported`) — the rest are never counted as 0 lines — out of `sessions` in view. */
export interface CodeChangeTotals {
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  sessionsReported: number
  sessions: number
}

/** One row of Analytics' "By language": every trace in view grouped by its PRIMARY language
 *  (media/src/language.ts). Traces stored before language tracking existed have no language —
 *  `language: null`, shown "Not reported" and sorted last. Same shape as the cloud dashboard's
 *  By language card (traceroost/cloud src/lib/rollups/analytics.ts). */
export interface LanguageBreakdownRow extends CodeChangeTotals {
  language: SessionLanguage | null
  /** Input + output tokens, excluding cache reads — same measure as the outcome trend. */
  tokens: number
  costUsd: number
}

export interface LanguageBreakdown {
  /** The whole view's totals — the "lines the agent changed" summary line. */
  totals: CodeChangeTotals
  /** Ordered by traces, most first; ties by LANGUAGE_IDS order, not reported last. */
  rows: LanguageBreakdownRow[]
}

/** Display label for the no-language row (distinct from `none`/`no_files`, which were recorded). */
export const LANGUAGE_NOT_REPORTED_LABEL = 'Not reported'

const emptyTotals = (): CodeChangeTotals => ({ filesChanged: 0, linesAdded: 0, linesRemoved: 0, sessionsReported: 0, sessions: 0 })

/** `sessions` is the already-filtered set the neighbouring charts use (filteredSessions). */
export function buildLanguageBreakdown(sessions: SessionSummaryCard[]): LanguageBreakdown {
  const totals = emptyTotals()
  const rows = new Map<SessionLanguage | null, LanguageBreakdownRow>()
  for (const s of sessions) {
    const key = s.language ?? null
    const row = rows.get(key) ?? { ...emptyTotals(), language: key, tokens: 0, costUsd: 0 }
    const reported = hasLineData(s)
    for (const acc of [totals, row]) {
      acc.sessions++
      if (!reported) continue
      acc.sessionsReported++
      acc.filesChanged += s.filesChangedCount ?? 0
      acc.linesAdded += s.linesAdded ?? 0
      acc.linesRemoved += s.linesRemoved ?? 0
    }
    row.tokens += (s.inputTokens || 0) + (s.outputTokens || 0)
    row.costUsd += calcSessionCost(s).totalUsd || 0
    rows.set(key, row)
  }
  const rank = (l: SessionLanguage | null) => l === null ? LANGUAGE_IDS.length : LANGUAGE_IDS.indexOf(l)
  return {
    totals,
    rows: [...rows.values()].sort((a, b) => (b.sessions - a.sessions) || (rank(a.language) - rank(b.language))),
  }
}
