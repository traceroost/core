import * as assert from 'assert'
import {
  detectLoopSignals,
  detectExactToolRepeat,
  detectEditRevertCycle,
  detectErrorRecurrence,
  detectRunawaySteps,
  detectTokenRunaway,
  detectChronicToolFailures,
  detectContextFloodingRisk,
  detectMalformedToolCall,
  inferTaskComplexity,
  getFileEditCounts,
  temperLoopSignalSeverity,
  LOOP_SIGNAL_ACTIONS,
} from '../loopDetector'
import { SessionSummaryCard, TimelineEntry } from '../spanSummarizer'
import { LoopSignal } from '../types'
import type { GitOutcome } from '../gitOutcome'

// ── Factories ────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-1',
    traceId: 'trace-1',
    source: 'claude_code',
    dataSource: 'otel',
    workspace: '',
    userRequest: 'fix the bug',
    model: 'claude-3-5-sonnet',
    turns: 3,
    inputTokens: 5000,
    outputTokens: 800,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    cacheHitRate: 0,
    durationMs: 12000,
    startTime: new Date().toISOString(),
    filesRead: [],
    filesSearched: [],
    filesChanged: [],
    filesWritten: [],
    toolCounts: {},
    totalToolCalls: 5,
    totalLlmCalls: 3,
    errors: 0,
    outcome: 'unknown',
    timeline: [],
    backgroundSpans: [],
    loopSignals: [],
    ...overrides,
  }
}

function makeTool(label: string, isError = false, errorMessage?: string): TimelineEntry {
  return {
    type: 'tool',
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    label,
    durationMs: 100,
    isError,
    errorMessage,
    timestamp: new Date().toISOString(),
  }
}

function makeLlm(inputTokens: number, outputTokens: number): TimelineEntry {
  return {
    type: 'llm',
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    label: 'claude-3-5-sonnet',
    model: 'claude-3-5-sonnet',
    inputTokens,
    outputTokens,
    durationMs: 2000,
    isError: false,
    timestamp: new Date().toISOString(),
  }
}

function makeEdit(filePath: string, oldString: string, newString: string): TimelineEntry {
  return {
    type: 'tool',
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    label: `edit_file ${filePath}`,
    durationMs: 50,
    isError: false,
    timestamp: new Date().toISOString(),
    editDetails: [{ filePath, oldString, newString }],
  }
}

function makeErrorTool(label: string, errorMessage: string): TimelineEntry {
  return makeTool(label, true, errorMessage)
}

function makeResultTool(label: string, fullResult: string): TimelineEntry {
  return {
    type: 'tool',
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    label,
    durationMs: 100,
    isError: false,
    fullResult,
    timestamp: new Date().toISOString(),
  }
}

// ── inferTaskComplexity ───────────────────────────────────────────────────────

suite('inferTaskComplexity', () => {
  test('short request with no complex keywords → simple', () => {
    assert.strictEqual(inferTaskComplexity('fix typo in README'), 'simple')
  })

  test('rename keyword → simple', () => {
    assert.strictEqual(inferTaskComplexity('rename the variable'), 'simple')
  })

  test('implement keyword alone on a short request → medium', () => {
    // Short request (<50 chars) with only 1 complex keyword → falls through to medium
    assert.strictEqual(inferTaskComplexity('implement the auth flow'), 'medium')
  })

  test('implement + refactor (2 complex keywords) → complex', () => {
    assert.strictEqual(inferTaskComplexity('implement and refactor the auth flow'), 'complex')
  })

  test('refactor + migrate (2 complex keywords) → complex', () => {
    assert.strictEqual(inferTaskComplexity('refactor the database layer and migrate the schema'), 'complex')
  })

  test('long request (>150 chars) with no specific keywords → complex', () => {
    const long = 'Please look at the entire codebase and figure out what is wrong with the authentication, the database connection, and the API routing layer so we can ship.'
    assert.ok(long.length > 150)
    assert.strictEqual(inferTaskComplexity(long), 'complex')
  })

  test('medium length request with one complex keyword → medium', () => {
    assert.strictEqual(inferTaskComplexity('build a helper for parsing JSON'), 'medium')
  })

  test('debug/investigate keywords count as complex even without many files touched', () => {
    const result = inferTaskComplexity('investigate why checkout occasionally fails and find the root cause')
    assert.strictEqual(result, 'complex')
  })

  test('very short request with no keywords → simple', () => {
    assert.strictEqual(inferTaskComplexity('hi'), 'simple')
  })
})

// ── detectExactToolRepeat ────────────────────────────────────────────────────

suite('detectExactToolRepeat', () => {
  test('no signals when all tool calls are unique', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeTool('read_file src/index.ts'),
        makeTool('read_file src/app.ts'),
        makeTool('edit_file src/index.ts'),
      ],
    })
    detectExactToolRepeat(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('no signal when a tool is called exactly twice', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [makeTool('read_file README'), makeTool('read_file README')],
    })
    detectExactToolRepeat(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('warning when a tool is called 3 times', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeTool('read_file README'),
        makeTool('read_file README'),
        makeTool('read_file README'),
      ],
    })
    detectExactToolRepeat(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].type, 'exact_tool_repeat')
    assert.strictEqual(signals[0].severity, 'warning')
    assert.strictEqual(signals[0].count, 3)
  })

  test('critical when a tool is called 5+ times', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: Array(6).fill(null).map(() => makeTool('bash ls -la')),
    })
    detectExactToolRepeat(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'critical')
    assert.strictEqual(signals[0].count, 6)
  })

  test('ignores non-tool timeline entries', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeLlm(1000, 200),
        makeLlm(1200, 210),
        makeLlm(1400, 220),
      ],
    })
    detectExactToolRepeat(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('resets the streak when a file is edited between repeats', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeTool('run_tests'),
        makeEdit('src/a.ts', 'x', 'y'),
        makeTool('run_tests'),
        makeEdit('src/a.ts', 'y', 'z'),
        makeTool('run_tests'),
      ],
    })
    detectExactToolRepeat(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('does not sum partial streaks across an edit boundary', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeTool('run_tests'),
        makeTool('run_tests'),
        makeEdit('src/a.ts', 'x', 'y'),
        makeTool('run_tests'),
        makeTool('run_tests'),
      ],
    })
    detectExactToolRepeat(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('only highest-count tool drives severity, examples include top 3', () => {
    const signals: LoopSignal[] = []
    // toolA ×6, toolB ×3, toolC ×3
    const timeline = [
      ...Array(6).fill(null).map(() => makeTool('bash echo hello')),
      ...Array(3).fill(null).map(() => makeTool('read_file config.json')),
      ...Array(3).fill(null).map(() => makeTool('grep_search TODO')),
    ]
    const session = makeSession({ timeline })
    detectExactToolRepeat(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'critical')
    assert.ok(signals[0].examples.length <= 3)
  })
})

// ── detectEditRevertCycle ────────────────────────────────────────────────────

suite('detectEditRevertCycle', () => {
  test('no signal when all edits are forward-only', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeEdit('src/index.ts', 'foo()', 'bar()'),
        makeEdit('src/index.ts', 'bar()', 'baz()'),
      ],
    })
    detectEditRevertCycle(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('critical signal when a file is edited then reverted', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeEdit('src/app.ts', 'const x = 1', 'const x = 2'),
        makeEdit('src/app.ts', 'const x = 2', 'const x = 1'),
      ],
    })
    detectEditRevertCycle(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].type, 'edit_revert_cycle')
    assert.strictEqual(signals[0].severity, 'critical')
    assert.strictEqual(signals[0].count, 1)
    assert.ok(signals[0].examples[0].includes('app.ts'))
  })

  test('no false positive when a different file is reverted from a different prior state', () => {
    const signals: LoopSignal[] = []
    // file goes A→B→C then is set to A (not reverting any prior edit since C≠B)
    const session = makeSession({
      timeline: [
        makeEdit('src/mod.ts', 'A', 'B'),
        makeEdit('src/mod.ts', 'B', 'C'),
        makeEdit('src/mod.ts', 'C', 'A'), // this IS a revert of edit 0
      ],
    })
    // C→A reverts the original A→B (A==A, B==C? No, B≠C)
    // Actually edits[2].old === edits[0].new (C === B? No)
    // So no revert detected — signal.length should be 0
    detectEditRevertCycle(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('revert detected across non-adjacent edits', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeEdit('src/index.ts', 'old', 'new'),
        makeEdit('src/other.ts', 'a', 'b'),   // different file, not a revert
        makeEdit('src/index.ts', 'new', 'old'), // revert of edit 0
      ],
    })
    detectEditRevertCycle(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].count, 1)
  })

  test('multiple reverted files each counted', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeEdit('a.ts', 'x', 'y'),
        makeEdit('a.ts', 'y', 'x'),
        makeEdit('b.ts', '1', '2'),
        makeEdit('b.ts', '2', '1'),
      ],
    })
    detectEditRevertCycle(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].count, 2)
  })

  test('ignores entries without editDetails', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [makeTool('read_file a.ts'), makeTool('read_file a.ts')],
    })
    detectEditRevertCycle(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('downgrades to warning when the file is edited again after the revert', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeEdit('src/app.ts', 'const x = 1', 'const x = 2'),
        makeEdit('src/app.ts', 'const x = 2', 'const x = 1'), // reverts the first edit
        makeEdit('src/app.ts', 'const x = 1', 'const x = 3'), // agent moved on afterward
      ],
    })
    detectEditRevertCycle(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'warning')
  })

  test('stays critical overall if at least one reverted file never recovered, even if another did', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        // a.ts recovers after its revert
        makeEdit('a.ts', 'x', 'y'),
        makeEdit('a.ts', 'y', 'x'),
        makeEdit('a.ts', 'x', 'z'),
        // b.ts stays reverted — this is still the last edit to b.ts
        makeEdit('b.ts', '1', '2'),
        makeEdit('b.ts', '2', '1'),
      ],
    })
    detectEditRevertCycle(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'critical')
    assert.strictEqual(signals[0].count, 2)
  })
})

// ── getFileEditCounts ────────────────────────────────────────────────────────

function makeLlmEdit(filePath: string, oldString: string, newString: string): TimelineEntry {
  return {
    type: 'llm',
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    label: 'claude-sonnet-5',
    model: 'claude-sonnet-5',
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 2000,
    isError: false,
    timestamp: new Date().toISOString(),
    editDetails: [{ filePath, oldString, newString }],
  }
}

suite('getFileEditCounts', () => {
  test('reads from tool entries when no llm entries have editDetails', () => {
    const session = makeSession({
      timeline: [makeEdit('a.ts', '1', '2'), makeTool('Read')],
    })
    const counts = getFileEditCounts(session)
    assert.deepStrictEqual(Object.keys(counts), ['a.ts'])
    assert.strictEqual(counts['a.ts'].length, 1)
  })

  test('prefers llm entries over tool entries without double-counting', () => {
    // Same edit reported on both the 'llm' entry (Claude's primary source, parsed from
    // gen_ai.output.messages tool_use blocks) and a separate 'tool' entry (secondary
    // source, from the claude_code.tool span) — this happens whenever both
    // CLAUDE_CODE_ENHANCED_TELEMETRY_BETA and OTEL_LOG_TOOL_DETAILS are set.
    const session = makeSession({
      timeline: [makeLlmEdit('a.ts', '1', '2'), makeEdit('a.ts', '1', '2')],
    })
    const counts = getFileEditCounts(session)
    assert.deepStrictEqual(Object.keys(counts), ['a.ts'])
    assert.strictEqual(counts['a.ts'].length, 1, 'should count the edit once, not twice')
  })

  test('falls back to tool entries when llm entries have no editDetails', () => {
    const session = makeSession({
      timeline: [makeLlm(100, 50), makeEdit('a.ts', '1', '2')],
    })
    const counts = getFileEditCounts(session)
    assert.deepStrictEqual(Object.keys(counts), ['a.ts'])
  })

  test('returns empty when no entries have editDetails', () => {
    const session = makeSession({ timeline: [makeTool('Read'), makeLlm(100, 50)] })
    assert.deepStrictEqual(getFileEditCounts(session), {})
  })
})

// ── detectErrorRecurrence ────────────────────────────────────────────────────

suite('detectErrorRecurrence', () => {
  test('no signal when errors are all unique', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeErrorTool('bash', 'file not found'),
        makeErrorTool('bash', 'permission denied'),
      ],
    })
    detectErrorRecurrence(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('no signal when same error appears only twice', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeErrorTool('bash', 'Module not found'),
        makeErrorTool('bash', 'Module not found'),
      ],
    })
    detectErrorRecurrence(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('warning when same error appears 3 times', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: Array(3).fill(null).map(() => makeErrorTool('npm install', 'Module not found: react')),
    })
    detectErrorRecurrence(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].type, 'error_recurrence')
    assert.strictEqual(signals[0].severity, 'warning')
  })

  test('critical when same error appears 5+ times', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: Array(5).fill(null).map(() => makeErrorTool('tsc', 'Property X does not exist')),
    })
    detectErrorRecurrence(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'critical')
  })

  test('falls back to label when errorMessage is absent', () => {
    const signals: LoopSignal[] = []
    const errEntry: TimelineEntry = {
      type: 'tool',
      spanId: 'x',
      label: 'bash',
      durationMs: 100,
      isError: true,
      timestamp: new Date().toISOString(),
    }
    const session = makeSession({ timeline: [errEntry, errEntry, errEntry] })
    detectErrorRecurrence(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.ok(signals[0].examples[0].includes('bash'))
  })

  test('label-fallback grouping is capped at warning even with 5+ occurrences', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      // isError with no errorMessage falls back to the tool label for grouping
      timeline: [
        makeTool('run_build', true),
        makeTool('run_build', true),
        makeTool('run_build', true),
        makeTool('run_build', true),
        makeTool('run_build', true),
      ],
    })
    detectErrorRecurrence(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'warning')
  })

  test('normalizes tmp paths and timestamps so the same underlying error still groups', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeErrorTool('bash', 'ENOENT: /tmp/traceroost-abc123/build.log not found at 2026-01-01T10:00:00.000Z'),
        makeErrorTool('bash', 'ENOENT: /tmp/traceroost-xyz789/build.log not found at 2026-01-01T10:05:12.500Z'),
        makeErrorTool('bash', 'ENOENT: /tmp/traceroost-qqq111/build.log not found at 2026-01-01T10:11:47.100Z'),
      ],
    })
    detectErrorRecurrence(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].count, 3)
  })

  test('does not merge different line numbers into the same error', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeErrorTool('bash', 'SyntaxError at line 42'),
        makeErrorTool('bash', 'SyntaxError at line 43'),
        makeErrorTool('bash', 'SyntaxError at line 44'),
      ],
    })
    detectErrorRecurrence(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('ignores non-error entries', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [makeTool('read_file a'), makeTool('read_file a'), makeTool('read_file a')],
    })
    detectErrorRecurrence(session, signals)
    assert.strictEqual(signals.length, 0)
  })
})

// ── detectRunawaySteps ────────────────────────────────────────────────────────

suite('detectRunawaySteps', () => {
  test('no signal when steps are under threshold', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      userRequest: 'fix typo in README',
      totalLlmCalls: 2,
      totalToolCalls: 5,
    })
    detectRunawaySteps(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('warning when steps exceed simple threshold (15)', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      userRequest: 'rename the variable',
      totalLlmCalls: 8,
      totalToolCalls: 10,  // total=18 > 15
    })
    detectRunawaySteps(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].type, 'runaway_steps')
    assert.strictEqual(signals[0].severity, 'warning')
  })

  test('critical when steps exceed 2× threshold', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      userRequest: 'rename the variable',
      totalLlmCalls: 15,
      totalToolCalls: 16,  // total=31 > 2×15=30
    })
    detectRunawaySteps(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'critical')
  })

  test('warning when steps exceed medium threshold (35)', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      userRequest: 'build a helper function for parsing JSON',
      totalLlmCalls: 20,
      totalToolCalls: 20, // total=40 > 35
    })
    detectRunawaySteps(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'warning')
  })

  test('no signal for complex task under 80 steps', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      userRequest: 'implement and refactor the entire authentication module',
      totalLlmCalls: 30,
      totalToolCalls: 45,  // total=75 ≤ 80
    })
    detectRunawaySteps(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('evidence string includes complexity and threshold', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      userRequest: 'rename the variable x to y',
      totalLlmCalls: 10,
      totalToolCalls: 10,
    })
    detectRunawaySteps(session, signals)
    assert.ok(signals[0].evidence.includes('simple'))
    assert.ok(signals[0].evidence.includes('15'))
  })
})

// ── detectTokenRunaway ────────────────────────────────────────────────────────

suite('detectTokenRunaway', () => {
  test('no signal with fewer than 4 LLM calls', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeLlm(5000, 200),
        makeLlm(20000, 100),
        makeLlm(35000, 50),
      ],
    })
    detectTokenRunaway(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('no signal when input growth is under 15k tokens', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeLlm(1000, 300),
        makeLlm(3000, 280),
        makeLlm(5000, 260),
        makeLlm(7000, 240),
      ],
    })
    detectTokenRunaway(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('warning when output ratio drops ≥50% and input grew >15k', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeLlm(1000, 400),   // ratio 0.4
        makeLlm(8000, 300),
        makeLlm(12000, 200),
        makeLlm(18000, 100),  // ratio ~0.0056, well below 0.2 (50% of 0.4)
      ],
    })
    detectTokenRunaway(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].type, 'token_runaway')
    assert.strictEqual(signals[0].severity, 'warning')
  })

  test('critical when input grew >50k tokens', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeLlm(1000, 400),
        makeLlm(20000, 200),
        makeLlm(40000, 100),
        makeLlm(55000, 50),  // growth = 54000 > 50000
      ],
    })
    detectTokenRunaway(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'critical')
  })

  test('warning when avg output stays below 150 and input grew >30k', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        // even if early/late ratio doesn't drop 50%, absolute condition triggers
        makeLlm(2000, 100),
        makeLlm(12000, 120),
        makeLlm(22000, 80),
        makeLlm(34000, 90),  // growth=32k>30k, avg output=(100+120+80+90)/4=97.5<150
      ],
    })
    detectTokenRunaway(session, signals)
    assert.strictEqual(signals.length, 1)
  })

  test('no signal when output stays proportional to input growth', () => {
    const signals: LoopSignal[] = []
    // Outputs scale with inputs so ratio stays constant; no absolute low-output condition
    const session = makeSession({
      timeline: [
        makeLlm(1000, 200),
        makeLlm(5000, 900),
        makeLlm(10000, 1800),
        makeLlm(18000, 3000),  // growth=17k>15k, but late ratio=0.167 > early ratio*0.5=0.1
      ],
    })
    detectTokenRunaway(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('ignores LLM entries with zero input tokens', () => {
    const signals: LoopSignal[] = []
    const zeroInput: TimelineEntry = {
      type: 'llm',
      spanId: 'x',
      label: 'model',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 100,
      isError: false,
      timestamp: new Date().toISOString(),
    }
    const session = makeSession({
      timeline: [
        zeroInput,
        zeroInput,
        makeLlm(1000, 300),
        makeLlm(5000, 250),
      ],
    })
    detectTokenRunaway(session, signals)
    // only 2 non-zero LLM calls, below threshold of 4
    assert.strictEqual(signals.length, 0)
  })
})

// ── detectChronicToolFailures ───────────────────────────────────────────────

suite('detectChronicToolFailures', () => {
  test('no signal below the minimum sample size, even at 100% failure', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({ timeline: [makeTool('bash', true), makeTool('bash', true)] })
    detectChronicToolFailures(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('no signal for a normal, low ambient failure rate (1/6 ≈ 17%, under the 20% floor)', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeTool('bash', true), makeTool('bash'), makeTool('bash'),
        makeTool('bash'), makeTool('bash'), makeTool('bash'),
      ],
    })
    detectChronicToolFailures(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('warning at a rate between the two thresholds (2/7 ≈ 29%)', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeTool('bash', true), makeTool('bash', true),
        makeTool('read_file'), makeTool('read_file'), makeTool('read_file'),
        makeTool('read_file'), makeTool('read_file'),
      ],
    })
    detectChronicToolFailures(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].type, 'chronic_tool_failures')
    assert.strictEqual(signals[0].severity, 'warning')
    assert.strictEqual(signals[0].count, 2)
  })

  test('critical at a very high failure rate', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeTool('bash', true), makeTool('bash', true), makeTool('bash', true),
        makeTool('read_file'), makeTool('read_file'),
      ],
    })
    detectChronicToolFailures(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'critical')
  })

  test('ignores llm entries when counting the sample size', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [makeLlm(100, 50), makeLlm(100, 50), makeLlm(100, 50), makeTool('bash', true), makeTool('bash')],
    })
    detectChronicToolFailures(session, signals)
    assert.strictEqual(signals.length, 0) // only 2 tool entries, below the 5-call minimum
  })
})

// ── detectContextFloodingRisk ───────────────────────────────────────────────

suite('detectContextFloodingRisk', () => {
  test('no signal when no result exceeds the size threshold', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({ timeline: [makeResultTool('read_file', 'x'.repeat(500))] })
    detectContextFloodingRisk(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('warning when a result exceeds the threshold but total stays under the critical size', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({ timeline: [makeResultTool('read_file', 'x'.repeat(15_000))] })
    detectContextFloodingRisk(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].type, 'context_flooding_risk')
    assert.strictEqual(signals[0].severity, 'warning')
  })

  test('critical when the total accumulated size crosses the critical threshold', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeResultTool('read_file', 'x'.repeat(200_000)),
        makeResultTool('grep', 'x'.repeat(150_000)),
      ],
    })
    detectContextFloodingRisk(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'critical')
    assert.strictEqual(signals[0].count, 2)
  })

  test('ignores entries without fullResult', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({ timeline: [makeTool('read_file')] })
    detectContextFloodingRisk(session, signals)
    assert.strictEqual(signals.length, 0)
  })
})

// ── detectMalformedToolCall ─────────────────────────────────────────────────

suite('detectMalformedToolCall', () => {
  test('no signal for a normal runtime error', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({ timeline: [makeErrorTool('bash', 'command failed with exit code 1')] })
    detectMalformedToolCall(session, signals)
    assert.strictEqual(signals.length, 0)
  })

  test('fires on a single rejected call, unlike error_recurrence', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({ timeline: [makeErrorTool('bash', 'Invalid tool call: missing required parameter "path"')] })
    detectMalformedToolCall(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].type, 'malformed_tool_call')
    assert.strictEqual(signals[0].severity, 'warning')
    assert.strictEqual(signals[0].count, 1)
  })

  test('critical at 3 or more rejected calls', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({
      timeline: [
        makeErrorTool('bash', 'unknown tool "run_shell"'),
        makeErrorTool('bash', 'unknown tool "run_shell"'),
        makeErrorTool('bash', 'unknown tool "run_shell"'),
      ],
    })
    detectMalformedToolCall(session, signals)
    assert.strictEqual(signals.length, 1)
    assert.strictEqual(signals[0].severity, 'critical')
  })

  test('ignores non-error entries', () => {
    const signals: LoopSignal[] = []
    const session = makeSession({ timeline: [makeTool('bash')] })
    detectMalformedToolCall(session, signals)
    assert.strictEqual(signals.length, 0)
  })
})

// ── detectLoopSignals (integration) ─────────────────────────────────────────

suite('detectLoopSignals', () => {
  test('returns empty array for a clean session', () => {
    const session = makeSession({
      userRequest: 'fix typo in README',
      totalLlmCalls: 2,
      totalToolCalls: 3,
      timeline: [
        makeTool('read_file README.md'),
        makeLlm(1000, 300),
        makeTool('edit_file README.md'),
      ],
    })
    const signals = detectLoopSignals(session)
    assert.deepStrictEqual(signals, [])
  })

  test('returns multiple signal types when multiple patterns present', () => {
    // exact_tool_repeat + error_recurrence
    const errEntry = makeErrorTool('npm test', 'ENOENT: no such file')
    const session = makeSession({
      userRequest: 'rename the variable',
      totalLlmCalls: 2,
      totalToolCalls: 9,
      timeline: [
        makeTool('read_file index.ts'),
        makeTool('read_file index.ts'),
        makeTool('read_file index.ts'),
        errEntry,
        errEntry,
        errEntry,
      ],
    })
    const signals = detectLoopSignals(session)
    const types = signals.map(s => s.type)
    assert.ok(types.includes('exact_tool_repeat'))
    assert.ok(types.includes('error_recurrence'))
  })

  test('each signal has required fields', () => {
    const session = makeSession({
      timeline: Array(3).fill(null).map(() => makeTool('bash ls')),
    })
    const signals = detectLoopSignals(session)
    for (const sig of signals) {
      assert.ok(sig.type)
      assert.ok(sig.severity === 'warning' || sig.severity === 'critical')
      assert.ok(typeof sig.evidence === 'string' && sig.evidence.length > 0)
      assert.ok(typeof sig.count === 'number')
      assert.ok(Array.isArray(sig.examples))
      assert.ok(typeof sig.patternName === 'string' && sig.patternName.length > 0)
    }
  })
})

// ── LOOP_SIGNAL_ACTIONS ──────────────────────────────────────────────────────

suite('LOOP_SIGNAL_ACTIONS', () => {
  const signalTypes: Array<import('../types').LoopSignalType> = [
    'exact_tool_repeat',
    'edit_revert_cycle',
    'error_recurrence',
    'runaway_steps',
    'token_runaway',
    'chronic_tool_failures',
    'context_flooding_risk',
    'malformed_tool_call',
  ]

  test('has an action string for every signal type', () => {
    for (const t of signalTypes) {
      assert.ok(LOOP_SIGNAL_ACTIONS[t], `missing action for ${t}`)
      assert.ok(LOOP_SIGNAL_ACTIONS[t].length > 20, `action too short for ${t}`)
    }
  })
})

// ── temperLoopSignalSeverity ─────────────────────────────────────────────────

suite('temperLoopSignalSeverity', () => {
  const criticalSignal: LoopSignal = {
    type: 'exact_tool_repeat', severity: 'critical', evidence: 'e', count: 5, examples: [], patternName: 'p', action: 'a',
  }
  const warningSignal: LoopSignal = { ...criticalSignal, severity: 'warning' }

  function outcome(overall: GitOutcome['overall']): GitOutcome {
    return { overall, files: {}, reason: 'test' }
  }

  test('downgrades critical to warning when outcome is productive', () => {
    const result = temperLoopSignalSeverity([criticalSignal], outcome('productive'))
    assert.strictEqual(result[0].severity, 'warning')
  })

  test('leaves warnings alone when outcome is productive', () => {
    const result = temperLoopSignalSeverity([warningSignal], outcome('productive'))
    assert.strictEqual(result[0].severity, 'warning')
  })

  test('leaves signals unchanged when outcome is null', () => {
    const result = temperLoopSignalSeverity([criticalSignal], null)
    assert.strictEqual(result[0].severity, 'critical')
  })

  test('leaves signals unchanged for reverted/abandoned/ambiguous outcomes', () => {
    for (const overall of ['reverted', 'abandoned', 'ambiguous'] as const) {
      const result = temperLoopSignalSeverity([criticalSignal], outcome(overall))
      assert.strictEqual(result[0].severity, 'critical')
    }
  })

  test('does not mutate the original signal objects', () => {
    const result = temperLoopSignalSeverity([criticalSignal], outcome('productive'))
    assert.strictEqual(criticalSignal.severity, 'critical')
    assert.notStrictEqual(result[0], criticalSignal)
  })
})
