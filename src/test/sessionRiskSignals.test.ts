import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  detectFailedCheckSubmission,
  detectHallucinatedImports,
  detectSessionRiskSignals,
} from '../sessionRiskSignals'
import { SessionSummaryCard, TimelineEntry } from '../spanSummarizer'

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

function makeToolCall(opts: { label: string; toolInput?: string; isError?: boolean; resultSummary?: string }): TimelineEntry {
  return {
    type: 'tool',
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    label: opts.label,
    toolInput: opts.toolInput,
    durationMs: 100,
    isError: opts.isError ?? false,
    resultSummary: opts.resultSummary,
    timestamp: new Date().toISOString(),
  }
}

function makeLlm(): TimelineEntry {
  return {
    type: 'llm',
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    label: 'claude-3-5-sonnet',
    model: 'claude-3-5-sonnet',
    inputTokens: 1000,
    outputTokens: 200,
    durationMs: 1000,
    isError: false,
    timestamp: new Date().toISOString(),
  }
}

function makeEdit(filePath: string, newString: string): TimelineEntry {
  return {
    type: 'tool',
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    label: `edit_file ${filePath}`,
    durationMs: 50,
    isError: false,
    timestamp: new Date().toISOString(),
    editDetails: [{ filePath, oldString: '', newString }],
  }
}

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-risk-test-'))
}

// ── detectFailedCheckSubmission ─────────────────────────────────────────────

suite('detectFailedCheckSubmission', () => {
  test('null when the last tool call is not a test runner', () => {
    const session = makeSession({ timeline: [makeToolCall({ label: 'read_file' })] })
    assert.strictEqual(detectFailedCheckSubmission(session), null)
  })

  test('null when the last tool call is a test runner that passed', () => {
    const session = makeSession({
      timeline: [makeToolCall({ label: 'bash', toolInput: 'npm test', resultSummary: 'All 12 tests passed' })],
    })
    assert.strictEqual(detectFailedCheckSubmission(session), null)
  })

  test('flags a session that ends right after a failing test run', () => {
    const session = makeSession({
      timeline: [makeToolCall({ label: 'bash', toolInput: 'npm test', isError: true, resultSummary: '3 tests failed' })],
    })
    const signal = detectFailedCheckSubmission(session)
    assert.ok(signal)
    assert.strictEqual(signal!.type, 'failed_check_submission')
    assert.strictEqual(signal!.severity, 'warning')
  })

  test('does not flag when a fix attempt follows the failing test', () => {
    const session = makeSession({
      timeline: [
        makeToolCall({ label: 'bash', toolInput: 'npm test', isError: true, resultSummary: '3 tests failed' }),
        makeEdit('src/a.ts', 'fixed'),
        makeToolCall({ label: 'bash', toolInput: 'npm test', resultSummary: 'All tests passed' }),
      ],
    })
    assert.strictEqual(detectFailedCheckSubmission(session), null)
  })

  test('detects a pytest failure via result text even without isError set', () => {
    const session = makeSession({
      timeline: [makeToolCall({ label: 'bash', toolInput: 'pytest tests/', resultSummary: '2 failed, 8 passed' })],
    })
    assert.ok(detectFailedCheckSubmission(session))
  })

  test('null for an empty timeline', () => {
    assert.strictEqual(detectFailedCheckSubmission(makeSession({ timeline: [] })), null)
  })
})

// ── detectHallucinatedImports ───────────────────────────────────────────────

suite('detectHallucinatedImports', () => {
  test('null when there is no manifest at all', () => {
    const dir = tmpWorkspace()
    const session = makeSession({ timeline: [makeEdit('src/a.ts', "import foo from 'not-a-real-package'")] })
    assert.strictEqual(detectHallucinatedImports(session, dir), null)
  })

  test('flags an import not present in package.json and not on disk', () => {
    const dir = tmpWorkspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }))
    const session = makeSession({
      timeline: [makeEdit('src/a.ts', "import leftpad from 'left-pad-totally-fake'\nimport express from 'express'")],
    })
    const signal = detectHallucinatedImports(session, dir)
    assert.ok(signal)
    assert.strictEqual(signal!.count, 1)
    assert.ok(signal!.examples[0].startsWith('left-pad-totally-fake'))
  })

  test('does not flag a declared dependency', () => {
    const dir = tmpWorkspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }))
    const session = makeSession({ timeline: [makeEdit('src/a.ts', "import express from 'express'")] })
    assert.strictEqual(detectHallucinatedImports(session, dir), null)
  })

  test('does not flag Node built-ins', () => {
    const dir = tmpWorkspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const session = makeSession({ timeline: [makeEdit('src/a.ts', "import fs from 'fs'\nimport path from 'node:path'")] })
    assert.strictEqual(detectHallucinatedImports(session, dir), null)
  })

  test('does not flag relative imports', () => {
    const dir = tmpWorkspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const session = makeSession({ timeline: [makeEdit('src/a.ts', "import { helper } from './utils'")] })
    assert.strictEqual(detectHallucinatedImports(session, dir), null)
  })

  test('does not flag a package that resolves under node_modules even if undeclared (monorepo workspace case)', () => {
    const dir = tmpWorkspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
    fs.mkdirSync(path.join(dir, 'node_modules', '@myorg', 'shared'), { recursive: true })
    const session = makeSession({ timeline: [makeEdit('src/a.ts', "import { thing } from '@myorg/shared'")] })
    assert.strictEqual(detectHallucinatedImports(session, dir), null)
  })

  test('Python: flags an undeclared package and excludes stdlib', () => {
    const dir = tmpWorkspace()
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'requests==2.31.0\n')
    const session = makeSession({ timeline: [makeEdit('app.py', 'import os\nimport requests\nimport not_a_real_pkg\n')] })
    const signal = detectHallucinatedImports(session, dir)
    assert.ok(signal)
    assert.strictEqual(signal!.count, 1)
    assert.ok(signal!.examples[0].startsWith('not_a_real_pkg'))
  })

  test('ignores entries without editDetails', () => {
    const dir = tmpWorkspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const session = makeSession({ timeline: [makeToolCall({ label: 'read_file' })] })
    assert.strictEqual(detectHallucinatedImports(session, dir), null)
  })

  test('null when workspaceRoot is empty', () => {
    const session = makeSession({ timeline: [makeEdit('src/a.ts', "import foo from 'bar'")] })
    assert.strictEqual(detectHallucinatedImports(session, ''), null)
  })
})

// ── detectSessionRiskSignals ────────────────────────────────────────────────

suite('detectSessionRiskSignals', () => {
  test('empty when neither detector fires', () => {
    const dir = tmpWorkspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const session = makeSession({ timeline: [makeLlm()] })
    assert.deepStrictEqual(detectSessionRiskSignals(session, dir), [])
  })

  test('returns both signals when both fire', () => {
    const dir = tmpWorkspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const session = makeSession({
      timeline: [
        makeEdit('src/a.ts', "import fake from 'totally-fake-pkg'"),
        makeToolCall({ label: 'bash', toolInput: 'npm test', isError: true, resultSummary: 'failed' }),
      ],
    })
    const signals = detectSessionRiskSignals(session, dir)
    assert.strictEqual(signals.length, 2)
    assert.deepStrictEqual(
      new Set(signals.map(s => s.type)),
      new Set(['hallucinated_import', 'failed_check_submission']),
    )
  })
})
