import * as assert from 'assert'
import { retentionCutoffMs, pruneLogSessions } from './sessionRetention'

const DAY = 86_400_000

suite('sessionRetention', () => {
  suite('retentionCutoffMs', () => {
    test('is `days` before now', () => {
      assert.strictEqual(retentionCutoffMs(90, 100 * DAY), 10 * DAY)
    })

    test('zero, negative or non-finite days keep everything', () => {
      assert.strictEqual(retentionCutoffMs(0, 100 * DAY), 0)
      assert.strictEqual(retentionCutoffMs(-5, 100 * DAY), 0)
      assert.strictEqual(retentionCutoffMs(NaN, 100 * DAY), 0)
    })
  })

  suite('pruneLogSessions', () => {
    const now = Date.parse('2026-10-05T00:00:00Z')
    const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString()

    test('removes cards that started before the cutoff and reports their keys', () => {
      const sessions = new Map([
        ['old', { startTime: iso(120) }],
        ['edge', { startTime: iso(90) }],
        ['recent', { startTime: iso(1) }],
        ['today', { startTime: iso(0) }],
      ])
      const removed = pruneLogSessions(sessions, retentionCutoffMs(90, now))
      assert.deepStrictEqual(removed, ['old'])
      assert.deepStrictEqual([...sessions.keys()], ['edge', 'recent', 'today'])
    })

    test('keeps cards whose start time does not parse', () => {
      const sessions = new Map([['no-time', { startTime: '' }], ['garbage', { startTime: 'not a date' }]])
      assert.deepStrictEqual(pruneLogSessions(sessions, retentionCutoffMs(90, now)), [])
      assert.strictEqual(sessions.size, 2)
    })

    test('a zero cutoff is a no-op', () => {
      const sessions = new Map([['old', { startTime: iso(5000) }]])
      assert.deepStrictEqual(pruneLogSessions(sessions, 0), [])
      assert.strictEqual(sessions.size, 1)
    })
  })
})
