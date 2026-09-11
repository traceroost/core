import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { attributeRepository, memoryAttributionCache } from '../../../cloud/attribution'
import { scanCommits } from '../../../cloud/attribution/commitScan'
import type { AttributionSession } from '../../../cloud/attribution/types'

let repo: string
const clock = Date.parse('2026-03-01T09:00:00Z')

function at(offsetMinutes: number): string {
  return new Date(clock + offsetMinutes * 60_000).toISOString()
}

function git(args: string[], iso?: string): string {
  const env = { ...process.env, GIT_AUTHOR_DATE: iso ?? at(0), GIT_COMMITTER_DATE: iso ?? at(0) }
  return execFileSync('git', args, { cwd: repo, env, encoding: 'utf-8' })
}

function write(rel: string, lines: number, tag = 'x'): void {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, Array.from({ length: lines }, (_, i) => `${tag} line ${i}`).join('\n') + '\n')
}

function commit(message: string, iso: string): string {
  git(['add', '-A'])
  git(['commit', '-m', message], iso)
  return git(['rev-parse', 'HEAD']).trim()
}

suite('attribution', () => {
  setup(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'al-attr-'))
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'me@example.com'])
    git(['config', 'user.name', 'Me'])
    write('README.md', 1, 'r')
    commit('root', at(-1000))
  })
  teardown(() => { fs.rmSync(repo, { recursive: true, force: true }) })

  test('first run on a repo with no AgentLens history: 0 coverage, no crash', async () => {
    write('src/a.ts', 20, 'a')
    commit('add a', at(0))
    const res = await attributeRepository(repo, { sessions: [] })
    assert.strictEqual(res.unavailable, undefined)
    assert.strictEqual(res.coverage.attributedLines, 0)
    assert.ok(res.coverage.totalMergedLines >= 20)
    assert.ok(res.commits.every(c => c.attribution === 'unknown'))
  })

  test('a commit trailer naming an agent → certain', async () => {
    write('src/b.ts', 15, 'b')
    commit('feat: b\n\nCo-Authored-By: Claude <noreply@anthropic.com>', at(0))
    const res = await attributeRepository(repo, { sessions: [] })
    const rec = res.commits.find(c => !c.isMerge)!
    assert.strictEqual(rec.attribution, 'certain')
    assert.ok(rec.aiLines >= 15)
    assert.strictEqual(res.coverage.attributedLines, 15)  // b.ts only; the root commit's 1 line stays unknown
  })

  test('a commit inside a session span → certain; within the lookback window → probable', async () => {
    write('src/c.ts', 10, 'c')
    const inside = commit('add c', at(30))
    write('src/d.ts', 8, 'd')
    const after = commit('add d', at(600)) // 10h later

    const sessions: AttributionSession[] = [
      { sessionId: 's1', workspace: repo, startMs: clock + 20 * 60_000, endMs: clock + 40 * 60_000, filesChanged: [path.join(repo, 'src/c.ts')] },
      { sessionId: 's2', workspace: repo, startMs: clock + 100 * 60_000, endMs: clock + 120 * 60_000, filesChanged: [path.join(repo, 'src/d.ts')] },
    ]
    const res = await attributeRepository(repo, { sessions })
    const bySha = new Map(res.commits.map(c => [c.sha, c]))
    assert.strictEqual(bySha.get(inside)?.attribution, 'certain')
    assert.strictEqual(bySha.get(after)?.attribution, 'probable')
    assert.deepStrictEqual(bySha.get(inside)?.sessionIds, ['s1'])
  })

  test('a session outside the lookback window does not attribute', async () => {
    write('src/e.ts', 12, 'e')
    const sha = commit('add e', at(0))
    const sessions: AttributionSession[] = [
      { sessionId: 'old', workspace: repo, startMs: clock - 200 * 3600_000, endMs: clock - 199 * 3600_000, filesChanged: [path.join(repo, 'src/e.ts')] },
    ]
    const res = await attributeRepository(repo, { sessions })
    assert.strictEqual(res.commits.find(c => c.sha === sha)?.attribution, 'unknown')
  })

  test('merge commits are not double-counted', async () => {
    write('src/base.ts', 5, 'base')
    commit('base', at(0))
    git(['checkout', '-q', '-b', 'feature'])
    write('src/feat.ts', 6, 'feat')
    commit('feat work\n\nCo-Authored-By: Claude <x@anthropic.com>', at(10))
    git(['checkout', '-q', 'main'])
    write('src/main.ts', 4, 'main')
    commit('main work', at(20))
    git(['merge', '--no-ff', '-m', 'merge feature', 'feature'])

    const res = await attributeRepository(repo, { sessions: [] })
    const merge = res.commits.find(c => c.isMerge)
    assert.ok(merge)
    assert.strictEqual(merge!.aiLines, 0)
    assert.strictEqual(merge!.attribution, 'unknown')
  })

  test('attribution is stable across runs (same inputs → same output)', async () => {
    write('src/f.ts', 9, 'f')
    commit('feat: f\n\nCo-Authored-By: Codex <x@openai.com>', at(0))
    const a = await attributeRepository(repo, { sessions: [] })
    const b = await attributeRepository(repo, { sessions: [] })
    assert.deepStrictEqual(a.commits, b.commits)
  })

  test('the cache is consulted and populated', async () => {
    write('src/g.ts', 7, 'g')
    const sha = commit('feat: g\n\nCo-Authored-By: Claude <x@anthropic.com>', at(0))
    const cache = memoryAttributionCache()
    await attributeRepository(repo, { sessions: [], cache })
    assert.ok(cache.get(sha))
    // Second run: mutate the cache entry and confirm it is returned verbatim (not recomputed).
    cache.put({ ...cache.get(sha)!, aiLines: 999 })
    const res = await attributeRepository(repo, { sessions: [], cache })
    assert.strictEqual(res.commits.find(c => c.sha === sha)?.aiLines, 999)
  })

  test('only the local author\'s commits are attributed by default', async () => {
    write('src/h.ts', 5, 'h')
    execFileSync('git', ['-c', 'user.email=other@example.com', '-c', 'user.name=Other', 'commit', '-am', 'x', '--allow-empty'],
      { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: at(0), GIT_COMMITTER_DATE: at(0) } })
    git(['add', '-A'])
    execFileSync('git', ['-c', 'user.email=other@example.com', '-c', 'user.name=Other', 'commit', '-m', 'other adds h\n\nCo-Authored-By: Claude <x@anthropic.com>'],
      { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: at(0), GIT_COMMITTER_DATE: at(0) } })
    const res = await attributeRepository(repo, { sessions: [], authorEmail: 'me@example.com' })
    assert.ok(res.commits.every(c => c.sha !== git(['rev-parse', 'HEAD']).trim()))
  })

  test('scanCommits never surfaces the commit message text', async () => {
    write('src/i.ts', 3, 'i')
    commit('SECRET_SUBJECT_TEXT should not appear anywhere', at(0))
    const scanned = await scanCommits(repo)
    const serialized = JSON.stringify(scanned)
    assert.ok(!serialized.includes('SECRET_SUBJECT_TEXT'))
  })
})
