import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { drainQueue } from '../../../cloud/forward/sender'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { DeliveryLedger, scopedKey } from '../../../cloud/forward/deliveryLedger'
import { readForwardState } from '../../../cloud/forward/forwardState'
import { setCredentialStore, type CredentialStore } from '../../../cloud/team/credentials'
import type { TeamCredentials } from '../../../cloud/team/config'
import type { RollupPayload } from '../../../cloud/forward/schema'

const CREDS: TeamCredentials = {
  endpoint: 'https://traceroost.com',
  orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1', role: 'member',
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

  test('202 → recordSent called once with the batch total', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    new ForwardQueue(home).enqueue(payload(ID2))
    stubFetch(() => new Response('', { status: 202 }))
    const calls: Array<[number, number]> = []
    await drainQueue({ baseHome: home, recordSent: (count, at) => calls.push([count, at]) })
    assert.deepStrictEqual(calls.length, 1)
    assert.strictEqual(calls[0][0], 2)
    assert.ok(calls[0][1] > 0)
  })

  test('nothing eligible to send → recordSent is never called', async () => {
    stubFetch(() => new Response('', { status: 202 }))
    let called = false
    const res = await drainQueue({ baseHome: home, recordSent: () => { called = true } })
    assert.strictEqual(res.stopped, 'nothing-eligible')
    assert.strictEqual(called, false)
  })

  test('400 → dropped, not sent → recordSent is never called', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    stubFetch(() => new Response('', { status: 400 }))
    let called = false
    await drainQueue({ baseHome: home, recordSent: () => { called = true } })
    assert.strictEqual(called, false)
  })

  test('a successful send records the item in the delivery ledger, scoped to the install it was sent to', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    const key = scopedKey(CREDS.installId!, `session:${ID1}`)
    assert.strictEqual(new DeliveryLedger(home).isDelivered(key), false)
    stubFetch(() => new Response('', { status: 202 }))
    await drainQueue({ baseHome: home })
    assert.strictEqual(new DeliveryLedger(home).isDelivered(key), true)
    // Not recorded as delivered to some other install that never received it — the exact bug
    // this scoping exists to prevent (a session delivered to install A reading as "already
    // delivered" after a relink mints install B, even of the same org, which never actually got
    // it).
    assert.strictEqual(new DeliveryLedger(home).isDelivered(scopedKey('some-other-install', `session:${ID1}`)), false)
  })

  test('a credential missing installId (written before it existed) self-heals via a token refresh before recording delivery', async () => {
    setCredentialStore(memStore({ ...CREDS, installId: undefined }))
    new ForwardQueue(home).enqueue(payload(ID1))
    stubFetch((url) => {
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600,
          member_id: 'm-1', org_id: 'org-1', install_id: 'install-healed',
        }), { status: 200 })
      }
      return new Response('', { status: 202 })
    })
    await drainQueue({ baseHome: home })
    assert.strictEqual(
      new DeliveryLedger(home).isDelivered(scopedKey('install-healed', `session:${ID1}`)),
      true,
    )
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
        return new Response(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, member_id: 'm-1', org_id: 'org-1', install_id: 'install-1' }), { status: 200 })
      }
      ingestCalls++
      return new Response('', { status: ingestCalls === 1 ? 401 : 202 })
    })
    const res = await drainQueue({ baseHome: home })
    assert.strictEqual(res.sent, 1)
    assert.strictEqual(new ForwardQueue(home).depth(), 0)
  })

  test('401 with the refresh token rejected (invalid_grant) → credential cleared, queue kept, one notice', async () => {
    const store = memStore(CREDS)
    setCredentialStore(store)
    new ForwardQueue(home).enqueue(payload(ID1))
    const notices: string[] = []
    stubFetch((url) => {
      if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      return new Response('', { status: 401 })
    })
    const res = await drainQueue({ baseHome: home, notify: (m) => notices.push(m) })
    assert.strictEqual(res.stopped, 'auth-failed')
    assert.strictEqual(notices.length, 1)
    // Unlike a transient refresh failure, this credential will never refresh successfully again
    // — it's cleared so the Team panel drops back to "Unlinked" (with its "Link this machine"
    // button) rather than staying stuck on "Paused" forever.
    assert.strictEqual(store.load(), null)
    assert.strictEqual(readForwardState(home).paused, false)
    // The queued rollup itself is still good data — only the credential died — so it's kept for
    // whenever this machine gets re-linked.
    assert.strictEqual(new ForwardQueue(home).depth(), 1)
  })

  test('401 with a transient refresh failure (5xx from the token endpoint) → paused, one notice, credential kept', async () => {
    const store = memStore(CREDS)
    setCredentialStore(store)
    new ForwardQueue(home).enqueue(payload(ID1))
    const notices: string[] = []
    stubFetch((url) => {
      if (url.endsWith('/oauth/token')) return new Response('', { status: 500 })
      return new Response('', { status: 401 })
    })
    const res = await drainQueue({ baseHome: home, notify: (m) => notices.push(m) })
    assert.strictEqual(res.stopped, 'auth-failed')
    assert.strictEqual(notices.length, 1)
    // A 5xx from the token endpoint says nothing about whether this credential is still good —
    // unlike invalid_grant above, it's kept so the next drain just tries again.
    assert.notStrictEqual(store.load(), null)
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

  test('500 → both items kept with a bumped attempt count (backoff); drain reports offline but does not stop early', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    new ForwardQueue(home).enqueue(payload(ID2))
    stubFetch(() => new Response('', { status: 500 }))
    const res = await drainQueue({ baseHome: home })
    assert.strictEqual(res.stopped, 'offline')
    assert.strictEqual(new ForwardQueue(home).depth(), 2)
    // Both items were attempted — a failure on one no longer stops the batch before the other
    // is even tried.
    assert.ok(new ForwardQueue(home).list().every(it => it.attempts === 1))
  })

  test('a network failure on one item does not block the rest of the batch', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    new ForwardQueue(home).enqueue(payload(ID2))
    stubFetch((_url, init) => {
      if (String(init?.body).includes(ID1)) throw new TypeError('fetch failed')
      return new Response('', { status: 202 })
    })
    const res = await drainQueue({ baseHome: home })
    assert.strictEqual(res.sent, 1)
    assert.strictEqual(res.stopped, 'offline') // the ID1 failure is still surfaced
    const remaining = new ForwardQueue(home).list()
    assert.strictEqual(remaining.length, 1)
    assert.strictEqual(remaining[0].key, `session:${ID1}`)
    assert.strictEqual(remaining[0].attempts, 1)
  })

  test('a duplicate delivery is a no-op on the client (idempotent enqueue)', async () => {
    const q = new ForwardQueue(home)
    q.enqueue(payload(ID1))
    q.enqueue(payload(ID1))
    assert.strictEqual(q.depth(), 1)
  })

  test('onItemDone fires once per sent item, with the queue already down by one at each call — not just once at the end of the batch', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    new ForwardQueue(home).enqueue(payload(ID2))
    stubFetch(() => new Response('', { status: 202 }))
    const depthsAtCallTime: number[] = []
    const res = await drainQueue({ baseHome: home, onItemDone: () => depthsAtCallTime.push(new ForwardQueue(home).depth()) })
    assert.strictEqual(res.sent, 2)
    // Fired twice (once per item), and each call already sees that item's removal reflected on
    // disk — a live progress indicator reading the queue mid-drain gets the true count, not the
    // pre-drain total until the very end.
    assert.deepStrictEqual(depthsAtCallTime, [1, 0])
  })

  test('onItemDone also fires for a permanently-dropped (400) item, but not for one merely backed off for retry', async () => {
    new ForwardQueue(home).enqueue(payload(ID1))
    new ForwardQueue(home).enqueue(payload(ID2))
    stubFetch((_url, init) => {
      if (String(init?.body).includes(ID1)) return new Response('bad payload', { status: 400 })
      return new Response('', { status: 500 })
    })
    let calls = 0
    const res = await drainQueue({ baseHome: home, onItemDone: () => { calls++ } })
    assert.strictEqual(res.droppedInvalid, 1)
    assert.strictEqual(calls, 1) // the 400 drop, not the 500 (still queued for retry)
  })
})
