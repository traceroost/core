import * as assert from 'assert'
import { chooseLinkFlow } from './org-cli'

suite('chooseLinkFlow (traceroost org link)', () => {
  const desktop = { args: [], env: {}, stdoutIsTty: true, platform: 'darwin' as const }

  test('uses the browser flow on a desktop terminal, as before', () => {
    assert.strictEqual(chooseLinkFlow(desktop), 'browser')
    assert.strictEqual(chooseLinkFlow({ ...desktop, platform: 'linux', env: { DISPLAY: ':0' } }), 'browser')
  })

  test('uses the device flow over SSH', () => {
    assert.strictEqual(chooseLinkFlow({ ...desktop, env: { SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' } }), 'device')
    assert.strictEqual(chooseLinkFlow({ ...desktop, env: { SSH_TTY: '/dev/pts/0' } }), 'device')
  })

  test('uses the device flow on Linux without a display', () => {
    assert.strictEqual(chooseLinkFlow({ ...desktop, platform: 'linux' }), 'device')
  })

  test('uses the device flow when stdout is not a terminal or opening is turned off', () => {
    assert.strictEqual(chooseLinkFlow({ ...desktop, stdoutIsTty: false }), 'device')
    assert.strictEqual(chooseLinkFlow({ ...desktop, args: ['--no-open'] }), 'device')
    assert.strictEqual(chooseLinkFlow({ ...desktop, env: { TRACEROOST_NO_OPEN: '1' } }), 'device')
  })

  test('lets --device and --browser override the detection', () => {
    assert.strictEqual(chooseLinkFlow({ ...desktop, args: ['--device'] }), 'device')
    assert.strictEqual(chooseLinkFlow({ ...desktop, args: ['--browser'], env: { SSH_TTY: '/dev/pts/0' } }), 'browser')
    assert.strictEqual(chooseLinkFlow({ ...desktop, args: ['--browser', '--device'] }), 'device')
  })
})
