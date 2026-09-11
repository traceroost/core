import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileCredentialStore, credentialsPath } from '../../team/credentials'
import type { TeamCredentials } from '../../team/config'

const SAMPLE: TeamCredentials = {
  endpoint: 'https://app.agentlens.dev',
  orgId: 'org_1',
  orgName: 'Acme',
  memberId: 'mem_1',
  role: 'member',
  perDeveloperVisibility: false,
  accessToken: 'at',
  refreshToken: 'rt',
  accessTokenExpiresAt: Date.now() + 3600_000,
  linkedAt: new Date().toISOString(),
}

suite('team/credentials', () => {
  let home: string
  setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-team-')) })
  teardown(() => { fs.rmSync(home, { recursive: true, force: true }) })

  test('load returns null when nothing is stored (no side effects, no throw)', () => {
    const store = fileCredentialStore(home)
    assert.strictEqual(store.load(), null)
    assert.strictEqual(fs.existsSync(credentialsPath(home)), false)
  })

  test('save then load round-trips, and the file is user-only (0600)', () => {
    const store = fileCredentialStore(home)
    store.save(SAMPLE)
    assert.deepStrictEqual(store.load(), SAMPLE)
    const mode = fs.statSync(credentialsPath(home)).mode & 0o777
    assert.strictEqual(mode, 0o600)
  })

  test('clear deletes the credential and is idempotent', () => {
    const store = fileCredentialStore(home)
    store.save(SAMPLE)
    store.clear()
    assert.strictEqual(store.load(), null)
    store.clear() // no throw the second time
  })

  test('a malformed / partial credential file loads as null, not a half object', () => {
    const store = fileCredentialStore(home)
    fs.mkdirSync(path.dirname(credentialsPath(home)), { recursive: true })
    fs.writeFileSync(credentialsPath(home), JSON.stringify({ orgId: 'x' }))
    assert.strictEqual(store.load(), null)
  })
})
