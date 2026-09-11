import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import {
  deriveRepoKey,
  repoHash,
  fileHash,
  branchHash,
  commitHash,
  repoKeyFingerprint,
  toRepoRelativePosix,
} from '../../../cloud/forward/repoKey'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00' },
  })
}

/** A throwaway repo with a known root commit and a couple of files. */
function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 't@example.com'])
  git(dir, ['config', 'user.name', 'T'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'root\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'root'])
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'second'])
}

suite('forward/repoKey', () => {
  let tmp: string
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-repokey-')) })
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('two checkouts of the same repo at different paths derive identical hashes', async () => {
    const upstream = path.join(tmp, 'upstream')
    makeRepo(upstream)
    const cloneA = path.join(tmp, 'a', 'proj')
    const cloneB = path.join(tmp, 'b', 'somewhere', 'else', 'proj')
    fs.mkdirSync(path.dirname(cloneA), { recursive: true })
    fs.mkdirSync(path.dirname(cloneB), { recursive: true })
    git(tmp, ['clone', '-q', upstream, cloneA])
    git(tmp, ['clone', '-q', upstream, cloneB])

    const a = await deriveRepoKey(cloneA, 'org-1')
    const b = await deriveRepoKey(cloneB, 'org-1')
    assert.ok(a.ok && b.ok)
    if (!a.ok || !b.ok) return

    assert.strictEqual(repoHash(a.ctx), repoHash(b.ctx))
    assert.strictEqual(fileHash(a.ctx, path.join(cloneA, 'src', 'a.ts')), fileHash(b.ctx, 'src/a.ts'))
    assert.strictEqual(branchHash(a.ctx, 'main'), branchHash(b.ctx, 'main'))
    assert.match(repoHash(a.ctx), /^[a-f0-9]{64}$/)
  })

  test('a different org_id produces different hashes for the same repo', async () => {
    const repo = path.join(tmp, 'repo')
    makeRepo(repo)
    const a = await deriveRepoKey(repo, 'org-1')
    const b = await deriveRepoKey(repo, 'org-2')
    assert.ok(a.ok && b.ok)
    if (!a.ok || !b.ok) return
    assert.notStrictEqual(repoHash(a.ctx), repoHash(b.ctx))
    assert.notStrictEqual(repoKeyFingerprint(a.ctx), repoKeyFingerprint(b.ctx))
  })

  test('a path with spaces, unicode and a leading ./ hashes identically to its normal form', async () => {
    const repo = path.join(tmp, 'repo')
    makeRepo(repo)
    const r = await deriveRepoKey(repo, 'org-1')
    assert.ok(r.ok)
    if (!r.ok) return
    const canonical = fileHash(r.ctx, 'src/weird name — café.ts')
    assert.strictEqual(fileHash(r.ctx, './src/weird name — café.ts'), canonical)
    assert.strictEqual(fileHash(r.ctx, path.join(repo, 'src', 'weird name — café.ts')), canonical)
  })

  test('a path outside the repo hashes to null', async () => {
    const repo = path.join(tmp, 'repo')
    makeRepo(repo)
    const r = await deriveRepoKey(repo, 'org-1')
    assert.ok(r.ok)
    if (!r.ok) return
    assert.strictEqual(fileHash(r.ctx, '/etc/passwd'), null)
    assert.strictEqual(toRepoRelativePosix(repo, '../outside.ts'), null)
  })

  test('commitHash is case- and whitespace-insensitive on the input SHA', async () => {
    const repo = path.join(tmp, 'repo')
    makeRepo(repo)
    const r = await deriveRepoKey(repo, 'org-1')
    assert.ok(r.ok)
    if (!r.ok) return
    const sha = git(repo, ['rev-parse', 'HEAD']).trim()
    assert.strictEqual(commitHash(r.ctx, sha), commitHash(r.ctx, ` ${sha.toUpperCase()} `))
  })

  test('a shallow clone is reported, not silently hashed', async () => {
    const upstream = path.join(tmp, 'upstream')
    makeRepo(upstream)
    const shallow = path.join(tmp, 'shallow')
    git(tmp, ['clone', '-q', '--depth', '1', `file://${upstream}`, shallow])
    const r = await deriveRepoKey(shallow, 'org-1')
    assert.strictEqual(r.ok, false)
    if (!r.ok) assert.strictEqual(r.reason, 'shallow-clone')
  })

  test('a non-repo directory is reported as not-a-repo', async () => {
    const plain = path.join(tmp, 'plain')
    fs.mkdirSync(plain)
    const r = await deriveRepoKey(plain, 'org-1')
    assert.strictEqual(r.ok, false)
    if (!r.ok) assert.strictEqual(r.reason, 'not-a-repo')
  })
})
