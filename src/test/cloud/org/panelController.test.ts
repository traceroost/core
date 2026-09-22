import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import { handleOrgMessage, type OrgPanelDeps } from '../../../cloud/org/panelController'
import { setCredentialStore } from '../../../cloud/org/credentials'
import type { CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { DeliveryLedger, scopedKey } from '../../../cloud/forward/deliveryLedger'
import { toUuid } from '../../../cloud/forward/buildSessionRollup'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'

function memoryStore(): CredentialStore {
  let cur: OrgCredentials | null = null
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

type FetchArgs = Parameters<typeof fetch>
const realFetch = globalThis.fetch
const realHome = process.env.HOME

/**
 * Simulates the browser: reads the authorize URL, hits the loopback redirect with code+state.
 * Resolves once the request is sent, not once the response completes — the server holds that
 * response open until `linkInteractive()` itself calls `finish()` (after the exchange), so
 * waiting for it here would deadlock against the very call this is meant to unblock.
 */
function fakeBrowser() {
  return (authorizeUrl: string) =>
    new Promise<void>((resolve, reject) => {
      const u = new URL(authorizeUrl)
      const redirectUri = u.searchParams.get('redirect_uri')!
      const state = u.searchParams.get('state')!
      const req = http.get(`${redirectUri}?code=testcode&state=${encodeURIComponent(state)}`, res => {
        res.resume()
      })
      req.on('error', reject)
      req.on('finish', () => resolve())
    })
}

function baseDeps(overrides: Partial<OrgPanelDeps> = {}): OrgPanelDeps {
  return {
    post: () => {},
    openExternal: (url) => fakeBrowser()(url),
    recentSessions: () => [],
    log: () => {},
    ...overrides,
  }
}

suite('org/panelController — link back-fill and reconciliation', () => {
  let home: string

  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-panelctl-'))
    process.env.HOME = home // ForwardQueue() has no injectable baseHome — sandbox via HOME
    setCredentialStore(memoryStore())
    globalThis.fetch = (async (input: FetchArgs[0]) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer',
          expires_in: 3600, member_id: 'mem-1', org_id: 'org-new-team', install_id: 'install-new-team',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/roster/me')) {
        return new Response(JSON.stringify({ org_name: 'New Team', role: 'member', per_developer_visibility: false, email: 'dev@example.com' }), { status: 200 })
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as typeof fetch
  })

  teardown(() => {
    globalThis.fetch = realFetch
    setCredentialStore(undefined)
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('linking queues every existing local session, not just ones that close afterward', async () => {
    const cards = [makeCard('s1'), makeCard('s2'), makeCard('s3')]
    await handleOrgMessage({ type: 'orgLink' }, baseDeps({ allLocalSessions: () => cards }))

    // The back-fill is fire-and-forget (local file I/O, not a network call) — give its
    // sequential per-card enqueue loop a tick to finish.
    await new Promise(resolve => setTimeout(resolve, 300))

    const queued = new ForwardQueue().list()
    assert.strictEqual(queued.length, 3)
    // Local session ids aren't always UUID-shaped (log-ingested sources use their own scheme);
    // the wire form runs every id through toUuid() first — see buildSessionRollup.ts.
    assert.deepStrictEqual(
      new Set(queued.map(it => it.key)),
      new Set(['s1', 's2', 's3'].map(id => `session:${toUuid(id)}`)),
    )
  })

  test('without allLocalSessions the host just skips the back-fill — no crash', async () => {
    await handleOrgMessage({ type: 'orgLink' }, baseDeps())
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.strictEqual(new ForwardQueue().depth(), 0)
  })

  test('orgReconcile queues sessions not yet confirmed delivered and reports the count', async () => {
    await handleOrgMessage({ type: 'orgLink' }, baseDeps()) // link with no allLocalSessions — queue starts empty
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.strictEqual(new ForwardQueue().depth(), 0)

    const posted: Record<string, unknown>[] = []
    const cards = [makeCard('r1'), makeCard('r2')]
    await handleOrgMessage({ type: 'orgReconcile' }, baseDeps({ allLocalSessions: () => cards, post: (m) => posted.push(m) }))

    assert.strictEqual(new ForwardQueue().depth(), 2)
    const result = posted.find(m => m.type === 'orgReconcileResult')
    assert.deepStrictEqual(result, { type: 'orgReconcileResult', queued: 2 })
  })

  test('orgReconcile skips a session already recorded as delivered — reports 0, does not re-queue it', async () => {
    await handleOrgMessage({ type: 'orgLink' }, baseDeps())
    await new Promise(resolve => setTimeout(resolve, 100))

    new DeliveryLedger().markDelivered(scopedKey('install-new-team', `session:${toUuid('r1')}`))
    const posted: Record<string, unknown>[] = []
    await handleOrgMessage({ type: 'orgReconcile' }, baseDeps({ allLocalSessions: () => [makeCard('r1')], post: (m) => posted.push(m) }))

    assert.strictEqual(new ForwardQueue().depth(), 0)
    assert.deepStrictEqual(posted.find(m => m.type === 'orgReconcileResult'), { type: 'orgReconcileResult', queued: 0 })
  })

  test('relinking (even to the SAME org) re-delivers a session the old install already has but the new install never received', async () => {
    // The exact real-world bug: link (install A), a session is confirmed delivered to A, leave,
    // relink — the server mints a brand-new install B, even for the same org. B never got that
    // session, so reconciling after the relink must queue it again, not skip it as "already
    // delivered" (that check has to be scoped per-install, not per-org — a relink alone, with no
    // org switch at all, already reproduces this).
    await handleOrgMessage({ type: 'orgLink' }, baseDeps()) // links install 'install-new-team', per the module-level fetch stub
    await new Promise(resolve => setTimeout(resolve, 100))
    new DeliveryLedger().markDelivered(scopedKey('install-new-team', `session:${toUuid('shared')}`))

    globalThis.fetch = (async (input: FetchArgs[0]) => {
      const url = String(input)
      if (url.endsWith('/oauth/revoke')) return new Response('{"ok":true}', { status: 200 })
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as typeof fetch
    await handleOrgMessage({ type: 'orgLeave' }, baseDeps())

    globalThis.fetch = (async (input: FetchArgs[0]) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'Bearer',
          // Same org as before — this is a relink, not a switch — but a fresh install id, exactly
          // like the real server does on every `exchangeCode`.
          expires_in: 3600, member_id: 'mem-2', org_id: 'org-new-team', install_id: 'install-relinked',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/roster/me')) {
        return new Response(JSON.stringify({ org_name: 'New Team', role: 'member', per_developer_visibility: false, email: 'dev2@example.com' }), { status: 200 })
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as typeof fetch
    await handleOrgMessage({ type: 'orgLink' }, baseDeps())
    await new Promise(resolve => setTimeout(resolve, 100))

    const posted: Record<string, unknown>[] = []
    await handleOrgMessage({ type: 'orgReconcile' }, baseDeps({ allLocalSessions: () => [makeCard('shared')], post: (m) => posted.push(m) }))

    assert.deepStrictEqual(posted.find(m => m.type === 'orgReconcileResult'), { type: 'orgReconcileResult', queued: 1 })
    assert.strictEqual(new ForwardQueue().list()[0]?.key, `session:${toUuid('shared')}`)
  })

  test('orgReconcile reports progress as it works through local sessions', async () => {
    await handleOrgMessage({ type: 'orgLink' }, baseDeps())
    await new Promise(resolve => setTimeout(resolve, 100))

    const posted: Record<string, unknown>[] = []
    const cards = [makeCard('p1'), makeCard('p2'), makeCard('p3')]
    await handleOrgMessage({ type: 'orgReconcile' }, baseDeps({ allLocalSessions: () => cards, post: (m) => posted.push(m) }))

    const progress = posted.filter(m => m.type === 'orgReconcileProgress')
    assert.deepStrictEqual(progress, [
      { type: 'orgReconcileProgress', done: 1, total: 3 },
      { type: 'orgReconcileProgress', done: 2, total: 3 },
      { type: 'orgReconcileProgress', done: 3, total: 3 },
    ])
  })

  test('orgReconcile always replies, even when reading local sessions throws — no permanent "Checking…"', async () => {
    const posted: Record<string, unknown>[] = []
    await handleOrgMessage({ type: 'orgReconcile' }, baseDeps({
      allLocalSessions: () => { throw new Error('log directory unreadable') },
      post: (m) => posted.push(m),
    }))

    assert.deepStrictEqual(
      posted.find(m => m.type === 'orgReconcileResult'),
      { type: 'orgReconcileResult', queued: 0, error: 'log directory unreadable' },
    )
  })

  test('orgExplainPayload always replies, even when building the preview throws — no permanent "Building…"', async () => {
    const posted: Record<string, unknown>[] = []
    await handleOrgMessage({ type: 'orgExplainPayload' }, baseDeps({
      recentSessions: () => [makeCard('e1')],
      buildPayloadPreview: () => { throw new Error('git subprocess failed') },
      post: (m) => posted.push(m),
    }))

    const preview = posted.find(m => m.type === 'orgPayloadPreview') as { previews: { text: string }[] } | undefined
    assert.ok(preview?.previews[0]?.text.includes('git subprocess failed'))
  })

  test('orgExplainPayload caps at MAX_PAYLOAD_PREVIEW_SESSIONS (5) even with more recent sessions', async () => {
    const posted: Record<string, unknown>[] = []
    let receivedCount = 0
    await handleOrgMessage({ type: 'orgExplainPayload' }, baseDeps({
      recentSessions: () => Array.from({ length: 8 }, (_, i) => makeCard(`e${i}`)),
      buildPayloadPreview: (sessions) => { receivedCount = sessions.length; return sessions.map((s) => s.sessionId) },
      post: (m) => posted.push(m),
    }))

    assert.strictEqual(receivedCount, 5)
    const preview = posted.find(m => m.type === 'orgPayloadPreview') as { previews: { text: string; sessionLabel: string }[] } | undefined
    assert.strictEqual(preview?.previews.length, 5)
  })

  test('orgReconcile processes a backlog larger than the concurrency pool correctly, and reports done in strict order', async () => {
    await handleOrgMessage({ type: 'orgLink' }, baseDeps())
    await new Promise(resolve => setTimeout(resolve, 100))

    // More sessions than the pool's concurrency (6) — exercises the "more work left when a
    // worker finishes" path, not just "everyone gets their own worker".
    const cards = Array.from({ length: 14 }, (_, i) => makeCard(`bulk${i}`))
    const posted: Record<string, unknown>[] = []
    await handleOrgMessage({ type: 'orgReconcile' }, baseDeps({ allLocalSessions: () => cards, post: (m) => posted.push(m) }))

    assert.strictEqual(new ForwardQueue().depth(), 14)
    assert.deepStrictEqual(posted.find(m => m.type === 'orgReconcileResult'), { type: 'orgReconcileResult', queued: 14 })
    const progress = posted.filter(m => m.type === 'orgReconcileProgress') as { done: number; total: number }[]
    assert.strictEqual(progress.length, 14)
    // `done` is assigned as each completion lands, so regardless of which underlying session
    // finishes first, the sequence of posted values is always 1..total in order.
    assert.deepStrictEqual(progress.map(p => p.done), Array.from({ length: 14 }, (_, i) => i + 1))
    assert.ok(progress.every(p => p.total === 14))
  })

  test('orgLinkDevice also starts the forward scheduler (it was silently missing before)', async () => {
    // linkViaDevice polls a *different* endpoint than the interactive flow — stub the
    // device-code request and its poll separately (see oauthClient.ts startDeviceFlow /
    // pollDeviceFlow).
    globalThis.fetch = (async (input: FetchArgs[0]) => {
      const url = String(input)
      if (url.endsWith('/oauth/device/code')) {
        return new Response(JSON.stringify({
          device_code: 'dc-1', user_code: 'ABCD-1234', verification_uri: 'https://test.traceroost.com/oauth/device',
          expires_in: 600, interval: 1,
        }), { status: 200 })
      }
      if (url.endsWith('/oauth/device/token')) {
        return new Response(JSON.stringify({
          access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer',
          expires_in: 3600, member_id: 'mem-1', org_id: 'org-new-team', install_id: 'install-device-1',
        }), { status: 200 })
      }
      if (url.includes('/api/roster/me')) {
        return new Response(JSON.stringify({ org_name: 'New Team', role: 'member', per_developer_visibility: false, email: 'dev@example.com' }), { status: 200 })
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as typeof fetch

    const cards = [makeCard('d1')]
    await handleOrgMessage({ type: 'orgLinkDevice' }, baseDeps({ allLocalSessions: () => cards }))
    await new Promise(resolve => setTimeout(resolve, 300))

    const queued = new ForwardQueue().list()
    assert.strictEqual(queued.length, 1)
    assert.strictEqual(queued[0].key, `session:${toUuid('d1')}`)
  })
})
