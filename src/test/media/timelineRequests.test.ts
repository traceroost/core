import * as assert from 'assert'
import './domShim'
import { sessionTimelines, requestSessionTimeline, receiveSessionTimeline, setVscode } from '../../../media/src/state'

suite('requestSessionTimeline — one load per session, not per render', () => {
  let posted: string[] = []
  const realNow = Date.now

  setup(() => {
    posted = []
    sessionTimelines.value = {}
    setVscode({ postMessage: (m: unknown) => { const msg = m as { type: string; sessionId: string }; if (msg.type === 'loadSessionDetail') posted.push(msg.sessionId) } } as never)
  })
  teardown(() => {
    Date.now = realNow
    setVscode(null as never)
  })

  test('repeated asks while a request is in flight send it once', () => {
    requestSessionTimeline('tl-a')
    requestSessionTimeline('tl-a')
    requestSessionTimeline('tl-b')
    requestSessionTimeline('tl-a')
    assert.deepStrictEqual(posted, ['tl-a', 'tl-b'])
  })

  test('a loaded timeline is not asked for; a stored answer clears the in-flight request', () => {
    requestSessionTimeline('tl-c')
    receiveSessionTimeline('tl-c', [])
    assert.deepStrictEqual(sessionTimelines.value['tl-c'], [])
    requestSessionTimeline('tl-c')
    assert.deepStrictEqual(posted, ['tl-c'])
    // cleared (e.g. Clear all) → asked again
    sessionTimelines.value = {}
    requestSessionTimeline('tl-c')
    assert.deepStrictEqual(posted, ['tl-c', 'tl-c'])
  })

  test('an unanswered request (a failed fetch) may be retried after 10 s', () => {
    const t0 = realNow()
    Date.now = () => t0
    requestSessionTimeline('tl-d')
    Date.now = () => t0 + 9_000
    requestSessionTimeline('tl-d')
    Date.now = () => t0 + 10_001
    requestSessionTimeline('tl-d')
    assert.deepStrictEqual(posted, ['tl-d', 'tl-d'])
  })
})
