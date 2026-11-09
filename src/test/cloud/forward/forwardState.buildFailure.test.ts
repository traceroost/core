import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { recordBuildFailure, queueStats, readForwardState, writeForwardState } from '../../../cloud/forward/forwardState'
import { getOrgStatus } from '../../../cloud/org/status'
import { setCredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'

const LINKED: OrgCredentials = {
  endpoint: 'https://traceroost.com', orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'mem-1',
  role: 'developer', perDeveloperVisibility: false, accessToken: 'a', refreshToken: 'r',
  accessTokenExpiresAt: Date.now() + 3_600_000, linkedAt: '2026-01-01T00:00:00.000Z',
}

// A payload that cannot be built never reaches the queue, so until recordBuildFailure existed the
// sender never saw it and the status stayed "reporting": the 1.0.0 desktop app shipped without
// schema/rollup.v1.json, failed every build, and read "Synced" the whole time.
suite('cloud/forward/forwardState — recordBuildFailure', () => {
  let home: string
  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-build-failure-'))
    setCredentialStore({ load: () => LINKED, save: () => undefined, clear: () => undefined })
  })
  teardown(() => {
    setCredentialStore(undefined)
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('a build failure is recorded like a failed send, and the status turns degraded with the reason', () => {
    recordBuildFailure('could not locate schema/rollup.v1.json — the package is built incorrectly', home)
    const state = readForwardState(home)
    assert.strictEqual(state.lastError, 'could not prepare a trace to send: could not locate schema/rollup.v1.json — the package is built incorrectly')
    assert.ok(state.lastErrorAt)
    const status = getOrgStatus(queueStats(0, home), undefined, false, home)
    assert.strictEqual(status.indicator, 'degraded')
    assert.strictEqual(status.degradedReason, state.lastError)
  })

  test('a later successful send outranks it — the status is reporting again', async () => {
    recordBuildFailure('boom', home)
    await new Promise(resolve => setTimeout(resolve, 5))
    writeForwardState({ lastSuccessAt: new Date().toISOString() }, home)
    const status = getOrgStatus(queueStats(0, home), undefined, false, home)
    assert.strictEqual(status.indicator, 'reporting')
  })
})
