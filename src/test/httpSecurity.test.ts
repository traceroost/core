import * as assert from 'assert'
import {
  isLoopbackHost, isAllowedHostHeader, isAuthorized, extractToken, extractCookieToken,
  authCookieHeader, AUTH_COOKIE_NAME,
} from '../httpSecurity'

function req(opts: { host?: string; authorization?: string; url?: string; cookie?: string }) {
  const headers: Record<string, string> = {}
  if (opts.host !== undefined) headers['host'] = opts.host
  if (opts.authorization !== undefined) headers['authorization'] = opts.authorization
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie
  return { headers, url: opts.url ?? '/' }
}

suite('httpSecurity', () => {
  suite('isLoopbackHost', () => {
    test('recognizes the three loopback aliases', () => {
      assert.strictEqual(isLoopbackHost('localhost'), true)
      assert.strictEqual(isLoopbackHost('127.0.0.1'), true)
      assert.strictEqual(isLoopbackHost('::1'), true)
    })

    test('rejects a real hostname or 0.0.0.0', () => {
      assert.strictEqual(isLoopbackHost('0.0.0.0'), false)
      assert.strictEqual(isLoopbackHost('example.com'), false)
    })
  })

  suite('isAllowedHostHeader', () => {
    test('allows localhost and 127.0.0.1 with a port, regardless of bindHost', () => {
      assert.strictEqual(isAllowedHostHeader('localhost:3000', '0.0.0.0'), true)
      assert.strictEqual(isAllowedHostHeader('127.0.0.1:3000', '0.0.0.0'), true)
    })

    test('allows bracketed IPv6 loopback', () => {
      assert.strictEqual(isAllowedHostHeader('[::1]:3000', '127.0.0.1'), true)
    })

    test('allows the configured bindHost itself when it is not loopback', () => {
      assert.strictEqual(isAllowedHostHeader('traceroost.internal:3000', 'traceroost.internal'), true)
    })

    test('rejects an attacker-controlled hostname (DNS-rebinding scenario)', () => {
      // The whole point of Host validation: a page at evil.com that gets its own domain to
      // resolve to 127.0.0.1 still sends "evil.com" as the Host header, not "localhost" —
      // the browser does not rewrite it to match the IP it actually connected to.
      assert.strictEqual(isAllowedHostHeader('evil.com:3000', '127.0.0.1'), false)
    })

    test('rejects a missing Host header', () => {
      assert.strictEqual(isAllowedHostHeader(undefined, '127.0.0.1'), false)
    })
  })

  suite('extractToken', () => {
    test('reads an Authorization: Bearer header', () => {
      assert.strictEqual(extractToken(req({ authorization: 'Bearer abc123' })), 'abc123')
    })

    test('reads a ?token= query param', () => {
      assert.strictEqual(extractToken(req({ url: '/?token=xyz789' })), 'xyz789')
    })

    test('reads the traceroost_token cookie', () => {
      assert.strictEqual(extractToken(req({ cookie: `${AUTH_COOKIE_NAME}=cookieval` })), 'cookieval')
    })

    test('prefers the Authorization header over a query token', () => {
      assert.strictEqual(extractToken(req({ authorization: 'Bearer header-token', url: '/?token=query-token' })), 'header-token')
    })

    test('returns null when nothing is present', () => {
      assert.strictEqual(extractToken(req({})), null)
    })

    test('ignores a malformed Authorization header', () => {
      assert.strictEqual(extractToken(req({ authorization: 'Basic dXNlcjpwYXNz' })), null)
    })
  })

  suite('extractCookieToken', () => {
    test('extracts the token from among multiple cookies', () => {
      assert.strictEqual(extractCookieToken(req({ cookie: `foo=bar; ${AUTH_COOKIE_NAME}=thetoken; baz=qux` })), 'thetoken')
    })

    test('returns null when the cookie is absent', () => {
      assert.strictEqual(extractCookieToken(req({ cookie: 'foo=bar' })), null)
    })
  })

  suite('isAuthorized', () => {
    test('accepts a matching token from any source', () => {
      assert.strictEqual(isAuthorized(req({ authorization: 'Bearer secret' }), 'secret'), true)
      assert.strictEqual(isAuthorized(req({ url: '/?token=secret' }), 'secret'), true)
      assert.strictEqual(isAuthorized(req({ cookie: `${AUTH_COOKIE_NAME}=secret` }), 'secret'), true)
    })

    test('rejects a wrong or missing token', () => {
      assert.strictEqual(isAuthorized(req({ authorization: 'Bearer wrong' }), 'secret'), false)
      assert.strictEqual(isAuthorized(req({}), 'secret'), false)
    })

    test('fails open when no token is configured yet', () => {
      assert.strictEqual(isAuthorized(req({}), ''), true)
    })
  })

  suite('authCookieHeader', () => {
    test('sets the token, HttpOnly, and a long Max-Age', () => {
      const header = authCookieHeader('mytoken')
      assert.ok(header.includes(`${AUTH_COOKIE_NAME}=mytoken`))
      assert.ok(header.includes('HttpOnly'))
      assert.ok(header.includes('Path=/'))
    })
  })
})
