import * as assert from 'assert'
import './domShim'
import { makeCard } from './fixtures'
import {
  formatToolLabel, formatLlmLabel, formatToolResult, formatMs, timestampToMs, nanoToMs, sessionDateKey,
  formatSessionTime, getInputTokens, getOutputTokens, getCodexSessionId, extractUserRequest,
  extractLlmResponseText, isLlmSpanName, isToolSpanName, getAgentSourceLabel, getAgentColor,
  getConversationColor, buildDisplaySummary,
} from '../../../media/src/utils'
import {
  fmtUsd, oneShotRate, avgEditsPerFile, buildDailyCostMap, getDailyCostUsd, sessionDisplayName,
  getPeakContextUsage, getIdenticalToolRepeat, getErrorHealth, getActiveComputeMs, calcSessionCost,
} from '../../../media/src/sessionMetrics'
import { buildTrendBins } from '../../../media/src/tabs/outcomeTrend'
import type { Span, TimelineEntry } from '../../../media/src/types'

// Webview data formatting: the labels, numbers and per-day/per-session metrics the dashboard
// renders. Pure functions, so the edge cases (empty/garbage input, truncation, precedence) are
// pinned here rather than through the Playwright suite.

function span(attrs: Record<string, string | number>, name = 'chat x'): Span {
  return {
    traceId: 't', spanId: 's', name, startTime: '0', endTime: '0',
    attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: v } : { stringValue: v } })),
  }
}
function tl(o: Partial<TimelineEntry> & { type: TimelineEntry['type'] }): TimelineEntry {
  return { spanId: 'x', label: '', durationMs: 0, isError: false, timestamp: '', ...o } as TimelineEntry
}

suite('media/utils — label formatting', () => {
  test('formatToolLabel derives a label from Claude-style JSON toolInput', () => {
    assert.strictEqual(formatToolLabel({ label: 'Edit', toolInput: '{"file_path":"/r/src/app.ts"}' }), 'Edit app.ts')
    assert.strictEqual(formatToolLabel({ label: 'MultiEdit', toolInput: '{"file_path":"/r/a.ts","edits":[{},{},{}]}' }), 'MultiEdit a.ts +2')
    assert.strictEqual(formatToolLabel({ label: 'MultiEdit', toolInput: '{"file_path":"/r/a.ts","edits":[{}]}' }), 'MultiEdit a.ts')
    assert.strictEqual(formatToolLabel({ label: 'Bash', toolInput: '{"command":"npm test"}' }), 'Bash npm test')
    const long = 'echo ' + 'x'.repeat(80)
    assert.strictEqual(formatToolLabel({ label: 'Bash', toolInput: JSON.stringify({ command: long }) }), 'Bash ' + long.slice(0, 57) + '…')
    assert.strictEqual(formatToolLabel({ label: 'Grep', toolInput: '{"pattern":"TODO"}' }), 'Grep TODO')
    assert.strictEqual(formatToolLabel({ label: 'WebSearch', toolInput: '{"query":"sql.js wal"}' }), 'WebSearch sql.js wal')
    // Broken JSON or JSON with nothing useful falls through to the plain tool name.
    assert.strictEqual(formatToolLabel({ label: 'Edit', toolInput: '{oops' }), 'Edit')
    assert.strictEqual(formatToolLabel({ label: 'Task', toolInput: '{"description":"x"}' }), 'Task')
  })

  test('formatToolLabel treats a raw toolInput string as a path or a shell command', () => {
    assert.strictEqual(formatToolLabel({ label: 'Read', toolInput: '/r/src/main.ts' }), 'Read main.ts')
    assert.strictEqual(formatToolLabel({ label: 'Read', toolInput: '~/notes.md' }), 'Read notes.md')
    assert.strictEqual(formatToolLabel({ label: 'Bash', toolInput: 'git status' }), 'Bash git status')
  })

  test('formatToolLabel takes the basename of Windows paths too', () => {
    assert.strictEqual(formatToolLabel({ label: 'Edit', toolInput: '{"file_path":"C:\\\\r\\\\src\\\\app.ts"}' }), 'Edit app.ts')
    assert.strictEqual(formatToolLabel({ label: 'Read', toolInput: 'C:\\r\\src\\main.ts' }), 'Read main.ts')
    assert.strictEqual(formatToolLabel({ label: 'file_search **\\src\\README.md' }), 'Find README.md')
    assert.strictEqual(formatToolLabel({ label: 'grep_search "needle" in src\\a.ts' }), 'Grep "needle" in a.ts')
  })

  test('formatToolLabel rewrites Copilot tool labels', () => {
    const cases: Array<[string, string]> = [
      ['read_file src/a.ts L10-20', 'Read src/a.ts :10-20'],
      ['read_file src/a.ts', 'Read src/a.ts'],
      ['file_search **/src/*.ts', 'Find files matching *.ts'],
      ['file_search **/README.md', 'Find README.md'],
      ['grep_search "needle" in **/src/a.ts', 'Grep "needle" in a.ts'],
      ['grep_search needle', 'Grep needle'],
      ['list_dir src', 'List src/'],
      ['manage_todo_list 3 items (2 done)', 'Update todos (2 done)'],
      ['manage_todo_list 4 items', 'Update todos (4 items)'],
      ['manage_todo_list', 'Check todos'],
      ['semantic_search auth flow', 'Search codebase auth flow'],
      ['replace_string_in_file a.ts', 'Edit a.ts'],
      ['create_file b.ts', 'Create b.ts'],
      ['runSubagent explore', 'Sub-agent: explore'],
      ['some_tool arg', 'some_tool arg'],
      ['bare_tool', 'bare_tool'],
    ]
    for (const [label, want] of cases) assert.strictEqual(formatToolLabel({ label }), want, label)
    const cmd = 'x'.repeat(70)
    assert.strictEqual(formatToolLabel({ label: 'run_in_terminal ' + cmd }), 'Run: ' + cmd.slice(0, 57) + '…')
    assert.strictEqual(formatToolLabel({}), '')
  })

  test('formatLlmLabel groups repeated tool calls and names plain responses', () => {
    assert.strictEqual(formatLlmLabel({ action: 'called read_file, read_file, grep_search' }), 'Decide → 2× read_file, grep_search')
    assert.strictEqual(formatLlmLabel({ action: 'text response' }), 'Respond with answer')
    assert.strictEqual(formatLlmLabel({ action: 'max_tokens' }), 'max_tokens')
    assert.strictEqual(formatLlmLabel({}), 'LLM call')
  })

  test('formatToolResult collapses boilerplate results', () => {
    assert.strictEqual(formatToolResult({}), '')
    assert.strictEqual(formatToolResult({ resultSummary: 'empty' }), '')
    assert.strictEqual(formatToolResult({ resultSummary: 'Successfully edited a.ts' }), 'ok')
    assert.strictEqual(formatToolResult({ resultSummary: 'No todo list found.' }), 'none')
    assert.strictEqual(formatToolResult({ resultSummary: 'no list' }), 'none')
    assert.strictEqual(formatToolResult({ resultSummary: '3 matches' }), '3 matches')
  })

  test('agent labels and colours fall back for unknown sources; conversation colours are stable', () => {
    assert.strictEqual(getAgentSourceLabel('cursor'), 'Cursor')
    assert.strictEqual(getAgentSourceLabel(undefined), 'Copilot')
    assert.strictEqual(getAgentColor('nope'), '#90a4ae')
    assert.strictEqual(getConversationColor('conv-1'), getConversationColor('conv-1'))
  })
})

suite('media/utils — numbers and time', () => {
  test('formatMs picks a unit at each boundary', () => {
    assert.deepStrictEqual([0.5, 999, 1000, 59_999, 60_000, 3_599_999, 3_600_000].map(formatMs),
      ['<1ms', '999ms', '1.0s', '60.0s', '1.0min', '60.0min', '1.0h'])
  })

  test('timestampToMs accepts epoch ms numbers, nanosecond strings and ISO strings; garbage is 0', () => {
    assert.strictEqual(timestampToMs(1234), 1234)
    assert.strictEqual(timestampToMs('1700000000123456789'), 1700000000123)
    assert.strictEqual(timestampToMs('2026-01-01T00:00:00.000Z'), Date.UTC(2026, 0, 1))
    assert.strictEqual(timestampToMs(''), 0)
    assert.strictEqual(timestampToMs(undefined), 0)
    assert.strictEqual(timestampToMs('not a date'), 0)
    assert.strictEqual(nanoToMs('garbage'), 0)
    assert.strictEqual(nanoToMs(undefined), 0)
  })

  test('date keys and session times degrade to placeholders on bad input', () => {
    assert.strictEqual(sessionDateKey({ startTime: '2026-03-04T23:59:59.000Z' }), '2026-03-04')
    assert.strictEqual(sessionDateKey({ startTime: 'nope' }), '')
    assert.strictEqual(sessionDateKey({}), '')
    assert.strictEqual(formatSessionTime({ startTime: 'nope' }), '—')
    assert.match(formatSessionTime({ startTime: '2026-03-04T12:00:00.000Z' }), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  test('buildDisplaySummary aggregates efficiency over the given sessions', () => {
    const s = buildDisplaySummary([
      makeCard({ inputTokens: 1000, outputTokens: 10, totalLlmCalls: 2, cacheReadTokens: 500 }),
      makeCard({ inputTokens: 3000, outputTokens: 30, totalLlmCalls: 2, cacheReadTokens: 0 }),
    ])
    assert.strictEqual(s.efficiency.totalInputTokens, 4000)
    assert.strictEqual(s.efficiency.avgInputPerCall, 1000)
    assert.strictEqual(s.efficiency.cacheHitRate, 0.125)
    assert.strictEqual(buildDisplaySummary([]).efficiency.avgInputPerCall, 0)
  })
})

suite('media/utils — span helpers', () => {
  test('input tokens: gen_ai.* (incl. cache) takes precedence over legacy keys, which are summed', () => {
    assert.strictEqual(getInputTokens(span({
      'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.cache_read.input_tokens': 50, 'input_tokens': 9999,
    })), 150)
    assert.strictEqual(getInputTokens(span({ input_tokens: 10, cache_read_tokens: '5', 'codex.turn.token_usage.cached_input_tokens': 2 })), 17)
    assert.strictEqual(getInputTokens(span({ input_tokens: 'abc' })), 0)
  })

  test('output tokens take the first present key and never add reasoning on top', () => {
    assert.strictEqual(getOutputTokens(span({ 'gen_ai.usage.output_tokens': 7, output_tokens: 99 })), 7)
    assert.strictEqual(getOutputTokens(span({ output_token_count: 40, reasoning_token_count: 30 })), 40)
    assert.strictEqual(getOutputTokens(span({})), 0)
  })

  test('getCodexSessionId: explicit id, else conversation+turn, else empty', () => {
    assert.strictEqual(getCodexSessionId(span({ 'codex.session.id': 'abc', 'thread.id': 't' })), 'abc')
    assert.strictEqual(getCodexSessionId(span({ conversation_id: 'c1', turn_id: 'u2' })), 'codex:c1:u2')
    assert.strictEqual(getCodexSessionId(span({ conversation_id: 'c1' })), '')
  })

  test('extractUserRequest unwraps <userRequest>, Codex "## My request", and strips <ide_*> blocks', () => {
    assert.strictEqual(extractUserRequest('<ctx/>\n<userRequest>\n  Fix it \n</userRequest>'), 'Fix it')
    assert.strictEqual(extractUserRequest('# AGENTS.md\n...\n## My request for Codex:\nAdd a test\nplease'), 'Add a test\nplease')
    assert.strictEqual(extractUserRequest('<ide_selection>foo</ide_selection> do the thing'), 'do the thing')
    assert.strictEqual(extractUserRequest('<ide_opened_file>x</ide_opened_file>'), '<ide_opened_file>x</ide_opened_file>')
    assert.strictEqual(extractUserRequest(''), '')
  })

  test('extractLlmResponseText returns the first non-empty assistant text block', () => {
    const msgs = JSON.stringify([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', name: 't' }, { type: 'text', text: '  ' }, { type: 'text', text: 'answer' }] },
    ])
    assert.strictEqual(extractLlmResponseText(span({ 'gen_ai.output.messages': msgs })), 'answer')
    assert.strictEqual(extractLlmResponseText(span({ 'gen_ai.output.messages': '{bad' })), null)
    assert.strictEqual(extractLlmResponseText(span({})), null)
  })

  test('span-name classification', () => {
    assert.ok(isLlmSpanName('chat gpt-4.1') && isLlmSpanName('codex.sse_event') && !isLlmSpanName('claude_code.tool'))
    assert.ok(isToolSpanName('execute_tool read_file') && isToolSpanName('codex.tool.result') && !isToolSpanName('chat x'))
  })
})

suite('media/sessionMetrics', () => {
  test('fmtUsd, oneShotRate and avgEditsPerFile edge cases', () => {
    assert.deepStrictEqual([0, 0.004, 0.01, 12.345].map(fmtUsd), ['$0.00', '<$0.01', '$0.01', '$12.35'])
    assert.strictEqual(oneShotRate({ filesConsidered: 1, oneShotFiles: 1 }), null, 'below the minimum sample')
    assert.strictEqual(oneShotRate({ filesConsidered: 4, oneShotFiles: 3 }), 0.75)
    assert.strictEqual(avgEditsPerFile({ filesConsidered: 0, totalEdits: 3 }), null)
    assert.strictEqual(avgEditsPerFile({ filesConsidered: 2, totalEdits: 3 }), 1.5)
  })

  test('buildDailyCostMap groups by UTC day and agent; getDailyCostUsd reads one day', () => {
    const a = makeCard({ sessionId: 'a', source: 'claude_code', model: 'claude-sonnet-4-6', startTime: '2026-05-01T23:30:00.000Z', inputTokens: 1_000_000, outputTokens: 0 })
    const b = makeCard({ sessionId: 'b', source: 'codex', model: 'gpt-5', startTime: '2026-05-01T01:00:00.000Z', inputTokens: 10, outputTokens: 10 })
    const c = makeCard({ sessionId: 'c', source: 'claude_code', model: 'claude-sonnet-4-6', startTime: '2026-05-02T00:30:00.000Z', inputTokens: 1_000_000, outputTokens: 0 })
    const map = buildDailyCostMap([a, b, c])
    assert.deepStrictEqual([...map.keys()].sort(), ['2026-05-01', '2026-05-02'])
    const may1 = map.get('2026-05-01')!
    assert.strictEqual(may1.input, 1_000_010)
    assert.deepStrictEqual([...may1.agents.keys()].sort(), ['claude_code', 'codex'])
    assert.deepStrictEqual([...may1.agents.get('codex')!.models], ['gpt-5'])
    const costA = calcSessionCost(a).totalUsd
    assert.ok(costA > 0)
    assert.strictEqual(getDailyCostUsd([a, b, c], '2026-05-02'), costA, 'same tokens, same model → same cost')
    assert.strictEqual(getDailyCostUsd([a], '1999-01-01'), 0)
    assert.strictEqual(buildDailyCostMap([makeCard({ startTime: '' })]).has('unknown'), true)
    // A non-empty but unparseable startTime buckets as 'unknown' too, instead of throwing (which
    // used to wipe out the whole map, and every chart and alert built on it).
    const bad = buildDailyCostMap([a, makeCard({ sessionId: 'bad', startTime: 'not a date' })])
    assert.deepStrictEqual([...bad.keys()].sort(), ['2026-05-01', 'unknown'])
  })

  test('buildTrendBins leaves undatable sessions out instead of losing every bin', () => {
    const ok = makeCard({ sessionId: 'ok', startTime: '2026-05-01T10:00:00.000Z' })
    const bad = makeCard({ sessionId: 'bad', startTime: 'garbage' })
    const outcome = { overall: 'committed' as const, files: {}, reason: '' }
    const { bins } = buildTrendBins([ok, bad], { ok: outcome, bad: outcome })
    assert.deepStrictEqual(bins.map(b => [b.start, b.total.sessions]), [['2026-05-01', 1]])
  })

  test('calcSessionCost flags unknown models and accumulates per-turn cost', () => {
    const s = makeCard({ model: 'claude-sonnet-4-6', timeline: [
      tl({ type: 'llm', model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 100 }),
      tl({ type: 'tool', label: 'Read' }),
      tl({ type: 'llm', model: 'mystery-model-9', inputTokens: 1000, outputTokens: 100 }),
    ] })
    const cost = calcSessionCost(s)
    assert.strictEqual(cost.modelUnknown, true)
    assert.strictEqual(cost.byTurn.length, 2)
    assert.ok(cost.byTurn[1] >= cost.byTurn[0])
    assert.strictEqual(calcSessionCost(makeCard({ model: 'claude-sonnet-4-6', timeline: [] })).modelUnknown, false)
  })

  test('sessionDisplayName truncates at 70 chars and labels empty/in-progress prompts', () => {
    assert.strictEqual(sessionDisplayName(makeCard({ userRequest: '   ' })), '[trace in progress]')
    assert.strictEqual(sessionDisplayName(makeCard({ userRequest: 'y'.repeat(71) })), 'y'.repeat(70) + '...')
  })

  test('getPeakContextUsage uses the largest LLM input, else the per-call average', () => {
    const withTl = getPeakContextUsage(makeCard({ source: 'claude_code', timeline: [
      tl({ type: 'llm', inputTokens: 5_000 }), tl({ type: 'llm', inputTokens: 20_000 }), tl({ type: 'tool', inputTokens: 999_999 }),
    ] }))
    assert.strictEqual(withTl.peakTokens, 20_000)
    assert.ok(withTl.contextWindowTokens > 0)
    assert.strictEqual(withTl.percent, 20_000 / withTl.contextWindowTokens * 100)
    assert.strictEqual(getPeakContextUsage(makeCard({ inputTokens: 900, totalLlmCalls: 3, timeline: [] })).peakTokens, 300)
    assert.strictEqual(getPeakContextUsage(makeCard({ totalLlmCalls: 0, timeline: [] })).peakTokens, 0)
  })

  test('getIdenticalToolRepeat normalises JSON key order and resets after a file change', () => {
    const read = (input: string) => tl({ type: 'tool', label: 'Read', toolInput: input })
    const s = makeCard({ timeline: [
      read('{"file_path":"/a","limit":5}'),
      read('{"limit":5,"file_path":"/a"}'),
      read('{"limit": 5, "file_path": "/a"}'),
    ] })
    const rep = getIdenticalToolRepeat(s)!
    assert.strictEqual(rep.count, 3)
    assert.strictEqual(rep.tool, 'Read')

    const broken = makeCard({ timeline: [
      read('{"file_path":"/a"}'),
      tl({ type: 'tool', label: 'Bash', toolInput: 'sed -i s/a/b/ x.ts' }),  // a file-changing shell command
      read('{"file_path":"/a"}'),
    ] })
    assert.strictEqual(getIdenticalToolRepeat(broken), null, 're-reading after an edit is not a repeat')
    assert.strictEqual(getIdenticalToolRepeat(makeCard({ timeline: [] })), null)
  })

  test('getErrorHealth tracks consecutive and trailing failures and keeps the last 3 messages', () => {
    const e = (msg: string) => tl({ type: 'tool', label: 'Bash', isError: true, errorMessage: msg })
    const ok = tl({ type: 'llm', label: 'LLM' })
    const h = getErrorHealth(makeCard({ errors: 0, timeline: [e('1'), e('2'), ok, e('3'), e('4'), tl({ type: 'user_input', isError: true })] }))
    assert.deepStrictEqual(
      { errorCount: h.errorCount, steps: h.measuredSteps, max: h.maxConsecutive, trailing: h.trailingConsecutive, recent: h.recentErrors },
      { errorCount: 4, steps: 5, max: 2, trailing: 2, recent: ['2', '3', '4'] },
    )
    const fallback = getErrorHealth(makeCard({ errors: 2, totalLlmCalls: 3, totalToolCalls: 1, timeline: [] }))
    assert.strictEqual(fallback.failureRate, 0.5)
  })

  test('getActiveComputeMs sums LLM/tool durations, ignoring negatives and other entry types', () => {
    assert.strictEqual(getActiveComputeMs(makeCard({ timeline: [
      tl({ type: 'llm', durationMs: 100 }), tl({ type: 'tool', durationMs: -50 }), tl({ type: 'user_input', durationMs: 9_999 }), tl({ type: 'tool', durationMs: 25 }),
    ] })), 125)
  })
})
