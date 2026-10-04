import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startForwardScheduler, beginCatchUp } from '../../../cloud/forward/scheduler'
import type { TraceManifestSource } from '../../../cloudBridge'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { setCredentialStore, type CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'
import type { RollupPayload } from '../../../cloud/forward/schema'

const CREDS: OrgCredentials = {
  endpoint: 'https://traceroost.com',
  orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1', role: 'developer',
  perDeveloperVisibility: false,
  accessToken: 'access-1', refreshToken: 'refresh-1',
  accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
}

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
const ID1 = '11111111-1111-4111-8111-111111111111'

const realFetch = globalThis.fetch

/** A stub for the batch ingest endpoint: every item in the request succeeds. */
function stubBatchOk(onRequest?: () => void): typeof fetch {
  return (async (_url: unknown, init?: unknown) => {
    onRequest?.()
    const items = (JSON.parse(String((init as RequestInit | undefined)?.body)) as { items: unknown[] }).items
    return new Response(JSON.stringify({ results: items.map(() => ({ status: 202 })) }), { status: 200 })
  }) as typeof fetch
}

suite('forward/scheduler', () => {
  let home: string
  setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-scheduler-')) })
  teardown(() => {
    globalThis.fetch = realFetch
    setCredentialStore(undefined)
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('onDrainComplete fires after the drain that starting with a linked credential triggers', async () => {
    setCredentialStore(memStore(CREDS))
    new ForwardQueue(home).enqueue(payload(ID1))
    globalThis.fetch = stubBatchOk()

    let calls = 0
    const scheduler = startForwardScheduler({ baseHome: home, onDrainComplete: () => { calls++ } })
    await new Promise(resolve => setTimeout(resolve, 100))
    scheduler.dispose()

    assert.ok(calls >= 1, 'onDrainComplete should have fired at least once')
    assert.strictEqual(new ForwardQueue(home).depth(), 0)
  })

  test('onDrainComplete does not fire when nothing is linked — the tick is skipped outright', async () => {
    setCredentialStore(memStore(null))
    let calls = 0
    const scheduler = startForwardScheduler({ baseHome: home, onDrainComplete: () => { calls++ } })
    await new Promise(resolve => setTimeout(resolve, 100))
    scheduler.dispose()
    assert.strictEqual(calls, 0)
  })

  test('a backlog bigger than one batch fully drains within a single run, not one batch per tick', async () => {
    setCredentialStore(memStore(CREDS))
    const q = new ForwardQueue(home)
    const ids = Array.from({ length: 7 }, (_, i) => `${(i + 1).toString().repeat(8)}-0000-4000-8000-000000000000`)
    for (const id of ids) q.enqueue(payload(id))
    let requestCount = 0
    globalThis.fetch = stubBatchOk(() => { requestCount++ })

    // batchLimit: 2 simulates a real backlog (200+ items) using a small queue — 7 items across
    // 2-item batches needs 4 batches (drainQueue calls) to fully drain. Each batch's items still
    // go out in one HTTP request (well under the default httpBatchSize of 25), so this also
    // covers that a queue-level batch and an HTTP batch aren't the same thing.
    const scheduler = startForwardScheduler({ baseHome: home, batchLimit: 2, intervalMs: 5 * 60_000 })
    await new Promise(resolve => setTimeout(resolve, 200))
    scheduler.dispose()

    assert.strictEqual(new ForwardQueue(home).depth(), 0, 'the whole backlog should drain in one run, without waiting for further ticks')
    assert.strictEqual(requestCount, 4)
  })

  test('drainSoon triggers onDrainComplete again, on top of the initial one', async () => {
    setCredentialStore(memStore(CREDS))
    globalThis.fetch = stubBatchOk()

    let calls = 0
    const scheduler = startForwardScheduler({ baseHome: home, onDrainComplete: () => { calls++ } })
    await new Promise(resolve => setTimeout(resolve, 50))
    const afterStart = calls
    assert.ok(afterStart >= 1)

    new ForwardQueue(home).enqueue(payload(ID1))
    scheduler.drainSoon()
    await new Promise(resolve => setTimeout(resolve, 3200))
    scheduler.dispose()

    assert.ok(calls > afterStart, 'drainSoon\'s eventual drain should have fired onDrainComplete again')
  })

  test('drainWhenIdle sends within about a second, and repeated calls do not push it back', async () => {
    setCredentialStore(memStore(CREDS))
    globalThis.fetch = stubBatchOk()
    const scheduler = startForwardScheduler({ baseHome: home })
    await new Promise(resolve => setTimeout(resolve, 50)) // the startup drain, on an empty queue

    const q = new ForwardQueue(home)
    // A catch-up queueing one session every 200 ms: a debounce that restarts on each call (as
    // drainSoon does) would not send until the burst ends.
    for (let i = 0; i < 6; i++) {
      q.enqueue(payload(`${(i + 1).toString().repeat(8)}-0000-4000-8000-000000000000`))
      scheduler.drainWhenIdle()
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    const depthMidBurst = q.depth()
    await new Promise(resolve => setTimeout(resolve, 1300))
    scheduler.dispose()

    assert.ok(depthMidBurst < 6, `items should go out while the burst is still going (depth ${depthMidBurst})`)
    assert.strictEqual(q.depth(), 0)
  })

  test('drainWhenIdle during a drain runs one more drain right after it, not at the next tick', async () => {
    setCredentialStore(memStore(CREDS))
    const q = new ForwardQueue(home)
    q.enqueue(payload(ID1))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ok = stubBatchOk()
    let requests = 0
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (requests++ === 0) await gate // hold the startup drain open
      return ok(url as string, init as RequestInit)
    }) as typeof fetch

    const scheduler = startForwardScheduler({ baseHome: home })
    await new Promise(resolve => setTimeout(resolve, 50))
    q.enqueue(payload('22222222-2222-4222-8222-222222222222'))
    scheduler.drainWhenIdle()
    release()
    await new Promise(resolve => setTimeout(resolve, 1300))
    scheduler.dispose()

    assert.strictEqual(q.depth(), 0)
  })

  test('the trace manifest waits while a catch-up is still queueing', async () => {
    setCredentialStore(memStore(CREDS))
    globalThis.fetch = stubBatchOk()
    let manifestRuns = 0
    const source: TraceManifestSource = {
      isWriter: () => { manifestRuns++; return false },
      isReady: () => true, localHorizonMs: () => null, listTraceKeys: () => [], countTraces: () => 0,
    }
    const endCatchUp = beginCatchUp()
    let scheduler
    try {
      scheduler = startForwardScheduler({ baseHome: home, traceManifest: source })
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.strictEqual(manifestRuns, 0)
    } finally {
      endCatchUp()
    }
    scheduler.drainWhenIdle()
    await new Promise(resolve => setTimeout(resolve, 1200))
    scheduler.dispose()
    assert.strictEqual(manifestRuns, 1)
  })
})
