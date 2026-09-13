#!/usr/bin/env node
/**
 * Validate generated or captured TraceRoost fixtures against app summarization logic.
 *
 * This intentionally runs without the UI. Use demo/replay.ts --fixture <name> when
 * you want to stream the same fixture through the standalone dashboard.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
function flag(name, fallback) {
  const i = args.indexOf('--' + name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const FIXTURES_DIR = path.resolve(flag('dir', path.join(__dirname, 'fixtures')))
const ONLY = flag('fixture', 'all')
const summarizerPath = path.join(__dirname, '..', 'out', 'test', 'spanSummarizer.js')

if (!fs.existsSync(summarizerPath)) {
  process.stderr.write('[fixtures] missing out/test/spanSummarizer.js\n')
  process.stderr.write('[fixtures] run: pnpm run compile-tests\n')
  process.exit(1)
}

const { summarizeSpans } = require(summarizerPath)

function fixtureFiles() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    process.stderr.write(`[fixtures] directory not found: ${FIXTURES_DIR}\n`)
    process.stderr.write('[fixtures] run: pnpm run fixtures:generate\n')
    process.exit(1)
  }
  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .filter(f => ONLY === 'all' || f === `${ONLY}.json`)
    .sort()
  if (files.length === 0) {
    process.stderr.write(`[fixtures] no fixture files matched "${ONLY}" in ${FIXTURES_DIR}\n`)
    process.exit(1)
  }
  return files.map(f => path.join(FIXTURES_DIR, f))
}

function agentsFrom(summary) {
  return [...new Set(summary.sessions.map(s => s.source))].sort()
}

function findExpectedSession(summary, expected) {
  return summary.sessions.find(session => {
    if (expected.source && session.source !== expected.source) return false
    if (expected.promptIncludes && !session.userRequest.includes(expected.promptIncludes)) return false
    return true
  })
}

function validateFixture(fixture) {
  const summary = summarizeSpans(fixture.spans)
  const expect = fixture.expect
  if (!expect) {
    return {
      fixture: fixture.name,
      sessions: summary.sessions.length,
      agents: agentsFrom(summary),
      checked: false,
    }
  }

  if (expect.totals?.sessionCount !== undefined) {
    assert.equal(
      summary.sessions.length,
      expect.totals.sessionCount,
      `${fixture.name}: expected ${expect.totals.sessionCount} sessions`
    )
  }

  if (expect.totals?.agents) {
    assert.deepEqual(
      agentsFrom(summary),
      [...expect.totals.agents].sort(),
      `${fixture.name}: agent set mismatch`
    )
  }

  for (const expected of expect.sessions ?? []) {
    const session = findExpectedSession(summary, expected)
    assert.ok(
      session,
      `${fixture.name}: missing ${expected.source ?? 'any'} session containing "${expected.promptIncludes ?? ''}"`
    )

    if (expected.minLlmCalls !== undefined) {
      assert.ok(
        session.totalLlmCalls >= expected.minLlmCalls,
        `${fixture.name}: ${session.source} expected >= ${expected.minLlmCalls} LLM calls, got ${session.totalLlmCalls}`
      )
    }
    if (expected.minToolCalls !== undefined) {
      assert.ok(
        session.totalToolCalls >= expected.minToolCalls,
        `${fixture.name}: ${session.source} expected >= ${expected.minToolCalls} tool calls, got ${session.totalToolCalls}`
      )
    }
    if (expected.minErrors !== undefined) {
      assert.ok(
        session.errors >= expected.minErrors,
        `${fixture.name}: ${session.source} expected >= ${expected.minErrors} errors, got ${session.errors}`
      )
    }
    for (const file of expected.filesChangedIncludes ?? []) {
      assert.ok(
        session.filesChanged.includes(file),
        `${fixture.name}: ${session.source} expected changed file ${file}`
      )
    }
    for (const [tool, count] of Object.entries(expected.toolCounts ?? {})) {
      assert.equal(
        session.toolCounts[tool],
        count,
        `${fixture.name}: ${session.source} expected ${count} ${tool} calls`
      )
    }
    for (const signal of expected.loopSignals ?? []) {
      assert.ok(
        session.loopSignals.some(s => s.type === signal),
        `${fixture.name}: ${session.source} expected loop signal ${signal}`
      )
    }
  }

  return {
    fixture: fixture.name,
    sessions: summary.sessions.length,
    agents: agentsFrom(summary),
    checked: true,
  }
}

function main() {
  const results = []
  for (const file of fixtureFiles()) {
    const fixture = JSON.parse(fs.readFileSync(file, 'utf-8'))
    results.push(validateFixture(fixture))
  }

  for (const result of results) {
    const marker = result.checked ? 'ok' : 'summary-only'
    process.stdout.write(
      `[fixtures] ${marker} ${result.fixture}: ${result.sessions} sessions [${result.agents.join(', ')}]\n`
    )
  }
  process.stdout.write(`[fixtures] validated ${results.length} fixture${results.length !== 1 ? 's' : ''}\n`)
}

try {
  main()
} catch (err) {
  process.stderr.write(`[fixtures] validation failed: ${err.message}\n`)
  process.exit(1)
}
