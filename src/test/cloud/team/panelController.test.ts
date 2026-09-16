import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import { handleTeamMessage, type TeamPanelDeps } from '../../../cloud/team/panelController'
import { setCredentialStore } from '../../../cloud/team/credentials'
import type { CredentialStore } from '../../../cloud/team/credentials'
import type { TeamCredentials } from '../../../cloud/team/config'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { DeliveryLedger, scopedKey } from '../../../cloud/forward/deliveryLedger'
import { toUuid } from '../../../cloud/forward/buildSessionRollup'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'

function memoryStore(): CredentialStore {
  let cur: TeamCredentials | null = null
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

function baseDeps(overrides: Partial<TeamPanelDeps> = {}): TeamPanelDeps {
  return {
    post: () => {},
    openExternal: (url) => fakeBrowser()(url),
    recentSessions: () => [],
    log: () => {},
    ...overrides,
  }
}

suite('team/panelController — link back-fill and reconciliation', () => {
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
          expires_in: 3600, member_id: 'mem-1', org_id: 'org-new-team',
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
    await handleTeamMessage({ type: 'teamLink' }, baseDeps({ allLocalSessions: () => cards }))

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
    await handleTeamMessage({ type: 'teamLink' }, baseDeps())
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.strictEqual(new ForwardQueue().depth(), 0)
  })

  test('teamReconcile queues sessions not yet confirmed delivered and reports the count', async () => {
    await handleTeamMessage({ type: 'teamLink' }, baseDeps()) // link with no allLocalSessions — queue starts empty
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.strictEqual(new ForwardQueue().depth(), 0)

    const posted: Record<string, unknown>[] = []
    const cards = [makeCard('r1'), makeCard('r2')]
    await handleTeamMessage({ type: 'teamReconcile' }, baseDeps({ allLocalSessions: () => cards, post: (m) => posted.push(m) }))

    assert.strictEqual(new ForwardQueue().depth(), 2)
    const result = posted.find(m => m.type === 'teamReconcileResult')
    assert.deepStrictEqual(result, { type: 'teamReconcileResult', queued: 2 })
  })

  test('teamReconcile skips a session already recorded as delivered — reports 0, does not re-queue it', async () => {
    await handleTeamMessage({ type: 'teamLink' }, baseDeps())
    await new Promise(resolve => setTimeout(resolve, 100))

    new DeliveryLedger().markDelivered(scopedKey('org-new-team', `session:${toUuid('r1')}`))
    const posted: Record<string, unknown>[] = []
    await handleTeamMessage({ type: 'teamReconcile' }, baseDeps({ allLocalSessions: () => [makeCard('r1')], post: (m) => posted.push(m) }))

    assert.strictEqual(new ForwardQueue().depth(), 0)
    assert.deepStrictEqual(posted.find(m => m.type === 'teamReconcileResult'), { type: 'teamReconcileResult', queued: 0 })
  })

  test('switching teams re-delivers a session the old team already has but the new team never received', async () => {
    // The exact real-world bug: link org A, a session is confirmed delivered to A, leave, link
    // org B — B never got that session, so reconciling after the switch must queue it again, not
    // skip it as "already delivered" (that check has to be scoped per-org, not global).
    await handleTeamMessage({ type: 'teamLink' }, baseDeps()) // links 'org-new-team', per the module-level fetch stub
    await new Promise(resolve => setTimeout(resolve, 100))
    new DeliveryLedger().markDelivered(scopedKey('org-new-team', `session:${toUuid('shared')}`))

    globalThis.fetch = (async (input: FetchArgs[0]) => {
      const url = String(input)
      if (url.endsWith('/oauth/revoke')) return new Response('{"ok":true}', { status: 200 })
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as typeof fetch
    await handleTeamMessage({ type: 'teamLeave' }, baseDeps())

    globalThis.fetch = (async (input: FetchArgs[0]) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'Bearer',
          expires_in: 3600, member_id: 'mem-2', org_id: 'org-second-team',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/roster/me')) {
        return new Response(JSON.stringify({ org_name: 'Second Team', role: 'member', per_developer_visibility: false, email: 'dev2@example.com' }), { status: 200 })
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as typeof fetch
    await handleTeamMessage({ type: 'teamLink' }, baseDeps())
    await new Promise(resolve => setTimeout(resolve, 100))

    const posted: Record<string, unknown>[] = []
    await handleTeamMessage({ type: 'teamReconcile' }, baseDeps({ allLocalSessions: () => [makeCard('shared')], post: (m) => posted.push(m) }))

    assert.deepStrictEqual(posted.find(m => m.type === 'teamReconcileResult'), { type: 'teamReconcileResult', queued: 1 })
    assert.strictEqual(new ForwardQueue().list()[0]?.key, `session:${toUuid('shared')}`)
  })

  test('teamLinkDevice also starts the forward scheduler (it was silently missing before)', async () => {
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
          expires_in: 3600, member_id: 'mem-1', org_id: 'org-new-team',
        }), { status: 200 })
      }
      if (url.includes('/api/roster/me')) {
        return new Response(JSON.stringify({ org_name: 'New Team', role: 'member', per_developer_visibility: false, email: 'dev@example.com' }), { status: 200 })
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as typeof fetch

    const cards = [makeCard('d1')]
    await handleTeamMessage({ type: 'teamLinkDevice' }, baseDeps({ allLocalSessions: () => cards }))
    await new Promise(resolve => setTimeout(resolve, 300))

    const queued = new ForwardQueue().list()
    assert.strictEqual(queued.length, 1)
    assert.strictEqual(queued[0].key, `session:${toUuid('d1')}`)
  })
})
