import * as assert from 'assert'
import { dashboardTarget } from './dashboardUrl'

suite('dashboardUrl', () => {
  test('a loopback collector needs no token, matching the server\'s own rule', () => {
    const target = dashboardTarget({ uiPort: 3000, bindHost: '127.0.0.1', authToken: 'secret' })
    assert.strictEqual(target.initialUrl, 'http://127.0.0.1:3000/')
    assert.ok(!target.initialUrl.includes('secret'))
  })

  test('localhost and ::1 count as loopback too', () => {
    for (const host of ['localhost', '::1', '[::1]', '127.0.0.5']) {
      const target = dashboardTarget({ uiPort: 3000, bindHost: host, authToken: 'secret' })
      assert.ok(!target.initialUrl.includes('secret'), host)
    }
  })

  test('a collector bound beyond loopback gets the token once, in the first request only', () => {
    const target = dashboardTarget({ uiPort: 3000, bindHost: '0.0.0.0', authToken: 'secret' })
    assert.strictEqual(target.initialUrl, 'http://127.0.0.1:3000/?token=secret')
    assert.strictEqual(target.origin, 'http://127.0.0.1:3000')
  })

  test('the origin never carries the token, since it is what navigation is checked against', () => {
    const target = dashboardTarget({ uiPort: 3000, bindHost: '0.0.0.0', authToken: 'secret' })
    assert.ok(!target.origin.includes('secret'))
    assert.ok(!target.origin.includes('?'))
  })

  test('a token with URL-significant characters is escaped', () => {
    const target = dashboardTarget({ uiPort: 3000, bindHost: '0.0.0.0', authToken: 'a&b=c d' })
    assert.strictEqual(target.initialUrl, 'http://127.0.0.1:3000/?token=a%26b%3Dc%20d')
  })

  test('a non-loopback collector with no token still loads — the server will say what it wants', () => {
    const target = dashboardTarget({ uiPort: 3000, bindHost: '0.0.0.0' })
    assert.strictEqual(target.initialUrl, 'http://127.0.0.1:3000/')
  })

  test('the connection is always made to loopback, whatever the collector bound', () => {
    assert.strictEqual(dashboardTarget({ uiPort: 3000, bindHost: '0.0.0.0' }).origin, 'http://127.0.0.1:3000')
    assert.strictEqual(dashboardTarget({ uiPort: 9 }).origin, 'http://127.0.0.1:9')
  })
})
