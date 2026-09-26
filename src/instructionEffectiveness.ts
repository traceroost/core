/**
 * Instruction effectiveness tracking — before/after metrics for applied suggestions.
 * All functions receive workspace-pre-filtered sessions.
 */

import type { SessionSummaryCard } from './summarizers/summarizerTypes'
import { calcTokenCostUsd } from './pricing'

export interface BaselineSnapshot {
  sessionCount: number
  costAvg: number
  turnsAvg: number
  errorRate: number
  loopRate: number
  insufficient: boolean  // true if < 5 sessions in baseline window
}

export interface PostMetrics {
  sessionCount: number
  costAvg: number
  turnsAvg: number
  errorRate: number
  loopRate: number
}

export interface EffectivenessResult {
  baseline: BaselineSnapshot
  post: PostMetrics | null    // null when < 3 post sessions
  confidence: 'none' | 'low' | 'medium' | 'high'
  costChangePct: number | null
  turnsChangePct: number | null
  errorChangePct: number | null
}

function cost(s: SessionSummaryCard): number {
  return calcTokenCostUsd(
    s.inputTokens - s.cacheReadTokens - (s.cacheCreateTokens ?? 0),
    s.cacheReadTokens,
    s.cacheCreateTokens ?? 0,
    s.outputTokens,
    s.model,
  )
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function changePct(before: number, after: number): number | null {
  if (before === 0) return null
  return ((after - before) / before) * 100
}

/** Compute the baseline from the N sessions immediately before appliedAtMs. */
export function computeBaseline(
  sessions: SessionSummaryCard[],
  appliedAtMs: number,
  windowSize = 20,
): BaselineSnapshot {
  const before = sessions
    .filter(s => s.startTime && Date.parse(s.startTime) < appliedAtMs)
    .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
    .slice(0, windowSize)

  if (before.length < 5) {
    return { sessionCount: before.length, costAvg: 0, turnsAvg: 0, errorRate: 0, loopRate: 0, insufficient: true }
  }

  return {
    sessionCount: before.length,
    costAvg:    avg(before.map(cost)),
    turnsAvg:   avg(before.map(s => s.totalLlmCalls)),
    errorRate:  avg(before.map(s => s.errors)),
    loopRate:   before.filter(s => (s.loopSignals?.length ?? 0) > 0).length / before.length,
    insufficient: false,
  }
}

/** Compute post-application metrics from sessions after appliedAtMs. */
export function computePostMetrics(
  sessions: SessionSummaryCard[],
  appliedAtMs: number,
): PostMetrics | null {
  const after = sessions.filter(s => s.startTime && Date.parse(s.startTime) >= appliedAtMs)
  if (after.length < 3) return null

  return {
    sessionCount: after.length,
    costAvg:    avg(after.map(cost)),
    turnsAvg:   avg(after.map(s => s.totalLlmCalls)),
    errorRate:  avg(after.map(s => s.errors)),
    loopRate:   after.filter(s => (s.loopSignals?.length ?? 0) > 0).length / after.length,
  }
}

function confidenceLevel(postCount: number): EffectivenessResult['confidence'] {
  if (postCount < 3)  return 'none'
  if (postCount < 8)  return 'low'
  if (postCount < 15) return 'medium'
  return 'high'
}

export function computeEffectiveness(
  sessions: SessionSummaryCard[],
  appliedAtMs: number,
): EffectivenessResult {
  const baseline = computeBaseline(sessions, appliedAtMs)
  const post     = computePostMetrics(sessions, appliedAtMs)

  return {
    baseline,
    post,
    confidence: post ? confidenceLevel(post.sessionCount) : 'none',
    costChangePct:  post && !baseline.insufficient ? changePct(baseline.costAvg,  post.costAvg)  : null,
    turnsChangePct: post && !baseline.insufficient ? changePct(baseline.turnsAvg, post.turnsAvg) : null,
    errorChangePct: post && !baseline.insufficient ? changePct(baseline.errorRate, post.errorRate) : null,
  }
}

export interface ImpactSummary {
  appliedCount: number
  measuredCount: number
  avgCostChangePct: number | null
  avgTurnsChangePct: number | null
  improving: number
  flat: number
  worse: number
}
