import { LoopSignal } from '../types'
import type { OneShotStats } from '../oneShotRate'
import type { SessionLanguage, SecondaryLanguage } from '../language'

export interface SessionSummaryCard {
  sessionId: string
  traceId: string
  source: 'copilot' | 'claude_code' | 'codex' | 'opencode' | 'cursor'
  dataSource: 'otel' | 'log'
  initiator?: 'user' | 'agent' | 'api'
  conversationId?: string
  /** Claude Code's own session id (its OTEL `session.id`, and the `sessionId` field of every
   *  transcript line) when known — how an OTEL interaction finds its transcript turn
   *  (claudeTurnJoin.ts). */
  claudeSessionId?: string
  // ── Stable trace identity (see src/traceIdentity.ts) ──
  /** True when `sessionId` is a derived key: the source has no turn id of its own (or a Claude
   *  OTEL interaction could not be joined to its transcript turn). Never merged with another
   *  source's card. */
  derived?: boolean
  /** OTEL with usage (3) > full transcript (2) > partial (1) — see traceIdentity.ts. A lower
   *  rank never replaces a higher one for the same key. Inferred when absent. */
  sourceRank?: number
  /** Claude: subagent transcripts folded into this turn (their usage is in its totals). */
  subagentCount?: number
  /** A Claude OTEL card whose transcript join is still on hold (claudeTurnJoin.ts): its
   *  `sessionId` is provisional, so it is shown but not persisted or forwarded yet. */
  keyPending?: boolean
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
  /** Most common code language among the distinct files this session read/changed — or, with no
   *  code, the kind of file it touched (docs, config, data, assets) — see
   *  src/language.ts's deriveSessionLanguage. Set when the card is built (logReader's _buildCard,
   *  spanSummarizer's summarizeSpans); absent on a row stored before this existed (shown "—"). */
  language?: SessionLanguage
  /** Runner-up in the primary's own tier (code or non-code), or null when only one was touched.
   *  Never `none` or `no_files`. */
  languageSecondary?: SecondaryLanguage | null
  /** Distinct files the agent edited or wrote (filesChanged, counted — code or not). See
   *  src/editStats.ts. Absent on a row stored before change-size tracking. */
  filesChangedCount?: number
  /** Lines the agent's own edit/write tool calls added / removed (src/editStats.ts) — not git
   *  stats. Undefined when the source records no edit contents (unknown, not 0). */
  linesAdded?: number
  linesRemoved?: number
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
