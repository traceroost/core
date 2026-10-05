import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileCredentialStore, setCredentialStore, loadCredentials } from '../../../cloud/org/credentials'
import { refreshCredentials, freshCredentials, fetchWithFreshToken } from '../../../cloud/org/tokenRefresh'
import { TokenRefreshError, isPermanentRefreshError, versionFromPackageJson } from '../../../cloud/org/oauthClient'
import type { OrgCredentials } from '../../../cloud/org/config'

const CREDS: OrgCredentials = {
  endpoint: 'https://traceroost.com',
  orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1', role: 'developer',
  perDeveloperVisibility: false,
  accessToken: 'access-1', refreshToken: 'refresh-1',
  accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
}

const realFetch = globalThis.fetch

function tokenBody(n: number): string {
  return JSON.stringify({
    access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600,
    member_id: 'm-1', org_id: 'org-1', install_id: 'install-1',
  })
}

suite('org/tokenRefresh', () => {
  let home: string
  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-refresh-'))
    const store = fileCredentialStore(home)
    store.save(CREDS)
    setCredentialStore(store)
  })
  teardown(() => {
    globalThis.fetch = realFetch
    setCredentialStore(undefined)
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('two concurrent refreshes of the same credential rotate it once — the second uses the first\'s tokens', async () => {
    let tokenCalls = 0
    globalThis.fetch = (async () => {
      tokenCalls++
      await new Promise(r => setTimeout(r, 50))
      // The server rotates: only the first presentation of refresh-1 is valid.
      return tokenCalls === 1
        ? new Response(tokenBody(2), { status: 200 })
        : new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    }) as typeof fetch
    const [a, b] = await Promise.all([refreshCredentials(CREDS), refreshCredentials(CREDS)])
    assert.strictEqual(tokenCalls, 1)
    assert.strictEqual(a.refreshToken, 'refresh-2')
    assert.strictEqual(b.refreshToken, 'refresh-2')
    assert.strictEqual(loadCredentials()?.refreshToken, 'refresh-2')
  })

  test('a genuinely rejected refresh token surfaces as a permanent error', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch
    await assert.rejects(refreshCredentials(CREDS), (e: unknown) => e instanceof TokenRefreshError && e.permanent)
  })

  test('a rejection whose error carries trailing detail is still permanent', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_grant (refresh token expired)' }), { status: 400 })) as typeof fetch
    await assert.rejects(refreshCredentials(CREDS), (e: unknown) => e instanceof TokenRefreshError && e.permanent)
  })

  test('a server error during refresh is not permanent', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'server_error' }), { status: 500 })) as typeof fetch
    await assert.rejects(refreshCredentials(CREDS), (e: unknown) => e instanceof TokenRefreshError && !e.permanent)
  })

  test('isPermanentRefreshError reads only the error code before any detail', () => {
    for (const e of ['invalid_grant', 'invalid_client', 'invalid_grant (refresh token expired)', 'invalid_client(revoked)', ' invalid_grant']) {
      assert.strictEqual(isPermanentRefreshError(e), true, e)
    }
    for (const e of [undefined, 42, '', 'server_error', 'invalid_grants', 'temporarily_unavailable (invalid_grant)', 'invalid_request']) {
      assert.strictEqual(isPermanentRefreshError(e), false, String(e))
    }
  })

  test('versionFromPackageJson accepts the extension and npm package names only', () => {
    assert.strictEqual(versionFromPackageJson(JSON.stringify({ name: 'agentlens-dashboard', version: '1.2.3' })), '1.2.3')
    assert.strictEqual(versionFromPackageJson(JSON.stringify({ name: 'traceroost', version: '4.5.6' })), '4.5.6')
    assert.strictEqual(versionFromPackageJson(JSON.stringify({ name: 'some-host-project', version: '9.9.9' })), undefined)
    assert.strictEqual(versionFromPackageJson(JSON.stringify({ name: 'traceroost' })), undefined)
  })

  test('freshCredentials leaves a comfortably valid token alone', async () => {
    globalThis.fetch = (() => { throw new Error('must not refresh') }) as typeof fetch
    assert.strictEqual((await freshCredentials())?.accessToken, 'access-1')
  })

  test('freshCredentials refreshes a token that has expired', async () => {
    fileCredentialStore(home).save({ ...CREDS, accessTokenExpiresAt: Date.now() - 1 })
    globalThis.fetch = (async () => new Response(tokenBody(3), { status: 200 })) as typeof fetch
    assert.strictEqual((await freshCredentials())?.accessToken, 'access-3')
  })

  test('fetchWithFreshToken refreshes once on a 401 and retries with the new token', async () => {
    const auths: string[] = []
    globalThis.fetch = (async (u: unknown) => {
      if (String(u).endsWith('/oauth/token')) return new Response(tokenBody(4), { status: 200 })
      return new Response('', { status: 401 })
    }) as typeof fetch
    const res = await fetchWithFreshToken(async (c) => {
      auths.push(c.accessToken)
      return auths.length === 1 ? new Response('', { status: 401 }) : new Response('{}', { status: 200 })
    })
    assert.strictEqual(res?.status, 200)
    assert.deepStrictEqual(auths, ['access-1', 'access-4'])
  })

  test('fetchWithFreshToken makes no request on an unlinked machine', async () => {
    setCredentialStore({ load: () => null, save: () => {}, clear: () => {} })
    let called = false
    const res = await fetchWithFreshToken(async () => { called = true; return new Response('') })
    assert.strictEqual(res, null)
    assert.strictEqual(called, false)
  })
})
