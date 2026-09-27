import * as assert from 'assert'
import './domShim'
import { makeCard, makeSummary } from './fixtures'
import { applySessionDelta } from '../../../media/src/state'

suite('media/applySessionDelta', () => {
  const a = makeCard({ sessionId: 'a' })
  const b = makeCard({ sessionId: 'b' })
  const efficiency = makeSummary([]).efficiency

  test('replaces changed cards in place, keeping the rest by identity', () => {
    const b2 = makeCard({ sessionId: 'b', totalLlmCalls: 9 })
    const next = applySessionDelta(makeSummary([a, b]), { upserts: [b2], efficiency })!
    assert.deepStrictEqual(next.sessions, [a, b2])
    assert.strictEqual(next.sessions[0], a)
    assert.deepStrictEqual(next.backgroundSpans, [])
  })

  test('follows a new order, adding and dropping sessions', () => {
    const c = makeCard({ sessionId: 'c' })
    const next = applySessionDelta(makeSummary([a, b]), { upserts: [c], order: ['c', 'a'], efficiency })!
    assert.deepStrictEqual(next.sessions.map(s => s.sessionId), ['c', 'a'])
  })

  test('builds from nothing when the delta carries the full order', () => {
    const next = applySessionDelta(null, { upserts: [a], order: ['a'], efficiency })!
    assert.deepStrictEqual(next.sessions, [a])
  })

  test('returns null (resync) when it names a session this webview does not hold', () => {
    assert.strictEqual(applySessionDelta(makeSummary([a]), { upserts: [], order: ['a', 'zz'], efficiency }), null)
    assert.strictEqual(applySessionDelta(null, { upserts: [a], efficiency }), null)
  })
})
