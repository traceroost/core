import * as assert from 'assert'
import { updateCheckDisabled, startVersionCheckLoop, getCachedVersionCheck } from './versionCheck'

suite('versionCheck', () => {
  const realFetch = globalThis.fetch
  const realEnv = process.env.TRACEROOST_NO_UPDATE_CHECK
  teardown(() => {
    globalThis.fetch = realFetch
    if (realEnv === undefined) delete process.env.TRACEROOST_NO_UPDATE_CHECK
    else process.env.TRACEROOST_NO_UPDATE_CHECK = realEnv
  })

  test('TRACEROOST_NO_UPDATE_CHECK=1 (or true) disables the check; anything else leaves it on', () => {
    assert.strictEqual(updateCheckDisabled({ TRACEROOST_NO_UPDATE_CHECK: '1' }), true)
    assert.strictEqual(updateCheckDisabled({ TRACEROOST_NO_UPDATE_CHECK: 'true' }), true)
    assert.strictEqual(updateCheckDisabled({ TRACEROOST_NO_UPDATE_CHECK: ' TRUE ' }), true)
    assert.strictEqual(updateCheckDisabled({}), false)
    assert.strictEqual(updateCheckDisabled({ TRACEROOST_NO_UPDATE_CHECK: '0' }), false)
    assert.strictEqual(updateCheckDisabled({ TRACEROOST_NO_UPDATE_CHECK: '' }), false)
  })

  test('with the opt-out set, starting the loop never touches the network', () => {
    process.env.TRACEROOST_NO_UPDATE_CHECK = '1'
    let called = false
    globalThis.fetch = (() => { called = true; throw new Error('must not fetch') }) as typeof fetch
    startVersionCheckLoop('1.2.3')
    assert.strictEqual(called, false)
    const r = getCachedVersionCheck('1.2.3')
    assert.strictEqual(r.currentVersion, '1.2.3')
    assert.strictEqual(r.updateAvailable, false)
  })
})
