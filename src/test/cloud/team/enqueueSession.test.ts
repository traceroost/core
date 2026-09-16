import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { maybeEnqueueSession } from '../../../cloud/team/enqueueSession'
import { setCredentialStore } from '../../../cloud/team/credentials'
import type { CredentialStore } from '../../../cloud/team/credentials'
import type { TeamCredentials } from '../../../cloud/team/config'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { DeliveryLedger } from '../../../cloud/forward/deliveryLedger'
import { toUuid } from '../../../cloud/forward/buildSessionRollup'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'

function memoryStore(): CredentialStore {
  let cur: TeamCredentials | null = {
    endpoint: 'https://test.traceroost.com', orgId: 'org-1', orgName: 'Acme', memberId: 'm-1', role: 'member',
    perDeveloperVisibility: false, accessToken: 'a', refreshToken: 'r',
    accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
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

suite('team/enqueueSession', () => {
  let home: string

  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-enqueue-'))
    process.env.HOME = home // ForwardQueue()/DeliveryLedger() have no injectable baseHome here
    setCredentialStore(memoryStore())
  })

  teardown(() => {
    setCredentialStore(undefined)
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('not linked → no-op, nothing touched', async () => {
    setCredentialStore((() => { let cur: TeamCredentials | null = null; return { load: () => cur, save: (c: TeamCredentials) => { cur = c }, clear: () => { cur = null } } })())
    const res = await maybeEnqueueSession(makeCard('s1'))
    assert.deepStrictEqual(res, { enqueued: false, reason: 'not-linked' })
    assert.strictEqual(new ForwardQueue().depth(), 0)
  })

  test('a session never sent before gets enqueued', async () => {
    const res = await maybeEnqueueSession(makeCard('s1'))
    assert.strictEqual(res.enqueued, true)
    assert.strictEqual(new ForwardQueue().depth(), 1)
  })

  test('a session already confirmed delivered is skipped — not rebuilt, not re-enqueued', async () => {
    new DeliveryLedger().markDelivered(`session:${toUuid('s1')}`)
    const res = await maybeEnqueueSession(makeCard('s1'))
    assert.deepStrictEqual(res, { enqueued: false, reason: 'already-delivered' })
    assert.strictEqual(new ForwardQueue().depth(), 0, 'must not have been added to the queue')
  })

  test('a still-queued (not yet delivered) session is not affected by the ledger check', async () => {
    // First call enqueues it (not yet delivered); a second call before any drain should report
    // 'duplicate' (already queued), not 'already-delivered' (confirmed sent) — those are
    // different states and the panel/logs should be able to tell them apart.
    await maybeEnqueueSession(makeCard('s1'))
    const res = await maybeEnqueueSession(makeCard('s1'))
    assert.deepStrictEqual(res, { enqueued: false, reason: 'duplicate' })
  })
})
