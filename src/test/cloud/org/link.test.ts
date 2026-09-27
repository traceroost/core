import * as assert from 'assert'
import * as http from 'http'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { linkInteractive, leave, refreshOrgNameIfStale, resetRoleCheckForTests } from '../../../cloud/org/link'
import { getOrgStatus } from '../../../cloud/org/status'
import { setCredentialStore, loadCredentials } from '../../../cloud/org/credentials'
import type { CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'

function memoryStore(): CredentialStore {
  let cur: OrgCredentials | null = null
  return {
    load: () => cur,
    save: (c) => { cur = c },
    clear: () => { cur = null },
  }
}

type FetchArgs = Parameters<typeof fetch>
const realFetch = globalThis.fetch

/**
 * Simulates the browser: reads the authorize URL, hits the loopback redirect with code+state.
 * Resolves once the request is sent, not once the response completes — the server now holds that
 * response open until `linkInteractive()` itself calls `finish()` (after the exchange below), so
 * waiting for it here would deadlock against the very call this is meant to unblock. A real
 * browser open doesn't wait for the page to finish loading either.
 */
function fakeBrowser(overrideState?: string) {
  return (authorizeUrl: string) =>
    new Promise<void>((resolve, reject) => {
      const u = new URL(authorizeUrl)
      const redirectUri = u.searchParams.get('redirect_uri')!
      const state = overrideState ?? u.searchParams.get('state')!
      const req = http.get(`${redirectUri}?code=testcode&state=${encodeURIComponent(state)}`, res => {
        res.resume() // drain in the background so the socket doesn't back up
      })
      req.on('error', reject)
      req.on('finish', () => resolve())
    })
}

suite('org/link', () => {
  setup(() => {
    setCredentialStore(memoryStore())
    globalThis.fetch = (async (input: FetchArgs[0], _init?: FetchArgs[1]) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer',
          expires_in: 3600, member_id: 'mem-1', org_id: 'org-1', install_id: 'install-1',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/roster/me')) {
        return new Response(JSON.stringify({ org_name: 'Acme Corp', role: 'developer', per_developer_visibility: false, email: 'dev@example.com' }), { status: 200 })
      }
      if (url.endsWith('/oauth/revoke')) return new Response('{"ok":true}', { status: 200 })
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as typeof fetch
  })
  teardown(() => {
    globalThis.fetch = realFetch
    setCredentialStore(undefined)
  })

  test('an unlinked install makes no network request to produce its status', () => {
    globalThis.fetch = (() => { throw new Error('status must not touch the network') }) as typeof fetch
    const status = getOrgStatus()
    assert.strictEqual(status.linked, false)
    assert.strictEqual(status.indicator, 'unlinked')
  })

  test('linkInteractive completes the PKCE flow and persists a credential', async () => {
    const result = await linkInteractive({ openUrl: fakeBrowser(), timeoutMs: 2000 })
    assert.strictEqual(result.orgId, 'org-1')
    assert.strictEqual(result.orgName, 'Acme Corp')
    const creds = loadCredentials()
    assert.strictEqual(creds?.accessToken, 'access-1')
    assert.strictEqual(creds?.memberId, 'mem-1')
    assert.strictEqual(creds?.installId, 'install-1')
    assert.strictEqual(creds?.email, 'dev@example.com')
    assert.strictEqual(getOrgStatus().indicator, 'reporting')
  })

  test('a state mismatch on the callback is rejected and nothing is persisted', async () => {
    await assert.rejects(
      linkInteractive({ openUrl: fakeBrowser('WRONG-STATE'), timeoutMs: 2000 }),
      /state mismatch/,
    )
    assert.strictEqual(loadCredentials(), null)
  })

  test('leave clears the credential and the org-salted queue, even when the server is unreachable', async () => {
    await linkInteractive({ openUrl: fakeBrowser(), timeoutMs: 2000 })
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-leave-'))
    try {
      new ForwardQueue(home).enqueue({ schema_version: '1', repo_key_fp: 'a'.repeat(64), session: { session_id: '11111111-1111-4111-8111-111111111111', agent: 'claude-code', started_at: '2026-03-01T00:00:00.000Z', duration_ms: 1 } })
      globalThis.fetch = (() => { throw new Error('offline') }) as typeof fetch
      const res = await leave(home)
      assert.strictEqual(res.wasLinked, true)
      assert.strictEqual(res.serverRevoked, false)
      assert.strictEqual(loadCredentials(), null)
      assert.strictEqual(new ForwardQueue(home).depth(), 0)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test('refreshOrgNameIfStale heals a credential whose orgName fell back to orgId', async () => {
    // Simulate exactly what persistFromTokens does when the link-time roster fetch fails: the
    // credential is saved with orgName === orgId.
    setCredentialStore((() => {
      let cur: OrgCredentials | null = {
        endpoint: 'https://test.traceroost.com', orgId: 'org-1', orgName: 'org-1',
        memberId: 'mem-1', role: 'developer', perDeveloperVisibility: false,
        accessToken: 'access-1', refreshToken: 'refresh-1',
        accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
      }
      return { load: () => cur, save: (c: OrgCredentials) => { cur = c }, clear: () => { cur = null } }
    })())

    const changed = await refreshOrgNameIfStale()
    assert.strictEqual(changed, true)
    assert.strictEqual(loadCredentials()?.orgName, 'Acme Corp')
    assert.strictEqual(loadCredentials()?.email, 'dev@example.com')
  })

  test('refreshOrgNameIfStale backfills email alone for a credential with a real orgName already', async () => {
    // A credential saved before `email` existed on OrgCredentials: orgName resolved fine at
    // the time, but there was never an email field to fill in.
    setCredentialStore((() => {
      let cur: OrgCredentials | null = {
        endpoint: 'https://test.traceroost.com', orgId: 'org-1', orgName: 'Acme Corp',
        memberId: 'mem-1', role: 'developer', perDeveloperVisibility: false,
        accessToken: 'access-1', refreshToken: 'refresh-1',
        accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
      }
      return { load: () => cur, save: (c: OrgCredentials) => { cur = c }, clear: () => { cur = null } }
    })())

    const changed = await refreshOrgNameIfStale()
    assert.strictEqual(changed, true)
    assert.strictEqual(loadCredentials()?.email, 'dev@example.com')
  })

  test('refreshOrgNameIfStale is a no-op once orgName and email are both already resolved', async () => {
    await linkInteractive({ openUrl: fakeBrowser(), timeoutMs: 2000 }) // orgName resolves to 'Acme Corp' here
    globalThis.fetch = (() => { throw new Error('must not be called — nothing is stale') }) as typeof fetch
    const changed = await refreshOrgNameIfStale()
    assert.strictEqual(changed, false)
  })

  test('refreshOrgNameIfStale re-reads the role once per process — an admin cached as a member is corrected', async () => {
    resetRoleCheckForTests()
    setCredentialStore((() => {
      let cur: OrgCredentials | null = {
        endpoint: 'https://test.traceroost.com', orgId: 'org-1', orgName: 'Acme Corp', email: 'dev@example.com',
        memberId: 'mem-1', role: 'developer', perDeveloperVisibility: false,
        accessToken: 'access-1', refreshToken: 'refresh-1',
        accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
      }
      return { load: () => cur, save: (c: OrgCredentials) => { cur = c }, clear: () => { cur = null } }
    })())
    globalThis.fetch = (async () => new Response(JSON.stringify({ org_name: 'Acme Corp', role: 'admin', per_developer_visibility: false, email: 'dev@example.com' }), { status: 200 })) as typeof fetch
    assert.strictEqual(await refreshOrgNameIfStale(), true)
    assert.strictEqual(loadCredentials()?.role, 'admin')
    globalThis.fetch = (() => { throw new Error('checked once already') }) as typeof fetch
    assert.strictEqual(await refreshOrgNameIfStale(), false)
  })

  test('refreshOrgNameIfStale logs and stays stale when the roster fetch keeps failing', async () => {
    setCredentialStore((() => {
      let cur: OrgCredentials | null = {
        endpoint: 'https://test.traceroost.com', orgId: 'org-1', orgName: 'org-1',
        memberId: 'mem-1', role: 'developer', perDeveloperVisibility: false,
        accessToken: 'access-1', refreshToken: 'refresh-1',
        accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
      }
      return { load: () => cur, save: (c: OrgCredentials) => { cur = c }, clear: () => { cur = null } }
    })())
    globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch

    const logs: string[] = []
    const changed = await refreshOrgNameIfStale((m) => logs.push(m))
    assert.strictEqual(changed, false)
    assert.strictEqual(loadCredentials()?.orgName, 'org-1')
    assert.strictEqual(logs.length, 1)
  })
})
