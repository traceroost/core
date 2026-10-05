import * as assert from 'assert'
import { createRevisionForwardBatcher } from './revisionForwardBatcher'

suite('revisionForwardBatcher', () => {
  function harness(opts: { linked?: boolean } = {}) {
    let listings = 0
    const enqueued: Array<{ sessionId: string; revision: number }> = []
    const timers: Array<() => void> = []
    const batcher = createRevisionForwardBatcher<{ sessionId: string }>({
      listCards: () => { listings++; return [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'a' }] },
      enqueue: (card, revision) => enqueued.push({ sessionId: card.sessionId, revision }),
      isLinked: () => opts.linked ?? true,
      batchMs: 1000,
      setTimer: (fn) => { timers.push(fn); return timers.length as unknown as ReturnType<typeof setTimeout> },
      clearTimer: () => { timers.length = 0 },
    })
    const fire = () => { const fns = timers.splice(0); fns.forEach(f => f()) }
    return { batcher, enqueued, listings: () => listings, timers, fire }
  }

  test('one listing per burst, highest revision per session wins', () => {
    const h = harness()
    h.batcher.onResult({ sessionId: 'a', changed: true, revision: 1 })
    h.batcher.onResult({ sessionId: 'b', changed: true, revision: 3 })
    h.batcher.onResult({ sessionId: 'a', changed: true, revision: 2 })
    h.batcher.onResult({ sessionId: 'a', changed: true, revision: 1 })
    assert.strictEqual(h.timers.length, 1, 'one flush timer for the burst')
    assert.strictEqual(h.listings(), 0)
    h.fire()
    assert.strictEqual(h.listings(), 1)
    assert.deepStrictEqual(h.enqueued, [{ sessionId: 'a', revision: 2 }, { sessionId: 'b', revision: 3 }])
    assert.strictEqual(h.batcher.pendingCount, 0)
  })

  test('unchanged results, null revisions and unknown sessions are ignored', () => {
    const h = harness()
    h.batcher.onResult({ sessionId: 'a', changed: false, revision: 5 })
    h.batcher.onResult({ sessionId: 'a', changed: true, revision: null })
    assert.strictEqual(h.timers.length, 0)
    h.batcher.onResult({ sessionId: 'zzz', changed: true, revision: 1 })
    h.fire()
    assert.deepStrictEqual(h.enqueued, [])
  })

  test('collects nothing while no org is linked', () => {
    const h = harness({ linked: false })
    h.batcher.onResult({ sessionId: 'a', changed: true, revision: 1 })
    assert.strictEqual(h.timers.length, 0)
    assert.strictEqual(h.batcher.pendingCount, 0)
  })

  test('a new burst after a flush gets its own timer and listing', () => {
    const h = harness()
    h.batcher.onResult({ sessionId: 'a', changed: true, revision: 1 })
    h.fire()
    h.batcher.onResult({ sessionId: 'b', changed: true, revision: 1 })
    assert.strictEqual(h.timers.length, 1)
    h.fire()
    assert.strictEqual(h.listings(), 2)
    assert.deepStrictEqual(h.enqueued.map(e => e.sessionId), ['a', 'b'])
  })

  test('dispose drops what is pending', () => {
    const h = harness()
    h.batcher.onResult({ sessionId: 'a', changed: true, revision: 1 })
    h.batcher.dispose()
    assert.strictEqual(h.batcher.pendingCount, 0)
    h.fire()
    assert.deepStrictEqual(h.enqueued, [])
  })
})
