import * as assert from 'assert'
import { logLevel, logDebug } from '../logLevel'

suite('logLevel', () => {
  const saved = process.env.TRACEROOST_LOG_LEVEL
  teardown(() => {
    if (saved === undefined) delete process.env.TRACEROOST_LOG_LEVEL
    else process.env.TRACEROOST_LOG_LEVEL = saved
  })

  test('defaults to info and drops debug lines', () => {
    delete process.env.TRACEROOST_LOG_LEVEL
    const lines: string[] = []
    logDebug(m => lines.push(m), 'detail')
    assert.strictEqual(logLevel(), 'info')
    assert.deepStrictEqual(lines, [])
  })

  test('TRACEROOST_LOG_LEVEL=debug (any case) passes debug lines through', () => {
    process.env.TRACEROOST_LOG_LEVEL = ' DEBUG '
    const lines: string[] = []
    logDebug(m => lines.push(m), 'detail')
    assert.strictEqual(logLevel(), 'debug')
    assert.deepStrictEqual(lines, ['detail'])
  })

  test('an unknown value means info', () => {
    process.env.TRACEROOST_LOG_LEVEL = 'verbose'
    assert.strictEqual(logLevel(), 'info')
  })
})
