import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { buildLocalTurnoverReport } from '../../../cloud/turnover/localReport'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'

function card(over: Partial<SessionSummaryCard>): SessionSummaryCard {
  return {
    sessionId: 's', traceId: 't', source: 'claude_code', dataSource: 'log',
    workspace: '', userRequest: '', model: 'claude-sonnet-5', turns: 1,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0,
    durationMs: 60_000, startTime: '2026-01-15T10:00:00.000Z',
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'tool_calls', timeline: [], backgroundSpans: [], loopSignals: [],
    ...over,
  }
}

suite('turnover/localReport', () => {
  let repo: string
  setup(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'al-localreport-'))
    const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-15T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-15T10:00:00Z' }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'me@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Me'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'a.ts'), Array.from({ length: 260 }, (_, i) => `x${i}`).join('\n') + '\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'add a\n\nCo-Authored-By: Claude <n@anthropic.com>'], { cwd: repo, env })
  })
  teardown(() => { fs.rmSync(repo, { recursive: true, force: true }) })

  test('assembles a per-repo report and flags a measurable cohort', async () => {
    const report = await buildLocalTurnoverReport(
      [card({ workspace: repo, filesChanged: [path.join(repo, 'a.ts')] })],
      { now: Date.UTC(2026, 8, 1) },
    )
    assert.strictEqual(report.repos.length, 1)
    assert.strictEqual(report.hasMeasurableCohort, true)
    assert.ok(report.repos[0].report.results.some(r => r.kind === 'measured'))
    assert.ok(report.repos[0].label.length > 0)
  })

  test('a workspace that no longer exists on disk is skipped, not an error', async () => {
    const report = await buildLocalTurnoverReport(
      [card({ workspace: '/nonexistent/path/xyz', filesChanged: ['/nonexistent/path/xyz/a.ts'] })],
      { now: Date.UTC(2026, 8, 1) },
    )
    assert.deepStrictEqual(report.repos, [])
    assert.strictEqual(report.hasMeasurableCohort, false)
  })

  test('sessions with no workspace produce an empty (not crashing) report', async () => {
    const report = await buildLocalTurnoverReport([card({})], {})
    assert.deepStrictEqual(report.repos, [])
  })
})
