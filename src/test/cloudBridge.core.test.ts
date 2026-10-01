import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { cloudBridge as core } from '../cloudBridge.core'
import { cloud } from '../cloudBridge'
import { NOT_AVAILABLE_IN_CORE } from '../edition'
import { deriveRepoKey, repoHash } from '../repoKey'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

// The core edition's CloudBridge is what every seam call resolves to in a `--edition=core` build —
// these pin that it really is inert (nothing queued, nothing linked, no timers) and that anything
// that would have linked answers "not available" instead of hanging or pretending to succeed.
suite('cloudBridge.core (core edition seam)', () => {
  const card = { sessionId: 's1', workspace: process.cwd() } as unknown as SessionSummaryCard

  test('unbundled code (tests, dev) always gets the full implementation', () => {
    assert.strictEqual(cloud.edition, 'full')
    assert.strictEqual(core.edition, 'core')
  })

  test('is never linked and never queues or sends anything', async () => {
    assert.strictEqual(core.isLinked(), false)
    assert.deepStrictEqual(core.orgStatus(true), { linked: false })
    assert.deepStrictEqual(await core.enqueueSession(card), { enqueued: false, reason: 'not-linked' })
    assert.strictEqual(await core.enqueueInstructionTelemetry(process.cwd(), [card]), false)
    assert.deepStrictEqual(await core.buildPayloadPreview([card]), [])
    assert.strictEqual(await core.resolveRepoHash('a'.repeat(64), [process.cwd()]), null)
    assert.deepStrictEqual(core.privacy, { sent: [], neverSent: [] })
  })

  test('link is refused with the edition message; leave is a harmless no-op', async () => {
    await assert.rejects(core.link({ openUrl: () => assert.fail('must not open anything') }), { message: NOT_AVAILABLE_IN_CORE })
    assert.deepStrictEqual(await core.leave(), { serverRevoked: false })
  })

  test('scheduler and pricing sync handles are inert', () => {
    const s = core.startForwardScheduler({ log: () => assert.fail('must not log') })
    s.syncToLinkState(); s.drainSoon(); s.dispose()
    core.startPricingSync({ onSync: () => assert.fail('must not sync') }).dispose()
    core.drainUploadsSoon()
  })

  test('org panel messages get a "not available" reply; status requests get none', async () => {
    const posted: Record<string, unknown>[] = []
    const deps = { post: (m: Record<string, unknown>) => posted.push(m), openExternal: () => {}, recentSessions: () => [] }
    await core.handleOrgMessage({ type: 'getOrgStatus' }, deps)
    assert.strictEqual(posted.length, 0)
    await core.handleOrgMessage({ type: 'orgLink' }, deps)
    assert.deepStrictEqual(posted.map(m => m.type), ['orgActionResult', 'orgError'])
    assert.strictEqual(posted[0].ok, false)
    assert.strictEqual(posted[0].error, NOT_AVAILABLE_IN_CORE)
  })

  test('describeRepo shows the same repo hash an unlinked full-edition install does', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-core-repo-'))
    try {
      const run = (args: string[]) => execFileSync('git', args, { cwd: dir })
      run(['init', '-q', '-b', 'main'])
      run(['config', 'user.email', 't@example.com'])
      run(['config', 'user.name', 'T'])
      fs.writeFileSync(path.join(dir, 'README.md'), 'root\n')
      run(['add', '-A'])
      run(['commit', '-qm', 'root'])

      const rk = await deriveRepoKey(dir, 'unlinked-preview')
      assert.ok(rk.ok)
      const info = await core.describeRepo(dir)
      assert.deepStrictEqual(info, { root: rk.ctx.root, hash: repoHash(rk.ctx) })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    assert.strictEqual(await core.describeRepo(path.parse(os.tmpdir()).root), null)
  })
})
