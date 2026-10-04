import * as assert from 'assert'
import { hashSessionRollup } from '../../reconcile/payloadHash'
import type { SessionRollup } from '../../cloud/forward/schema'

function baseRollup(overrides: Partial<SessionRollup> = {}): SessionRollup {
  return {
    session_id: '11111111-1111-1111-1111-111111111111',
    agent: 'claude-code',
    started_at: '2026-01-01T00:00:00.000Z',
    duration_ms: 1000,
    turns: 2,
    tokens_in: 10,
    tokens_out: 20,
    outcome: 'committed',
    data_source: 'log',
    source_rank: 2,
    host_id: '0a0a0a0a-1111-4111-8111-aaaaaaaaaaaa',
    ...overrides,
  }
}

suite('hashSessionRollup', () => {
  test('identical rollups hash identically', () => {
    assert.strictEqual(hashSessionRollup(baseRollup()), hashSessionRollup(baseRollup()))
  })

  test('host_id is not content: a different sending host (or the unlinked placeholder) hashes the same', () => {
    assert.strictEqual(
      hashSessionRollup(baseRollup()),
      hashSessionRollup(baseRollup({ host_id: '00000000-0000-4000-8000-000000000000' })),
    )
  })

  test('a changed scalar field (duration) changes the hash', () => {
    const a = hashSessionRollup(baseRollup({ duration_ms: 1000 }))
    const b = hashSessionRollup(baseRollup({ duration_ms: 2000 }))
    assert.notStrictEqual(a, b)
  })

  test('a changed outcome changes the hash', () => {
    const a = hashSessionRollup(baseRollup({ outcome: 'committed' }))
    const b = hashSessionRollup(baseRollup({ outcome: 'merged' }))
    assert.notStrictEqual(a, b)
  })

  test('revision is excluded — bumping it alone must not change the hash', () => {
    const a = hashSessionRollup(baseRollup({ revision: 1 }))
    const b = hashSessionRollup(baseRollup({ revision: 42 }))
    assert.strictEqual(a, b)
  })

  test('array-of-object order does not affect the hash (models)', () => {
    const a = hashSessionRollup(baseRollup({ models: [{ model: 'claude', calls: 3 }, { model: 'gpt', calls: 1 }] }))
    const b = hashSessionRollup(baseRollup({ models: [{ model: 'gpt', calls: 1 }, { model: 'claude', calls: 3 }] }))
    assert.strictEqual(a, b)
  })

  test('array-of-scalar order does not affect the hash (file_hashes)', () => {
    const a = hashSessionRollup(baseRollup({ file_hashes: ['aa', 'bb', 'cc'] }))
    const b = hashSessionRollup(baseRollup({ file_hashes: ['cc', 'aa', 'bb'] }))
    assert.strictEqual(a, b)
  })

  test('a genuinely different set of models changes the hash, not just their order', () => {
    const a = hashSessionRollup(baseRollup({ models: [{ model: 'claude', calls: 3 }] }))
    const b = hashSessionRollup(baseRollup({ models: [{ model: 'claude', calls: 3 }, { model: 'gpt', calls: 1 }] }))
    assert.notStrictEqual(a, b)
  })

  test('tool_calls key order does not affect the hash (plain object, not array)', () => {
    const a = hashSessionRollup(baseRollup({ tool_calls: { read: 2, write: 1 } }))
    const b = hashSessionRollup(baseRollup({ tool_calls: { write: 1, read: 2 } }))
    assert.strictEqual(a, b)
  })
})
