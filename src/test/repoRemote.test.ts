import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { resolveGithubUrl, resolveOriginUrl, stripRemoteCredentials } from '../repoRemote'

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

suite('repoRemote.resolveGithubUrl', () => {
  let tmp: string
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-remote-')) })
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  async function urlFor(remote: string | null): Promise<string | null> {
    const repo = fs.mkdtempSync(path.join(tmp, 'r-'))
    git(repo, ['init', '-q'])
    if (remote !== null) git(repo, ['remote', 'add', 'origin', remote])
    fs.mkdirSync(path.join(repo, 'pkg'))
    return resolveGithubUrl(path.join(repo, 'pkg'))
  }

  test('normalizes every GitHub remote form to an https URL, from a subdirectory', async () => {
    assert.strictEqual(await urlFor('git@github.com:owner/repo.git'), 'https://github.com/owner/repo')
    assert.strictEqual(await urlFor('ssh://git@github.com/owner/repo.git'), 'https://github.com/owner/repo')
    assert.strictEqual(await urlFor('git://github.com/owner/repo'), 'https://github.com/owner/repo')
    assert.strictEqual(await urlFor('https://github.com/owner/repo.git'), 'https://github.com/owner/repo')
    assert.strictEqual(await urlFor('http://github.com/owner/repo'), 'https://github.com/owner/repo')
  })

  test('non-GitHub remotes, no remote, and non-repos give null', async () => {
    assert.strictEqual(await urlFor('git@gitlab.com:owner/repo.git'), null)
    assert.strictEqual(await urlFor('/some/local/path.git'), null)
    assert.strictEqual(await urlFor(null), null)
    assert.strictEqual(await resolveGithubUrl(path.join(tmp, 'does-not-exist')), null)
  })
})

suite('repoRemote.resolveOriginUrl', () => {
  let tmp: string
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-origin-')) })
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('returns the origin remote as git has it, for any host', async () => {
    git(tmp, ['init', '-q'])
    git(tmp, ['remote', 'add', 'origin', 'git@gitlab.com:owner/repo.git'])
    assert.strictEqual(await resolveOriginUrl(tmp), 'git@gitlab.com:owner/repo.git')
  })

  test('null with no origin remote', async () => {
    git(tmp, ['init', '-q'])
    assert.strictEqual(await resolveOriginUrl(tmp), null)
  })

  test('never prints a credential saved in an https remote', () => {
    assert.strictEqual(stripRemoteCredentials('https://me:ghp_secret@github.com/o/r.git'), 'https://github.com/o/r.git')
    assert.strictEqual(stripRemoteCredentials('https://ghp_secret@dev.azure.com/o/r'), 'https://dev.azure.com/o/r')
    assert.strictEqual(stripRemoteCredentials('git@github.com:o/r.git'), 'git@github.com:o/r.git')
    assert.strictEqual(stripRemoteCredentials('ssh://git@github.com/o/r.git'), 'ssh://git@github.com/o/r.git')
  })
})
