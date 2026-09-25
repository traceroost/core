import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { classifySessionOutcome, createOutcomeRepoCache, onRunningGitCommandsChanged } from '../gitOutcome'

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
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@traceroost.local'])
    git(['config', 'user.name', 'TraceRoost Test'])
    fileCounter++
  })

  teardown(() => {
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('classifies a file as merged when committed on the trunk branch itself', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    writeFile(file, 'v2')
    commitAll('session change kept', '2026-01-04T00:00:00Z')

    const result = await classifySessionOutcome(repoDir, [path.join(repoDir, file)])
    assert.ok(result, 'expected a non-null result')
    assert.strictEqual(result!.overall, 'merged')
  })

  test('classifies a file as committed (not merged) when it only exists on a feature branch', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')

    git(['checkout', '-q', '-b', 'feature'])
    writeFile(file, 'v2')
    commitAll('feature branch change', '2026-01-02T00:00:00Z')

    const result = await classifySessionOutcome(repoDir, [path.join(repoDir, file)])
    assert.ok(result)
    assert.strictEqual(result!.overall, 'committed')
  })

  test('classifies a file as merged once its feature-branch commit is merged into trunk', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')

    git(['checkout', '-q', '-b', 'feature'])
    writeFile(file, 'v2')
    commitAll('feature branch change', '2026-01-02T00:00:00Z')

    git(['checkout', '-q', 'main'])
    git(['merge', '-q', '--no-ff', 'feature', '-m', 'merge feature'], '2026-01-03T00:00:00Z')

    const result = await classifySessionOutcome(repoDir, [path.join(repoDir, file)])
    assert.ok(result)
    assert.strictEqual(result!.overall, 'merged')
  })

  test('classifies a squash-merged file as merged (content match, not commit ancestry)', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')

    git(['checkout', '-q', '-b', 'feature'])
    writeFile(file, 'v2')
    commitAll('feature branch change', '2026-01-02T00:00:00Z')

    // A squash merge gives trunk's copy of the change a brand-new commit sha — ancestry-based
    // detection (`merge-base --is-ancestor`) would miss this; content comparison shouldn't.
    git(['checkout', '-q', 'main'])
    git(['merge', '-q', '--squash', 'feature'])
    commitAll('squash-merge feature', '2026-01-03T00:00:00Z')

    const result = await classifySessionOutcome(repoDir, [path.join(repoDir, file)])
    assert.ok(result)
    assert.strictEqual(result!.overall, 'merged')
  })

  test('classifies a file as abandoned when it is still uncommitted', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    writeFile(file, 'v2') // left modified on disk, never committed

    const result = await classifySessionOutcome(repoDir, [path.join(repoDir, file)])
    assert.ok(result)
    assert.strictEqual(result!.overall, 'abandoned')
  })

  test('classifies a file as ambiguous when it was never tracked and does not exist on disk', async () => {
    writeFile('unrelated.txt', 'x')
    commitAll('initial', '2026-01-01T00:00:00Z')

    const missingFile = path.join(repoDir, 'never-existed.txt')
    const result = await classifySessionOutcome(repoDir, [missingFile])
    assert.ok(result)
    assert.strictEqual(result!.overall, 'ambiguous')
  })

  test('returns null for a workspace that does not exist', async () => {
    const result = await classifySessionOutcome(path.join(repoDir, 'does-not-exist'), ['whatever.txt'])
    assert.strictEqual(result, null)
  })

  test('returns null for a workspace that is not a git repo', async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-not-a-repo-'))
    try {
      const result = await classifySessionOutcome(notARepo, ['whatever.txt'])
      assert.strictEqual(result, null)
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true })
    }
  })

  test('returns null when there are no changed files', async () => {
    commitAll('initial', '2026-01-01T00:00:00Z')
    const result = await classifySessionOutcome(repoDir, [])
    assert.strictEqual(result, null)
  })

  test('ignores files outside the repo root instead of marking them ambiguous', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    writeFile(file, 'v2')
    commitAll('session change kept', '2026-01-04T00:00:00Z')

    // A session's filesChanged isn't scoped to the repo it ran in — e.g. Claude Code's own
    // memory notes or global settings can show up alongside real repo edits. Those shouldn't
    // drag a cleanly-committed session down to 'ambiguous'.
    const outsideRepo = path.join(os.tmpdir(), 'not-in-this-repo.md')
    const result = await classifySessionOutcome(repoDir, [path.join(repoDir, file), outsideRepo])
    assert.ok(result)
    assert.strictEqual(result!.overall, 'merged')
    assert.strictEqual(Object.keys(result!.files).length, 1)
    assert.strictEqual(result!.files[path.join(repoDir, file)], 'merged')
  })

  test('returns null when every changed file falls outside the repo root', async () => {
    commitAll('initial', '2026-01-01T00:00:00Z')
    const outsideRepo = path.join(os.tmpdir(), 'also-not-in-this-repo.md')
    const result = await classifySessionOutcome(repoDir, [outsideRepo])
    assert.strictEqual(result, null)
  })

  test('overall status prioritizes abandoned over merged across multiple files', async () => {
    const mergedFile = `merged${fileCounter}.txt`
    const abandonedFile = `abandoned${fileCounter}.txt`
    writeFile(mergedFile, 'v1')
    writeFile(abandonedFile, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    writeFile(mergedFile, 'v2')
    commitAll('session change', '2026-01-04T00:00:00Z')
    writeFile(abandonedFile, 'v2') // left modified on disk, never committed

    const result = await classifySessionOutcome(repoDir, [path.join(repoDir, mergedFile), path.join(repoDir, abandonedFile)])
    assert.ok(result)
    assert.strictEqual(result!.overall, 'abandoned')
    assert.strictEqual(result!.files[path.join(repoDir, mergedFile)], 'merged')
    assert.strictEqual(result!.files[path.join(repoDir, abandonedFile)], 'abandoned')
  })

  test('createOutcomeRepoCache: same result with and without a cache — caching never changes the answer', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')
    writeFile(file, 'v2')
    commitAll('session change kept', '2026-01-04T00:00:00Z')

    const cache = createOutcomeRepoCache()
    const uncached = await classifySessionOutcome(repoDir, [path.join(repoDir, file)])
    const cached = await classifySessionOutcome(repoDir, [path.join(repoDir, file)], cache)
    assert.deepStrictEqual(cached, uncached)
  })

  test('createOutcomeRepoCache: memoizes root() and trunkRef() per key — same promise, not a fresh git call each time', async () => {
    commitAll('initial', '2026-01-01T00:00:00Z')
    const cache = createOutcomeRepoCache()

    const rootP1 = cache.root(repoDir)
    const rootP2 = cache.root(repoDir)
    assert.strictEqual(rootP1, rootP2, 'a second call for the same workspace must reuse the in-flight/resolved promise, not start a new git subprocess')
    const root = await rootP1
    assert.ok(root)

    const trunkP1 = cache.trunkRef(root!)
    const trunkP2 = cache.trunkRef(root!)
    assert.strictEqual(trunkP1, trunkP2, 'a second call for the same root must reuse the in-flight/resolved promise')

    // A different workspace/root gets its own cache entry — this isn't a global singleton.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-gitoutcome-other-'))
    try {
      const otherRootP = cache.root(other)
      assert.notStrictEqual(otherRootP, rootP1)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  test('onRunningGitCommandsChanged notifies immediately (leading edge), not only once a throttle window elapses', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')

    // The throttle's "is a notify already scheduled" flag is process-wide, not per-test — a git
    // call left over from a preceding test (in this file, or run alongside it) can still have a
    // trailing window open. Waiting one out first isolates this test from that shared state.
    // Must clear RUNNING_COMMANDS_NOTIFY_THROTTLE_MS (gitOutcome.ts).
    await new Promise(resolve => setTimeout(resolve, 600))

    const snapshots: string[][] = []
    const unsubscribe = onRunningGitCommandsChanged(commands => snapshots.push(commands))
    try {
      // classifySessionOutcome's first git subprocess (finding the repo root) is spawned
      // synchronously up to its own first `await`, so the leading-edge notify must already have
      // fired by the time this call returns a promise — a pure trailing-edge debounce would report
      // nothing here, since real git calls typically finish well inside the throttle window.
      const pending = classifySessionOutcome(repoDir, [path.join(repoDir, file)])
      assert.ok(snapshots.length > 0, 'expected a snapshot before the classification settled')
      assert.ok(snapshots[0].length > 0, 'expected the first snapshot to report an in-flight command')
      await pending
    } finally {
      unsubscribe()
    }
  })

  test('onRunningGitCommandsChanged eventually reports an empty snapshot once classification settles', async () => {
    const file = `file${fileCounter}.txt`
    writeFile(file, 'v1')
    commitAll('initial', '2026-01-01T00:00:00Z')

    const snapshots: string[][] = []
    const unsubscribe = onRunningGitCommandsChanged(commands => snapshots.push(commands))
    try {
      await classifySessionOutcome(repoDir, [path.join(repoDir, file)])
      // The trailing edge of the throttle (RUNNING_COMMANDS_NOTIFY_THROTTLE_MS) needs a moment to
      // fire after the last subprocess exits.
      await new Promise(resolve => setTimeout(resolve, 600))
      assert.ok(snapshots.some(s => s.length === 0), 'expected a snapshot reporting no commands in flight once everything settled')
    } finally {
      unsubscribe()
    }
  })
})
