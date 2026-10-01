import * as assert from 'assert'
import { checkAutomationTriggers } from '../automationEngine'
import type { SessionSummaryCard, TimelineEntry } from '../summarizers/summarizerTypes'

// The trigger thresholds, hard-stop escalation and the prompts each automation produces.
// automationEngine dedups fired triggers process-wide, so every test uses its own session ids.

let seq = 0
function card(source: SessionSummaryCard['source'], overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: `ae-${++seq}`, traceId: 't', source, dataSource: 'otel', workspace: '/w', userRequest: 'do the thing',
    model: 'm', turns: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 0, startTime: new Date().toISOString(), filesRead: [], filesSearched: [],
    filesChanged: [], filesWritten: [], toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'unknown', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

const now = () => new Date().toISOString()
function tool(label: string, toolInput?: string, extra: Partial<TimelineEntry> = {}): TimelineEntry {
  return { type: 'tool', spanId: 's', label, toolInput, durationMs: 1, isError: false, timestamp: now(), ...extra }
}
function llm(extra: Partial<TimelineEntry> = {}): TimelineEntry {
  return { type: 'llm', spanId: 's', label: 'm', durationMs: 1, isError: false, timestamp: now(), ...extra }
}
const run = (s: SessionSummaryCard, timeline: TimelineEntry[]) => checkAutomationTriggers([s], '/w', () => timeline)

suite('automationEngine — triggers and prompts', () => {
  test('loop breaker counts identical calls with JSON inputs compared key-order-insensitively', () => {
    const s = card('claude_code')
    const t = run(s, [tool('Read', '{"a":1,"b":[2]}'), tool('Read', '{"b":[2],"a":1}'), tool('Read', '  {"a":1, "b":[2]} ')])
    const loop = t.find(x => x.automationId === 'loop_break')
    assert.ok(loop)
    assert.strictEqual(loop.label, 'Loop Breaker')
    assert.match(loop.evidence, /repeated 3 times without intervening file changes/)
    assert.match(loop.prompt, /Read \{"a":1,"b":\[2\]\}/)
    assert.ok(!loop.prompt.startsWith('HARD STOP'))
    assert.match(loop.prompt, /ask for clarification/)
  })

  test('a file change between repeats resets the count; non-JSON inputs compare whitespace-collapsed', () => {
    const s = card('claude_code')
    const t = run(s, [
      tool('Bash', 'ls   -la'), tool('Bash', 'ls -la'),
      tool('Edit src/a.ts', undefined, { editDetails: [{ filePath: 'src/a.ts' }] }),
      tool('Bash', 'ls -la'), tool('Bash', 'ls -la'),
    ])
    assert.strictEqual(t.find(x => x.automationId === 'loop_break'), undefined, 'two runs of 2, never 3')
  })

  test('labels without input are keyed by label; write/create_file labels count as file changes', () => {
    const repeats = run(card('claude_code'), [tool('Glob **/*.ts'), tool('Glob **/*.ts'), tool('Glob **/*.ts')])
    assert.match(repeats.find(x => x.automationId === 'loop_break')!.evidence, /"Glob \*\*\/\*\.ts" repeated 3 times/)
    const reset = run(card('claude_code'), [tool('Glob x'), tool('Glob x'), tool('write_file a'), tool('Glob x'), tool('create_file b'), tool('Glob x')])
    assert.strictEqual(reset.find(x => x.automationId === 'loop_break'), undefined)
  })

  test('eight identical repeats escalate to a hard stop; Codex needs four to nudge', () => {
    const hard = run(card('claude_code'), Array.from({ length: 8 }, () => tool('Read', 'x')))
    const loop = hard.find(x => x.automationId === 'loop_break')!
    assert.strictEqual(loop.label, 'Loop Breaker Hard Stop')
    assert.ok(loop.prompt.startsWith('HARD STOP.'))
    assert.match(loop.prompt, /Do not make another tool call until you have written the diagnosis/)

    const codex3 = run(card('codex'), Array.from({ length: 3 }, () => tool('Read', 'x')))
    assert.strictEqual(codex3.find(x => x.automationId === 'loop_break'), undefined)
    const codex4 = run(card('codex'), Array.from({ length: 4 }, () => tool('Read', 'x')))
    assert.ok(codex4.find(x => x.automationId === 'loop_break'))
  })

  test('error cascade lists the most recent errors and escalates at eight in a row', () => {
    const err = (i: number) => tool('Bash', `cmd${i}`, { isError: true, errorMessage: `boom ${i}` })
    const nudge = run(card('copilot'), [err(1), llm(), err(2), err(3), err(4)])
    const e = nudge.find(x => x.automationId === 'error_cascade')!
    assert.strictEqual(e.evidence, '3 consecutive error(s), 4 total error(s)')
    assert.match(e.prompt, /hit 3 consecutive error\(s\):\n {2}- boom 2\n {2}- boom 3\n {2}- boom 4\n/)
    assert.match(e.prompt, /Do not proceed until/)

    const hard = run(card('copilot'), Array.from({ length: 8 }, (_, i) => err(i)))
    const h = hard.find(x => x.automationId === 'error_cascade')!
    assert.strictEqual(h.label, 'Error Cascade Stop Hard Stop')
    assert.ok(h.prompt.startsWith('HARD STOP.'))
  })

  test('errors without a message fall back to the label; the card error count is a floor', () => {
    const t = run(card('claude_code', { errors: 10 }), [
      llm({ isError: true, label: 'llm failed' }), llm({ isError: true, label: '' }), tool('x', undefined, { isError: true }),
    ])
    const e = t.find(x => x.automationId === 'error_cascade')!
    assert.strictEqual(e.evidence, '3 consecutive error(s), 10 total error(s)')
    assert.match(e.prompt, /- llm failed\n {2}- x\n/)
  })

  test('high turns fires at the per-agent nudge and says how many calls were made', () => {
    const t = run(card('claude_code', { totalLlmCalls: 80 }), [])
    const h = t.find(x => x.automationId === 'high_turns')!
    assert.strictEqual(h.evidence, '80 LLM turn(s)')
    assert.match(h.prompt, /This session has made 80 LLM calls/)
    assert.strictEqual(run(card('copilot', { totalLlmCalls: 80 }), []).find(x => x.automationId === 'high_turns'), undefined)
  })

  test('context compaction falls back to average input per call with no LLM timeline', () => {
    const t = run(card('claude_code', { inputTokens: 1_500_000, totalLlmCalls: 10 }), [])
    const c = t.find(x => x.automationId === 'context_compaction')!
    // toLocaleString's grouping separator depends on the runner's locale.
    assert.match(c.evidence, /peak context 150\D?000 tokens/)
    assert.match(c.prompt, /crossing the 140\D?000-token threshold/)
  })

  test('an unknown agent source is held to Copilot defaults, and an empty request gets a placeholder title', () => {
    const s = card('mystery' as SessionSummaryCard['source'], { userRequest: '', totalLlmCalls: 150 })
    const t = run(s, [])
    const h = t.find(x => x.automationId === 'high_turns')!
    assert.strictEqual(h.sessionTitle, '(trace in progress)')
    assert.strictEqual(h.agent, 'mystery')
    assert.match(h.prompt, /- Trace: \(trace in progress\)/)
  })

  test('a trigger fires once per session, stage and threshold', () => {
    const s = card('claude_code', { totalLlmCalls: 90 })
    assert.strictEqual(run(s, []).length, 1)
    assert.deepStrictEqual(run(s, []), [])
  })

  test('only in-progress, recently active sessions are evaluated', () => {
    const finished = card('claude_code', { outcome: 'text_response', totalLlmCalls: 500 })
    const stale = card('claude_code', { totalLlmCalls: 500, startTime: new Date(Date.now() - 10 * 60_000).toISOString() })
    const undated = card('claude_code', { totalLlmCalls: 500, startTime: '' })
    const garbled = card('claude_code', { totalLlmCalls: 500, startTime: 'yesterday-ish' })
    assert.deepStrictEqual(checkAutomationTriggers([finished, stale, undated, garbled], '/w', () => []), [])
    // The last timeline entry, not the start time, decides recency.
    const longRunning = card('claude_code', { totalLlmCalls: 500, startTime: new Date(Date.now() - 60 * 60_000).toISOString() })
    assert.strictEqual(checkAutomationTriggers([longRunning], '/w', () => [llm()]).length, 1)
  })
})
