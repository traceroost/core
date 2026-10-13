import * as assert from 'assert'
import { browserCommand, shouldAutoOpen } from './openBrowser'

suite('openBrowser', () => {
  test('passes the URL as an argument, never through a shell', () => {
    const url = 'http://localhost:3000/?token=abc"; rm -rf ~ #'
    assert.deepStrictEqual(browserCommand(url, 'darwin'), { file: 'open', args: [url] })
    assert.deepStrictEqual(browserCommand(url, 'linux'), { file: 'xdg-open', args: [url] })
    assert.deepStrictEqual(browserCommand(url, 'win32'), { file: 'cmd', args: ['/c', 'start', '', url] })
  })

  test('service install opens the dashboard only for someone at a local, interactive terminal', () => {
    const base = { args: [] as string[], env: {}, stdoutIsTty: true, platform: 'darwin' as NodeJS.Platform }
    assert.strictEqual(shouldAutoOpen(base), true)
    assert.strictEqual(shouldAutoOpen({ ...base, args: ['--ui-port', '3001', '--no-open'] }), false)
    assert.strictEqual(shouldAutoOpen({ ...base, env: { TRACEROOST_NO_OPEN: '1' } }), false)
    assert.strictEqual(shouldAutoOpen({ ...base, stdoutIsTty: false }), false)
    assert.strictEqual(shouldAutoOpen({ ...base, env: { SSH_CONNECTION: '10.0.0.2 5000 10.0.0.3 22' } }), false)
    assert.strictEqual(shouldAutoOpen({ ...base, platform: 'linux' }), false)
    assert.strictEqual(shouldAutoOpen({ ...base, platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }), true)
    assert.strictEqual(shouldAutoOpen({ ...base, platform: 'win32' }), true)
  })
})
