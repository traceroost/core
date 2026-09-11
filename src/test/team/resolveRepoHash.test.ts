import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { resolveRepoHash } from '../../team/resolveRepoHash'
import { deriveRepoKey, repoHash } from '../../forward/repoKey'
import { setCredentialStore } from '../../team/credentials'

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'root'], { cwd: dir })
}

suite('team/resolveRepoHash', () => {
  let tmp: string
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-resolve-')); setCredentialStore({ load: () => null, save: () => {}, clear: () => {} }) })
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); setCredentialStore(undefined) })

  test('resolves a hash to the local repo root when the machine has it', async () => {
    const repo = path.join(tmp, 'proj')
    makeRepo(repo)
    const rk = await deriveRepoKey(repo, 'unlinked-preview')
    assert.ok(rk.ok)
    if (!rk.ok) return
    const hash = repoHash(rk.ctx)
    const resolved = await resolveRepoHash(hash, [repo, path.join(tmp, 'other')])
    assert.strictEqual(resolved, rk.ctx.root)
  })

  test('an unknown hash resolves to null — never an oracle, never a probe', async () => {
    const repo = path.join(tmp, 'proj')
    makeRepo(repo)
    const resolved = await resolveRepoHash('f'.repeat(64), [repo])
    assert.strictEqual(resolved, null)
  })

  test('a malformed hash resolves to null without touching git', async () => {
    assert.strictEqual(await resolveRepoHash('not-a-hash', ['/tmp']), null)
  })
})
