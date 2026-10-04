import * as assert from 'assert'
import { createSessionForwarder } from '../sessionForwarder'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'
import type { ReconciliationService } from '../reconcile/reconciliationService'

const card = (id: string) => ({ sessionId: id, workspace: '/w' }) as unknown as SessionSummaryCard
const flush = () => new Promise(r => setImmediate(r))

suite('sessionForwarder', () => {
  function harness(opts: { reconciliation?: boolean; enqueued?: boolean } = {}) {
    const calls: string[] = []
    let drains = 0
    const scheduled = new Map<string, () => void>()
    const svc = {} as ReconciliationService
    const forward = createSessionForwarder({
      cloud: {
        enqueueSession: async c => { calls.push(`enqueue:${c.sessionId}`); return { enqueued: opts.enqueued ?? true } },
        forwardOnContentChange: async (s, c) => {
          assert.strictEqual(s, svc)
          calls.push(`content:${c.sessionId}`)
          return { enqueued: opts.enqueued ?? true }
        },
      },
      reconciliation: () => (opts.reconciliation ? svc : undefined),
      // Records the latest run per key, like KeyedDebouncer (a later schedule replaces it).
      debouncer: { schedule: (key, run) => { scheduled.set(key, run) } },
      drainSoon: () => { drains++ },
    })
    return { forward, calls, scheduled, drains: () => drains }
  }

  test('with reconciliation, a changed session goes through the content gate, debounced per session', async () => {
    const h = harness({ reconciliation: true })
    h.forward(card('a'))
    h.forward(card('a'))
    h.forward(card('b'))
    assert.deepStrictEqual(h.calls, [], 'nothing runs until the debounce fires')
    assert.deepStrictEqual([...h.scheduled.keys()], ['a', 'b'], 'one pending check per session')
    for (const run of h.scheduled.values()) run()
    await flush()
    assert.deepStrictEqual(h.calls, ['content:a', 'content:b'])
    assert.strictEqual(h.drains(), 2, 'each enqueue asks for a drain')
  })

  test('without reconciliation, it falls back to the first-send enqueue, immediately', async () => {
    const h = harness()
    h.forward(card('a'))
    await flush()
    assert.deepStrictEqual(h.calls, ['enqueue:a'])
    assert.strictEqual(h.scheduled.size, 0)
    assert.strictEqual(h.drains(), 1)
  })

  test('nothing enqueued (unchanged content, or no org linked) asks for no drain', async () => {
    const h = harness({ reconciliation: true, enqueued: false })
    h.forward(card('a'))
    h.scheduled.get('a')!()
    await flush()
    assert.strictEqual(h.drains(), 0)
  })

  test('the reconciliation service is read at call time, not when the forwarder is built', async () => {
    const current: { svc?: ReconciliationService } = {}
    const seen: string[] = []
    const forward = createSessionForwarder({
      cloud: {
        enqueueSession: async c => { seen.push(`enqueue:${c.sessionId}`); return { enqueued: false } },
        forwardOnContentChange: async (_s, c) => { seen.push(`content:${c.sessionId}`); return { enqueued: false } },
      },
      reconciliation: () => current.svc,
      debouncer: { schedule: (_k, run) => run() },
      drainSoon: () => {},
    })
    forward(card('early'))
    current.svc = {} as ReconciliationService
    forward(card('late'))
    await flush()
    assert.deepStrictEqual(seen, ['enqueue:early', 'content:late'])
  })
})
