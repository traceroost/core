import { LoopSignal } from '../types'
import type { OneShotStats } from '../oneShotRate'

export interface SessionSummaryCard {
  sessionId: string
  traceId: string
  source: 'copilot' | 'claude_code' | 'codex' | 'opencode' | 'cursor'
  dataSource: 'otel' | 'log'
  initiator?: 'user' | 'agent' | 'api'
  conversationId?: string
  workspace: string
  projectPath?: string
  userRequest: string
  model: string
  /** Distinct models used across this session's LLM calls, ordered by token volume (descending). `model` is `models[0]`. */
  models?: string[]
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  cacheHitRate: number
  durationMs: number
  startTime: string
  filesRead: string[]
  filesSearched: string[]
  filesChanged: string[]
  filesChangedNote?: string
  toolCounts: Record<string, number>
  totalToolCalls: number
  totalLlmCalls: number
  errors: number
  outcome: 'text_response' | 'tool_calls' | 'unknown'
  timeline: TimelineEntry[]
  backgroundSpans: BackgroundSpanSummary[]
  loopSignals: LoopSignal[]
  peakContextPerTurn?: number   // max single-turn (input + cacheRead + cacheCreate); undefined for single-turn sessions
  filesWritten: string[]        // files fully written (Write / create_file tools); subset of filesChanged
  /** One-shot/retry edit-pass stats, derived from timeline editDetails. Computed during
   *  summarization (see spanSummarizer.ts), same lifecycle as loopSignals — absent on
   *  synthetic/in-progress cards built before that pass runs. */
  oneShotStats?: OneShotStats
}

export interface TimelineEntry {
  type: 'llm' | 'tool' | 'user_input' | 'background'
  spanId: string
  label: string
  thinking?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
  ttft?: number
  durationMs: number
  action?: string
  responseText?: string
  resultSummary?: string
  fullResult?: string
  toolInput?: string
  decision?: string
  isError: boolean
  errorMessage?: string
  timestamp: string
  editDetails?: EditDetail[]
}

export interface EditDetail {
  filePath: string
  oldString?: string
  newString?: string
  content?: string
  toolName?: string
}

export interface EfficiencyReport {
  totalInputTokens: number
  totalOutputTokens: number
  totalLlmCalls: number
  avgInputPerCall: number
  avgTtft: number
  cacheHitRate: number
  toolDefWaste: number
  sysInstructionWaste: number
  topTokenConsumers: Array<{ label: string; tokens: number }>
}

export interface BackgroundSpanSummary {
  name: string
  model: string
  purpose: string
  inputTokens: number
  outputTokens: number
}

export interface FullSummary {
  sessions: SessionSummaryCard[]
  backgroundSpans: BackgroundSpanSummary[]
  efficiency: EfficiencyReport
}
