import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TraceHorizon, evictionFloorMs, nanoStringToMs, TRACE_HORIZON_FILE } from '../traceHorizon'
import { localHorizonOf, sourceExtentsOf } from '../traceIdentity'
import { pruneSpans } from '../spanStore'
import type { Span } from '../types'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 4, 12)
const card = (source: string, daysAgo: number, extra: { sessionId?: string; keyPending?: boolean } = {}) => ({
  sessionId: extra.sessionId ?? `${source}-${daysAgo}`,
  startTime: new Date(NOW - daysAgo * DAY).toISOString(),
  keyPending: extra.keyPending,
  source,
})

suite('traceHorizon — the manifest window\'s lower bound', () => {
  let dir: string
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-horizon-')) })
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('per source: the latest of each source\'s oldest card (Claude ages out at 30 days, Codex keeps 50)', () => {
    const cards = [card('codex', 50), card('codex', 2), card('claude_code', 30), card('claude_code', 1), card('claude_code', 70, { sessionId: 'synth-x' })]
    assert.strictEqual(localHorizonOf(cards), NOW - 30 * DAY)
    const ext = sourceExtentsOf(cards)
    assert.deepStrictEqual(ext.get('claude_code'), { oldestMs: NOW - 30 * DAY, newestMs: NOW - DAY })
    assert.strictEqual(new TraceHorizon(dir, () => NOW).horizonMs(ext), NOW - 30 * DAY)
  })

  test('a source that vanished entirely still bounds the window: nothing up to its newest card is claimed', () => {
    const h = new TraceHorizon(dir, () => NOW)
    assert.strictEqual(h.horizonMs(sourceExtentsOf([card('codex', 50), card('claude_code', 45), card('claude_code', 40)])), NOW - 45 * DAY)
    // Every Claude transcript aged out; Codex still reaches back 50 days.
    assert.strictEqual(h.horizonMs(sourceExtentsOf([card('codex', 50), card('codex', 1)])), NOW - 40 * DAY + 1)
    // Remembered across restarts (persisted in the store dir).
    assert.strictEqual(new TraceHorizon(dir, () => NOW).horizonMs(sourceExtentsOf([card('codex', 50)])), NOW - 40 * DAY + 1)
    // …and forgotten once it is past any manifest window.
    assert.strictEqual(new TraceHorizon(dir, () => NOW + 30 * DAY).horizonMs(sourceExtentsOf([card('codex', 50)])), NOW - 50 * DAY)
  })

  test('a raised floor (clear all data, a spans.json reset) holds, persists and never moves back', () => {
    const h = new TraceHorizon(dir, () => NOW)
    h.raiseFloor(NOW - 5 * DAY)
    h.raiseFloor(NOW - 9 * DAY)
    const ext = sourceExtentsOf([card('codex', 20)])
    assert.strictEqual(h.horizonMs(ext), NOW - 5 * DAY)
    assert.strictEqual(new TraceHorizon(dir, () => NOW).horizonMs(ext), NOW - 5 * DAY)
    assert.ok(fs.existsSync(path.join(dir, TRACE_HORIZON_FILE)))
    // Another window of the same store raised it since: picked up on the next read.
    new TraceHorizon(dir, () => NOW).raiseFloor(NOW - DAY)
    assert.strictEqual(h.horizonMs(ext), NOW - DAY)
  })

  test('nothing held → no horizon at all; a transient floor (a log file that failed to parse) is not persisted', () => {
    const h = new TraceHorizon(dir, () => NOW)
    assert.strictEqual(h.horizonMs(new Map()), null)
    h.raiseTransientFloor(NOW - 3 * DAY)
    const ext = sourceExtentsOf([card('codex', 20)])
    assert.strictEqual(h.horizonMs(ext), NOW - 3 * DAY)
    assert.strictEqual(new TraceHorizon(dir, () => NOW).horizonMs(ext), NOW - 20 * DAY)
    h.resetTransientFloor()
    assert.strictEqual(h.horizonMs(ext), NOW - 20 * DAY)
  })

  test('OTEL span eviction moves the floor just past the newest evicted span', () => {
    const span = (i: number, startMs: number): Span => ({ traceId: `t${i}`, spanId: `s${i}`, name: 'x', startTime: String(BigInt(startMs) * 1_000_000n), endTime: String(BigInt(startMs) * 1_000_000n), attributes: [] })
    const spans: Span[] = []
    for (let i = 0; i < 1_200; i++) spans.push(span(i, NOW - (2_000 - i) * 60_000))
    let floor = 0
    const dropped = pruneSpans(spans, 100, ev => { floor = evictionFloorMs(ev) })
    assert.strictEqual(dropped, 1_100)
    assert.strictEqual(floor, NOW - (2_000 - 1_099) * 60_000 + 1)
    assert.strictEqual(nanoStringToMs(spans[0].startTime), NOW - (2_000 - 1_100) * 60_000)
    assert.strictEqual(evictionFloorMs([]), 0)
    const h = new TraceHorizon(null, () => NOW)
    h.raiseFloor(floor)
    assert.strictEqual(h.horizonMs(sourceExtentsOf([card('codex', 20)])), floor)
  })
})
