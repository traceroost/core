import * as assert from 'assert'
import { createCloudStoragePredicate, providerDisplayName, type CloudStorageFs } from '../cloudStoragePaths'
import {
  configureProjectAccess, mayTouchProject, resetProjectAccessForTests, setReadCloudStorageProjects,
  projectAccessStatus, cloudStorageGuardActive,
} from '../projectAccess'

const HOME = '/Users/dev'
const CLOUD = `${HOME}/Library/CloudStorage`

/** A fake fs holding only symlinks (everything else is a plain directory) that records every path
 *  it is asked about — so a test can prove nothing inside CloudStorage was ever touched. */
function fakeFs(links: Record<string, string>): CloudStorageFs & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    lstatSync(p: string) {
      calls.push(p)
      return { isSymbolicLink: () => p in links }
    },
    readlinkSync(p: string) {
      calls.push(p)
      if (!(p in links)) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
      return links[p]
    },
  }
}

function assertNothingInsideCloudStorageTouched(calls: string[]): void {
  for (const c of calls) {
    assert.ok(!c.toLowerCase().startsWith(CLOUD.toLowerCase()), `touched ${c} inside CloudStorage`)
  }
}

suite('cloudStoragePaths — isCloudStoragePath', () => {
  test('a path directly under ~/Library/CloudStorage/<Provider> is cloud storage, with no fs call at all', () => {
    const fs = fakeFs({})
    const pred = createCloudStoragePredicate({ platform: 'darwin', home: HOME, fs })
    assert.strictEqual(pred.isCloudStoragePath(`${CLOUD}/OneDrive-Acme/code/app`), true)
    assert.strictEqual(pred.isCloudStoragePath(`${CLOUD}/Dropbox/proj/src/index.ts`), true)
    assert.strictEqual(pred.isCloudStoragePath(`${HOME}/library/cloudstorage/Box-Box/x`), true, 'case-insensitive, like a default macOS volume')
    assert.deepStrictEqual(fs.calls, [])
    assert.deepStrictEqual(pred.match(`${CLOUD}/OneDrive-Acme/code/app`), {
      providerRoot: `${CLOUD}/OneDrive-Acme`, providerName: 'OneDrive - Acme',
    })
  })

  test('~/Documents symlinked into OneDrive (Desktop & Documents backup) counts, resolving the link as a string', () => {
    const fs = fakeFs({ [`${HOME}/Documents`]: 'Library/CloudStorage/OneDrive-Acme/Documents' })
    const pred = createCloudStoragePredicate({ platform: 'darwin', home: HOME, fs })
    assert.deepStrictEqual(pred.match(`${HOME}/Documents/work/app`), {
      providerRoot: `${CLOUD}/OneDrive-Acme`, providerName: 'OneDrive - Acme',
    })
    assert.deepStrictEqual(fs.calls, [`${HOME}/Documents`, `${HOME}/Documents`], 'only ~/Documents itself: one lstat, one readlink')
    assertNothingInsideCloudStorageTouched(fs.calls)
  })

  test('an absolute symlink target into CloudStorage counts too, and the per-component result is cached', () => {
    const fs = fakeFs({ [`${HOME}/Desktop`]: `${CLOUD}/OneDrive-Personal/Desktop` })
    const pred = createCloudStoragePredicate({ platform: 'darwin', home: HOME, fs })
    assert.strictEqual(pred.isCloudStoragePath(`${HOME}/Desktop/a`), true)
    const after = fs.calls.length
    assert.strictEqual(pred.isCloudStoragePath(`${HOME}/Desktop/b/c`), true)
    assert.strictEqual(fs.calls.length, after, 'second lookup under the same home child uses the cache')
    assertNothingInsideCloudStorageTouched(fs.calls)
  })

  test('~/Library/Mobile Documents (iCloud Drive) is not cloud storage', () => {
    const fs = fakeFs({})
    const pred = createCloudStoragePredicate({ platform: 'darwin', home: HOME, fs })
    assert.strictEqual(pred.isCloudStoragePath(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/proj`), false)
  })

  test('a normal ~/code path, a non-home path and a relative path are not', () => {
    const fs = fakeFs({ [`${HOME}/Documents`]: `${CLOUD}/OneDrive-Acme/Documents` })
    const pred = createCloudStoragePredicate({ platform: 'darwin', home: HOME, fs })
    assert.strictEqual(pred.isCloudStoragePath(`${HOME}/code/app`), false)
    assert.strictEqual(pred.isCloudStoragePath('/opt/src/app'), false)
    assert.strictEqual(pred.isCloudStoragePath('code/app'), false)
    assert.strictEqual(pred.isCloudStoragePath(''), false)
    assert.ok(!fs.calls.some(c => !c.startsWith(HOME + '/')), 'nothing outside home is lstat\'d')
  })

  test('a symlink to somewhere outside CloudStorage is not cloud storage', () => {
    const fs = fakeFs({ [`${HOME}/code`]: '/Volumes/work/code' })
    const pred = createCloudStoragePredicate({ platform: 'darwin', home: HOME, fs })
    assert.strictEqual(pred.isCloudStoragePath(`${HOME}/code/app`), false)
  })

  test('off macOS it is always false, and nothing is lstat\'d', () => {
    for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
      const fs = fakeFs({ [`${HOME}/Documents`]: `${CLOUD}/OneDrive-Acme/Documents` })
      const pred = createCloudStoragePredicate({ platform, home: HOME, fs })
      assert.strictEqual(pred.isCloudStoragePath(`${CLOUD}/OneDrive-Acme/app`), false)
      assert.strictEqual(pred.isCloudStoragePath(`${HOME}/Documents/app`), false)
      assert.deepStrictEqual(fs.calls, [])
    }
  })

  test('provider display names', () => {
    assert.strictEqual(providerDisplayName('OneDrive-Acme'), 'OneDrive - Acme')
    assert.strictEqual(providerDisplayName('GoogleDrive-dev@example.com'), 'Google Drive - dev@example.com')
    assert.strictEqual(providerDisplayName('Dropbox'), 'Dropbox')
    assert.strictEqual(providerDisplayName('GoogleDrive'), 'Google Drive')
  })
})

suite('projectAccess — mayTouchProject', () => {
  const predicate = createCloudStoragePredicate({
    platform: 'darwin', home: HOME, fs: fakeFs({ [`${HOME}/Documents`]: `${CLOUD}/OneDrive-Acme/Documents` }),
  })
  teardown(() => resetProjectAccessForTests())

  test('not configured (unit tests, one-shot CLI): everything passes', () => {
    resetProjectAccessForTests()
    assert.strictEqual(cloudStorageGuardActive(), false)
    assert.strictEqual(mayTouchProject(`${CLOUD}/Dropbox/app`), true)
  })

  test('the VS Code extension host is unaffected', () => {
    const logs: string[] = []
    configureProjectAccess({ host: 'extension', predicate, home: HOME, log: m => logs.push(m) })
    assert.strictEqual(mayTouchProject(`${CLOUD}/OneDrive-Acme/app`), true)
    assert.strictEqual(mayTouchProject(`${HOME}/Documents/app`), true)
    assert.deepStrictEqual(logs, [])
  })

  test('standalone skips cloud-storage folders by default and logs once per provider root, never the project path', () => {
    const logs: string[] = []
    configureProjectAccess({ host: 'standalone', predicate, home: HOME, log: m => logs.push(m) })
    assert.strictEqual(mayTouchProject(`${CLOUD}/OneDrive-Acme/secret-project`), false)
    assert.strictEqual(mayTouchProject(`${HOME}/Documents/other-secret`), false)
    assert.strictEqual(mayTouchProject(`${CLOUD}/Dropbox/third`), false)
    assert.strictEqual(mayTouchProject(`${HOME}/code/app`), true)
    assert.strictEqual(mayTouchProject(''), true)
    assert.strictEqual(logs.length, 2, logs.join('\n'))
    assert.ok(logs[0].includes('OneDrive - Acme (~/Library/CloudStorage/OneDrive-Acme)'), logs[0])
    assert.ok(logs[0].includes('readCloudStorageProjects: true'), logs[0])
    assert.ok(logs[1].includes('Dropbox (~/Library/CloudStorage/Dropbox)'), logs[1])
    assert.ok(!logs.some(l => /secret|third/.test(l)), 'no project path in the log')
    assert.deepStrictEqual(projectAccessStatus('darwin'), {
      applicable: true, readCloudStorageProjects: false, skippedProviders: ['Dropbox', 'OneDrive - Acme'],
    })
  })

  test('readCloudStorageProjects: true (config.json or Settings) restores access', () => {
    configureProjectAccess({ host: 'standalone', readCloudStorageProjects: true, predicate, home: HOME, log: () => {} })
    assert.strictEqual(mayTouchProject(`${CLOUD}/OneDrive-Acme/app`), true)
    setReadCloudStorageProjects(false)
    assert.strictEqual(mayTouchProject(`${CLOUD}/OneDrive-Acme/app`), false)
    setReadCloudStorageProjects(true)
    assert.strictEqual(mayTouchProject(`${HOME}/Documents/app`), true)
    assert.strictEqual(projectAccessStatus('linux').applicable, false)
  })
})
