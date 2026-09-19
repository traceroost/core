import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startForwardScheduler } from '../../../cloud/forward/scheduler'
import { ForwardQueue } from '../../../cloud/forward/queue'
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

const realFetch = globalThis.fetch

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
    globalThis.fetch = (async () => new Response('', { status: 202 })) as typeof fetch

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
    let sendCount = 0
    globalThis.fetch = (async () => { sendCount++; return new Response('', { status: 202 }) }) as typeof fetch

    // batchLimit: 2 simulates a real backlog (200+ items) using a small queue — 7 items across
    // 2-item batches needs 4 batches to fully drain.
    const scheduler = startForwardScheduler({ baseHome: home, batchLimit: 2, intervalMs: 5 * 60_000 })
    await new Promise(resolve => setTimeout(resolve, 200))
    scheduler.dispose()

    assert.strictEqual(new ForwardQueue(home).depth(), 0, 'the whole backlog should drain in one run, without waiting for further ticks')
    assert.strictEqual(sendCount, 7)
  })

  test('drainSoon triggers onDrainComplete again, on top of the initial one', async () => {
    setCredentialStore(memStore(CREDS))
    globalThis.fetch = (async () => new Response('', { status: 202 })) as typeof fetch

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
})
