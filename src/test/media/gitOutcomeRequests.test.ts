import * as assert from 'assert'
import './domShim'
import { makeCard } from './fixtures'
import { gitOutcomes, requestGitOutcomesFor, gitOutcomeRequestSettled, setVscode } from '../../../media/src/state'

suite('requestGitOutcomesFor — in-flight tracking', () => {
  let posted: string[][] = []
  const realNow = Date.now
  const settle = (ms = 10) => new Promise(r => setTimeout(r, ms))
  const cards = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => makeCard({ sessionId: `${prefix}${i}`, filesChanged: ['a.ts'] }))

  setup(() => {
    posted = []
    gitOutcomes.value = {}
    setVscode({ postMessage: (m: unknown) => { const msg = m as { type: string; sessionIds: string[] }; if (msg.type === 'getGitOutcomes') posted.push(msg.sessionIds) } } as never)
  })
  teardown(() => {
    Date.now = realNow
    setVscode(null as never)
  })

  test('a session already requested and not yet answered is not requested again', async () => {
    const sessions = cards(3, 'inflight-')
    requestGitOutcomesFor(sessions)
    requestGitOutcomesFor(sessions)
    await settle()
    requestGitOutcomesFor(sessions)
    await settle()
    assert.deepStrictEqual(posted, [['inflight-0', 'inflight-1', 'inflight-2']])
  })

  test('once answered but still unresolved (deferred), the next call asks again', async () => {
    const [s] = cards(1, 'deferred-')
    requestGitOutcomesFor([s])
    await settle()
    gitOutcomeRequestSettled(s.sessionId)
    requestGitOutcomesFor([s])
    await settle()
    assert.deepStrictEqual(posted, [[s.sessionId], [s.sessionId]])
  })

  test('resolved sessions are never requested; sessions without changed files resolve locally', async () => {
    const [a, b] = cards(2, 'resolved-')
    const none = makeCard({ sessionId: 'resolved-none', filesChanged: [] })
    gitOutcomes.value = { [a.sessionId]: null }
    requestGitOutcomesFor([a, b, none])
    await settle()
    assert.deepStrictEqual(posted, [[b.sessionId]])
    assert.strictEqual(gitOutcomes.value['resolved-none'], null)
  })

  test('a provisional cached outcome remains in flight until the fresh result settles', async () => {
    const [s] = cards(1, 'provisional-')
    requestGitOutcomesFor([s])
    gitOutcomes.value = { [s.sessionId]: { overall: 'merged', files: {}, reason: '' } }
    requestGitOutcomesFor([s])
    assert.deepStrictEqual(posted, [[s.sessionId]])

    gitOutcomeRequestSettled(s.sessionId)
    gitOutcomes.value = { [s.sessionId]: { overall: 'committed', files: {}, reason: '' } }
    requestGitOutcomesFor([s])
    assert.deepStrictEqual(posted, [[s.sessionId]])
  })

  test('a large set is sent in one batch and is not requested again while in flight', async () => {
    const sessions = cards(400, 'chain-')
    requestGitOutcomesFor(sessions)
    requestGitOutcomesFor(sessions)
    assert.strictEqual(posted.length, 1)
    assert.strictEqual(posted[0].length, 400)
    assert.strictEqual(new Set(posted[0]).size, 400)
  })

  test('a request that is never answered stops blocking a new one after the expiry', async () => {
    const [s] = cards(1, 'expiry-')
    requestGitOutcomesFor([s])
    await settle()
    const t0 = realNow()
    Date.now = () => t0 + 61_000
    requestGitOutcomesFor([s])
    await settle()
    assert.deepStrictEqual(posted, [[s.sessionId], [s.sessionId]])
  })
})
