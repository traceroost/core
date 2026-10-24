import * as assert from 'assert'
import { updateCheckDisabled, startVersionCheckLoop, getCachedVersionCheck, updateAdvice, DESKTOP_RELEASES_URL } from './versionCheck'

suite('versionCheck', () => {
  const realFetch = globalThis.fetch
  const realEnv = process.env.TRACEROOST_NO_UPDATE_CHECK
  teardown(() => {
    globalThis.fetch = realFetch
    if (realEnv === undefined) delete process.env.TRACEROOST_NO_UPDATE_CHECK
    else process.env.TRACEROOST_NO_UPDATE_CHECK = realEnv
  })

  test('updateAdvice: the desktop app is sent to a download, not an npm/service command', () => {
    const notBrew = () => false
    const desktop = updateAdvice({ TRACEROOST_DESKTOP: '1' }, notBrew)
    assert.strictEqual(desktop.isDesktop, true)
    assert.strictEqual(desktop.recommendedUrl, DESKTOP_RELEASES_URL)
    assert.strictEqual(desktop.recommendedCommand, '')
    // The service and Docker flags win: a desktop app attached to the service has no own collector.
    assert.deepStrictEqual(updateAdvice({ TRACEROOST_SERVICE: '1', TRACEROOST_DESKTOP: '1' }, notBrew),
      { isService: true, isDocker: false, isDesktop: false, recommendedCommand: 'traceroost service update' })
    assert.strictEqual(updateAdvice({ TRACEROOST_DOCKER: '1' }, notBrew).recommendedCommand, 'docker pull traceroost/traceroost')
    assert.strictEqual(updateAdvice({}, () => true).recommendedCommand, 'traceroost service install')
    const npx = updateAdvice({}, notBrew)
    assert.strictEqual(npx.recommendedCommand, 'npx traceroost@latest service install')
    assert.strictEqual(npx.isDesktop, false)
    assert.strictEqual(npx.recommendedUrl, undefined)
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
