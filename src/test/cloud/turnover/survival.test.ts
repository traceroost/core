import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { buildSurvivalIndex, survivingAiLines, type FileBlameCache } from '../../../cloud/turnover/survival'

let repo: string

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' })
}

function write(rel: string, content: string): void {
  fs.writeFileSync(path.join(repo, rel), content)
}

function memoryFileBlameCache(): FileBlameCache & { size: () => number } {
  const m = new Map<string, { blobSha: string; origins: Record<string, number> }>()
  return {
    get: (p) => m.get(p),
    put: (p, blobSha, origins) => { m.set(p, { blobSha, origins }) },
    pruneExcept: (paths) => {
      const keep = new Set(paths)
      for (const k of [...m.keys()]) if (!keep.has(k)) m.delete(k)
    },
    size: () => m.size,
  }
}

suite('turnover/survival', () => {
  setup(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'al-survival-'))
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'me@example.com'])
    git(['config', 'user.name', 'Me'])
  })
  teardown(() => { fs.rmSync(repo, { recursive: true, force: true }) })

  test('without a cache, blames every file every call', async () => {
    write('a.txt', 'line1\nline2\n')
    write('b.txt', 'lineA\nlineB\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'initial'])

    const idx1 = await buildSurvivalIndex(repo)
    const idx2 = await buildSurvivalIndex(repo)
    assert.strictEqual(idx1?.filesBlamed, 2)
    assert.strictEqual(idx2?.filesBlamed, 2)
  })

  test('with a cache, a second call with nothing changed blames zero files', async () => {
    write('a.txt', 'line1\nline2\n')
    write('b.txt', 'lineA\nlineB\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'initial'])

    const cache = memoryFileBlameCache()
    const idx1 = await buildSurvivalIndex(repo, cache)
    const idx2 = await buildSurvivalIndex(repo, cache)
    assert.strictEqual(idx1?.filesBlamed, 2)
    assert.strictEqual(idx2?.filesBlamed, 0)
    assert.deepStrictEqual([...idx1!.bySha.entries()], [...idx2!.bySha.entries()])
  })

  test('only the file whose content actually changed gets re-blamed', async () => {
    write('a.txt', 'line1\nline2\n')
    write('b.txt', 'lineA\nlineB\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'initial'])

    const cache = memoryFileBlameCache()
    await buildSurvivalIndex(repo, cache)

    write('a.txt', 'line1\nline2\nline3\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'edit a.txt only'])

    const idx = await buildSurvivalIndex(repo, cache)
    assert.strictEqual(idx?.filesBlamed, 1)
  })

  test('a deleted file is pruned from the cache', async () => {
    write('a.txt', 'line1\n')
    write('b.txt', 'lineA\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'initial'])

    const cache = memoryFileBlameCache()
    await buildSurvivalIndex(repo, cache)
    assert.strictEqual(cache.size(), 2)

    fs.rmSync(path.join(repo, 'b.txt'))
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'delete b.txt'])

    await buildSurvivalIndex(repo, cache)
    assert.strictEqual(cache.size(), 1)
  })

  test('onProgress reports each file, ending at done === total', async () => {
    write('a.txt', 'line1\n')
    write('b.txt', 'lineA\n')
    write('c.txt', 'lineX\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'initial'])

    const calls: Array<{ done: number; total: number }> = []
    await buildSurvivalIndex(repo, undefined, (done, total) => calls.push({ done, total }))

    assert.strictEqual(calls.length, 3)
    assert.deepStrictEqual(calls[calls.length - 1], { done: 3, total: 3 })
    assert.ok(calls.every(c => c.total === 3))
  })

  test('survivingAiLines is unaffected by whether the index came from a cache', async () => {
    write('keep.txt', Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') + '\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'add keep'])
    const sha = git(['rev-parse', 'HEAD']).trim()

    const cache = memoryFileBlameCache()
    await buildSurvivalIndex(repo, cache)
    const cached = await buildSurvivalIndex(repo, cache)

    const surviving = survivingAiLines(cached!, { sha, aiLines: 10, linesAdded: 10 })
    assert.strictEqual(surviving, 10)
  })
})
