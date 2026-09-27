/**
 * Synthetic session fixtures for the UX suite — no live agent traffic, no standalone server, no
 * log readers or account access. Shape matches what the extension's webview receives over
 * postMessage (media/src/types.ts's SessionSummary), not a real trace.
 */
export const sessions = Array.from({ length: 64 }, (_, i) => ({
  sessionId: `ux-${i}`,
  traceId: `trace-${i}`,
  source: ['copilot', 'claude_code', 'codex', 'opencode'][i % 4],
  dataSource: i % 2 ? 'log' : 'otel',
  initiator: ['user', 'agent', 'api'][i % 3],
  workspace: `/fixtures/${i % 2 ? 'cloud' : 'core'}`,
  userRequest: `Task ${String(i).padStart(2, '0')} ${
    i % 2 ? 'Implement a much longer request with enough text to exercise truncation' : 'Fix bug'
  }`,
  model: i % 2 ? 'gpt-5' : 'claude-sonnet-4',
  turns: i + 1,
  inputTokens: (i + 1) * 700,
  outputTokens: (i + 1) * 125,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  cacheHitRate: 0,
  durationMs: (i + 1) * 1234,
  startTime: new Date(Date.now() - i * 3600000).toISOString(),
  filesRead: [],
  filesSearched: [],
  filesChanged: [],
  filesWritten: [],
  toolCounts: {},
  totalToolCalls: 0,
  totalLlmCalls: 1,
  errors: 0,
  outcome: 'text_response',
  timeline: [],
  backgroundSpans: [],
  loopSignals: [],
}))
