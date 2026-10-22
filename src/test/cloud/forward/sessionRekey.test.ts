import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { decodeBody } from './decodeBody'
import { drainQueue, resetServerCapabilities } from '../../../cloud/forward/sender'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { DeliveryLedger, DroppedLedger, scopedKey } from '../../../cloud/forward/deliveryLedger'
import { RekeyLedger, ownerSessionId, wireSessionId, rekeyLedgerPath } from '../../../cloud/forward/sessionRekey'
import { previewManifestChunk } from '../../../cloud/forward/traceManifest'
import { matchLocalSessions } from '../../../cloud/org/clusterResolve'
import { maybeEnqueueSession } from '../../../cloud/org/enqueueSession'
import { setCredentialStore, type CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'
import type { RollupPayload } from '../../../cloud/forward/schema'
import type { TraceManifestSource } from '../../../cloudBridge'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'
import { toUuid } from '../../../traceIdentity'

// The machine is now linked as m-2. The cloud already holds some of its traces for m-1 — the
// developer who had this machine linked before (or the same traces sent to another org).
const CREDS: OrgCredentials = {
  endpoint: 'https://stage.traceroost.com',
  orgId: 'org-1', installId: 'install-2', orgName: 'Acme', memberId: 'm-2', role: 'developer',
  perDeveloperVisibility: false,
  accessToken: 'access-1', refreshToken: 'refresh-1',
  accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
}
const OWNER = { orgId: CREDS.orgId, memberId: CREDS.memberId }

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

function memStore(initial: OrgCredentials | null): CredentialStore {
  let cur = initial
  return { load: () => cur, save: c => { cur = c }, clear: () => { cur = null } }
}

function payload(id: string): RollupPayload {
  return {
    schema_version: '1', repo_key_fp: 'a'.repeat(64),
    session: { session_id: id, agent: 'claude-code', repo_hash: 'b'.repeat(64), started_at: '2026-03-01T00:00:00.000Z', duration_ms: 1, source_rank: 2, host_id: '0a0a0a0a-1111-4111-8111-aaaaaaaaaaaa' },
  }
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

const realFetch = globalThis.fetch
const realHome = process.env.HOME
const realUserProfile = process.env.USERPROFILE

suite('forward/sessionRekey', () => {
  let home: string
  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-rekey-'))
    // enqueueSession / clusterResolve read the default home — pointed here.
    process.env.HOME = home
    process.env.USERPROFILE = home
    setCredentialStore(memStore(CREDS))
    resetServerCapabilities()
  })
  teardown(() => {
    globalThis.fetch = realFetch
    setCredentialStore(undefined)
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    fs.rmSync(home, { recursive: true, force: true })
  })

  suite('ids', () => {
    test('an owner id is a stable UUID, distinct per org and per member, and never the plain id', () => {
      const a = ownerSessionId(OWNER, ID1)
      assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.strictEqual(ownerSessionId(OWNER, ID1.toUpperCase()), a)
      assert.notStrictEqual(a, ID1)
      assert.notStrictEqual(ownerSessionId({ ...OWNER, memberId: 'm-3' }, ID1), a)
      assert.notStrictEqual(ownerSessionId({ ...OWNER, orgId: 'org-9' }, ID1), a)
    })

    test('a session keeps its plain id until re-keyed, and only for the owner it was re-keyed for', () => {
      const rekeys = new RekeyLedger(home)
      assert.strictEqual(rekeys.wireId(OWNER, ID1), ID1)
      rekeys.markRekeyed(OWNER, ID1)
      assert.strictEqual(rekeys.wireId(OWNER, ID1), ownerSessionId(OWNER, ID1))
      assert.strictEqual(rekeys.wireId({ ...OWNER, memberId: 'm-1' }, ID1), ID1)
      assert.strictEqual(rekeys.wireId(OWNER, ID2), ID2)
      assert.strictEqual(wireSessionId(null, ID1, home), ID1)
    })

    test('isOwnerId recognizes only an owner id minted for that owner', () => {
      const rekeys = new RekeyLedger(home)
      rekeys.markRekeyed(OWNER, ID1)
      assert.strictEqual(rekeys.isOwnerId(OWNER, ownerSessionId(OWNER, ID1)), true)
      assert.strictEqual(rekeys.isOwnerId(OWNER, ID1), false)
      assert.strictEqual(rekeys.isOwnerId({ ...OWNER, memberId: 'm-3' }, ownerSessionId(OWNER, ID1)), false)
    })
  })

  suite('sender', () => {
    /** A cloud that holds `ownedElsewhere` for someone else and accepts everything else — answering
     *  the refusal as 409 only to a client that sent the accepts header, like cloud persist.ts. */
    function fakeCloud(ownedElsewhere: Set<string>, opts: { batch?: boolean } = {}) {
      const seen: { id: string; accepts: string | null }[] = []
      globalThis.fetch = (async (u: unknown, i?: unknown) => {
        const url = String(u)
        const init = i as RequestInit
        const accepts = new Headers(init.headers).get('x-traceroost-accepts')
        const answer = (p: RollupPayload) => {
          const id = p.session!.session_id
          seen.push({ id, accepts })
          return ownedElsewhere.has(id) && accepts === 'session-owner-conflict'
            ? { status: 409, error: 'session_owned_elsewhere' }
            : ownedElsewhere.has(id) ? { status: 200 } : { status: 202 }
        }
        if (url.endsWith('/api/ingest/batch')) {
          if (opts.batch === false) return new Response('', { status: 404 })
          const items = (JSON.parse(decodeBody(init.body, init.headers)) as { items: RollupPayload[] }).items
          return new Response(JSON.stringify({ results: items.map(answer) }), { status: 200 })
        }
        const r = answer(JSON.parse(decodeBody(init.body, init.headers)) as RollupPayload)
        return new Response(JSON.stringify(r.error ? { error: r.error } : { received: true }), { status: r.status })
      }) as typeof fetch
      return seen
    }

    for (const batch of [true, false]) {
      test(`a session another member holds is re-sent under this owner's id, and only that id is recorded delivered (${batch ? 'batch' : 'single-item'} route)`, async () => {
        const seen = fakeCloud(new Set([ID1]), { batch })
        const queue = new ForwardQueue(home)
        queue.enqueue(payload(ID1))
        queue.enqueue(payload(ID2))

        const first = await drainQueue({ baseHome: home })
        assert.strictEqual(first.sent, 1)
        assert.strictEqual(first.rekeyed, 1)
        assert.strictEqual(first.remaining, 1)
        assert.strictEqual(first.stopped, null) // the scheduler drains again right away
        assert.deepStrictEqual(queue.list().map(it => it.key), [`session:${ownerSessionId(OWNER, ID1)}`])
        assert.strictEqual(queue.list()[0].attempts, 0)

        const second = await drainQueue({ baseHome: home })
        assert.strictEqual(second.sent, 1)
        assert.strictEqual(second.remaining, 0)
        assert.ok(seen.every(s => s.accepts === 'session-owner-conflict'))
        assert.deepStrictEqual(seen.map(s => s.id).filter(id => id !== ID2), [ID1, ownerSessionId(OWNER, ID1)])

        const ledger = new DeliveryLedger(home)
        assert.strictEqual(ledger.isDelivered(scopedKey(CREDS.installId!, `session:${ID1}`)), false)
        assert.strictEqual(ledger.isDelivered(scopedKey(CREDS.installId!, `session:${ownerSessionId(OWNER, ID1)}`)), true)
        assert.strictEqual(new RekeyLedger(home).wireId(OWNER, ID1), ownerSessionId(OWNER, ID1))
      })
    }

    test('an owner id the cloud refuses too is dropped, not re-keyed again', async () => {
      new RekeyLedger(home).markRekeyed(OWNER, ID1)
      fakeCloud(new Set([ownerSessionId(OWNER, ID1)]))
      new ForwardQueue(home).enqueue(payload(ownerSessionId(OWNER, ID1)))
      const res = await drainQueue({ baseHome: home })
      assert.strictEqual(res.rekeyed, 0)
      assert.strictEqual(res.droppedInvalid, 1)
      assert.strictEqual(res.remaining, 0)
      assert.strictEqual(new DroppedLedger(home).isDropped(scopedKey(CREDS.installId!, `session:${ownerSessionId(OWNER, ID1)}`)), true)
    })
  })

  suite('every wire id follows the re-key', () => {
    test('a re-keyed session is built, queued and ledger-checked under its owner id', async () => {
      const plain = toUuid('local-session-1')
      new RekeyLedger(home).markRekeyed(OWNER, plain)
      const res = await maybeEnqueueSession(card('local-session-1'))
      assert.strictEqual(res.enqueued, true)
      assert.deepStrictEqual(new ForwardQueue(home).list().map(it => it.payload.session?.session_id), [ownerSessionId(OWNER, plain)])

      new ForwardQueue(home).clear()
      new DeliveryLedger(home).markDelivered(scopedKey(CREDS.installId!, `session:${ownerSessionId(OWNER, plain)}`))
      assert.deepStrictEqual(await maybeEnqueueSession(card('local-session-1')), { enqueued: false, reason: 'already-delivered' })
    })

    test('the trace manifest lists a re-keyed session by its owner id', () => {
      const day = Date.UTC(2026, 0, 10)
      const source: TraceManifestSource = {
        isWriter: () => true,
        isReady: () => true,
        localHorizonMs: () => day,
        listTraceKeys: (from, to) => (day + 3600_000 >= from && day + 3600_000 <= to ? [ID1, ID2] : []),
        countTraces: (from, to) => (day + 3600_000 >= from && day + 3600_000 <= to ? 2 : 0),
      }
      new RekeyLedger(home).markRekeyed(OWNER, ID1)
      const chunk = previewManifestChunk(source, '0a0a0a0a-1111-4111-8111-aaaaaaaaaaaa', day + 3 * 86_400_000, home)!
      assert.deepStrictEqual([...chunk.keys].sort(), [ownerSessionId(OWNER, ID1), ID2].sort())
    })

    test('a cluster names a re-keyed session by its owner id, and it still matches locally', () => {
      new RekeyLedger(home).markRekeyed(OWNER, toUuid('s1'))
      const local = [card('s1'), card('s2')]
      const { matched } = matchLocalSessions({ sessionIds: [ownerSessionId(OWNER, toUuid('s1')), toUuid('s2')], sessions: 2, members: 2, files: 1, topTools: [] }, local)
      assert.deepStrictEqual(matched.map(m => m.sessionId).sort(), ['s1', 's2'])
    })

    test('the ledger lives beside the other forwarding files', () => {
      new RekeyLedger(home).markRekeyed(OWNER, ID1)
      assert.ok(fs.existsSync(rekeyLedgerPath(home)))
    })
  })
})
