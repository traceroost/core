import * as assert from 'assert'
import * as crypto from 'crypto'
import {
  createPkcePair,
  deriveCodeChallenge,
  generateCodeVerifier,
  statesMatch,
  buildAuthorizeUrl,
} from '../../team/pkce'

suite('team/pkce', () => {
  test('verifier is 43+ unreserved chars (RFC 7636 §4.1)', () => {
    for (let i = 0; i < 20; i++) {
      const v = generateCodeVerifier()
      assert.ok(v.length >= 43 && v.length <= 128, `bad length ${v.length}`)
      assert.ok(/^[A-Za-z0-9\-._~]+$/.test(v), `non-unreserved char in ${v}`)
    }
  })

  test('challenge is S256 of the verifier', () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const expected = crypto.createHash('sha256').update(v, 'ascii').digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    assert.strictEqual(deriveCodeChallenge(v), expected)
  })

  test('statesMatch is exact and rejects mismatch / missing', () => {
    const { state } = createPkcePair()
    assert.strictEqual(statesMatch(state, state), true)
    assert.strictEqual(statesMatch(state, state + 'x'), false)
    assert.strictEqual(statesMatch(state, 'nope'), false)
    assert.strictEqual(statesMatch(state, undefined), false)
    assert.strictEqual(statesMatch(state, null), false)
  })

  test('authorize URL carries challenge, S256 method and state, and a loopback redirect', () => {
    const url = new URL(buildAuthorizeUrl({
      authorizeEndpoint: 'https://app.agentlens.dev/oauth/authorize',
      clientId: 'agentlens-client',
      redirectUri: 'http://127.0.0.1:51234/callback',
      scope: 'rollup.write roster.read',
      challenge: 'CHAL',
      state: 'STATE',
    }))
    assert.strictEqual(url.searchParams.get('code_challenge'), 'CHAL')
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256')
    assert.strictEqual(url.searchParams.get('state'), 'STATE')
    assert.strictEqual(url.searchParams.get('response_type'), 'code')
    assert.ok(url.searchParams.get('redirect_uri')!.startsWith('http://127.0.0.1:'))
  })
})
