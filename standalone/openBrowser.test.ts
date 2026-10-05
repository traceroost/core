import * as assert from 'assert'
import { browserCommand } from './openBrowser'

suite('openBrowser', () => {
  test('passes the URL as an argument, never through a shell', () => {
    const url = 'http://localhost:3000/?token=abc"; rm -rf ~ #'
    assert.deepStrictEqual(browserCommand(url, 'darwin'), { file: 'open', args: [url] })
    assert.deepStrictEqual(browserCommand(url, 'linux'), { file: 'xdg-open', args: [url] })
    assert.deepStrictEqual(browserCommand(url, 'win32'), { file: 'cmd', args: ['/c', 'start', '', url] })
  })
})
