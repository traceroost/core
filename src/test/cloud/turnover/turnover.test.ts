import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { computeTurnover, MIN_ATTRIBUTED_LINES } from '../../../cloud/turnover'

let repo: string
const T0 = Date.UTC(2026, 0, 15) // 2026-01-15
const FUTURE = Date.UTC(2026, 8, 1) // far enough that Jan/Feb cohorts' 90-day windows elapsed

function iso(ms: number): string { return new Date(ms).toISOString() }

function git(args: string[], atMs = T0): string {
  const env = { ...process.env, GIT_AUTHOR_DATE: iso(atMs), GIT_COMMITTER_DATE: iso(atMs) }
  return execFileSync('git', args, { cwd: repo, env, encoding: 'utf-8' })
}

function writeLines(rel: string, n: number, tag: string): void {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, Array.from({ length: n }, (_, i) => `${tag}-${i}`).join('\n') + '\n')
}

function aiCommit(msg: string, atMs: number): string {
  git(['add', '-A'])
  git(['commit', '-m', `${msg}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`], atMs)
  return git(['rev-parse', 'HEAD']).trim()
}

suite('turnover', () => {
  setup(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'al-turn-'))
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'me@example.com'])
    git(['config', 'user.name', 'Me'])
    writeLines('seed.txt', 1, 'seed')
    git(['add', '-A'])
    git(['commit', '-m', 'seed'], T0 - 400 * 86_400_000) // repo is >90d old
  })
  teardown(() => { fs.rmSync(repo, { recursive: true, force: true }) })

  test('a cohort whose AI lines all survive → 0% turnover', async () => {
    writeLines('keep.txt', MIN_ATTRIBUTED_LINES + 50, 'keep')
    aiCommit('add keep', T0)
    const report = await computeTurnover(repo, { now: FUTURE, windows: [90] })
    const measured = report.results.find(r => r.kind === 'measured')
    assert.ok(measured && measured.kind === 'measured')
    assert.strictEqual(measured.turnoverRate, 0)
    assert.strictEqual(measured.aiLinesSurviving, measured.aiLinesAuthored)
    assert.ok(measured.aiLinesAuthored >= MIN_ATTRIBUTED_LINES)
  })

  test('a cohort whose AI lines are all later removed → 100% turnover', async () => {
    writeLines('gone.txt', MIN_ATTRIBUTED_LINES + 50, 'gone')
    aiCommit('add gone', T0)
    // Later (still before HEAD, after the cohort month) the file is deleted.
    fs.rmSync(path.join(repo, 'gone.txt'))
    git(['add', '-A'])
    git(['commit', '-m', 'remove gone'], T0 + 40 * 86_400_000)

    const report = await computeTurnover(repo, { now: FUTURE, windows: [90] })
    const measured = report.results.find(r => r.kind === 'measured' && r.cohortLabel === '2026-01')
    assert.ok(measured && measured.kind === 'measured')
    assert.strictEqual(measured.turnoverRate, 1)
    assert.strictEqual(measured.aiLinesSurviving, 0)
  })

  test('a cohort below the attributed-line floor → InsufficientData(too-few-attributed-lines)', async () => {
    writeLines('small.txt', 40, 'small')
    aiCommit('add small', T0)
    const report = await computeTurnover(repo, { now: FUTURE, windows: [90] })
    const r = report.results.find(x => x.cohortLabel === '2026-01' && x.windowDays === 90)
    assert.ok(r && r.kind === 'insufficient')
    assert.strictEqual(r.reason, 'too-few-attributed-lines')
  })

  test('a repository younger than the window → InsufficientData(repository-younger-than-window)', async () => {
    // Fresh repo whose only history is a few days old.
    const young = fs.mkdtempSync(path.join(os.tmpdir(), 'al-turn-young-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: young })
    execFileSync('git', ['config', 'user.email', 'me@example.com'], { cwd: young })
    execFileSync('git', ['config', 'user.name', 'Me'], { cwd: young })
    fs.writeFileSync(path.join(young, 'a.txt'), Array.from({ length: 300 }, (_, i) => `a-${i}`).join('\n'))
    const env = { ...process.env, GIT_AUTHOR_DATE: iso(T0), GIT_COMMITTER_DATE: iso(T0) }
    execFileSync('git', ['add', '-A'], { cwd: young })
    execFileSync('git', ['commit', '-m', 'x\n\nCo-Authored-By: Claude <n@anthropic.com>'], { cwd: young, env })
    try {
      const report = await computeTurnover(young, { now: T0 + 5 * 86_400_000, windows: [90] })
      assert.ok(report.results.every(r => r.kind === 'insufficient'))
      assert.ok(report.results.some(r => r.kind === 'insufficient' && r.reason === 'repository-younger-than-window'))
    } finally {
      fs.rmSync(young, { recursive: true, force: true })
    }
  })

  test('a recent cohort whose window has not elapsed → InsufficientData(window-not-elapsed) with a date', async () => {
    writeLines('recent.txt', 300, 'recent')
    aiCommit('add recent', Date.UTC(2026, 7, 20)) // August
    // "now" is early September — August's 90-day window has not elapsed.
    const report = await computeTurnover(repo, { now: Date.UTC(2026, 8, 5), windows: [90] })
    const r = report.results.find(x => x.cohortLabel === '2026-08' && x.windowDays === 90)
    assert.ok(r && r.kind === 'insufficient')
    assert.strictEqual(r.reason, 'window-not-elapsed')
    assert.ok(r.measurableAtIso && Date.parse(r.measurableAtIso) > Date.UTC(2026, 8, 5))
  })

  test('zero attributed lines (no trailers, no sessions) → no measured result', async () => {
    writeLines('plain.txt', 300, 'plain')
    git(['add', '-A'])
    git(['commit', '-m', 'plain, no trailer'], T0)
    const report = await computeTurnover(repo, { now: FUTURE, windows: [90], sessions: [] })
    assert.ok(report.results.every(r => r.kind === 'insufficient'))
    assert.strictEqual(report.coverage.attributedLines, 0)
  })

  test('no percentage is ever returned without a line count, commit count and date range', async () => {
    writeLines('full.txt', 300, 'full')
    aiCommit('add full', T0)
    const report = await computeTurnover(repo, { now: FUTURE, windows: [30, 90] })
    for (const r of report.results) {
      if (r.kind !== 'measured') continue
      assert.ok(Number.isFinite(r.aiLinesAuthored))
      assert.ok(Number.isFinite(r.commitCount) && r.commitCount > 0)
      assert.ok(r.mergeRange.fromIso && r.mergeRange.toIso)
      assert.ok(r.benchmark.verdict)
    }
  })
})
