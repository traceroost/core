import type { SessionSummaryCard, TimelineEntry, OneShotStats } from './types'
import { getAgentProfiles, resolveAgentProfile, type AgentThresholdProfiles } from './agentProfiles'
import { lookupRates, calcTokenCost, type PricingMode } from './pricing'

// Mirrors src/oneShotRate.ts — see there for why this metric exists and its honest limitations
// (edit-pass counting, not a correctness signal).
export const MIN_FILES_FOR_RATE = 2

export function oneShotRate(stats: Pick<OneShotStats, 'filesConsidered' | 'oneShotFiles'>): number | null {
  return stats.filesConsidered >= MIN_FILES_FOR_RATE ? stats.oneShotFiles / stats.filesConsidered : null
}

export function avgEditsPerFile(stats: Pick<OneShotStats, 'filesConsidered' | 'totalEdits'>): number | null {
  return stats.filesConsidered > 0 ? stats.totalEdits / stats.filesConsidered : null
}

export function fmtUsd(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.001) return '<$0.001'
  if (usd < 1) return '$' + usd.toFixed(3)
  return '$' + usd.toFixed(2)
}

export function calcEntryCost(entry: TimelineEntry, sessionModel: string): number {
  const rates = lookupRates(entry.model || sessionModel)
  if (!rates) return 0
  const cacheRead   = entry.cacheReadTokens   ?? 0
  const cacheCreate = entry.cacheCreateTokens ?? 0
  const rawInput    = Math.max(0, (entry.inputTokens ?? 0) - cacheRead - cacheCreate)
  return calcTokenCost(rawInput, cacheRead, cacheCreate, entry.outputTokens ?? 0, rates)
}

export type { PricingMode }

export interface SessionCost {
  totalUsd: number
  aiCredits: number     // totalUsd / 0.01 — Copilot's billing unit
  byTurn: number[]      // cumulative USD at each LLM timeline entry index
  modelUnknown: boolean
  pricingMode: PricingMode
}

export function calcSessionCost(session: SessionSummaryCard, mode: PricingMode): SessionCost {
  const modelId = session.model || ''
  const rates = lookupRates(modelId)
  const llmEntries = (session.timeline ?? []).filter(e => e.type === 'llm')

  if (mode === 'request' || mode === 'request-annual') {
    const mult = mode === 'request-annual'
      ? (rates?.multiplierAnnualPostJun1 ?? 0)
      : (rates?.multiplier ?? 0)
    if (!rates || mult === 0) {
      return { totalUsd: 0, aiCredits: 0, byTurn: llmEntries.map(() => 0), modelUnknown: !rates, pricingMode: mode }
    }
    // Only the user-initiated prompt counts as a premium request in agentic sessions;
    // autonomous tool calls and internal LLM calls within a session do not.
    // session.turns reflects user prompt count; fall back to 1 if unavailable.
    const promptCount = session.turns || 1
    const totalUsd = promptCount * mult * 0.04
    const perPrompt = totalUsd / promptCount
    let cum = 0
    // Spread cost evenly across LLM entries for the chart shape, but total is prompt-based.
    const byTurn = llmEntries.map(() => { cum = Math.min(cum + perPrompt, totalUsd); return cum })
    return { totalUsd, aiCredits: totalUsd / 0.01, byTurn, modelUnknown: false, pricingMode: mode }
  }

  // Token-based mode.
  // Sessions can span more than one model (a Task-tool subagent on a cheaper model, a
  // mid-session /model switch) — when the timeline shows more than one distinct model,
  // price each LLM entry at its own model and sum, instead of pricing the session's
  // aggregate tokens at one model's rate. Mirrors src/database/writer.ts's server-side
  // calculation; single-model sessions fall back to the original aggregate calc.
  const distinctModels = new Set(llmEntries.map(e => e.model).filter((m): m is string => Boolean(m)))
  const anyRateUnknown = distinctModels.size > 0
    ? [...distinctModels].some(m => !lookupRates(m))
    : !rates

  let cum = 0
  const byTurn = llmEntries.map(entry => {
    cum += calcEntryCost(entry, modelId)
    return cum
  })

  const rawInput = Math.max(0, session.inputTokens - session.cacheReadTokens - session.cacheCreateTokens)
  const totalUsd = distinctModels.size > 1
    ? byTurn[byTurn.length - 1] ?? 0
    : rates
      ? calcTokenCost(rawInput, session.cacheReadTokens, session.cacheCreateTokens, session.outputTokens, rates)
      : 0

  return { totalUsd, aiCredits: totalUsd / 0.01, byTurn, modelUnknown: anyRateUnknown, pricingMode: mode }
}

export interface PeakContextUsage {
  peakTokens: number
  contextWindowTokens: number
  percent: number
}

export interface IdenticalToolRepeat {
  key: string
  tool: string
  count: number
  display: string
}

export interface ErrorHealth {
  errorCount: number
  measuredSteps: number
  maxConsecutive: number
  trailingConsecutive: number
  failureRate: number
  recentErrors: string[]
}

export function sessionCostMode(session: SessionSummaryCard, mode: PricingMode): PricingMode {
  // Codex and Claude Code are always token-based; the mode toggle only applies to Copilot
  return (session.source === 'codex' || session.source === 'claude_code') ? 'token' : mode
}

// 'YYYY-MM-DD', UTC — matches the day-grouping convention used by the Cost tab's daily chart.
export function dayKeyUtc(t: string | undefined): string {
  return t ? new Date(t).toISOString().slice(0, 10) : 'unknown'
}

export interface AgentDayCost {
  source: string
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  cost: number
  models: Set<string>
}

export interface DayCost {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  cost: number
  agents: Map<string, AgentDayCost>
}

// Day → agent cost/token breakdown. The single source of truth for "daily cost" — the Analytics
// tab's cost table, the daily_cost alert, and anything else that needs a per-day total should
// build on this rather than re-deriving their own day-grouping and summing.
export function buildDailyCostMap(sessions: SessionSummaryCard[], mode: PricingMode): Map<string, DayCost> {
  const dayMap = new Map<string, DayCost>()
  for (const sess of sessions) {
    const day = dayKeyUtc(sess.startTime)
    const cost = calcSessionCost(sess, sessionCostMode(sess, mode)).totalUsd
    if (!dayMap.has(day)) dayMap.set(day, { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, agents: new Map() })
    const de = dayMap.get(day)!
    de.input += sess.inputTokens; de.output += sess.outputTokens
    de.cacheCreate += sess.cacheCreateTokens ?? 0; de.cacheRead += sess.cacheReadTokens; de.cost += cost
    if (!de.agents.has(sess.source)) de.agents.set(sess.source, { source: sess.source, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, models: new Set() })
    const ae = de.agents.get(sess.source)!
    ae.input += sess.inputTokens; ae.output += sess.outputTokens
    ae.cacheCreate += sess.cacheCreateTokens ?? 0; ae.cacheRead += sess.cacheReadTokens; ae.cost += cost
    if (sess.model) ae.models.add(sess.model)
  }
  return dayMap
}

// Estimated cost across sessions that started on the given UTC day key. Defaults to token-based
// pricing (Copilot's AI Credits model) since this runs in contexts (alerts) with no user-facing
// pricing-mode toggle to plumb through. Built on buildDailyCostMap, not a separate calculation.
export function getDailyCostUsd(sessions: SessionSummaryCard[], dayKey: string): number {
  return buildDailyCostMap(sessions, 'token').get(dayKey)?.cost ?? 0
}

export function sessionDisplayName(session: SessionSummaryCard): string {
  const req = (session.userRequest ?? '').trim()
  if (!req || req === '[trace in progress]') return '[trace in progress]'
  return req.length > 70 ? req.slice(0, 70) + '...' : req
}

export function getPeakContextUsage(session: SessionSummaryCard, profiles: AgentThresholdProfiles = getAgentProfiles()): PeakContextUsage {
  const llmInputs = (session.timeline ?? [])
    .filter(e => e.type === 'llm')
    .map(e => e.inputTokens ?? 0)
    .filter(n => n > 0)
  const fallback = session.totalLlmCalls > 0 ? Math.round((session.inputTokens ?? 0) / session.totalLlmCalls) : 0
  const peakTokens = llmInputs.length > 0 ? Math.max(...llmInputs) : fallback
  const contextWindowTokens = resolveAgentProfile(session.source, profiles).contextWindowTokens
  return {
    peakTokens,
    contextWindowTokens,
    percent: contextWindowTokens > 0 ? peakTokens / contextWindowTokens * 100 : 0,
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + stableJson(obj[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function normalizeToolInput(input: string | undefined): string {
  const raw = (input ?? '').trim()
  if (!raw) return ''
  try {
    return stableJson(JSON.parse(raw))
  } catch {
    return raw.replace(/\s+/g, ' ')
  }
}

function toolName(entry: TimelineEntry): string {
  return (entry.label ?? '').trim().split(/\s+/)[0] || 'tool'
}

function changesFiles(entry: TimelineEntry): boolean {
  if ((entry.editDetails ?? []).length > 0) return true
  const label = (entry.label ?? '').toLowerCase()
  if (/(apply_patch|replace_string|create_file|edit_notebook|write_file|str_replace|multi_edit)/.test(label)) return true
  if (!/(exec|shell|bash|command)/.test(label)) return false
  const input = (entry.toolInput ?? '').toLowerCase()
  return /(apply_patch|sed\s+-i|perl\s+-i|>\s*[\w./~-]|>>\s*[\w./~-]|\btee\b|\btouch\b|\bmv\b|\bcp\b|\brm\b|\bmkdir\b)/.test(input)
}

export function getIdenticalToolRepeat(session: SessionSummaryCard): IdenticalToolRepeat | null {
  const counts = new Map<string, IdenticalToolRepeat & { fileChangeGeneration: number }>()
  let best: IdenticalToolRepeat | null = null
  let fileChangeGeneration = 0
  for (const entry of session.timeline ?? []) {
    if (entry.type === 'tool') {
      const tool = toolName(entry)
      const normalizedInput = normalizeToolInput(entry.toolInput)
      const key = tool + '\n' + (normalizedInput || (entry.label ?? '').trim())
      const current = counts.get(key)
      const count = current && current.fileChangeGeneration === fileChangeGeneration ? current.count + 1 : 1
      counts.set(key, {
        key,
        tool,
        count,
        display: normalizedInput ? tool + ' ' + normalizedInput.slice(0, 90) : (entry.label ?? tool),
        fileChangeGeneration,
      })
      if (count > 1 && (!best || count > best.count)) {
        best = { key, tool, count, display: normalizedInput ? tool + ' ' + normalizedInput.slice(0, 90) : (entry.label ?? tool) }
      }
    }
    if (changesFiles(entry)) {
      fileChangeGeneration++
    }
  }
  return best
}

export function getErrorHealth(session: SessionSummaryCard): ErrorHealth {
  const measured = (session.timeline ?? []).filter(e => e.type === 'llm' || e.type === 'tool')
  let maxConsecutive = 0
  let current = 0
  let errorCount = 0
  const recentErrors: string[] = []
  for (const entry of measured) {
    if (entry.isError) {
      errorCount++
      current++
      maxConsecutive = Math.max(maxConsecutive, current)
      const msg = entry.errorMessage || entry.label
      if (msg) recentErrors.push(msg.slice(0, 140))
    } else {
      current = 0
    }
  }
  const fallbackErrors = Math.max(errorCount, session.errors ?? 0)
  const measuredSteps = measured.length || ((session.totalLlmCalls ?? 0) + (session.totalToolCalls ?? 0))
  return {
    errorCount: fallbackErrors,
    measuredSteps,
    maxConsecutive,
    trailingConsecutive: current,
    failureRate: measuredSteps > 0 ? fallbackErrors / measuredSteps : 0,
    recentErrors: recentErrors.slice(-3),
  }
}

export function getActiveComputeMs(session: SessionSummaryCard): number {
  return (session.timeline ?? [])
    .filter(e => e.type === 'llm' || e.type === 'tool')
    .reduce((sum, entry) => sum + Math.max(entry.durationMs ?? 0, 0), 0)
}
