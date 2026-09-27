/**
 * Adapts stored `SessionSummaryCard`s to the narrow `AttributionSession` view the join needs
 * (AL 05). Only the workspace, the time span, and the changed-file paths cross over — no prompt
 * or response text.
 */

import type { SessionSummaryCard } from '../summarizers/summarizerTypes'
import type { AttributionSession } from './types'

export function toAttributionSessions(cards: SessionSummaryCard[]): AttributionSession[] {
  const out: AttributionSession[] = []
  for (const c of cards) {
    if (!c.workspace || !c.startTime) continue
    const startMs = Date.parse(c.startTime)
    if (Number.isNaN(startMs)) continue
    const endMs = startMs + Math.max(0, c.durationMs || 0)
    if ((c.filesChanged ?? []).length === 0) continue
    out.push({
      sessionId: c.sessionId,
      workspace: c.workspace,
      startMs,
      endMs,
      filesChanged: c.filesChanged,
    })
  }
  return out
}
