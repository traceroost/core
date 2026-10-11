import * as assert from 'assert'
import { HistoryReadiness, type HistoryPassOutcome } from '../historyReadiness'

/** Timers run by hand. */
function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = []
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => { const t = { fn, ms }; pending.push(t); return t },
    clearTimer: (h: unknown) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1) },
    fire: async () => { const t = pending.shift(); t?.fn(); await new Promise(r => setImmediate(r)) },
  }
}

suite('historyReadiness — the trace manifest\'s "store is complete" gate', () => {
  test('a failed pass leaves the store not ready and is retried with backoff; success opens it', async () => {
    const timers = manualTimers()
    const outcomes: Array<HistoryPassOutcome | Error> = [new Error('EACCES'), new Error('EACCES'), 'done']
    const r = new HistoryReadiness({ run: async () => { const o = outcomes.shift()!; if (o instanceof Error) throw o; return o }, ...timers, retryBaseMs: 30_000 })
    await r.load()
    assert.strictEqual(r.isReady(), false)
    assert.deepStrictEqual(timers.pending.map(t => t.ms), [30_000])
    await timers.fire()
    assert.strictEqual(r.isReady(), false)
    assert.deepStrictEqual(timers.pending.map(t => t.ms), [60_000], 'backs off')
    await timers.fire()
    assert.strictEqual(r.isReady(), true)
    assert.strictEqual(timers.pending.length, 0)
  })

  test('"clear all data" during a pass: that pass does not open the gate; the next completed one does', async () => {
    const timers = manualTimers()
    let release!: () => void
    let calls = 0
    const r = new HistoryReadiness({
      ...timers,
      run: () => {
        calls++
        if (calls === 1) return new Promise<HistoryPassOutcome>(res => { release = () => res('done') })
        return Promise.resolve(calls === 2 ? 'busy' : 'done')
      },
    })
    const first = r.load()
    r.invalidate()
    await r.load() // the clear's own pass finds the first one still running
    assert.deepStrictEqual(timers.pending.map(t => t.ms), [1_000])
    release()
    await first
    assert.strictEqual(r.isReady(), false, 'a pass from before the clear never marks the cleared store ready')
    await timers.fire()
    assert.strictEqual(r.isReady(), true)
  })
})
