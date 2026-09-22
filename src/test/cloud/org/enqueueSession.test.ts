import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { maybeEnqueueSession } from '../../../cloud/org/enqueueSession'
import { setCredentialStore } from '../../../cloud/org/credentials'
import type { CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { DeliveryLedger, scopedKey } from '../../../cloud/forward/deliveryLedger'
import { toUuid } from '../../../cloud/forward/buildSessionRollup'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'

function memoryStore(overrides: Partial<OrgCredentials> = {}): CredentialStore {
  let cur: OrgCredentials | null = {
    endpoint: 'https://test.traceroost.com', orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1', role: 'member',
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

suite('org/enqueueSession', () => {
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
    setCredentialStore((() => { let cur: OrgCredentials | null = null; return { load: () => cur, save: (c: OrgCredentials) => { cur = c }, clear: () => { cur = null } } })())
    const res = await maybeEnqueueSession(makeCard('s1'))
    assert.deepStrictEqual(res, { enqueued: false, reason: 'not-linked' })
    assert.strictEqual(new ForwardQueue().depth(), 0)
  })

  test('a session never sent before gets enqueued', async () => {
    const res = await maybeEnqueueSession(makeCard('s1'))
    assert.strictEqual(res.enqueued, true)
    assert.strictEqual(new ForwardQueue().depth(), 1)
  })

  test('a session already confirmed delivered to the linked install is skipped — not rebuilt, not re-enqueued', async () => {
    new DeliveryLedger().markDelivered(scopedKey('install-1', `session:${toUuid('s1')}`))
    const res = await maybeEnqueueSession(makeCard('s1'))
    assert.deepStrictEqual(res, { enqueued: false, reason: 'already-delivered' })
    assert.strictEqual(new ForwardQueue().depth(), 0, 'must not have been added to the queue')
  })

  test('a session delivered to a DIFFERENT install is not treated as delivered after a relink', async () => {
    // The exact bug this scoping fixes: a session sent to install-old reading as "already
    // delivered" once the machine leaves and relinks — minting install-new, even of the SAME
    // org — silently never reaching install-new at all.
    new DeliveryLedger().markDelivered(scopedKey('install-old', `session:${toUuid('s1')}`))
    const res = await maybeEnqueueSession(makeCard('s1')) // credential store here is linked as 'install-1'
    assert.strictEqual(res.enqueued, true)
    assert.strictEqual(new ForwardQueue().depth(), 1)
  })

  test('a credential missing installId (written before it existed) always enqueues rather than guessing at "already delivered"', async () => {
    // Nothing can safely short-circuit here without an install to scope the check to — see
    // `ensureInstallId` (only `sender.ts`'s drain calls it; this function stays local-only).
    // Enqueueing anyway is safe: `ForwardQueue.enqueue` dedupes by key, and a redundant send is
    // deduplicated server-side too.
    setCredentialStore(memoryStore({ installId: undefined }))
    new DeliveryLedger().markDelivered(scopedKey('install-1', `session:${toUuid('s1')}`))
    const res = await maybeEnqueueSession(makeCard('s1'))
    assert.strictEqual(res.enqueued, true)
    assert.strictEqual(new ForwardQueue().depth(), 1)
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
