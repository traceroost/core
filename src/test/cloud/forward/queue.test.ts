import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ForwardQueue, itemKey, queuePath } from '../../../cloud/forward/queue'
import type { RollupPayload } from '../../../cloud/forward/schema'

function payload(sessionId: string, revision?: number): RollupPayload {
  return {
    schema_version: '1',
    repo_key_fp: 'a'.repeat(64),
    session: {
      session_id: sessionId,
      agent: 'claude-code',
      repo_hash: 'b'.repeat(64),
      started_at: '2026-03-01T00:00:00.000Z',
      duration_ms: 1,
      ...(revision !== undefined ? { revision } : {}),
    },
  }
}

suite('forward/queue', () => {
  let home: string
  setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-queue-')) })
  teardown(() => { fs.rmSync(home, { recursive: true, force: true }) })

  test('enqueue is idempotent on the item key', () => {
    const q = new ForwardQueue(home)
    assert.strictEqual(q.enqueue(payload('11111111-1111-4111-8111-111111111111')), true)
    assert.strictEqual(q.enqueue(payload('11111111-1111-4111-8111-111111111111')), false)
    assert.strictEqual(q.depth(), 1)
  })

  test('survives a restart (a fresh instance reads the same file)', () => {
    new ForwardQueue(home).enqueue(payload('22222222-2222-4222-8222-222222222222'))
    assert.strictEqual(new ForwardQueue(home).depth(), 1)
  })

  test('the queue file is user-only (0600)', () => {
    new ForwardQueue(home).enqueue(payload('33333333-3333-4333-8333-333333333333'))
    assert.strictEqual(fs.statSync(queuePath(home)).mode & 0o777, 0o600)
  })

  test('oldest-first eviction past the cap', () => {
    const q = new ForwardQueue(home, 3)
    for (const n of ['a', 'b', 'c', 'd', 'e']) {
      q.enqueue(payload(`${n.repeat(8)}-0000-4000-8000-000000000000`))
    }
    const keys = q.list().map(i => i.key)
    assert.strictEqual(keys.length, 3)
    assert.strictEqual(keys[0], itemKey(payload('cccccccc-0000-4000-8000-000000000000')))
  })

  test('remove drops items by key; a torn final line is ignored', () => {
    const q = new ForwardQueue(home)
    q.enqueue(payload('44444444-4444-4444-8444-444444444444'))
    q.enqueue(payload('55555555-5555-4555-8555-555555555555'))
    fs.appendFileSync(queuePath(home), '{"key":"broken')  // torn write
    q.remove([itemKey(payload('44444444-4444-4444-8444-444444444444'))])
    assert.strictEqual(q.depth(), 1)
    assert.strictEqual(q.list()[0].key, itemKey(payload('55555555-5555-4555-8555-555555555555')))
  })

  test('recordFailure bumps attempts without removing the item', () => {
    const q = new ForwardQueue(home)
    q.enqueue(payload('66666666-6666-4666-8666-666666666666'))
    const key = itemKey(payload('66666666-6666-4666-8666-666666666666'))
    q.recordFailure(key, 'boom')
    q.recordFailure(key, 'boom')
    assert.strictEqual(q.list()[0].attempts, 2)
    assert.strictEqual(q.list()[0].lastError, 'boom')
  })

  test('staged feature 10: a strictly newer revision replaces a still-unsent item in place', () => {
    const q = new ForwardQueue(home)
    const id = '11111111-1111-4111-8111-111111111111'
    assert.strictEqual(q.enqueue(payload(id, 1)), true)
    assert.strictEqual(q.enqueue(payload(id, 2)), true, 'a newer revision must replace, not be dropped as a duplicate key')
    assert.strictEqual(q.depth(), 1, 'replace happens in place, not as a second queued item')
    assert.strictEqual(q.list()[0].payload.session?.revision, 2)
  })

  test('staged feature 10: an equal or older revision does not replace the queued item', () => {
    const q = new ForwardQueue(home)
    const id = '11111111-1111-4111-8111-111111111111'
    q.enqueue(payload(id, 3))
    assert.strictEqual(q.enqueue(payload(id, 3)), false, 'same revision is a no-op, not a replace')
    assert.strictEqual(q.enqueue(payload(id, 2)), false, 'an older revision must never overwrite a newer queued one')
    assert.strictEqual(q.list()[0].payload.session?.revision, 3)
  })

  test('staged feature 10: a revision-bearing payload supersedes a legacy (no-revision) queued item', () => {
    const q = new ForwardQueue(home)
    const id = '11111111-1111-4111-8111-111111111111'
    q.enqueue(payload(id)) // legacy send, no revision field
    assert.strictEqual(q.enqueue(payload(id, 1)), true, 'a revisioned snapshot must supersede a pre-revision-protocol queued item')
    assert.strictEqual(q.list()[0].payload.session?.revision, 1)
  })

  test('staged feature 10: a payload with no revision never replaces an already-queued item, revisioned or not', () => {
    const q = new ForwardQueue(home)
    const id = '11111111-1111-4111-8111-111111111111'
    q.enqueue(payload(id, 5))
    assert.strictEqual(q.enqueue(payload(id)), false, 'cannot confirm a revision-less payload is newer, so it must not clobber a revisioned one')
    assert.strictEqual(q.list()[0].payload.session?.revision, 5)
  })

  test('staged feature 10: replacing in place preserves retry identity (enqueuedAt, attempts)', () => {
    const q = new ForwardQueue(home)
    const id = '11111111-1111-4111-8111-111111111111'
    q.enqueue(payload(id, 1))
    const key = itemKey(payload(id, 1))
    q.recordFailure(key, 'network blip')
    const before = q.list()[0]
    assert.strictEqual(before.attempts, 1)

    q.enqueue(payload(id, 2))
    const after = q.list()[0]
    assert.strictEqual(after.enqueuedAt, before.enqueuedAt, 'a replace keeps the original enqueuedAt, not a fresh one')
    assert.strictEqual(after.attempts, 1, 'a replace preserves in-flight retry state rather than resetting it')
  })

  test('eviction past the cap is logged, not silent', () => {
    const logs: string[] = []
    const q = new ForwardQueue(home, 2, (m) => logs.push(m))
    q.enqueue(payload('77777777-0000-4000-8000-000000000000'))
    q.enqueue(payload('88888888-0000-4000-8000-000000000000'))
    assert.strictEqual(logs.length, 0, 'no eviction yet, no log')
    q.enqueue(payload('99999999-0000-4000-8000-000000000000'))
    assert.strictEqual(logs.length, 1)
    assert.match(logs[0], /evicting 1 oldest unsent item/)
  })
})
