/**
 * Pulls together the signals TraceRoost already computes — loop-signal actions, hot-file
 * instruction suggestions, and cache hit rate — into one ranked "how to save money" list, instead
 * of leaving them scattered across Patterns/Insights/Instructions with no single place that says
 * "do these things, in this order, to spend less." Pure aggregation over already-computed
 * `SessionSummaryCard[]`; each session's `loopSignals` already carry host-computed
 * `patternName`/`action`/`evidence` text (see src/loopDetector.ts's PATTERN_NAMES/
 * LOOP_SIGNAL_ACTIONS), so this doesn't need its own copy of that taxonomy.
 *
 * This is section 2 of core/.staged-issues/value-prop-and-cost-savings.md turned into product
 * surface (that doc's Step 1) — every item here cites the signal it's built from, not a new one.
 */

import type { SessionSummaryCard, LoopSignalType } from './types'

export type CostSavingActionKind = 'cache_rate' | 'loop_signal' | 'hot_file'

export interface CostSavingAction {
  id: string
  kind: CostSavingActionKind
  title: string
  evidence: string
  action: string
  affectedSessions: number
  priority: 'high' | 'medium' | 'low'
  /** Only set for kind 'loop_signal' — which pattern this is, so callers can draw the exact same
   *  glyph the traces table's Signals column uses for it (see ../signalIcons.ts). */
  loopSignalType?: LoopSignalType
  /** Only set for kind 'loop_signal' — worst severity seen across occurrences, same escalation
   *  rule as Sessions.tsx's SignalsCell (any 'critical' occurrence wins). */
  loopSignalSeverity?: 'warning' | 'critical'
}

const CACHE_RATE_LOW_THRESHOLD = 0.6
const HOT_FILE_THRESHOLD = 0.4

function aggregateCacheHitRate(sessions: SessionSummaryCard[]): CostSavingAction | null {
  const withCalls = sessions.filter(s => s.totalLlmCalls > 0)
  if (withCalls.length < 3) return null
  const avg = withCalls.reduce((sum, s) => sum + s.cacheHitRate, 0) / withCalls.length
  if (avg >= CACHE_RATE_LOW_THRESHOLD) return null
  return {
    id: 'cache_rate',
    kind: 'cache_rate',
    title: `Prompt cache hit rate is ${Math.round(avg * 100)}%`,
    evidence: `Average across ${withCalls.length} session${withCalls.length === 1 ? '' : 's'} in view. Cached tokens cost roughly 10× less than fresh tokens.`,
    action: 'Going from 0% to 60% cache hit rate cuts trace cost by 80–90% with no change to model behavior — keep instruction files and early-turn context stable between calls so the cache stays warm.',
    affectedSessions: withCalls.length,
    priority: avg < 0.3 ? 'high' : 'medium',
  }
}

function loopSignalActions(sessions: SessionSummaryCard[]): CostSavingAction[] {
  const byType = new Map<LoopSignalType, { count: number; sessionIds: Set<string>; patternName: string; action: string; severity: 'warning' | 'critical' }>()
  for (const s of sessions) {
    const seenTypes = new Set<LoopSignalType>()
    for (const signal of s.loopSignals ?? []) {
      if (seenTypes.has(signal.type)) continue
      seenTypes.add(signal.type)
      const entry = byType.get(signal.type) ?? { count: 0, sessionIds: new Set<string>(), patternName: signal.patternName, action: signal.action, severity: 'warning' as const }
      if (signal.severity === 'critical') entry.severity = 'critical'
      entry.count++
      entry.sessionIds.add(s.sessionId)
      byType.set(signal.type, entry)
    }
  }

  const results: CostSavingAction[] = []
  for (const [type, { count, sessionIds, patternName, action, severity }] of byType) {
    const pct = sessionIds.size / sessions.length
    results.push({
      id: `loop_signal:${type}`,
      kind: 'loop_signal',
      title: patternName,
      evidence: `Detected in ${count} of ${sessions.length} session${sessions.length === 1 ? '' : 's'} (${Math.round(pct * 100)}%). Based on a heuristic — may include false positives.`,
      action,
      affectedSessions: sessionIds.size,
      priority: pct >= 0.2 ? 'high' : pct >= 0.08 ? 'medium' : 'low',
      loopSignalType: type,
      loopSignalSeverity: severity,
    })
  }
  return results.sort((a, b) => b.affectedSessions - a.affectedSessions)
}

/** Lightweight count-only version of instructionAdvisor.ts's getHotFileSuggestions (same 40%
 *  threshold) — the full suggestion text/apply flow already lives in the Instructions tab; this
 *  just needs to know whether that tab has something worth pointing at. */
function hotFileAction(sessions: SessionSummaryCard[], existingInstructionText: string): CostSavingAction | null {
  if (sessions.length < 5) return null
  const fileSessionIds = new Map<string, Set<string>>()
  for (const s of sessions) {
    for (const f of [...(s.filesRead ?? []), ...(s.filesChanged ?? [])]) {
      const basename = f.replace(/\\/g, '/').split('/').pop() ?? f
      if (basename.length < 4 || basename === 'index.ts' || basename === 'index.js') continue
      if (existingInstructionText.toLowerCase().includes(basename.toLowerCase())) continue
      if (!fileSessionIds.has(f)) fileSessionIds.set(f, new Set())
      fileSessionIds.get(f)!.add(s.sessionId)
    }
  }
  const qualifying = [...fileSessionIds.entries()].filter(([, ids]) => ids.size / sessions.length >= HOT_FILE_THRESHOLD)
  if (qualifying.length === 0) return null
  const maxPct = Math.max(...qualifying.map(([, ids]) => ids.size / sessions.length))
  return {
    id: 'hot_file_pointer',
    kind: 'hot_file',
    title: `${qualifying.length} file${qualifying.length === 1 ? '' : 's'} read often but missing from your instruction file`,
    evidence: `Each undocumented file the agent has to discover costs ~2–3 extra turns per session.`,
    action: 'See the Instructions tab for ready-to-paste suggestions, one per file.',
    affectedSessions: Math.round(maxPct * sessions.length),
    priority: maxPct >= 0.6 ? 'high' : 'medium',
  }
}

const PRIORITY_WEIGHT: Record<CostSavingAction['priority'], number> = { high: 2, medium: 1, low: 0 }

/**
 * The ranked "how to save money" list: cache hit rate (the single biggest lever by magnitude,
 * when it's actually low) first, then loop-signal actions and the hot-file pointer interleaved by
 * priority and how many sessions each affects.
 */
export function getCostSavingActions(
  sessions: SessionSummaryCard[],
  existingInstructionText: string,
): CostSavingAction[] {
  if (sessions.length === 0) return []

  const cacheAction = aggregateCacheHitRate(sessions)
  const hotFile = hotFileAction(sessions, existingInstructionText)
  const rest = [...loopSignalActions(sessions), ...(hotFile ? [hotFile] : [])]
    .sort((a, b) => {
      const weightDiff = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]
      if (weightDiff !== 0) return weightDiff
      return b.affectedSessions - a.affectedSessions
    })

  return cacheAction ? [cacheAction, ...rest] : rest
}
