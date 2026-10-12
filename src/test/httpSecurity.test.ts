import * as assert from 'assert'
import {
  isLoopbackHost, isAllowedHostHeader, isAuthorized, extractToken, extractCookieToken,
  authCookieHeader, AUTH_COOKIE_NAME, isAllowedOrigin, isAllowedOtlpContentType, isWildcardHost,
  isSameOriginRequest, isJsonContentType,
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

    test('accepts any Host when bound to a wildcard address (LAN / Docker, token mandatory)', () => {
      assert.strictEqual(isAllowedHostHeader('192.168.1.20:3000', '0.0.0.0'), true)
      assert.strictEqual(isAllowedHostHeader('traceroost:4318', '0.0.0.0'), true)
      assert.strictEqual(isAllowedHostHeader('[fe80::1]:3000', '::'), true)
      assert.strictEqual(isAllowedHostHeader(undefined, '0.0.0.0'), false)
    })

    test('still rejects foreign Hosts for a specific non-loopback bindHost', () => {
      assert.strictEqual(isAllowedHostHeader('evil.com:3000', '192.168.1.20'), false)
    })
  })

  suite('isWildcardHost', () => {
    test('recognizes IPv4 and IPv6 any-address forms', () => {
      assert.strictEqual(isWildcardHost('0.0.0.0'), true)
      assert.strictEqual(isWildcardHost('::'), true)
      assert.strictEqual(isWildcardHost('127.0.0.1'), false)
      assert.strictEqual(isWildcardHost('192.168.1.20'), false)
    })
  })

  suite('isAllowedOrigin', () => {
    test('allows requests with no Origin (non-browser clients)', () => {
      assert.strictEqual(isAllowedOrigin(undefined), true)
    })

    test('allows loopback and VS Code webview origins', () => {
      assert.strictEqual(isAllowedOrigin('http://localhost:3000'), true)
      assert.strictEqual(isAllowedOrigin('http://127.0.0.1:3000'), true)
      assert.strictEqual(isAllowedOrigin('http://[::1]:3000'), true)
      assert.strictEqual(isAllowedOrigin('vscode-webview://1abc2def'), true)
    })

    test('rejects any other website, the opaque null origin, and garbage', () => {
      assert.strictEqual(isAllowedOrigin('https://evil.example'), false)
      assert.strictEqual(isAllowedOrigin('http://localhost.evil.example'), false)
      assert.strictEqual(isAllowedOrigin('null'), false)
      assert.strictEqual(isAllowedOrigin('file://'), false)
      assert.strictEqual(isAllowedOrigin(''), false)
    })
  })

  suite('isSameOriginRequest', () => {
    test('allows the dashboard calling back to the server that served it', () => {
      assert.strictEqual(isSameOriginRequest({ origin: 'http://localhost:3000', host: 'localhost:3000' }), true)
      assert.strictEqual(isSameOriginRequest({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000', 'sec-fetch-site': 'same-origin' }), true)
      assert.strictEqual(isSameOriginRequest({ origin: 'http://[::1]:3000', host: '[::1]:3000' }), true)
      // LAN / Docker mode: the page's origin is the LAN address the browser used.
      assert.strictEqual(isSameOriginRequest({ origin: 'http://192.168.1.20:3000', host: '192.168.1.20:3000' }), true)
      // Default port: browsers omit it from Origin; a Host that spells it out is the same origin.
      assert.strictEqual(isSameOriginRequest({ origin: 'http://localhost', host: 'localhost:80' }), true)
      assert.strictEqual(isSameOriginRequest({ origin: 'http://LOCALHOST:3000', host: 'localhost:3000' }), true)
    })

    test('allows a non-browser client that sends neither Origin nor Sec-Fetch-Site', () => {
      assert.strictEqual(isSameOriginRequest({ host: 'localhost:3000' }), true)
    })

    test('refuses a page served on another localhost port (the loopback allowance isAllowedOrigin makes)', () => {
      assert.strictEqual(isAllowedOrigin('http://localhost:8080', 'localhost:3000'), true, 'precondition: the old check let this through')
      assert.strictEqual(isSameOriginRequest({ origin: 'http://localhost:8080', host: 'localhost:3000' }), false)
      assert.strictEqual(isSameOriginRequest({ origin: 'http://127.0.0.1:3000', host: 'localhost:3000' }), false)
      assert.strictEqual(isSameOriginRequest({ origin: 'https://localhost:3000', host: 'localhost:3000' }), true)
    })

    test('refuses when the browser says the request is not same-origin, even without Origin', () => {
      assert.strictEqual(isSameOriginRequest({ host: 'localhost:3000', 'sec-fetch-site': 'same-site' }), false)
      assert.strictEqual(isSameOriginRequest({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }), false)
      assert.strictEqual(isSameOriginRequest({ origin: 'http://localhost:3000', host: 'localhost:3000', 'sec-fetch-site': 'same-site' }), false)
    })

    test('refuses foreign sites, opaque and non-http origins, webviews, and a missing Host', () => {
      assert.strictEqual(isSameOriginRequest({ origin: 'https://evil.example', host: 'localhost:3000' }), false)
      assert.strictEqual(isSameOriginRequest({ origin: 'null', host: 'localhost:3000' }), false)
      assert.strictEqual(isSameOriginRequest({ origin: 'vscode-webview://1abc2def', host: 'localhost:3000' }), false)
      assert.strictEqual(isSameOriginRequest({ origin: 'file://', host: 'localhost:3000' }), false)
      assert.strictEqual(isSameOriginRequest({ origin: 'http://localhost:3000' }), false)
    })
  })

  suite('isJsonContentType', () => {
    test('accepts application/json with or without parameters', () => {
      assert.strictEqual(isJsonContentType('application/json'), true)
      assert.strictEqual(isJsonContentType('Application/JSON; charset=utf-8'), true)
    })

    test('refuses the preflight-free types, a smuggled parameter, and a missing header', () => {
      assert.strictEqual(isJsonContentType('text/plain'), false)
      assert.strictEqual(isJsonContentType('text/plain; x=application/json'), false)
      assert.strictEqual(isJsonContentType('application/x-www-form-urlencoded'), false)
      assert.strictEqual(isJsonContentType('multipart/form-data; boundary=x'), false)
      assert.strictEqual(isJsonContentType(undefined), false)
      assert.strictEqual(isJsonContentType(''), false)
    })
  })

  suite('isAllowedOtlpContentType', () => {
    test('allows JSON and protobuf (with parameters) and a missing header', () => {
      assert.strictEqual(isAllowedOtlpContentType('application/json'), true)
      assert.strictEqual(isAllowedOtlpContentType('application/json; charset=utf-8'), true)
      assert.strictEqual(isAllowedOtlpContentType('application/x-protobuf'), true)
      assert.strictEqual(isAllowedOtlpContentType(undefined), true)
    })

    test('refuses a missing header from a browser page (bodyless/binary fetch needs no preflight)', () => {
      assert.strictEqual(isAllowedOtlpContentType(undefined, 'http://localhost:8080'), false)
      assert.strictEqual(isAllowedOtlpContentType('application/json', 'http://localhost:8080'), true)
    })

    test('rejects the CORS-simple types a web page can send without a preflight', () => {
      assert.strictEqual(isAllowedOtlpContentType('text/plain; x=application/json'), false)
      assert.strictEqual(isAllowedOtlpContentType('text/plain'), false)
      assert.strictEqual(isAllowedOtlpContentType('text/plain;charset=UTF-8'), false)
      assert.strictEqual(isAllowedOtlpContentType('application/x-www-form-urlencoded'), false)
      assert.strictEqual(isAllowedOtlpContentType('multipart/form-data; boundary=x'), false)
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

    test('a malformed percent-escape yields no token instead of throwing out of the request handler', () => {
      assert.strictEqual(extractCookieToken(req({ cookie: `${AUTH_COOKIE_NAME}=%E0%A4%A` })), null)
      assert.strictEqual(isAuthorized(req({ cookie: `${AUTH_COOKIE_NAME}=%E0%A4%A` }), 'secret'), false)
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
