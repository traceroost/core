import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { currentHostId, loadOrCreateHostId, setHostStore, HOST_ID_FILE, PREVIEW_HOST_ID } from '../../../cloud/org/hostIdentity'
import { maybeEnqueueSession } from '../../../cloud/org/enqueueSession'
import { buildPayloadForCard } from '../../../cloud/org/payloadPreview'
import { setCredentialStore, type CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'
import { ForwardQueue } from '../../../cloud/forward/queue'
import type { RollupPayload } from '../../../cloud/forward/schema'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function store(linked: boolean): CredentialStore {
  let cur: OrgCredentials | null = linked
    ? {
        endpoint: 'https://test.traceroost.com', orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1', role: 'developer',
        perDeveloperVisibility: false, accessToken: 'a', refreshToken: 'r',
        accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
      }
    : null
  return { load: () => cur, save: (c) => { cur = c }, clear: () => { cur = null } }
}

function card(id: string): SessionSummaryCard {
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

suite('org/hostIdentity', () => {
  let home: string
  // The two hosts of one machine: the extension's global storage and the server's data dir.
  let extensionStore: string
  let serverStore: string

  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-host-'))
    extensionStore = path.join(home, 'Code', 'User', 'globalStorage', 'traceroost.traceroost')
    serverStore = path.join(home, '.traceroost')
  })
  teardown(() => {
    setHostStore(undefined)
    setCredentialStore(undefined)
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('generated once per store and stable across restarts', () => {
    const first = loadOrCreateHostId(serverStore)
    assert.match(first, UUID_RE)
    assert.strictEqual(loadOrCreateHostId(serverStore), first)
    // A "restart": a fresh process names the same store again.
    setHostStore(serverStore)
    assert.strictEqual(currentHostId(), first)
    setHostStore(undefined)
    setHostStore(serverStore)
    assert.strictEqual(currentHostId(), first)
  })

  test('the extension and the standalone server get distinct ids', () => {
    const ext = loadOrCreateHostId(extensionStore)
    const srv = loadOrCreateHostId(serverStore)
    assert.notStrictEqual(ext, srv)
    setHostStore(extensionStore)
    assert.strictEqual(currentHostId(), ext)
    setHostStore(serverStore)
    assert.strictEqual(currentHostId(), srv)
  })

  test('the file holds a random uuid and nothing else — nothing derived from the machine', () => {
    const id = loadOrCreateHostId(serverStore)
    const raw = fs.readFileSync(path.join(serverStore, HOST_ID_FILE), 'utf-8')
    assert.strictEqual(raw, id + '\n')
    assert.ok(!raw.includes(os.hostname()))
    assert.ok(!raw.includes(os.userInfo().username))
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(serverStore, HOST_ID_FILE)).mode & 0o777, 0o600)
    // Two stores in the same place on two machines would still differ: it is random, not derived.
    const elsewhere = path.join(home, 'copy', '.traceroost')
    assert.notStrictEqual(loadOrCreateHostId(elsewhere), id)
  })

  test('a corrupt file is replaced with a fresh id', () => {
    fs.mkdirSync(serverStore, { recursive: true })
    fs.writeFileSync(path.join(serverStore, HOST_ID_FILE), 'not a uuid\n')
    const id = loadOrCreateHostId(serverStore)
    assert.match(id, UUID_RE)
    assert.strictEqual(loadOrCreateHostId(serverStore), id)
  })

  test('naming a store writes nothing; a process with no store gets one id for its lifetime', () => {
    setHostStore(serverStore)
    assert.ok(!fs.existsSync(serverStore))
    setHostStore(undefined)
    const a = currentHostId()
    assert.match(a, UUID_RE)
    assert.strictEqual(currentHostId(), a)
  })

  suite('on the wire', () => {
    setup(() => {
      process.env.HOME = home // ForwardQueue() has no injectable baseHome here
      process.env.USERPROFILE = home
    })
    teardown(() => {
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
      if (realUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = realUserProfile
    })

    test('every queued rollup carries this host\'s id', async () => {
      setCredentialStore(store(true))
      setHostStore(extensionStore)
      assert.strictEqual((await maybeEnqueueSession(card('s1'))).enqueued, true)
      const queued = new ForwardQueue().list().map(it => it.payload as RollupPayload)
      assert.strictEqual(queued.length, 1)
      assert.strictEqual(queued[0].session!.host_id, loadOrCreateHostId(extensionStore))
    })

    test('an unlinked preview shows a placeholder and writes no host-id file', async () => {
      setCredentialStore(store(false))
      setHostStore(extensionStore)
      const { payload } = await buildPayloadForCard(card('s2'))
      assert.strictEqual(payload.session!.host_id, PREVIEW_HOST_ID)
      assert.ok(!fs.existsSync(path.join(extensionStore, HOST_ID_FILE)))
    })
  })
})
