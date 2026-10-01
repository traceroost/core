import * as assert from 'assert'
import { KeyedDebouncer } from '../../reconcile/keyedDebouncer'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

suite('reconcile/KeyedDebouncer', () => {
  test('a burst on one key runs once, after the quiet period', async () => {
    const d = new KeyedDebouncer(150, 10_000)
    const runs: string[] = []
    d.schedule('a', () => runs.push('a1'))
    d.schedule('a', () => runs.push('a2'))
    d.schedule('a', () => runs.push('a3'))
    await sleep(20)
    assert.deepStrictEqual(runs, [])
    await sleep(250)
    assert.deepStrictEqual(runs, ['a3'], 'only the latest callback of the burst runs')
    d.dispose()
  })

  test('keys are independent', async () => {
    const d = new KeyedDebouncer(20, 10_000)
    const runs: string[] = []
    d.schedule('a', () => runs.push('a'))
    d.schedule('b', () => runs.push('b'))
    await sleep(60)
    assert.deepStrictEqual(runs.sort(), ['a', 'b'])
    d.dispose()
  })

  test('continuous activity still runs by the max wait', async () => {
    const d = new KeyedDebouncer(200, 100)
    let runs = 0
    const start = Date.now()
    let ranAt = 0
    // Re-schedule every 15ms — never quiet for 200ms — so only maxWait can fire it.
    while (Date.now() - start < 1000 && runs === 0) {
      d.schedule('k', () => { runs++; ranAt = Date.now() })
      await sleep(15)
    }
    assert.strictEqual(runs, 1)
    assert.ok(ranAt - start < 190, `ran ${ranAt - start}ms after the first schedule, before the 200ms quiet period could`)
    d.dispose()
  })

  test('dispose cancels everything pending', async () => {
    const d = new KeyedDebouncer(10, 100)
    let runs = 0
    d.schedule('a', () => runs++)
    d.schedule('b', () => runs++)
    d.dispose()
    await sleep(40)
    assert.strictEqual(runs, 0)
  })
})
