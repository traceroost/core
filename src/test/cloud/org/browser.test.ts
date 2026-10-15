import * as assert from 'assert'
import { browserCommand } from '../../../cloud/org/browser'

suite('cloud/org/browser', () => {
  test('passes the URL as an argument, never through a shell', () => {
    const url = 'https://traceroost.com/org?token=abc"; rm -rf ~ #'
    assert.deepStrictEqual(browserCommand(url, 'darwin'), { file: 'open', args: [url] })
    assert.deepStrictEqual(browserCommand(url, 'linux'), { file: 'xdg-open', args: [url] })
    assert.deepStrictEqual(browserCommand(url, 'win32'), { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] })
  })

  test('on Windows the authorize URL never goes through cmd.exe, which would cut it at the first & and expand %', () => {
    const url = 'https://traceroost.com/oauth/authorize?client_id=traceroost-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fcallback&state=a%26b%3Dc&code_challenge=xyz'
    const { file, args } = browserCommand(url, 'win32')
    assert.strictEqual(file, 'rundll32')
    assert.deepStrictEqual(args, ['url.dll,FileProtocolHandler', url])
    assert.ok(args.every(a => !/[\s"]/.test(a)), 'nothing in the argv needs quoting, so libuv passes it verbatim')
  })
})
