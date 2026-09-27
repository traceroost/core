import * as assert from 'assert'
import { checkAutomationTriggers, workspaceMatches } from '../automationEngine'
import type { SessionSummaryCard, TimelineEntry } from '../summarizers/summarizerTypes'

function card(sessionId: string, source: SessionSummaryCard['source'], workspace: string): SessionSummaryCard {
  return {
    sessionId, traceId: 't', source, dataSource: 'otel', workspace, userRequest: 'x', model: 'm', turns: 1,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 0,
    startTime: new Date().toISOString(), filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0, outcome: 'unknown', timeline: [],
    backgroundSpans: [], loopSignals: [],
  }
}

function llm(inputTokens: number): TimelineEntry {
  return { type: 'llm', spanId: 's', label: 'm', inputTokens, durationMs: 1, isError: false, timestamp: new Date().toISOString() }
}

suite('automationEngine', () => {
  test('workspace match is on a path boundary, and an empty workspace matches nothing', () => {
    assert.ok(workspaceMatches('/repo', '/repo'))
    assert.ok(workspaceMatches('/repo/pkg', '/repo'))
    assert.ok(workspaceMatches('/repo/', '/repo'))
    assert.ok(!workspaceMatches('/repo-other', '/repo'))
    assert.ok(!workspaceMatches('/repo', ''))
    assert.ok(!workspaceMatches('', '/repo'))
    assert.ok(workspaceMatches('C:\\work\\repo\\a', 'C:\\work\\repo'))
  })

  test('context compaction uses the per-agent threshold (Copilot fires below the old flat 140K)', () => {
    const copilot = card('cp-compaction', 'copilot', '/w')
    const claude = card('cc-compaction', 'claude_code', '/w')
    const triggers = checkAutomationTriggers([copilot, claude], '/w', () => [llm(100_000)])
    const compaction = triggers.filter(t => t.automationId === 'context_compaction').map(t => t.sessionId)
    assert.deepStrictEqual(compaction, ['cp-compaction'])
  })

  test('sessions from a sibling directory are not evaluated', () => {
    const other = card('other-ws', 'copilot', '/w-other')
    assert.deepStrictEqual(checkAutomationTriggers([other], '/w', () => [llm(500_000)]), [])
  })
})
