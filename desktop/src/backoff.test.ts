import * as assert from 'assert'
import {
  BASE_DELAY_MS, countsAsCrashLoop, HEALTHY_UPTIME_MS, MAX_CONSECUTIVE_FAILURES, MAX_DELAY_MS,
  restartDelayMs, shouldKeepRestarting,
} from './backoff'

suite('backoff', () => {
  test('doubles from the base delay and then holds at the ceiling', () => {
    assert.strictEqual(restartDelayMs(1), BASE_DELAY_MS)
    assert.strictEqual(restartDelayMs(2), BASE_DELAY_MS * 2)
    assert.strictEqual(restartDelayMs(3), BASE_DELAY_MS * 4)
    assert.strictEqual(restartDelayMs(99), MAX_DELAY_MS)
  })

  test('never returns a negative or surprising delay for a nonsense count', () => {
    assert.strictEqual(restartDelayMs(0), 0)
    assert.strictEqual(restartDelayMs(-5), 0)
  })

  test('gives up rather than restarting forever', () => {
    assert.ok(shouldKeepRestarting(MAX_CONSECUTIVE_FAILURES - 1))
    assert.ok(!shouldKeepRestarting(MAX_CONSECUTIVE_FAILURES))
    assert.ok(!shouldKeepRestarting(MAX_CONSECUTIVE_FAILURES + 10))
  })

  test('the whole schedule up to giving up is bounded in the tens of seconds, not hours', () => {
    let total = 0
    for (let n = 1; n < MAX_CONSECUTIVE_FAILURES; n++) total += restartDelayMs(n)
    assert.ok(total < 60_000, `expected the give-up path to take under a minute, got ${total}ms`)
  })

  test('a collector that ran a while before dying starts a fresh count, not the next step of an old one', () => {
    assert.ok(countsAsCrashLoop(500))
    assert.ok(countsAsCrashLoop(HEALTHY_UPTIME_MS - 1))
    assert.ok(!countsAsCrashLoop(HEALTHY_UPTIME_MS))
    assert.ok(!countsAsCrashLoop(6 * 60 * 60 * 1000))
  })
})
