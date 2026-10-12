import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startDeviceFlow, pollDeviceFlow, exchangeCode, fetchRosterSelf, clientVersion } from '../../../cloud/org/oauthClient'
import { linkViaDevice } from '../../../cloud/org/link'
import { getOrgStatus } from '../../../cloud/org/status'
import { setCredentialStore, type CredentialStore } from '../../../cloud/org/credentials'
import { writeForwardState, readForwardState, clearForwardState } from '../../../cloud/forward/forwardState'
import type { OrgCredentials } from '../../../cloud/org/config'

const realFetch = globalThis.fetch
const TOKENS = { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, member_id: 'm', org_id: 'o', install_id: 'i' }

function memStore(initial: OrgCredentials | null = null): CredentialStore {
  let cur = initial
  return { load: () => cur, save: c => { cur = c }, clear: () => { cur = null } }
}

suite('org/oauthClient — device flow, cap errors, roster summary', () => {
  setup(() => setCredentialStore(memStore()))
  teardown(() => { globalThis.fetch = realFetch; setCredentialStore(undefined) })

  test('the device-code request sends client_version, as the auth-code flow does', async () => {
    let body = ''
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = String(init?.body)
      return new Response(JSON.stringify({ device_code: 'd', user_code: 'U', verification_uri: 'https://x/oauth/device', expires_in: 600, interval: 5 }), { status: 200 })
    }) as typeof fetch
    await startDeviceFlow('laptop')
    assert.strictEqual(new URLSearchParams(body).get('client_version'), clientVersion())
  })

  test('device poll: a 403 cap refusal (access_denied + error_description) is "blocked", a 400 access_denied is "denied"', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'access_denied', error_description: 'Free plan allows 1 machine.' }), { status: 403 })) as typeof fetch
    assert.deepStrictEqual(await pollDeviceFlow('d'), { status: 'blocked', message: 'Free plan allows 1 machine.' })
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'access_denied' }), { status: 400 })) as typeof fetch
    assert.deepStrictEqual(await pollDeviceFlow('d'), { status: 'denied', message: undefined })
  })

  test('linkViaDevice keeps polling through a cap refusal (the code stays pending) and links once a slot frees up', async () => {
    const replies = [
      () => new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
      () => new Response(JSON.stringify({ error: 'access_denied', error_description: 'Free plan allows 1 machine.' }), { status: 403 }),
      () => new Response(JSON.stringify({ error: 'access_denied', error_description: 'Free plan allows 1 machine.' }), { status: 403 }),
      () => new Response(JSON.stringify(TOKENS), { status: 200 }),
    ]
    globalThis.fetch = (async (u: unknown) => {
      const url = String(u)
      if (url.endsWith('/oauth/device/code')) return new Response(JSON.stringify({ device_code: 'd', user_code: 'U', verification_uri: 'https://x/oauth/device', expires_in: 600, interval: 1 }), { status: 200 })
      if (url.endsWith('/oauth/device/token')) return replies.shift()!()
      if (url.includes('/api/roster/me')) return new Response(JSON.stringify({ org_name: 'Acme', role: 'developer', per_developer_visibility: false, email: 'e@x' }), { status: 200 })
      throw new Error(url)
    }) as typeof fetch
    const blocked: string[] = []
    const res = await linkViaDevice({ onPrompt: () => {}, onBlocked: m => blocked.push(m), sleep: async () => {} })
    assert.strictEqual(res.orgName, 'Acme')
    assert.deepStrictEqual(blocked, ['Free plan allows 1 machine.'], 'told once per distinct message')
  })

  test('a refused code exchange shows the server\'s error_description', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'access_denied', error_description: 'This org has reached its machine limit.' }), { status: 403 })) as typeof fetch
    await assert.rejects(exchangeCode({ code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1/cb' }), /This org has reached its machine limit\./)
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch
    await assert.rejects(exchangeCode({ code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1/cb' }), /link failed: invalid_grant/)
  })

  test('roster/me\'s teammate_visibility_summary is read, cached on the credential and shown by status', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ org_name: 'Acme', role: 'developer', per_developer_visibility: true, email: 'e@x', teammate_visibility_summary: 'An admin of Acme sees your individual figures.' }), { status: 200 })) as typeof fetch
    const self = await fetchRosterSelf('tok', 'https://x')
    assert.strictEqual(self?.teammateVisibilitySummary, 'An admin of Acme sees your individual figures.')
    setCredentialStore(memStore({
      endpoint: 'https://x', orgId: 'o', orgName: 'Acme', memberId: 'm', role: 'developer', perDeveloperVisibility: true,
      teammateVisibilitySummary: self!.teammateVisibilitySummary, accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
    }))
    assert.strictEqual(getOrgStatus().teammateVisibilitySummary, 'An admin of Acme sees your individual figures.')
  })
})

suite('org/status — the persistent notice', () => {
  let home: string
  setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-notice-')); setCredentialStore(memStore()) })
  teardown(() => { setCredentialStore(undefined); fs.rmSync(home, { recursive: true, force: true }) })

  test('a relink notice shows while unlinked (survives clearing the rest of the state); an upgrade one only for its own version', () => {
    clearForwardState(home, { kind: 'relink', message: 'TraceRoost Cloud sign-in expired — re-link this machine', at: new Date().toISOString() })
    assert.strictEqual(readForwardState(home).lastError, null)
    const st = getOrgStatus(undefined, undefined, false, home)
    assert.strictEqual(st.linked, false)
    assert.strictEqual(st.notice?.kind, 'relink')
    writeForwardState({ notice: { kind: 'upgrade', message: 'Update TraceRoost', at: '', version: '0.0.0-old' } }, home)
    setCredentialStore(memStore({
      endpoint: 'https://x', orgId: 'o', orgName: 'Acme', memberId: 'm', role: 'developer', perDeveloperVisibility: false,
      accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
    }))
    assert.strictEqual(getOrgStatus(undefined, undefined, false, home).notice, undefined, 'raised for another version')
    writeForwardState({ notice: { kind: 'upgrade', message: 'Update TraceRoost', at: '', version: clientVersion() } }, home)
    const linked = getOrgStatus(undefined, undefined, false, home)
    assert.strictEqual(linked.notice?.kind, 'upgrade')
    assert.strictEqual(linked.indicator, 'degraded')
  })

  test('writeForwardState merges under the lock and replaces the file atomically (no tmp file left behind)', () => {
    writeForwardState({ lastError: 'a' }, home)
    writeForwardState({ paused: true }, home)
    const st = readForwardState(home)
    assert.strictEqual(st.lastError, 'a')
    assert.strictEqual(st.paused, true)
    const dir = path.join(home, '.traceroost')
    assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.includes('forward-state')), ['forward-state.json'])
  })
})
