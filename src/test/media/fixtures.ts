import type { EfficiencyReport, FullSummary, SessionSummaryCard } from '../../../media/src/types'

const EMPTY_EFFICIENCY: EfficiencyReport = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalLlmCalls: 0,
  avgInputPerCall: 0,
  avgTtft: 0,
  cacheHitRate: 0,
  toolDefWaste: 0,
  sysInstructionWaste: 0,
  topTokenConsumers: [],
}

export function makeCard(overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-1',
    traceId: 'trace-1',
    source: 'claude_code',
    dataSource: 'otel',
    initiator: 'user',
    workspace: '/repo/a',
    userRequest: 'fix the bug',
    model: 'claude-3',
    turns: 2,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    cacheHitRate: 0,
    durationMs: 1000,
    startTime: '2024-06-01T12:00:00.000Z',
    filesRead: [],
    filesSearched: [],
    filesChanged: [],
    filesWritten: [],
    toolCounts: {},
    totalToolCalls: 0,
    totalLlmCalls: 1,
    errors: 0,
    outcome: 'tool_calls',
    timeline: [],
    backgroundSpans: [],
    loopSignals: [],
    ...overrides,
  }
}

export function makeSummary(sessions: SessionSummaryCard[]): FullSummary {
  return { sessions, backgroundSpans: [], efficiency: EMPTY_EFFICIENCY }
}
