import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { classifySessionOutcome } from '../gitOutcome'

// Builds a throwaway git repo per test so the classifier can be exercised against real git
// history instead of mocks — commit timestamps are pinned via GIT_AUTHOR_DATE/GIT_COMMITTER_DATE
// so before/since date filtering is deterministic regardless of how fast the test runs.

let repoDir: string
let fileCounter = 0

function git(args: string[], isoDate?: string): string {
  const env = isoDate
    ? { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate }
    : process.env
  return execFileSync('git', args, { cwd: repoDir, env, encoding: 'utf-8' })
}

function writeFile(relPath: string, content: string): void {
  const abs = path.join(repoDir, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function commitAll(message: string, isoDate: string): void {
  git(['add', '-A'])
  git(['commit', '-m', message, '--allow-empty'], isoDate)
}

suite('gitOutcome', () => {
  setup(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-gitoutcome-'))
    git(['init', '-q'])
    git(['config', 'user.email', 'test@traceroost.local'])
    git(['config', 'user.name', 'TraceRoost Test'])
    fileCounter++
  })

  teardown(() => {
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('classifies a file as productive when a later commit kept the session\'s change', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')

    // Session runs 01-02 to 01-03; the change is committed afterward, at 01-04.
    const sessionStart = '2026-01-02T00:00:00Z'
    const sessionEnd = '2026-01-03T00:00:00Z'
    writeFile(file, 'v2')
    commitAll('session change kept', '2026-01-04T00:00:00Z')

    const result = await classifySessionOutcome(repoDir, [path.join(repoDir, file)], sessionStart, sessionEnd)
    assert.ok(result, 'expected a non-null result')
    assert.strictEqual(result!.overall, 'productive')
  })

  test('classifies a file as reverted when a later commit restored the pre-session content', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')

    const sessionStart = '2026-01-02T00:00:00Z'
    const sessionEnd = '2026-01-03T00:00:00Z'
    writeFile(file, 'v2')
    commitAll('session change', '2026-01-04T00:00:00Z')
    writeFile(file, 'v1')
    commitAll('revert back to v1', '2026-01-05T00:00:00Z')

    const result = await classifySessionOutcome(repoDir, [path.join(repoDir, file)], sessionStart, sessionEnd)
    assert.ok(result)
    assert.strictEqual(result!.overall, 'reverted')
  })

  test('classifies a file as abandoned when it is still uncommitted after the session', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')

    const sessionStart = '2026-01-02T00:00:00Z'
    const sessionEnd = '2026-01-03T00:00:00Z'
    writeFile(file, 'v2') // left modified on disk, never committed

    const result = await classifySessionOutcome(repoDir, [path.join(repoDir, file)], sessionStart, sessionEnd)
    assert.ok(result)
    assert.strictEqual(result!.overall, 'abandoned')
  })

  test('classifies a file as ambiguous when it was never tracked and does not exist on disk', async () => {
    writeFile('unrelated.txt', 'x')
    commitAll('initial', '2026-01-01T00:00:00Z')

    const missingFile = path.join(repoDir, 'never-existed.txt')
    const result = await classifySessionOutcome(repoDir, [missingFile], '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z')
    assert.ok(result)
    assert.strictEqual(result!.overall, 'ambiguous')
  })

  test('returns null for a workspace that does not exist', async () => {
    const result = await classifySessionOutcome(
      path.join(repoDir, 'does-not-exist'),
      ['whatever.txt'],
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    )
    assert.strictEqual(result, null)
  })

  test('returns null for a workspace that is not a git repo', async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-not-a-repo-'))
    try {
      const result = await classifySessionOutcome(notARepo, ['whatever.txt'], '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')
      assert.strictEqual(result, null)
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true })
    }
  })

  test('returns null when there are no changed files', async () => {
    commitAll('initial', '2026-01-01T00:00:00Z')
    const result = await classifySessionOutcome(repoDir, [], '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')
    assert.strictEqual(result, null)
  })

  test('overall status prioritizes reverted over productive across multiple files', async () => {
    const keptFile = `kept${fileCounter}.txt`
    const revertedFile = `reverted${fileCounter}.txt`
    writeFile(keptFile, 'v1')
    writeFile(revertedFile, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')

    const sessionStart = '2026-01-02T00:00:00Z'
    const sessionEnd = '2026-01-03T00:00:00Z'
    writeFile(keptFile, 'v2')
    writeFile(revertedFile, 'v2')
    commitAll('session changes', '2026-01-04T00:00:00Z')
    writeFile(revertedFile, 'v1')
    commitAll('revert one of them', '2026-01-05T00:00:00Z')

    const result = await classifySessionOutcome(
      repoDir,
      [path.join(repoDir, keptFile), path.join(repoDir, revertedFile)],
      sessionStart,
      sessionEnd,
    )
    assert.ok(result)
    assert.strictEqual(result!.overall, 'reverted')
    assert.strictEqual(result!.files[path.join(repoDir, keptFile)], 'productive')
    assert.strictEqual(result!.files[path.join(repoDir, revertedFile)], 'reverted')
  })
})
