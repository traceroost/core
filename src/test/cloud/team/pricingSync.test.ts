import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startPricingSync } from '../../../cloud/team/pricingSync'
import { setCredentialStore, type CredentialStore } from '../../../cloud/team/credentials'
import type { TeamCredentials } from '../../../cloud/team/config'
import { lookupRates, setCloudRateOverrides } from '../../../pricing'

const CREDS: TeamCredentials = {
  endpoint: 'https://traceroost.com',
  orgId: 'org-1', orgName: 'Acme', memberId: 'm-1', role: 'member',
  perDeveloperVisibility: false,
  accessToken: 'access-1', refreshToken: 'refresh-1',
  accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
}

function memStore(initial: TeamCredentials | null): CredentialStore {
  let cur = initial
  return { load: () => cur, save: c => { cur = c }, clear: () => { cur = null } }
}

const realFetch = globalThis.fetch

suite('team/pricingSync', () => {
  let home: string
  setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-pricingsync-')) })
  teardown(() => {
    globalThis.fetch = realFetch
    setCredentialStore(undefined)
    setCloudRateOverrides({})
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('onSync fires after a successful fetch on a linked install', async () => {
    setCredentialStore(memStore(CREDS))
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ rates: { 'claude-sonnet-5': { inputPerMTok: 1, cacheReadPerMTok: 1, cacheWritePerMTok: 1, outputPerMTok: 1 } } }),
      { status: 200 },
    )) as typeof fetch

    let calls = 0
    const handle = startPricingSync({ baseHome: home, onSync: () => { calls++ } })
    await new Promise(resolve => setTimeout(resolve, 50))
    handle.dispose()

    assert.ok(calls >= 1, 'onSync should have fired at least once')
    assert.strictEqual(lookupRates('claude-sonnet-5')?.inputPerMTok, 1)
  })

  test('onSync does not fire while unlinked — no timer is even started', async () => {
    setCredentialStore(memStore(null))
    let calls = 0
    const handle = startPricingSync({ baseHome: home, onSync: () => { calls++ } })
    await new Promise(resolve => setTimeout(resolve, 50))
    handle.dispose()
    assert.strictEqual(calls, 0)
  })

  test('leaving a team clears the override and fires onSync again, so the webview drops any stale "Remote" label', async () => {
    setCredentialStore(memStore(CREDS))
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ rates: { 'claude-sonnet-5': { inputPerMTok: 1, cacheReadPerMTok: 1, cacheWritePerMTok: 1, outputPerMTok: 1 } } }),
      { status: 200 },
    )) as typeof fetch

    let calls = 0
    const handle = startPricingSync({ baseHome: home, onSync: () => { calls++ } })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.strictEqual(lookupRates('claude-sonnet-5')?.inputPerMTok, 1, 'override should be active before leaving')
    const before = calls

    setCredentialStore(memStore(null))
    handle.syncToLinkState()

    assert.ok(calls > before, 'onSync should fire again on leaving')
    assert.notStrictEqual(lookupRates('claude-sonnet-5')?.inputPerMTok, 1, 'leaving should clear the override')
    handle.dispose()
  })
})
