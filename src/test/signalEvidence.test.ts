import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  detectExactToolRepeat,
  detectEditRevertCycle,
  detectErrorRecurrence,
  detectRunawaySteps,
  detectTokenRunaway,
  detectChronicToolFailures,
  detectContextFloodingRisk,
  detectToolCallCycle,
  detectFileReread,
  detectCacheMiss,
  detectTtlExpiry,
  detectLowCacheHitRatio,
  detectBudgetOverrun,
  detectModelTierMismatch,
} from '../loopDetector'
import { detectFailedCheckSubmission, detectHallucinatedImports } from '../sessionRiskSignals'
import { MAX_SIGNAL_STEPS, MAX_STEP_DETAIL_CHARS, editExcerpt, firstLine, oneLine, plural, signalStep, withSteps } from '../signalEvidence'
import { SessionSummaryCard, TimelineEntry } from '../spanSummarizer'
import { LoopSignal } from '../types'

// Every detector names the timeline entries that made it fire (LoopSignal.steps), so the trace view
// can list them and highlight them in the waterfall. These pin *which* entries each one names.

let spanSeq = 0
const nextSpan = () => 'span-' + (++spanSeq)

function makeSession(overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-1', traceId: 'trace-1', source: 'claude_code', dataSource: 'otel', workspace: '',
    userRequest: 'fix the bug', model: 'claude-3-5-sonnet', turns: 3, inputTokens: 5000, outputTokens: 800,
    cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 12000, startTime: new Date().toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [], toolCounts: {},
    totalToolCalls: 5, totalLlmCalls: 3, errors: 0, outcome: 'unknown',
    timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

function tool(label: string, extra: Partial<TimelineEntry> = {}): TimelineEntry {
  return { type: 'tool', spanId: nextSpan(), label, durationMs: 100, isError: false, timestamp: new Date().toISOString(), ...extra }
}

function llm(inputTokens: number, outputTokens: number, extra: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    type: 'llm', spanId: nextSpan(), label: 'claude-3-5-sonnet', model: 'claude-3-5-sonnet',
    inputTokens, outputTokens, durationMs: 1000, isError: false, timestamp: new Date().toISOString(), ...extra,
  }
}

function edit(filePath: string, oldString: string, newString: string, type: 'tool' | 'llm' = 'tool'): TimelineEntry {
  return {
    type, spanId: nextSpan(), label: `edit_file ${filePath}`, durationMs: 50, isError: false,
    timestamp: new Date().toISOString(), editDetails: [{ filePath, oldString, newString }],
  }
}

function run(detect: (s: SessionSummaryCard, out: LoopSignal[]) => void, session: SessionSummaryCard): LoopSignal {
  const out: LoopSignal[] = []
  detect(session, out)
  assert.strictEqual(out.length, 1, 'expected the detector to fire')
  return out[0]
}

const indices = (sig: LoopSignal) => (sig.steps ?? []).map(s => s.index)

suite('signalEvidence helpers', () => {
  test('signalStep carries the entry\'s spanId and a truncated label', () => {
    const timeline = [tool('x'.repeat(200))]
    const step = signalStep(timeline, 0, 'why')
    assert.strictEqual(step.spanId, timeline[0].spanId)
    assert.strictEqual(step.label.length, 80)
    assert.ok(step.label.endsWith('…'))
    assert.strictEqual(step.role, 'trigger')
  })

  test('withSteps sorts by index, keeps the first note per index, and caps with a total', () => {
    const timeline = Array.from({ length: 150 }, (_, i) => tool('t' + i))
    const steps = [signalStep(timeline, 5, 'first'), signalStep(timeline, 2, 'two'), signalStep(timeline, 5, 'dupe')]
    const out = withSteps(steps, 'why')
    assert.deepStrictEqual(out.steps!.map(s => [s.index, s.note]), [[2, 'two'], [5, 'first']])
    assert.strictEqual(out.stepsTotal, undefined)

    const many = withSteps(timeline.map((_, i) => signalStep(timeline, i, 'n')), 'why')
    assert.strictEqual(many.steps!.length, MAX_SIGNAL_STEPS)
    assert.strictEqual(many.stepsTotal, 150)
  })

  test('signalStep flattens a detail onto one line and caps it', () => {
    const timeline = [tool('x')]
    const step = signalStep(timeline, 0, 'why', 'trigger', 'line one\n  line two ' + 'y'.repeat(300))
    assert.ok(step.detail!.startsWith('line one line two '))
    assert.strictEqual(step.detail!.length, MAX_STEP_DETAIL_CHARS)
    assert.strictEqual(signalStep(timeline, 0, 'why', 'trigger', '   ').detail, undefined)
  })

  test('oneLine, editExcerpt and firstLine', () => {
    assert.strictEqual(oneLine('a\n\n b   c', 10), 'a b c')
    assert.strictEqual(oneLine('abcdefghij', 5), 'abcd…')
    assert.strictEqual(editExcerpt('ttl = 60', 'ttl = 3600'), '"ttl = 60" → "ttl = 3600"')
    assert.strictEqual(firstLine('\n  PASS a\n  FAIL b\n', /FAIL/), 'FAIL b')
    assert.strictEqual(firstLine('\n  PASS a\n  ok b\n', /FAIL/), 'PASS a')
  })

  test('plural picks the noun by count and formats the number', () => {
    assert.strictEqual(plural(1, 'call'), '1 call')
    assert.strictEqual(plural(0, 'call'), '0 calls')
    assert.strictEqual(plural(4, 'model call'), '4 model calls')
    assert.strictEqual(plural(1234, 'token'), '1,234 tokens')
    assert.strictEqual(plural(1, 'miss', 'misses'), '1 miss')
    assert.strictEqual(plural(3, 'miss', 'misses'), '3 misses')
  })

  test('withSteps with no steps leaves steps off but keeps the trigger', () => {
    assert.deepStrictEqual(withSteps([], 'why'), { trigger: 'why' })
  })
})

suite('signal evidence: per detector', () => {
  test('exact_tool_repeat names the longest streak, not the one an edit broke', () => {
    const timeline = [
      ...Array.from({ length: 5 }, () => tool('read_file a.ts')),
      edit('b.ts', 'x', 'y'),
      ...Array.from({ length: 31 }, () => tool('read_file a.ts')),
    ]
    const sig = run(detectExactToolRepeat, makeSession({ timeline }))
    assert.deepStrictEqual(indices(sig), Array.from({ length: 31 }, (_, k) => 6 + k))
    assert.strictEqual(sig.steps![30].note, 'identical call 31 of 31')
    assert.match(sig.trigger!, /ran 31 times with no file edit in between.*Flagged at 30 repeats; critical at 50\./)
  })

  test('edit_revert_cycle names the undone edit as context and the revert as the trigger', () => {
    const timeline = [edit('src/a.ts', 'A', 'B'), llm(100, 10), edit('src/a.ts', 'B', 'A')]
    const sig = run(detectEditRevertCycle, makeSession({ timeline }))
    assert.deepStrictEqual(sig.steps!.map(s => [s.index, s.role]), [[0, 'context'], [2, 'trigger']])
    assert.match(sig.steps![1].note, /undoes the earlier edit to a\.ts \(its last edit in this trace\)/)
    assert.strictEqual(sig.steps![0].detail, '"A" → "B"')
    assert.strictEqual(sig.steps![1].detail, '"B" → "A"')
  })

  test('edit_revert_cycle points at the LLM entries when edits came from them', () => {
    const timeline = [llm(100, 10), edit('a.ts', 'A', 'B', 'llm'), tool('bash ls'), edit('a.ts', 'B', 'A', 'llm')]
    const sig = run(detectEditRevertCycle, makeSession({ timeline }))
    assert.deepStrictEqual(indices(sig), [1, 3])
  })

  test('error_recurrence names every occurrence of the recurring error', () => {
    const err = (msg: string) => tool('bash npm test', { isError: true, errorMessage: msg })
    const timeline = [err('Cannot find module x'), llm(1, 1), err('Cannot find module x'), err('other'), err('Cannot find module x')]
    const sig = run(detectErrorRecurrence, makeSession({ timeline }))
    assert.deepStrictEqual(indices(sig), [0, 2, 4])
    assert.strictEqual(sig.steps![2].note, 'occurrence 3 of 3')
    assert.strictEqual(sig.steps![2].detail, 'Cannot find module x')
    assert.match(sig.trigger!, /The same error appeared 3 times: "Cannot find module x"\./)
  })

  test('runaway_steps marks the step that crossed the budget and covers the rest as a range', () => {
    const timeline = Array.from({ length: 50 }, (_, i) => tool('bash step' + i))
    const sig = run(detectRunawaySteps, makeSession({ userRequest: 'fix typo', timeline, totalToolCalls: 50, totalLlmCalls: 0 }))
    // simple → 45-step budget: the 46th step (index 45) crosses it.
    assert.strictEqual(sig.steps![0].index, 45)
    assert.match(sig.steps![0].note, /first step past the 45-step budget/)
    assert.deepStrictEqual(sig.range, { from: 45, to: 49, note: 'past the 45-step budget' })
    assert.strictEqual(sig.steps![sig.steps!.length - 1].role, 'context')
  })

  test('runaway_steps marks nothing when the timeline is shorter than the counters say', () => {
    const sig = run(detectRunawaySteps, makeSession({ userRequest: 'fix typo', timeline: [tool('a')], totalToolCalls: 60, totalLlmCalls: 0 }))
    assert.strictEqual(sig.steps, undefined)
    assert.strictEqual(sig.range, undefined)
    assert.ok(sig.trigger)
  })

  test('token_runaway names the baseline, the last call, and the biggest jumps', () => {
    const timeline = [llm(1000, 500), tool('read_file a'), llm(4000, 400), llm(16000, 300), llm(20000, 100)]
    const sig = run(detectTokenRunaway, makeSession({ timeline }))
    assert.deepStrictEqual(sig.steps!.map(s => [s.index, s.role]), [[0, 'context'], [2, 'trigger'], [3, 'trigger'], [4, 'trigger']])
    assert.match(sig.steps!.find(s => s.index === 3)!.note, /context grew 12,000 tokens/)
  })

  test('chronic_tool_failures names each failed call with its message', () => {
    const timeline = [tool('a'), tool('b', { isError: true, errorMessage: 'ENOENT: no such file\nstack…' }), tool('c'), tool('d', { isError: true }), tool('e')]
    const sig = run(detectChronicToolFailures, makeSession({ timeline }))
    assert.deepStrictEqual(indices(sig), [1, 3])
    assert.strictEqual(sig.steps![0].note, 'failed')
    assert.strictEqual(sig.steps![0].detail, 'ENOENT: no such file')
    assert.match(sig.steps![1].note, /no error message recorded/)
    assert.strictEqual(sig.steps![1].detail, undefined)
  })

  test('context_flooding_risk names the oversized results', () => {
    const timeline = [tool('read small', { fullResult: 'x' }), tool('read big', { fullResult: 'y'.repeat(12_000) })]
    const sig = run(detectContextFloodingRisk, makeSession({ timeline }))
    assert.deepStrictEqual(indices(sig), [1])
    assert.match(sig.steps![0].note, /12,000 characters/)
  })

  test('tool_call_cycle names every call of the repeating tail, by pass', () => {
    const timeline = [tool('warmup'), ...Array.from({ length: 5 }, () => [tool('npm test'), tool('cat log')]).flat()]
    const sig = run(detectToolCallCycle, makeSession({ timeline }))
    assert.deepStrictEqual(indices(sig), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.strictEqual(sig.steps![9].note, 'round 5 of 5, step 2 of 2')
    assert.match(sig.trigger!, /npm test → cat log/)
  })

  test('file_reread names the reads in the write-free run, first one as context', () => {
    const timeline = [
      tool('read_file a.ts'), edit('a.ts', 'x', 'y'),
      tool('read_file a.ts'), llm(1, 1), tool('read_file a.ts L10-20'), tool('read_file a.ts'),
    ]
    const sig = run(detectFileReread, makeSession({ timeline }))
    assert.deepStrictEqual(sig.steps!.map(s => [s.index, s.role]), [[2, 'context'], [4, 'trigger'], [5, 'trigger']])
  })

  test('cache_miss names the miss, never a model\'s cold first call', () => {
    const ts = new Date().toISOString()
    const timeline = [
      llm(20_000, 10, { cacheCreateTokens: 20_000, timestamp: ts }),
      llm(30_000, 10, { cacheReadTokens: 20_000, cacheCreateTokens: 10_000, timestamp: ts }),
    ]
    const sig = run(detectCacheMiss, makeSession({ timeline }))
    assert.deepStrictEqual(indices(sig), [1])
    assert.match(sig.steps![0].note, /re-saved 10,000 tokens to the cache \(33% of the 30,000 tokens sent\)/)
  })

  test('ttl_expiry names the call before the gap and the miss after it', () => {
    const t0 = Date.parse('2026-10-01T10:00:00Z')
    const timeline = [
      llm(20_000, 10, { cacheCreateTokens: 20_000, timestamp: new Date(t0).toISOString() }),
      tool('bash sleep'),
      llm(20_000, 10, { cacheCreateTokens: 20_000, timestamp: new Date(t0 + 90 * 60_000).toISOString() }),
    ]
    const sig = run(detectTtlExpiry, makeSession({ timeline }))
    assert.deepStrictEqual(sig.steps!.map(s => [s.index, s.role]), [[0, 'context'], [2, 'trigger']])
    assert.match(sig.steps![1].note, /^90 minutes after the previous call; re-saved/)
  })

  test('low_cache_hit_ratio names the calls that re-processed the most input', () => {
    const timeline = [llm(10_000, 10, { cacheReadTokens: 0 }), llm(2_000, 10, { cacheReadTokens: 1_500 }), llm(30_000, 10, { cacheReadTokens: 1_000 })]
    const sig = run(detectLowCacheHitRatio, makeSession({
      timeline, totalLlmCalls: 3, cacheReadTokens: 2_500, cacheCreateTokens: 5_000, cacheHitRate: 0.06,
    }))
    assert.deepStrictEqual(indices(sig), [0, 1, 2])
    assert.match(sig.steps!.find(s => s.index === 2)!.note, /29,000 of 30,000 tokens sent were not reused from the cache/)
  })

  test('budget_overrun names the most expensive calls', () => {
    const original = process.env['TRACEROOST_BUDGET_CAP_USD']
    process.env['TRACEROOST_BUDGET_CAP_USD'] = '0.01'
    try {
      const timeline = [llm(1000, 10, { model: 'claude-opus-5' }), tool('x'), llm(500_000, 10_000, { model: 'claude-opus-5' })]
      const sig = run(detectBudgetOverrun, makeSession({ model: 'claude-opus-5', timeline }))
      assert.deepStrictEqual(indices(sig), [0, 2])
      assert.match(sig.steps!.find(s => s.index === 2)!.note, /% of the trace's cost/)
    } finally {
      if (original === undefined) { delete process.env['TRACEROOST_BUDGET_CAP_USD'] } else { process.env['TRACEROOST_BUDGET_CAP_USD'] = original }
    }
  })

  test('model_tier_mismatch names the read-only calls', () => {
    const timeline = [tool('read_file a.ts'), llm(2000, 50, { model: 'claude-opus-5' }), tool('grep foo'), tool('read_file b.ts')]
    const sig = run(detectModelTierMismatch, makeSession({ model: 'claude-opus-5', timeline }))
    assert.deepStrictEqual(indices(sig), [0, 2, 3])
  })

  test('failed_check_submission names the session\'s last tool call', () => {
    const timeline = [tool('read_file a'), tool('bash', { toolInput: 'npm test', isError: true }), llm(10, 10)]
    const sig = detectFailedCheckSubmission(makeSession({ timeline }))
    assert.ok(sig)
    assert.deepStrictEqual(indices(sig!), [1])
    assert.match(sig!.steps![0].note, /reported an error/)
    assert.strictEqual(sig!.steps![0].detail, undefined)
  })

  test('failed_check_submission quotes the failing output line when there is one', () => {
    const timeline = [tool('bash', { toolInput: 'npm test', resultSummary: 'Tests: 11 passed\n✕ auth › refresh (12 ms)\nTests: 1 failed, 12 total' })]
    const sig = detectFailedCheckSubmission(makeSession({ timeline }))
    assert.ok(sig)
    assert.strictEqual(sig!.steps![0].detail, 'Tests: 1 failed, 12 total')
  })

  test('hallucinated_import names the edit that introduced the import', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-evidence-test-'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const timeline = [tool('read_file a.ts'), edit('src/a.ts', '', "import fake from 'totally-fake-pkg-xyz'")]
    const sig = detectHallucinatedImports(makeSession({ timeline }), dir)
    assert.ok(sig)
    assert.deepStrictEqual(indices(sig!), [1])
    assert.match(sig!.steps![0].note, /imports "totally-fake-pkg-xyz" in a\.ts/)
    assert.strictEqual(sig!.steps![0].detail, "import fake from 'totally-fake-pkg-xyz'")
  })
})

// The "Why it fired" sentence is read by people who don't know the detector: what happened (with
// the measured numbers), then the rule as its own sentence, with every threshold spelled out.
// These pin both the numbers and the singular/plural grammar for one firing of each detector.
suite('signal evidence: plain-language trigger text', () => {
  test('exact_tool_repeat states the count and the 30/50 rule', () => {
    const sig = run(detectExactToolRepeat, makeSession({ timeline: Array.from({ length: 30 }, () => tool('read_file a.ts')) }))
    assert.match(sig.trigger!, /^The most repeated call, "read_file a\.ts", ran 30 times with no file edit in between/)
    assert.match(sig.trigger!, /Flagged at 30 repeats; critical at 50\.$/)
    assert.strictEqual(sig.evidence, '1 tool call repeated identically 30+ times with no edit in between')
  })

  test('edit_revert_cycle reads in the singular for one file, and says when the undo stuck', () => {
    const sig = run(detectEditRevertCycle, makeSession({ timeline: [edit('src/a.ts', 'A', 'B'), edit('src/a.ts', 'B', 'A')] }))
    assert.strictEqual(sig.trigger,
      '1 file had an edit exactly undone by a later edit, which put the old text back.'
      + ' The undo was the file’s last edit, so that change did not survive the trace.'
      + ' Flagged on any exact undo; critical when the undo is the file’s last edit in the trace.')
    assert.strictEqual(sig.evidence, '1 file had an edit undone by a later edit')
  })

  test('edit_revert_cycle says the agent moved on when the file was edited again', () => {
    const sig = run(detectEditRevertCycle, makeSession({ timeline: [edit('a.ts', 'A', 'B'), edit('a.ts', 'B', 'A'), edit('a.ts', 'C', 'D')] }))
    assert.strictEqual(sig.severity, 'warning')
    assert.match(sig.trigger!, /The file was edited again afterwards, so the agent moved on\./)
  })

  test('error_recurrence says when it fell back to grouping by the call', () => {
    const sig = run(detectErrorRecurrence, makeSession({ timeline: Array.from({ length: 5 }, () => tool('bash npm test', { isError: true })) }))
    assert.strictEqual(sig.severity, 'warning')
    assert.match(sig.trigger!, /^"bash npm test" failed 5 times\. No error text was recorded/)
    assert.match(sig.trigger!, /Flagged at 3 repeats; critical at 5 when the error text itself matches\.$/)
  })

  test('runaway_steps names steps, turns, tool calls and the tier budget', () => {
    const sig = run(detectRunawaySteps, makeSession({ userRequest: 'fix typo', timeline: [], totalToolCalls: 49, totalLlmCalls: 1 }))
    assert.match(sig.trigger!, /^This trace took 50 steps \(1 turn and 49 tool calls\), against a budget of 45 for a simple task\./)
    assert.match(sig.trigger!, /Flagged past 45 steps; critical at 90\.$/)
    assert.deepStrictEqual(sig.examples.slice(0, 2), ['1 turn', '49 tool calls'])
  })

  test('token_runaway states the growth, the output share, and the 15,000/50,000 rule', () => {
    const timeline = [llm(1000, 500), llm(4000, 400), llm(16000, 300), llm(20000, 100)]
    const sig = run(detectTokenRunaway, makeSession({ timeline }))
    assert.match(sig.trigger!, /^The context sent to the model grew by 19,000 tokens across 4 model calls\./)
    assert.match(sig.trigger!, /fell from 50\.0% to 0\.5% of what it was sent/)
    assert.match(sig.trigger!, /grows 15,000\+ tokens over 4\+ calls and that output share drops below 30% of where it started\. Critical once the growth passes 50,000 tokens\.$/)
  })

  test('chronic_tool_failures states the share and the 20%/40% rule', () => {
    const timeline = [tool('a'), tool('b', { isError: true }), tool('c'), tool('d', { isError: true }), tool('e')]
    const sig = run(detectChronicToolFailures, makeSession({ timeline }))
    assert.match(sig.trigger!, /^2 of 5 tool calls failed \(40%\)\./)
    assert.match(sig.trigger!, /Flagged at 20% once a trace has 5\+ tool calls; critical at 40%\.$/)
  })

  test('context_flooding_risk reads in the singular for one result', () => {
    const sig = run(detectContextFloodingRisk, makeSession({ timeline: [tool('read big', { fullResult: 'y'.repeat(12_000) })] }))
    assert.match(sig.trigger!, /^1 tool result was over 10,000 characters, 12 KB in all\./)
    assert.match(sig.trigger!, /critical once they reach 300 KB in all\.$/)
    assert.strictEqual(sig.evidence, '1 tool call returned large results (12 KB in all)')
  })

  test('tool_call_cycle states the rounds and the 5/10 rule', () => {
    const timeline = Array.from({ length: 5 }, () => [tool('npm test'), tool('cat log')]).flat()
    const sig = run(detectToolCallCycle, makeSession({ timeline }))
    assert.match(sig.trigger!, /^The sequence npm test → cat log ran 5 times back to back/)
    assert.match(sig.trigger!, /Flagged at 5 rounds; critical at 10\.$/)
  })

  test('file_reread states the reads and the 3/6 rule', () => {
    const sig = run(detectFileReread, makeSession({ timeline: Array.from({ length: 3 }, () => tool('read_file src/a.ts')) }))
    assert.match(sig.trigger!, /^a\.ts was read 3 times with no edit to it in between\./)
    assert.match(sig.trigger!, /Flagged at 3 reads without an edit; critical at 6\.$/)
    assert.strictEqual(sig.steps![1].note, 'read a.ts again (2 of 3), no edit since the first')
  })

  test('cache_miss explains the re-save in plain words and keeps every threshold', () => {
    const timeline = [
      llm(20_000, 10, { cacheCreateTokens: 20_000 }),
      llm(30_000, 10, { cacheReadTokens: 20_000, cacheCreateTokens: 10_000 }),
    ]
    const sig = run(detectCacheMiss, makeSession({ timeline }))
    assert.strictEqual(sig.trigger,
      "1 later model call saved 10,000 tokens of context to the model's cache again, where reusing the stored copy was likely possible."
      + ' Saving to the cache costs much more than reusing from it.'
      + ' Flagged when a call re-saves at least 2,000 tokens and more than 5% of what it sends.'
      + " A model's first call doesn't count, since nothing is stored yet."
      + ' Critical once the total reaches 90,000 tokens.')
    assert.deepStrictEqual(sig.examples, ['10,000 tokens re-saved across 1 call'])
  })

  test('ttl_expiry states the pause and the 60-minute window', () => {
    const t0 = Date.parse('2026-10-01T10:00:00Z')
    const timeline = [
      llm(20_000, 10, { cacheCreateTokens: 20_000, timestamp: new Date(t0).toISOString() }),
      llm(20_000, 10, { cacheCreateTokens: 20_000, timestamp: new Date(t0 + 90 * 60_000).toISOString() }),
    ]
    const sig = run(detectTtlExpiry, makeSession({ timeline }))
    assert.match(sig.trigger!, /^1 model call came after a pause of more than 60 minutes and saved the context to the cache again\./)
    assert.match(sig.trigger!, /The longest pause was 90 minutes\./)
    assert.match(sig.trigger!, /re-saves at least 2,000 tokens and more than 5% of what it sends\. Critical at 3 or more such pauses\.$/)
    assert.deepStrictEqual(sig.examples, ['90-minute pause'])
  })

  test('low_cache_hit_ratio states the reuse share, the turns, and the 30%/10% rule', () => {
    const timeline = [llm(10_000, 10), llm(2_000, 10, { cacheReadTokens: 1_500 }), llm(30_000, 10, { cacheReadTokens: 1_000 })]
    const sig = run(detectLowCacheHitRatio, makeSession({
      timeline, totalLlmCalls: 3, cacheReadTokens: 2_500, cacheCreateTokens: 5_000, cacheHitRate: 0.06,
    }))
    assert.match(sig.trigger!, /^Only 6% of the tokens sent to the model across 3 turns were reused from the cache\./)
    assert.match(sig.trigger!, /Flagged under 30% once a trace has 2\+ turns and at least 2,000 tokens saved to or reused from the cache \(this one had 7,500\)\. Critical under 10%\./)
  })

  test('model_tier_mismatch states the price line and the reply ceiling', () => {
    const timeline = [tool('read_file a.ts'), llm(2000, 50, { model: 'claude-opus-5' }), tool('grep foo'), tool('read_file b.ts')]
    const sig = run(detectModelTierMismatch, makeSession({ model: 'claude-opus-5', timeline }))
    assert.match(sig.trigger!, /^3 of 3 tool calls only read or searched, and no file was edited\./)
    assert.match(sig.trigger!, /replies averaged 50 tokens per call\./)
    assert.match(sig.trigger!, /there are 3\+ tool calls, and at least 90% of them are read-only\. The model must also charge more than \$3 per million tokens sent, with replies averaging 300 tokens or fewer\.$/)
  })

  test('hallucinated_import reads in the singular for one package', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-evidence-test-'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const sig = detectHallucinatedImports(makeSession({ timeline: [edit('src/a.ts', '', "import fake from 'totally-fake-pkg-xyz'")] }), dir)
    assert.ok(sig)
    assert.match(sig!.trigger!, /^"totally-fake-pkg-xyz" is imported by this trace's edits, but isn’t listed in package\.json or requirements\.txt and isn’t installed\./)
    assert.strictEqual(sig!.evidence, '1 import of a package that isn’t listed as a dependency or installed')
  })

  test('no trigger, evidence or example falls back to a "(s)" plural', () => {
    const sigs: LoopSignal[] = []
    const t0 = Date.parse('2026-10-01T10:00:00Z')
    detectContextFloodingRisk(makeSession({ timeline: [tool('a', { fullResult: 'y'.repeat(12_000) }), tool('b', { fullResult: 'z'.repeat(12_000) })] }), sigs)
    detectCacheMiss(makeSession({ timeline: [
      llm(20_000, 10, { cacheCreateTokens: 20_000, timestamp: new Date(t0).toISOString() }),
      llm(20_000, 10, { cacheCreateTokens: 20_000, timestamp: new Date(t0 + 90 * 60_000).toISOString() }),
    ] }), sigs)
    detectFileReread(makeSession({ timeline: [...Array.from({ length: 3 }, () => tool('read_file a.ts')), ...Array.from({ length: 3 }, () => tool('read_file b.ts'))] }), sigs)
    assert.strictEqual(sigs.length, 3)
    for (const s of sigs) {
      for (const text of [s.trigger ?? '', s.evidence, ...s.examples, ...(s.steps ?? []).map(st => st.note)]) {
        assert.ok(!text.includes('(s)') && !text.includes('(es)'), `${s.type}: "${text}"`)
      }
    }
  })
})
