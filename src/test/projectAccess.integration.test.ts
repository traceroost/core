import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { createCloudStoragePredicate } from '../cloudStoragePaths'
import { configureProjectAccess, resetProjectAccessForTests } from '../projectAccess'
import { classifySessionOutcome, resolveOutcomeCacheKey } from '../gitOutcome'
import { deriveRepoKey } from '../repoKey'
import { detectInstructionFiles, readAllInstructionContent } from '../instructionFiles'
import { attributeRepository } from '../attribution'
import { computeTurnover } from '../turnover'
import { resolveGithubUrl } from '../repoRemote'
import { findProjectRoot } from '../summarizers/helpers'
import { getActionLogHistory } from '../actionLog'

// A real git repo placed where macOS keeps a cloud-storage provider (`<home>/Library/CloudStorage/
// OneDrive-Acme/…`, under a temp "home"), plus `<home>/Documents` as a real symlink into it —
// the OneDrive Desktop & Documents backup. With the standalone policy on, every guarded entry
// point must answer "not available" without touching any of it: no fs call on a path inside
// CloudStorage, no git run there.

type FsFn = (...args: unknown[]) => unknown

suite('projectAccess — guarded entry points never touch a cloud-storage project', () => {
  let home: string
  let repo: string
  let docsRepo: string
  let touched: string[]
  let restore: Array<() => void>

  function git(args: string[]): void {
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8' })
  }

  function spyOnFs(): void {
    touched = []
    restore = []
    const record = (p: unknown) => {
      if (typeof p === 'string' && p.includes(`${path.sep}CloudStorage`)) touched.push(p)
    }
    // The module object itself (not this file's import namespace, whose bindings are getters):
    // the code under test reads through to it on every call.
    const nodeFs = require('fs') as typeof fs
    const target = nodeFs as unknown as Record<string, FsFn>
    for (const name of ['existsSync', 'statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'openSync', 'realpathSync', 'readlinkSync', 'watch']) {
      const orig = target[name]
      const wrapped = Object.assign((...args: unknown[]) => { record(args[0]); return orig.apply(nodeFs, args) }, orig)
      target[name] = wrapped
      restore.push(() => { target[name] = orig })
    }
    const realpath = nodeFs.realpathSync as unknown as { native: FsFn }
    const origNative = realpath.native
    realpath.native = (...args: unknown[]) => { record(args[0]); return origNative.apply(nodeFs, args) }
    restore.push(() => { realpath.native = origNative })
  }

  suiteSetup(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tr-cloud-home-')))
    const provider = path.join(home, 'Library', 'CloudStorage', 'OneDrive-Acme')
    repo = path.join(provider, 'code', 'app')
    fs.mkdirSync(repo, { recursive: true })
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@traceroost.local'])
    git(['config', 'user.name', 'TraceRoost Test'])
    git(['remote', 'add', 'origin', 'git@github.com:acme/app.git'])
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# rules\n')
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'init'])
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2\n') // uncommitted: would read 'abandoned'
    fs.mkdirSync(path.join(provider, 'Documents'), { recursive: true })
    fs.symlinkSync(path.join(provider, 'Documents'), path.join(home, 'Documents'))
    docsRepo = path.join(home, 'Documents', 'proj')
  })

  suiteTeardown(() => {
    resetProjectAccessForTests()
    fs.rmSync(home, { recursive: true, force: true })
  })

  setup(() => {
    // The real fs, darwin rules, the temp home — so ~/Documents is lstat'd for real.
    const predicate = createCloudStoragePredicate({ platform: 'darwin', home, fs })
    configureProjectAccess({ host: 'standalone', predicate, home, log: () => {} })
    spyOnFs()
  })

  teardown(() => {
    for (const r of restore) r()
    resetProjectAccessForTests()
  })

  test('git outcome, repo key, instruction files, attribution and turnover all read as not available', async () => {
    const before = getActionLogHistory().length
    const file = path.join(repo, 'a.ts')

    assert.strictEqual(await classifySessionOutcome(repo, [file]), null)
    assert.strictEqual(await classifySessionOutcome('', [file]), null, 'multi-repo shape: no repo discovered inside it')
    assert.strictEqual(await resolveOutcomeCacheKey(repo, [file]), null)
    assert.deepStrictEqual(await deriveRepoKey(repo, 'org'), { ok: false, reason: 'not-a-repo' })
    assert.deepStrictEqual(detectInstructionFiles(repo), [])
    assert.strictEqual(readAllInstructionContent(repo), '')
    assert.strictEqual((await attributeRepository(repo)).unavailable, 'not-a-repo')
    assert.strictEqual((await computeTurnover(repo)).unavailable, 'not-a-repo')
    assert.strictEqual(await resolveGithubUrl(repo), null)
    assert.strictEqual(findProjectRoot(path.join(repo, 'src'), home), path.join(repo, 'src'))

    // The OneDrive-backed ~/Documents: only ~/Documents itself may be lstat'd/readlink'd.
    assert.strictEqual(await classifySessionOutcome(docsRepo, [path.join(docsRepo, 'x.ts')]), null)
    assert.deepStrictEqual(detectInstructionFiles(docsRepo), [])

    assert.deepStrictEqual(touched, [], `fs touched inside CloudStorage:\n${touched.join('\n')}`)
    const ran = getActionLogHistory().slice(before).filter(e => e.cwd.includes('CloudStorage') || e.cwd.startsWith(home))
    assert.deepStrictEqual(ran, [], 'no git run in the project')
  })

  test('with readCloudStorageProjects on, the same repo is read again (the fixture is a real repo)', async () => {
    for (const r of restore) r()
    restore = []
    configureProjectAccess({ host: 'standalone', readCloudStorageProjects: true, predicate: createCloudStoragePredicate({ platform: 'darwin', home, fs }), home })
    const outcome = await classifySessionOutcome(repo, [path.join(repo, 'a.ts')])
    assert.strictEqual(outcome?.overall, 'abandoned')
    assert.ok(detectInstructionFiles(repo).some(f => f.exists && f.relativePath === 'CLAUDE.md'))
    assert.strictEqual(await resolveGithubUrl(repo), 'https://github.com/acme/app')
  })

  test('the VS Code extension host reads it as before', async () => {
    configureProjectAccess({ host: 'extension', predicate: createCloudStoragePredicate({ platform: 'darwin', home, fs }), home })
    const rk = await deriveRepoKey(repo, 'org')
    assert.strictEqual(rk.ok, true)
  })
})
