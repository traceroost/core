// Browser-side type definitions for TraceRoost dashboard
// These mirror the backend types from src/types.ts and src/summarizers/summarizerTypes.ts

export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: string
  endTime: string
  attributes: SpanAttribute[]
  status?: SpanStatus
  receivedAt?: number
}

export interface SpanAttribute {
  key: string
  value: {
    stringValue?: string
    intValue?: number
    doubleValue?: number
    boolValue?: boolean
    arrayValue?: unknown
    kvlistValue?: unknown
  }
}

export interface SpanStatus {
  code: number
  message?: string
}

export type LoopSignalType =
  | 'exact_tool_repeat'
  | 'edit_revert_cycle'
  | 'error_recurrence'
  | 'runaway_steps'
  | 'token_runaway'
  | 'chronic_tool_failures'
  | 'context_flooding_risk'
  | 'hallucinated_import'
  | 'failed_check_submission'
  | 'tool_call_cycle'
  | 'file_reread'
  | 'cache_miss'
  | 'ttl_expiry'
  | 'low_cache_hit_ratio'
  | 'budget_overrun'
  | 'model_tier_mismatch'
  | 'skipped_checks'

export interface LoopSignal {
  type: LoopSignalType
  severity: 'warning' | 'critical'
  evidence: string
  count: number
  examples: string[]
  patternName: string
  action: string
}

// Mirrors src/gitOutcome.ts. Fetched lazily per session (see sessionTimelines in state.ts for the
// same lazy-cache pattern) — never eagerly computed for every loaded session.
export type FileOutcome = 'merged' | 'committed' | 'abandoned' | 'ambiguous'

export interface GitOutcome {
  overall: FileOutcome
  files: Record<string, FileOutcome>
  reason: string
}

// Mirrors src/actionLog.ts's ActionLogEntry — see action-log.md. Pushed via an `actionLog` message.
export interface ActionLogEntry {
  id: number
  cwd: string
  gloss: string | null
  raw: string
  startedAt: number
  finishedAt: number | null
  failed: boolean
}

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
  peakContextPerTurn?: number
  filesWritten: string[]
  /** Mirrors src/oneShotRate.ts's OneShotStats. Absent on cards computed before this field existed. */
  oneShotStats?: OneShotStats
}

export interface OneShotStats {
  filesConsidered: number
  oneShotFiles: number
  retriedFiles: number
  totalEdits: number
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

// ── Phase 4 analytics types ───────────────────────────────────────────────────

export interface DailyStatRow {
  day: string              // 'YYYY-MM-DD'
  totalTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  outputTokens: number
  costUsd: number
  sessionCount: number
}

export interface LifetimeStats {
  totalSessions: number
  totalTokens: number
  totalCostUsd: number
  oldestSessionMs: number
  newestSessionMs: number
}

export interface BurnRate {
  tokensPerMinute: number
  costPerHour: number
}

export interface Projection {
  totalTokens: number
  totalCostUsd: number
  remainingMinutes: number
  contextFillPct: number
}

export interface SearchQuery {
  text?: string
  source?: string
  model?: string
  since?: number
  until?: number
  minCostUsd?: number
  orderBy?: 'start_time' | 'cost_usd' | 'total_tokens' | 'duration_ms' | 'errors'
  orderDir?: 'ASC' | 'DESC'
  limit?: number
  offset?: number
}

export type AgentFilter = 'all' | 'copilot' | 'claude_code' | 'codex' | 'opencode' | 'cursor'
// 'agent' covers both agent-spawned sub-tasks and non-interactive API calls (sess.initiator
// 'agent' | 'api') — the two were a single visually-indistinguishable gray pill even before this
// type merged them, so the filter now matches what a user could actually tell apart.
export type InitiatorFilter = 'all' | 'user' | 'agent'
export type DataSourceFilter = 'all' | 'otel' | 'log'
export type InsightFilter = 'all' | 'loop' | 'efficiency'
// Freeform — '' means unfiltered (same convention as sessionTextFilter), any other value is a
// live substring search matched against a repo's name, path, and hash (see matchesRepoQuery).
export type WorkspaceFilter = string
// Mirrors WireOutcome (src/cloud/forward/schema.ts) minus 'in-progress', 'reverted' (neither of
// which the local classifier, gitOutcome.ts, produces any more) and 'unknown' — an
// ambiguous/inconclusive outcome has no dedicated filter: those sessions just don't match any of
// these and only show under 'all' (see outcomeToFilterBucket, state.ts).
export type OutcomeFilter = 'all' | 'merged' | 'committed' | 'abandoned'

export interface VsCodeApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

// Insight type used by Recommendations and Efficiency tabs
export interface Insight {
  severity: 'loop-critical' | 'loop-warning' | 'warning' | 'info'
  category: 'loop' | 'efficiency'
  sessionIdx?: number
  title: string
  detail: string
  action: string
  helpId?: string
  _loopType?: LoopSignalType
}

// Response shape of GET /api/version-check (standalone only — see standalone/versionCheck.ts).
// Hand-duplicated rather than imported: the webview bundle never imports from standalone/.
export interface VersionCheckResponse {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  checkedAt: string | null
  error: string | null
  isService: boolean
  recommendedCommand: string
}

/** 'standalone' — the background/npx service holds the OTLP port (seen from the VS Code
 *  extension's own collector). 'plugin' — the VS Code extension holds it instead (seen from the
 *  background/npx service). 'foreign' — an unrelated, non-TraceRoost process holds it, seen from
 *  either host. `boundPort` is only set when the reporting host fell back to a different port
 *  rather than failing to start (the background service's behavior, via listenWithFallback) —
 *  the port it's actually bound to. */
export type CollectorConflict = {
  owner: 'standalone' | 'plugin' | 'foreign'
  port: number
  boundPort?: number
} | null

declare global {
  interface Window {
    acquireVsCodeApi(): VsCodeApi
    __INITIAL_TOOL_CALLS__?: Record<string, number>
    __INITIAL_SESSION_SUMMARY__?: FullSummary | null
    __INITIAL_SESSION_REV__?: number
    __INITIAL_COLLECTOR_CONFLICT__?: CollectorConflict
    __STANDALONE__?: boolean
    __VERSION__?: string
  }
}
