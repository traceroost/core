import * as assert from 'assert'
import { getOrgStatus, type TraceSendStats } from '../../../cloud/org/status'
import { setCredentialStore } from '../../../cloud/org/credentials'
import type { CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'

function memoryStore(initial: OrgCredentials | null): CredentialStore {
  let cur = initial
  return {
    load: () => cur,
    save: (c) => { cur = c },
    clear: () => { cur = null },
  }
}

const LINKED: OrgCredentials = {
  endpoint: 'https://pro.example.com',
  orgId: 'org-1',
  installId: 'install-1',
  orgName: 'Acme Corp',
  memberId: 'mem-1',
  email: 'dev@example.com',
  role: 'developer',
  perDeveloperVisibility: false,
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: Date.now() + 3_600_000,
  linkedAt: '2026-01-01T00:00:00.000Z',
}

const STATS: TraceSendStats = { last5Min: 3, lastHour: 20, allTime: 500 }

// getOrgStatus's traceSendStats/sending parameters (AL 01, "Add transport transparency stats to
// the Team panel") — every other test in this repo that calls getOrgStatus calls it with zero
// arguments, so the pass-through itself was never exercised. See panelController.ts's `pushStatus`
// for the real caller this mirrors.
suite('org/status — traceSendStats and sending pass-through', () => {
  teardown(() => setCredentialStore(undefined))

  test('an unlinked install reports no traceSendStats even if one is passed', () => {
    setCredentialStore(memoryStore(null))
    const status = getOrgStatus(undefined, STATS, true)
    assert.strictEqual(status.linked, false)
    assert.strictEqual(status.traceSendStats, undefined)
    assert.strictEqual(status.sending, false)
  })

  test('a linked install echoes back the traceSendStats it was given', () => {
    setCredentialStore(memoryStore(LINKED))
    const status = getOrgStatus(undefined, STATS, false)
    assert.strictEqual(status.linked, true)
    assert.deepStrictEqual(status.traceSendStats, STATS)
  })

  test('a linked install with no traceSendStats supplied leaves it absent, not zeroed', () => {
    setCredentialStore(memoryStore(LINKED))
    const status = getOrgStatus()
    assert.strictEqual(status.linked, true)
    assert.strictEqual(status.traceSendStats, undefined)
  })

  test('sending reflects whatever the caller passes, defaulting to false', () => {
    setCredentialStore(memoryStore(LINKED))
    assert.strictEqual(getOrgStatus().sending, false)
    assert.strictEqual(getOrgStatus(undefined, undefined, true).sending, true)
  })
})
