import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { maybeForwardOnContentChange } from '../../reconcile/contentChangeForward'
import { ReconciliationService } from '../../reconcile/reconciliationService'
import { SCHEMA_SQL } from '../../database/schema'
import { setCredentialStore } from '../../cloud/org/credentials'
import type { CredentialStore } from '../../cloud/org/credentials'
import type { OrgCredentials } from '../../cloud/org/config'
import { ForwardQueue } from '../../cloud/forward/queue'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  export(): Uint8Array
  close(): void
}

async function openInMemoryDb(): Promise<SqlDb> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

function memoryStore(overrides: Partial<OrgCredentials> = {}): CredentialStore {
  let cur: OrgCredentials | null = {
    endpoint: 'https://test.traceroost.com', orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1', role: 'developer',
    perDeveloperVisibility: false, accessToken: 'a', refreshToken: 'r',
    accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
    ...overrides,
  }
  return { load: () => cur, save: (c) => { cur = c }, clear: () => { cur = null } }
}

function makeCard(id: string, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: id, traceId: 'trace-' + id, source: 'copilot', dataSource: 'otel', workspace: '/tmp/not-a-repo-' + id,
    userRequest: 'test', model: 'gpt-4o', turns: 1,
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: '2026-01-01T00:00:00.000Z',
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

const realHome = process.env.HOME
const realUserProfile = process.env.USERPROFILE

suite('reconcile/contentChangeForward', () => {
  let home: string
  let service: ReconciliationService

  setup(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-content-change-'))
    process.env.HOME = home // ForwardQueue() has no injectable baseHome here
    process.env.USERPROFILE = home // what os.homedir() reads on Windows
    setCredentialStore(memoryStore())
    service = new ReconciliationService(await openInMemoryDb())
  })

  teardown(() => {
    setCredentialStore(undefined)
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('not linked → no-op, nothing touched', async () => {
    setCredentialStore((() => { let cur: OrgCredentials | null = null; return { load: () => cur, save: (c: OrgCredentials) => { cur = c }, clear: () => { cur = null } } })())
    const res = await maybeForwardOnContentChange(service, makeCard('s1'))
    assert.deepStrictEqual(res, { enqueued: false, reason: 'not-linked' })
    assert.strictEqual(new ForwardQueue().depth(), 0)
  })

  test('a session never checked before is a change — gets enqueued under revision 1', async () => {
    const res = await maybeForwardOnContentChange(service, makeCard('s1'))
    assert.strictEqual(res.enqueued, true)
    const queued = new ForwardQueue().list()
    assert.strictEqual(queued.length, 1)
    assert.strictEqual(queued[0].payload.session?.revision, 1)
  })

  test('re-checking the identical card is not a change — skipped, queue untouched', async () => {
    await maybeForwardOnContentChange(service, makeCard('s1'))
    const res = await maybeForwardOnContentChange(service, makeCard('s1'))
    assert.deepStrictEqual(res, { enqueued: false, reason: 'duplicate' })
    assert.strictEqual(new ForwardQueue().depth(), 1)
  })

  test('a session whose duration grew after its first send is re-forwarded under a new revision', async () => {
    await maybeForwardOnContentChange(service, makeCard('s1', { durationMs: 1000 }))
    const res = await maybeForwardOnContentChange(service, makeCard('s1', { durationMs: 5000 }))
    assert.strictEqual(res.enqueued, true)
    const queued = new ForwardQueue().list()
    assert.strictEqual(queued.length, 1, 'replaces the still-unsent snapshot in place rather than queuing twice')
    assert.strictEqual(queued[0].payload.session?.revision, 2)
    assert.strictEqual(queued[0].payload.session?.duration_ms, 5000)
  })

  test('two different sessions are tracked independently', async () => {
    await maybeForwardOnContentChange(service, makeCard('s1'))
    await maybeForwardOnContentChange(service, makeCard('s2'))
    assert.strictEqual(new ForwardQueue().depth(), 2)
  })
})
