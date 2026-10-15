import * as assert from 'assert'
import { browserCommand, shouldAutoOpen } from './openBrowser'

suite('openBrowser', () => {
  test('passes the URL as an argument, never through a shell', () => {
    const url = 'http://localhost:3000/?token=abc"; rm -rf ~ #'
    assert.deepStrictEqual(browserCommand(url, 'darwin'), { file: 'open', args: [url] })
    assert.deepStrictEqual(browserCommand(url, 'linux'), { file: 'xdg-open', args: [url] })
    assert.deepStrictEqual(browserCommand(url, 'win32'), { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] })
  })

  test('on Windows the URL never goes through cmd.exe, which would cut it at the first & and expand %', () => {
    // An OAuth authorize URL: `&`-separated params, percent-encoded redirect_uri and state.
    const url = 'https://traceroost.com/oauth/authorize?client_id=traceroost-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fcallback&state=a%26b%3Dc&code_challenge=xyz'
    const { file, args } = browserCommand(url, 'win32')
    assert.notStrictEqual(file, 'cmd')
    assert.strictEqual(file, 'rundll32')
    assert.deepStrictEqual(args, ['url.dll,FileProtocolHandler', url])
    // Nothing in the argv needs quoting, so libuv passes it verbatim and no `&`/`%` is re-parsed.
    assert.ok(args.every(a => !/[\s"]/.test(a)))
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
