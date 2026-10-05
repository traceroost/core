import * as assert from 'assert'
import { OtelForwardGate } from './otelForwardGate'

const card = (traceId: string, durationMs: number, extra: Partial<{ inputTokens: number; outputTokens: number; totalToolCalls: number }> = {}) => ({
  traceId, durationMs, inputTokens: 10, outputTokens: 5, totalToolCalls: 1, ...extra,
})

suite('OtelForwardGate', () => {
  const IDLE = 1000

  test('forwards once content has been unchanged for the idle window', () => {
    const gate = new OtelForwardGate(IDLE)
    assert.strictEqual(gate.shouldForward(card('t', 100), 0), false)       // first sight
    assert.strictEqual(gate.shouldForward(card('t', 100), 500), false)     // not idle yet
    assert.strictEqual(gate.shouldForward(card('t', 100), 1000), true)     // idle → forward
    assert.strictEqual(gate.shouldForward(card('t', 100), 2000), false)    // same content already sent
  })

  test('a growing trace is not forwarded until it settles', () => {
    const gate = new OtelForwardGate(IDLE)
    assert.strictEqual(gate.shouldForward(card('t', 100), 0), false)
    assert.strictEqual(gate.shouldForward(card('t', 200), 900), false)     // changed: idle clock restarts
    assert.strictEqual(gate.shouldForward(card('t', 200), 1500), false)    // 600 ms idle only
    assert.strictEqual(gate.shouldForward(card('t', 200), 1900), true)
  })

  test('re-forwards when content changes after a forward and settles again (unlike forward-once)', () => {
    const gate = new OtelForwardGate(IDLE)
    gate.shouldForward(card('t', 100), 0)
    assert.strictEqual(gate.shouldForward(card('t', 100), 1000), true)
    // A long tool run adds to the turn three minutes later.
    assert.strictEqual(gate.shouldForward(card('t', 100, { totalToolCalls: 2 }), 5000), false)
    assert.strictEqual(gate.shouldForward(card('t', 100, { totalToolCalls: 2 }), 5500), false)
    assert.strictEqual(gate.shouldForward(card('t', 100, { totalToolCalls: 2 }), 6000), true)
    assert.strictEqual(gate.shouldForward(card('t', 100, { totalToolCalls: 2 }), 9000), false)
  })

  test('usage changes count as content changes', () => {
    const gate = new OtelForwardGate(IDLE)
    gate.shouldForward(card('t', 100), 0)
    assert.strictEqual(gate.shouldForward(card('t', 100, { outputTokens: 99 }), 1000), false)
    assert.strictEqual(gate.shouldForward(card('t', 100, { outputTokens: 99 }), 2000), true)
  })

  test('traces are independent', () => {
    const gate = new OtelForwardGate(IDLE)
    gate.shouldForward(card('a', 1), 0)
    gate.shouldForward(card('b', 1), 500)
    assert.strictEqual(gate.shouldForward(card('a', 1), 1000), true)
    assert.strictEqual(gate.shouldForward(card('b', 1), 1000), false)
    assert.strictEqual(gate.shouldForward(card('b', 1), 1500), true)
  })

  test('prune drops traces no longer in the store and keeps the rest', () => {
    const gate = new OtelForwardGate(IDLE)
    gate.shouldForward(card('a', 1), 0)
    gate.shouldForward(card('b', 1), 0)
    gate.shouldForward(card('c', 1), 0)
    assert.strictEqual(gate.size, 3)
    assert.strictEqual(gate.prune(new Set(['b'])), 2)
    assert.strictEqual(gate.size, 1)
    // 'b' keeps its idle clock: still forwards at the right time.
    assert.strictEqual(gate.shouldForward(card('b', 1), 1000), true)
    // 'a' starts over.
    assert.strictEqual(gate.shouldForward(card('a', 1), 1000), false)
  })
})
