/**
 * Span Summarizer — transforms raw OTLP spans into human-readable session summaries.
 *
 * Agent-specific parsing lives in src/summarizers/:
 *   copilot.ts  — invoke_agent spans (GitHub Copilot)
 *   claude.ts   — claude_code.interaction spans (Claude Code CLI)
 *   codex.ts    — codex.* spans (Codex CLI)
 *   helpers.ts  — shared attribute accessors and formatting utilities
 */

import { Span } from './types'
import { detectLoopSignals } from './loopDetector'
import { computeOneShotStats } from './oneShotRate'
import { buildCopilotSessions } from './summarizers/copilot'
import { buildClaudeSessions } from './summarizers/claude'
import { buildCodexSessions } from './summarizers/codex'
import { getAttrStr, getAttrInt, isCodexLlmSpanName, timestampToMs } from './summarizers/helpers'

// Re-export all types so callers don't need to update their imports
export type {
  SessionSummaryCard,
  TimelineEntry,
  EditDetail,
  EfficiencyReport,
  BackgroundSpanSummary,
  FullSummary,
} from './summarizers/summarizerTypes'

export function summarizeSpans(spans: Span[]) {
  if (!Array.isArray(spans) || spans.length === 0) {
    return {
      sessions: [],
      backgroundSpans: [],
      efficiency: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalLlmCalls: 0,
        avgInputPerCall: 0,
        avgTtft: 0,
        cacheHitRate: 0,
        toolDefWaste: 0,
        sysInstructionWaste: 0,
        topTokenConsumers: [],
      },
    }
  }

  // Build parent-child map and group spans for each builder
  const childrenOf: Record<string, Span[]> = {}
  const invokeAgentSpans: Span[] = []
  const claudeInteractionSpans: Span[] = []
  const orphanSpans: Span[] = []
  const spansByTraceId: Record<string, Span[]> = {}

  for (const s of spans) {
    if (s.name.startsWith('invoke_agent')) {
      invokeAgentSpans.push(s)
    } else if (s.name === 'claude_code.interaction') {
      claudeInteractionSpans.push(s)
    }
    if (s.parentSpanId) {
      if (!childrenOf[s.parentSpanId]) { childrenOf[s.parentSpanId] = [] }
      childrenOf[s.parentSpanId].push(s)
    } else if (!s.name.startsWith('invoke_agent') && s.name !== 'claude_code.interaction') {
      orphanSpans.push(s)
    }
    if (s.traceId) {
      if (!spansByTraceId[s.traceId]) { spansByTraceId[s.traceId] = [] }
      spansByTraceId[s.traceId].push(s)
    }
  }

  // Synthesize root interaction spans for Claude traces that have llm_request/tool spans
  // but no claude_code.interaction span (e.g., in-progress sessions or late-arriving root spans).
  const existingInteractionTraceIds = new Set(claudeInteractionSpans.map(s => s.traceId).filter(Boolean))
  for (const [traceId, traceSpans] of Object.entries(spansByTraceId)) {
    if (existingInteractionTraceIds.has(traceId)) { continue }
    const hasClaudeSpans = traceSpans.some(s => s.name === 'claude_code.llm_request' || s.name === 'claude_code.tool')
    if (!hasClaudeSpans) { continue }
    const sorted = traceSpans.slice().sort((a, b) => (a.startTime ?? '0') < (b.startTime ?? '0') ? -1 : 1)
    claudeInteractionSpans.push({
      traceId,
      spanId: `synth-${traceId.slice(0, 12)}`,
      name: 'claude_code.interaction',
      startTime: sorted[0].startTime,
      endTime: sorted[sorted.length - 1].endTime,
      attributes: [],
    })
  }

  // Synthesize invoke_agent spans for in-progress Copilot sessions.
  // chat* and execute_tool spans arrive before the root invoke_agent span closes,
  // so their parentSpanId points to a span that doesn't exist in the store yet.
  const allSpanIds = new Set(spans.map(s => s.spanId).filter(Boolean))
  const existingInvokeTraceIds = new Set(invokeAgentSpans.map(s => s.traceId).filter(Boolean))
  const existingInvokeSpanIds = new Set(invokeAgentSpans.map(s => s.spanId).filter(Boolean))
  const orphanParentChildren: Record<string, Span[]> = {}
  for (const s of spans) {
    if (!s.parentSpanId || allSpanIds.has(s.parentSpanId)) { continue }
    if (!s.name.startsWith('chat') && !s.name.startsWith('execute_tool')) { continue }
    if (s.traceId && existingInvokeTraceIds.has(s.traceId)) { continue }
    if (!orphanParentChildren[s.parentSpanId]) { orphanParentChildren[s.parentSpanId] = [] }
    orphanParentChildren[s.parentSpanId].push(s)
  }
  for (const [parentId, children] of Object.entries(orphanParentChildren)) {
    if (existingInvokeSpanIds.has(parentId)) { continue }
    const sorted = children.slice().sort((a, b) => (a.startTime ?? '0') < (b.startTime ?? '0') ? -1 : 1)
    const traceId = sorted[0].traceId || ''
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0, model = ''
    for (const c of children) {
      if (!c.name.startsWith('chat')) { continue }
      totalInput += getAttrInt(c, 'gen_ai.usage.input_tokens')
      totalOutput += getAttrInt(c, 'gen_ai.usage.output_tokens')
      totalCacheRead += getAttrInt(c, 'gen_ai.usage.cache_read.input_tokens')
      totalCacheCreate += getAttrInt(c, 'gen_ai.usage.cache_creation.input_tokens')
      const m = getAttrStr(c, 'gen_ai.request.model')
      if (m) { model = m }
    }
    invokeAgentSpans.push({
      traceId,
      spanId: parentId,
      name: 'invoke_agent',
      startTime: sorted[0].startTime,
      endTime: sorted[sorted.length - 1].endTime,
      attributes: [
        { key: 'copilot_chat.user_request', value: { stringValue: '[trace in progress]' } },
        { key: 'gen_ai.usage.input_tokens', value: { intValue: totalInput } },
        { key: 'gen_ai.usage.output_tokens', value: { intValue: totalOutput } },
        { key: 'gen_ai.usage.cache_read.input_tokens', value: { intValue: totalCacheRead } },
        { key: 'gen_ai.usage.cache_creation.input_tokens', value: { intValue: totalCacheCreate } },
        { key: 'gen_ai.request.model', value: { stringValue: model } },
      ],
    })
  }

  const allSorted = [
    ...buildCopilotSessions(invokeAgentSpans, childrenOf, spansByTraceId),
    ...buildClaudeSessions(claudeInteractionSpans, spansByTraceId),
    ...buildCodexSessions(spans),
  ].sort((a, b) => timestampToMs(a.startTime) - timestampToMs(b.startTime))

  const sessions = allSorted

  sessions.forEach(s => { s.loopSignals = detectLoopSignals(s) })
  sessions.forEach(s => { s.oneShotStats = computeOneShotStats(s) })

  // Background/orphan spans — associate with sessions by traceId
  const bgByTraceId: Record<string, Array<{ name: string; model: string; purpose: string; inputTokens: number; outputTokens: number }>> = {}
  const backgroundSpans = orphanSpans.filter(s => !s.name.startsWith('codex.')).map(s => {
    const agentName = getAttrStr(s, 'gen_ai.agent.name')
    const model = getAttrStr(s, 'gen_ai.request.model')
    const inTok = getAttrInt(s, 'gen_ai.usage.input_tokens')
    const outTok = getAttrInt(s, 'gen_ai.usage.output_tokens')
    let purpose = agentName || s.name
    if (agentName === 'title') { purpose = 'Generate chat title' }
    if (agentName === 'progressMessages') { purpose = 'Generate progress messages' }
    if (purpose === 'copilotLanguageModelWrapper' || s.name === 'copilotLanguageModelWrapper') { purpose = 'Extension language model call' }
    const bg = { name: s.name, model, purpose, inputTokens: inTok, outputTokens: outTok }
    const tid = s.traceId || ''
    if (tid) {
      if (!bgByTraceId[tid]) { bgByTraceId[tid] = [] }
      bgByTraceId[tid].push(bg)
    }
    return bg
  })

  const sessionOwnedBackgroundSpans = sessions.flatMap(s => s.backgroundSpans ?? [])

  for (const sess of sessions) {
    if (sess.traceId && bgByTraceId[sess.traceId]) {
      sess.backgroundSpans = [...(sess.backgroundSpans ?? []), ...bgByTraceId[sess.traceId]]
    }
  }

  // Efficiency report — token totals come from normalized sessions; this pass
  // only gathers raw-span extras such as TTFT and prompt/tool definition size.
  let ttftSum = 0, ttftCount = 0
  let toolDefSize = 0, sysInstructionSize = 0

  for (const s of spans) {
    const isCopilotLlm = s.name.startsWith('chat')
    const isClaudeLlm = s.name === 'claude_code.llm_request'
    const codexInput = getAttrInt(s, 'gen_ai.usage.input_tokens')
      + getAttrInt(s, 'gen_ai.usage.cache_read.input_tokens')
      + getAttrInt(s, 'gen_ai.usage.cache_creation.input_tokens')
      + getAttrInt(s, 'input_tokens')
      + getAttrInt(s, 'prompt_tokens')
      + getAttrInt(s, 'cache_read_tokens')
      + getAttrInt(s, 'cache_creation_tokens')
    const codexOutput = getAttrInt(s, 'gen_ai.usage.output_tokens')
      + getAttrInt(s, 'output_tokens')
      + getAttrInt(s, 'completion_tokens')
    const isCodexLlm = s.name.startsWith('codex.') && (isCodexLlmSpanName(s.name) || codexInput > 0 || codexOutput > 0)

    if (isCopilotLlm || isClaudeLlm || isCodexLlm || s.name.startsWith('invoke_agent')) {
      if (isCodexLlm) {
        // Codex TTFT is represented separately and attached during normalization.
      } else if (isCopilotLlm) {
        const inTok = getAttrInt(s, 'gen_ai.usage.input_tokens')
        const outTok = getAttrInt(s, 'gen_ai.usage.output_tokens')
        if (inTok > 0 || outTok > 0) {
          const ttft = getAttrInt(s, 'copilot_chat.time_to_first_token')
          if (ttft > 0) { ttftSum += ttft; ttftCount++ }
        }
      } else if (isClaudeLlm) {
        const inTok = getAttrInt(s, 'input_tokens')
          + getAttrInt(s, 'cache_read_tokens')
          + getAttrInt(s, 'cache_creation_tokens')
        const outTok = getAttrInt(s, 'output_tokens')
        if (inTok > 0 || outTok > 0) {
          const ttft = getAttrInt(s, 'ttft_ms')
          if (ttft > 0) { ttftSum += ttft; ttftCount++ }
        }
      }

      const toolDefs = getAttrStr(s, 'gen_ai.tool.definitions')
      if (toolDefs.length > 0) { toolDefSize += toolDefs.length }
      const sysInstr = getAttrStr(s, 'gen_ai.system_instructions')
      if (sysInstr.length > 0) { sysInstructionSize += sysInstr.length }
    }
  }

  const totalChars = spans.reduce((sum, s) =>
    sum + s.attributes.reduce((a, attr) => a + (attr.value?.stringValue?.length || 0), 0), 0)

  const totalCacheRead = sessions.reduce((s, sess) => s + sess.cacheReadTokens, 0)
  const sessionTotalInput = sessions.reduce((s, sess) => s + sess.inputTokens, 0)
  const sessionTotalOutput = sessions.reduce((s, sess) => s + sess.outputTokens, 0)
  const sessionTotalLlm = sessions.reduce((s, sess) => s + sess.totalLlmCalls, 0)

  return {
    sessions,
    backgroundSpans: [...backgroundSpans, ...sessionOwnedBackgroundSpans],
    efficiency: {
      totalInputTokens: sessionTotalInput,
      totalOutputTokens: sessionTotalOutput,
      totalLlmCalls: sessionTotalLlm,
      avgInputPerCall: sessionTotalLlm > 0 ? Math.round(sessionTotalInput / sessionTotalLlm) : 0,
      avgTtft: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : 0,
      cacheHitRate: sessionTotalInput > 0 ? totalCacheRead / sessionTotalInput : 0,
      toolDefWaste: totalChars > 0 ? toolDefSize / totalChars : 0,
      sysInstructionWaste: totalChars > 0 ? sysInstructionSize / totalChars : 0,
      topTokenConsumers: sessions
        .map(s => ({ label: s.userRequest.slice(0, 50), tokens: s.inputTokens + s.outputTokens }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 5),
    },
  }
}
