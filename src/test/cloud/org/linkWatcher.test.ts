import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startLinkWatcher, markLinkStateSeen, type LinkWatcher } from '../../../cloud/org/linkWatcher'
import { setCredentialStore, type CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { toUuid } from '../../../cloud/forward/buildSessionRollup'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'

function memoryStore(): CredentialStore & { set(c: OrgCredentials | null): void } {
  let cur: OrgCredentials | null = null
  return { load: () => cur, save: (c) => { cur = c }, clear: () => { cur = null }, set: (c) => { cur = c } }
}

function makeCreds(overrides: Partial<OrgCredentials> = {}): OrgCredentials {
  return {
    endpoint: 'https://stage.traceroost.com', orgId: 'org-1', installId: 'install-1', orgName: 'Acme',
    memberId: 'mem-1', role: 'developer', perDeveloperVisibility: false,
    accessToken: 'access-1', refreshToken: 'refresh-1', accessTokenExpiresAt: Date.now() + 3_600_000,
    linkedAt: '2026-10-04T21:01:05.661Z',
    ...overrides,
  }
}

function makeCard(id: string): SessionSummaryCard {
  return {
    sessionId: id, traceId: 'trace-' + id, source: 'copilot', dataSource: 'otel', workspace: '/tmp/not-a-repo-' + id,
    userRequest: 'test', model: 'gpt-4o', turns: 1,
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: '2026-01-01T00:00:00.000Z',
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
  }
}

const realHome = process.env.HOME
const realUserProfile = process.env.USERPROFILE

suite('org/linkWatcher — catching up after a link made outside this process', () => {
  let home: string
  let store: ReturnType<typeof memoryStore>
  let watcher: LinkWatcher | undefined
  const cards = [makeCard('s1'), makeCard('s2'), makeCard('s3')]
  const queuedKeys = () => new Set(new ForwardQueue().list().map(it => it.key))

  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-linkwatch-'))
    process.env.HOME = home // ForwardQueue() and the ledger have no injectable baseHome
    process.env.USERPROFILE = home
    store = memoryStore()
    setCredentialStore(store)
  })

  teardown(() => {
    watcher?.dispose()
    watcher = undefined
    setCredentialStore(undefined)
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('a link that appears while running queues every local trace not yet sent', async () => {
    watcher = startLinkWatcher({ allLocalSessions: () => cards })
    store.set(makeCreds()) // e.g. `traceroost org link` in a terminal
    await watcher.checkNow()
    assert.deepStrictEqual(queuedKeys(), new Set(['s1', 's2', 's3'].map(id => `session:${toUuid(id)}`)))
  })

  test('already linked at startup: left to the startup pass, not queued again by the watcher', async () => {
    store.set(makeCreds())
    watcher = startLinkWatcher({ allLocalSessions: () => cards })
    await watcher.checkNow()
    assert.strictEqual(queuedKeys().size, 0)
  })

  test('a token refresh rewrites the credential but is not a new link', async () => {
    store.set(makeCreds())
    watcher = startLinkWatcher({ allLocalSessions: () => cards })
    store.set(makeCreds({ accessToken: 'access-2', accessTokenExpiresAt: Date.now() + 7_200_000 }))
    await watcher.checkNow()
    assert.strictEqual(queuedKeys().size, 0)
  })

  test('a re-link (new linkedAt), even to the same org, catches up again', async () => {
    store.set(makeCreds())
    watcher = startLinkWatcher({ allLocalSessions: () => cards })
    store.set(makeCreds({ installId: 'install-2', linkedAt: '2026-10-05T09:00:00.000Z' }))
    await watcher.checkNow()
    assert.strictEqual(queuedKeys().size, 3)
  })

  test('a process that is not the data dir\'s writer leaves the history to the one that is', async () => {
    watcher = startLinkWatcher({ allLocalSessions: () => cards, isWriter: () => false })
    store.set(makeCreds())
    await watcher.checkNow()
    assert.strictEqual(queuedKeys().size, 0)
  })

  test('a link seen while the store is still loading is retried once it is ready', async () => {
    let ready = false
    watcher = startLinkWatcher({ allLocalSessions: () => cards, isReady: () => ready, intervalMs: 20 })
    store.set(makeCreds())
    await watcher.checkNow()
    assert.strictEqual(queuedKeys().size, 0, 'nothing queued against a half-loaded store')
    ready = true
    await new Promise(resolve => setTimeout(resolve, 150)) // the retry timer, not a file change
    assert.strictEqual(queuedKeys().size, 3)
  })

  test('the panel\'s own link marks the state seen, so the history is not queued a second time', async () => {
    const logs: string[] = []
    watcher = startLinkWatcher({ allLocalSessions: () => cards, log: (m) => logs.push(m) })
    store.set(makeCreds())
    markLinkStateSeen() // what panelController does right after linkInteractive / linkViaDevice
    await watcher.checkNow()
    assert.strictEqual(queuedKeys().size, 0)
    assert.ok(!logs.some(m => m.includes('linked outside this process')))
  })

  test('link and leave both notify the host so its Org panel refreshes', async () => {
    let changes = 0
    watcher = startLinkWatcher({ allLocalSessions: () => [], onLinkStateChange: () => { changes++ } })
    store.set(makeCreds())
    await watcher.checkNow()
    store.set(null)
    await watcher.checkNow()
    assert.strictEqual(changes, 2)
  })
})
