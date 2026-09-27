import * as assert from 'assert'
import { SseSessionSync, type SyncSummary } from './sseSessionSync'

interface Card { sessionId: string; n: number }
interface Summary { sessions: Card[]; backgroundSpans: unknown[]; efficiency: unknown }

function syncSummary(summary: Summary): SyncSummary {
  return {
    ids: summary.sessions.map(s => s.sessionId),
    cardJsons: summary.sessions.map(s => JSON.stringify(s)),
    efficiencyJson: JSON.stringify(summary.efficiency),
    backgroundSpansJson: JSON.stringify(summary.backgroundSpans),
    deltaable: Object.keys(summary).every(k => k === 'sessions' || k === 'efficiency' || k === 'backgroundSpans'),
  }
}

/** What the dashboard (media/src/App.tsx + state.ts's applySessionDelta) does with a frame. */
class Client {
  rev: number | undefined
  summary: Summary | null = null
  analytics: unknown
  resyncRequested = false
  apply(frame: Record<string, unknown>): void {
    const delta = frame.sessionDelta as { upserts: Card[]; order?: string[]; efficiency: unknown; backgroundSpans?: unknown[] } | undefined
    if (frame.sessionSummary !== undefined) {
      this.summary = frame.sessionSummary as Summary | null
      this.rev = frame.rev as number
      this.resyncRequested = false
    } else if (frame.base !== this.rev) {
      this.resyncRequested = true
      return
    } else if (delta) {
      const byId = new Map((this.summary?.sessions ?? []).map(s => [s.sessionId, s]))
      for (const s of delta.upserts) byId.set(s.sessionId, s)
      const order = delta.order ?? this.summary!.sessions.map(s => s.sessionId)
      this.summary = { sessions: order.map(id => byId.get(id)!), backgroundSpans: delta.backgroundSpans ?? [], efficiency: delta.efficiency }
      this.rev = frame.rev as number
    } else {
      this.rev = frame.rev as number
    }
    if (frame.analyticsData !== undefined) this.analytics = frame.analyticsData
  }
}

function step(sync: SseSessionSync, summary: Summary | null, analytics: unknown = { days: 1 }) {
  let fullAsked = false
  const s = sync.advance(summary && syncSummary(summary), () => { fullAsked = true; return JSON.stringify(summary) }, JSON.stringify(analytics))
  const frame = JSON.parse('{"type":"update"' + s.fields + ',"base":' + s.base + ',"rev":' + s.rev + '}') as Record<string, unknown>
  return { ...s, frame, fullAsked }
}

const card = (id: string, n = 0): Card => ({ sessionId: id, n })
const summaryOf = (...sessions: Card[]): Summary => ({ sessions, backgroundSpans: [], efficiency: { total: sessions.length } })

suite('SseSessionSync', () => {
  test('first step is full; unchanged data sends nothing and keeps the revision', () => {
    const sync = new SseSessionSync(100)
    const a = step(sync, summaryOf(card('a'), card('b')))
    assert.ok(a.frame.sessionSummary)
    assert.deepStrictEqual(a.frame.analyticsData, { days: 1 })
    assert.deepStrictEqual([a.base, a.rev], [100, 101])
    const b = step(sync, summaryOf(card('a'), card('b')))
    assert.strictEqual(b.fields, '')
    assert.strictEqual(b.fullAsked, false)
    assert.deepStrictEqual([b.base, b.rev], [101, 101])
  })

  test('a changed card is sent alone, without order or the full summary', () => {
    const sync = new SseSessionSync(0)
    step(sync, summaryOf(card('a'), card('b'), card('c')))
    const s = step(sync, summaryOf(card('a'), card('b', 1), card('c')))
    assert.strictEqual(s.fullAsked, false)
    assert.strictEqual(s.frame.sessionSummary, undefined)
    assert.deepStrictEqual(s.frame.sessionDelta, { upserts: [card('b', 1)], efficiency: { total: 3 } })
    assert.strictEqual(s.frame.analyticsData, undefined)
  })

  test('a new session sends it plus the new order; a removal sends only the order', () => {
    const sync = new SseSessionSync(0)
    step(sync, summaryOf(card('a'), card('b')))
    const added = step(sync, summaryOf(card('n'), card('a'), card('b')))
    assert.deepStrictEqual(added.frame.sessionDelta, { upserts: [card('n')], order: ['n', 'a', 'b'], efficiency: { total: 3 } })
    const removed = step(sync, summaryOf(card('n'), card('b')))
    assert.deepStrictEqual(removed.frame.sessionDelta, { upserts: [], order: ['n', 'b'], efficiency: { total: 2 } })
  })

  test('analytics-only and efficiency-only changes still advance the revision', () => {
    const sync = new SseSessionSync(0)
    const sum = summaryOf(card('a'))
    step(sync, sum)
    const an = step(sync, sum, { days: 2 })
    assert.deepStrictEqual(an.frame.analyticsData, { days: 2 })
    assert.strictEqual(an.frame.sessionDelta, undefined)
    assert.strictEqual(an.rev, an.base + 1)
    const eff = step(sync, { ...sum, efficiency: { total: 9 } }, { days: 2 })
    assert.deepStrictEqual(eff.frame.sessionDelta, { upserts: [], efficiency: { total: 9 } })
  })

  test('top-level background spans ride along in the delta whenever they change, and only when non-empty', () => {
    const sync = new SseSessionSync(0)
    step(sync, summaryOf(card('a')))
    const bg = step(sync, { ...summaryOf(card('a')), backgroundSpans: [{ name: 'x' }] })
    assert.deepStrictEqual(bg.frame.sessionDelta, { upserts: [], efficiency: { total: 1 }, backgroundSpans: [{ name: 'x' }] })
    const withCard = step(sync, { ...summaryOf(card('a', 1)), backgroundSpans: [{ name: 'x' }] })
    assert.deepStrictEqual(withCard.frame.sessionDelta, { upserts: [card('a', 1)], efficiency: { total: 1 }, backgroundSpans: [{ name: 'x' }] })
    const cleared = step(sync, summaryOf(card('a', 1)))
    assert.deepStrictEqual(cleared.frame.sessionDelta, { upserts: [], efficiency: { total: 1 } })
  })

  test('what a delta cannot express goes in full: duplicate ids, unknown summary keys, empty or missing', () => {
    const sync = new SseSessionSync(0)
    step(sync, summaryOf(card('a')))
    const odd = step(sync, { ...summaryOf(card('a')), extra: 1 } as Summary)
    assert.strictEqual((odd.frame.sessionSummary as { extra: number }).extra, 1)
    const oddSame = step(sync, { ...summaryOf(card('a')), extra: 1 } as Summary)
    assert.strictEqual(oddSame.fields, '', 'an unchanged full summary is not resent')
    const back = step(sync, summaryOf(card('a')))
    assert.ok(back.frame.sessionSummary, 'leaving full mode resends in full')
    const dup = step(sync, summaryOf(card('a'), card('a', 1)))
    assert.ok(dup.frame.sessionSummary)
    const empty = step(sync, summaryOf())
    assert.deepStrictEqual(empty.frame.sessionSummary, summaryOf())
    const none = step(sync, null)
    assert.strictEqual(none.frame.sessionSummary, null)
    assert.strictEqual(step(sync, null).fields, '')
  })

  test('a client following every frame ends up with the full summary; one that missed a frame asks to resync', () => {
    const sync = new SseSessionSync(7)
    const states: Summary[] = [
      summaryOf(card('a'), card('b')),
      summaryOf(card('a', 1), card('b')),
      summaryOf(card('c'), card('a', 1), card('b')),
      summaryOf(card('c', 2), card('b')),
      { ...summaryOf(card('c', 2), card('b')), backgroundSpans: [{ name: 'bg' }] },
      summaryOf(card('d'), card('c', 3), card('b', 1)),
    ]
    const follower = new Client()
    const lossy = new Client()
    states.forEach((sum, i) => {
      const s = step(sync, sum, { i })
      follower.apply(s.frame)
      if (i !== 2) lossy.apply(s.frame)
      assert.deepStrictEqual(follower.summary, JSON.parse(JSON.stringify(sum)))
      assert.deepStrictEqual(follower.analytics, { i })
      assert.strictEqual(follower.rev, sync.revision)
    })
    assert.strictEqual(follower.resyncRequested, false)
    assert.strictEqual(lossy.resyncRequested, true)
    // The resync the server sends: a full summary at the current revision.
    const last = states[states.length - 1]
    lossy.apply({ sessionSummary: JSON.parse(JSON.stringify(last)), analyticsData: { i: 5 }, base: sync.revision, rev: sync.revision })
    const next = summaryOf(card('d', 1), card('c', 3), card('b', 1))
    const s = step(sync, next, { i: 5 })
    lossy.apply(s.frame)
    assert.strictEqual(lossy.resyncRequested, false)
    assert.deepStrictEqual(lossy.summary, next)
  })
})
