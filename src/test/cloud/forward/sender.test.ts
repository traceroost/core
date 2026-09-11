import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { drainQueue } from '../../../cloud/forward/sender'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { readForwardState } from '../../../cloud/forward/forwardState'
import { setCredentialStore, type CredentialStore } from '../../../cloud/team/credentials'
import type { TeamCredentials } from '../../../cloud/team/config'
import type { RollupPayload } from '../../../cloud/forward/schema'

const CREDS: TeamCredentials = {
  endpoint: 'https://app.agentlens.dev',
  orgId: 'org-1', orgName: 'Acme', memberId: 'm-1', role: 'member',
  perDeveloperVisibility: false,
  accessToken: 'access-1', refreshToken: 'refresh-1',
  accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
}

function memStore(initial: TeamCredentials | null): CredentialStore {
  let cur = initial
  return { load: () => cur, save: c => { cur = c }, clear: () => { cur = null } }
}

function payload(id: string): RollupPayload {
  return {
    schema_version: '1', repo_key_fp: 'a'.repeat(64),
    session: { session_id: id, agent: 'claude-code', repo_hash: 'b'.repeat(64), started_at: '2026-03-01T00:00:00.000Z', duration_ms: 1 },
  }
}
const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

const realFetch = globalThis.fetch

suite('forward/sender', () => {
  let home: string
  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-sender-'))
    setCredentialStore(memStore(CREDS))
  })
  teardown(() => {
    globalThis.fetch = realFetch
    setCredentialStore(undefined)
    fs.rmSync(home, { recursive: true, force: true })
  })

  const stubFetch = (handler: (url: string, init?: RequestInit) => Response) => {
    globalThis.fetch = (async (u: unknown, init?: unknown) => handler(String(u), init as RequestInit)) as typeof fetch
  }

  test('no team linked → stops immediately, makes no request', async () => {
    setCredentialStore(memStore(null))
    let called = false
    stubFetch(() => { called = true; return new Response('', { status: 202 }) })
    const res = await drainQueue({ baseHome: home })
    assert.strictEqual(res.stopped, 'not-linked')
    assert.strictEqual(called, false)
  })

  test('202 → item removed and lastSuccessAt recorded', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    stubFetch(() => new Response('', { status: 202 }))
    const res = await drainQueue({ baseHome: home })
    assert.strictEqual(res.sent, 1)
    assert.strictEqual(new ForwardQueue(home).depth(), 0)
    assert.ok(readForwardState(home).lastSuccessAt)
  })

  test('400 → record dropped, never retried', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    stubFetch(() => new Response(JSON.stringify({ error: 'schema validation failed' }), { status: 400 }))
    const res = await drainQueue({ baseHome: home })
    assert.strictEqual(res.droppedInvalid, 1)
    assert.strictEqual(new ForwardQueue(home).depth(), 0)
  })

  test('401 → refresh once, then retry succeeds', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    let ingestCalls = 0
    stubFetch((url) => {
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, member_id: 'm-1', org_id: 'org-1' }), { status: 200 })
      }
      ingestCalls++
      return new Response('', { status: ingestCalls === 1 ? 401 : 202 })
    })
    const res = await drainQueue({ baseHome: home })
    assert.strictEqual(res.sent, 1)
    assert.strictEqual(new ForwardQueue(home).depth(), 0)
  })

  test('401 with a failed refresh → paused, one notice, queue kept', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    const notices: string[] = []
    stubFetch((url) => {
      if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      return new Response('', { status: 401 })
    })
    const res = await drainQueue({ baseHome: home, notify: (m) => notices.push(m) })
    assert.strictEqual(res.stopped, 'auth-failed')
    assert.strictEqual(notices.length, 1)
    assert.strictEqual(new ForwardQueue(home).depth(), 1)
    assert.strictEqual(readForwardState(home).paused, true)
  })

  test('403 → forwarding stops, credential and queue cleared, one notice', async () => {
    const store = memStore(CREDS)
    setCredentialStore(store)
    new ForwardQueue(home).enqueue(payload(ID1))
    const notices: string[] = []
    stubFetch(() => new Response('', { status: 403 }))
    const res = await drainQueue({ baseHome: home, notify: (m) => notices.push(m) })
    assert.strictEqual(res.stopped, 'membership-revoked')
    assert.strictEqual(store.load(), null)
    assert.strictEqual(new ForwardQueue(home).depth(), 0)
    assert.strictEqual(notices.length, 1)
  })

  test('429 → paused per Retry-After, queue kept', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    stubFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '120' } }))
    const res = await drainQueue({ baseHome: home })
    assert.strictEqual(res.stopped, 'rate-limited')
    assert.strictEqual(new ForwardQueue(home).depth(), 1)
    const st = readForwardState(home)
    assert.strictEqual(st.paused, true)
    assert.ok((st.pausedUntil ?? 0) > Date.now())
  })

  test('500 → item kept with a bumped attempt count (backoff), drain stops', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    new ForwardQueue(home).enqueue(payload(ID2))
    stubFetch(() => new Response('', { status: 500 }))
    const res = await drainQueue({ baseHome: home })
    assert.strictEqual(res.stopped, 'offline')
    assert.strictEqual(new ForwardQueue(home).depth(), 2)
    assert.strictEqual(new ForwardQueue(home).list()[0].attempts, 1)
  })

  test('a duplicate delivery is a no-op on the client (idempotent enqueue)', async () => {
    const q = new ForwardQueue(home)
    q.enqueue(payload(ID1))
    q.enqueue(payload(ID1))
    assert.strictEqual(q.depth(), 1)
  })
})
