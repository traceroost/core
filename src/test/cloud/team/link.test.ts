import * as assert from 'assert'
import * as http from 'http'
import { linkInteractive, leave } from '../../../cloud/team/link'
import { getTeamStatus } from '../../../cloud/team/status'
import { setCredentialStore, loadCredentials } from '../../../cloud/team/credentials'
import type { CredentialStore } from '../../../cloud/team/credentials'
import type { TeamCredentials } from '../../../cloud/team/config'

function memoryStore(): CredentialStore {
  let cur: TeamCredentials | null = null
  return {
    load: () => cur,
    save: (c) => { cur = c },
    clear: () => { cur = null },
  }
}

type FetchArgs = Parameters<typeof fetch>
const realFetch = globalThis.fetch

/** Simulates the browser: reads the authorize URL, hits the loopback redirect with code+state. */
function fakeBrowser(overrideState?: string) {
  return (authorizeUrl: string) =>
    new Promise<void>((resolve, reject) => {
      const u = new URL(authorizeUrl)
      const redirectUri = u.searchParams.get('redirect_uri')!
      const state = overrideState ?? u.searchParams.get('state')!
      http.get(`${redirectUri}?code=testcode&state=${encodeURIComponent(state)}`, res => {
        res.resume()
        res.on('end', () => resolve())
      }).on('error', reject)
    })
}

suite('team/link', () => {
  setup(() => {
    setCredentialStore(memoryStore())
    globalThis.fetch = (async (input: FetchArgs[0], _init?: FetchArgs[1]) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer',
          expires_in: 3600, member_id: 'mem-1', org_id: 'org-1',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/roster/me')) {
        return new Response(JSON.stringify({ org_name: 'Acme Corp', role: 'member', per_developer_visibility: false }), { status: 200 })
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
    const status = getTeamStatus()
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
    assert.strictEqual(getTeamStatus().indicator, 'reporting')
  })

  test('a state mismatch on the callback is rejected and nothing is persisted', async () => {
    await assert.rejects(
      linkInteractive({ openUrl: fakeBrowser('WRONG-STATE'), timeoutMs: 2000 }),
      /state mismatch/,
    )
    assert.strictEqual(loadCredentials(), null)
  })

  test('leave clears the credential even when the server is unreachable', async () => {
    await linkInteractive({ openUrl: fakeBrowser(), timeoutMs: 2000 })
    globalThis.fetch = (() => { throw new Error('offline') }) as typeof fetch
    const res = await leave()
    assert.strictEqual(res.wasLinked, true)
    assert.strictEqual(res.serverRevoked, false)
    assert.strictEqual(loadCredentials(), null)
  })
})
