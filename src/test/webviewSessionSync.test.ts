import * as assert from 'assert'
import { WebviewSessionSync, jsonEqual } from '../webviewSessionSync'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

function card(id: string, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: id, traceId: 't-' + id, source: 'claude_code', dataSource: 'otel', workspace: '/w',
    userRequest: 'fix', model: 'claude-sonnet-4-6', turns: 1, inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 1, startTime: '2026-09-01T00:00:00.000Z',
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [], toolCounts: {},
    totalToolCalls: 0, totalLlmCalls: 1, errors: 0, outcome: 'unknown', timeline: [], backgroundSpans: [],
    loopSignals: [], ...overrides,
  }
}

// Fresh objects every call — the repository never hands back the same card twice.
const list = (...cards: SessionSummaryCard[]) => cards.map(c => JSON.parse(JSON.stringify(c)) as SessionSummaryCard)
const eff = () => ({ totalLlmCalls: 1 })
const A = card('a'), B = card('b'), C = card('c')

suite('webviewSessionSync', () => {
  test('jsonEqual compares structure, not identity', () => {
    assert.ok(jsonEqual({ a: [1, { b: 'x' }], c: null }, { c: null, a: [1, { b: 'x' }] }))
    assert.ok(!jsonEqual({ a: [1, 2] }, { a: [1, 2, 3] }))
    assert.ok(!jsonEqual({ a: 1 }, { a: 1, b: 2 }))
    assert.ok(!jsonEqual({ a: [] }, { a: {} }))
    assert.ok(!jsonEqual(null, {}))
  })

  test('first post is full; an unchanged list then posts no sessions and keeps the revision', () => {
    const sync = new WebviewSessionSync()
    const first = sync.next(list(A, B), eff, { d: 1 }, null)
    assert.deepStrictEqual(first.sessionSummary?.sessions.map(s => s.sessionId), ['a', 'b'])
    assert.strictEqual(first.base, 0)
    assert.strictEqual(first.rev, 1)
    assert.deepStrictEqual(first.analyticsData, { d: 1 })
    assert.strictEqual(first.burnRate, null)

    const second = sync.next(list(A, B), eff, { d: 1 }, null)
    assert.deepStrictEqual(second, { base: 1, rev: 1 })
  })

  test('posts only changed cards, and the order only when it changed', () => {
    const sync = new WebviewSessionSync()
    sync.next(list(A, B, C), eff, {}, null)

    const changed = sync.next(list(A, card('b', { totalLlmCalls: 9 }), C), eff, {}, null)
    assert.strictEqual(changed.sessionSummary, undefined)
    assert.deepStrictEqual(changed.sessionDelta?.upserts.map(s => [s.sessionId, s.totalLlmCalls]), [['b', 9]])
    assert.strictEqual(changed.sessionDelta?.order, undefined)
    assert.deepStrictEqual(changed.sessionDelta?.efficiency, { totalLlmCalls: 1 })
    assert.deepStrictEqual([changed.base, changed.rev], [1, 2])

    const added = sync.next(list(card('d'), A, card('b', { totalLlmCalls: 9 })), eff, {}, null)
    assert.deepStrictEqual(added.sessionDelta?.upserts.map(s => s.sessionId), ['d'])
    assert.deepStrictEqual(added.sessionDelta?.order, ['d', 'a', 'b'])
  })

  test('an empty list posts a null summary once, then a full one when sessions return', () => {
    const sync = new WebviewSessionSync()
    sync.next(list(A), eff, {}, null)
    assert.strictEqual(sync.next([], eff, {}, null).sessionSummary, null)
    assert.strictEqual('sessionSummary' in sync.next([], eff, {}, null), false)
    assert.deepStrictEqual(sync.next(list(A), eff, {}, null).sessionSummary?.sessions.map(s => s.sessionId), ['a'])
  })

  test('seed() records the embedded list; reset() forces a full post', () => {
    const sync = new WebviewSessionSync()
    assert.strictEqual(sync.seed(list(A, B)), 0)
    assert.deepStrictEqual(sync.next(list(A, B), eff, {}, null).sessionDelta, undefined)
    sync.reset()
    assert.ok(sync.next(list(A, B), eff, {}, null).sessionSummary)

    const empty = new WebviewSessionSync()
    empty.seed([])
    assert.strictEqual('sessionSummary' in empty.next([], eff, {}, null), false)
  })

  test('duplicate session ids fall back to full posts', () => {
    const sync = new WebviewSessionSync()
    sync.next(list(A, B), eff, {}, null)
    assert.ok(sync.next(list(A, A, B), eff, {}, null).sessionSummary)
    assert.ok(sync.next(list(A, B), eff, {}, null).sessionSummary)
  })

  test('a card mutated in place after being posted still counts as changed', () => {
    const sync = new WebviewSessionSync()
    const cards = list(A, B)
    sync.next(cards, eff, {}, null)
    cards[0].workspace = '/elsewhere'
    assert.deepStrictEqual(sync.next(cards, eff, {}, null).sessionDelta?.upserts.map(s => s.sessionId), ['a'])
  })

  test('analytics and burn rate are only re-posted when they change', () => {
    const sync = new WebviewSessionSync()
    sync.next(list(A), eff, { d: [1] }, { rate: 1 })
    const same = sync.next(list(A), eff, { d: [1] }, { rate: 1 })
    assert.ok(!('analyticsData' in same) && !('burnRate' in same))
    const moved = sync.next(list(A), eff, { d: [2] }, null)
    assert.deepStrictEqual([moved.analyticsData, moved.burnRate, moved.rev], [{ d: [2] }, null, moved.base + 1])
  })
})
