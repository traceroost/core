import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { startBackgroundReconciliation, isRecentlyActive, type WatchableSession } from '../../reconcile/backgroundWatcher'
import type { ReconciliationService, ReconcileInput } from '../../reconcile/reconciliationService'

function tick(ms = 0): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

suite('backgroundWatcher', () => {
  let repoDir: string
  setup(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-bgwatch-'))
    execFileSync('git', ['init', '-q'], { cwd: repoDir })
  })
  teardown(() => { fs.rmSync(repoDir, { recursive: true, force: true }) })

  test('isRecentlyActive: running or recently ended sessions only', () => {
    const now = Date.parse('2026-01-10T00:00:00Z')
    const base = { sessionId: 's', workspace: '/w', filesChanged: [] }
    assert.strictEqual(isRecentlyActive({ ...base }, now), true)
    assert.strictEqual(isRecentlyActive({ ...base, endTime: '2026-01-09T12:00:00Z' }, now), true)
    assert.strictEqual(isRecentlyActive({ ...base, endTime: '2026-01-01T00:00:00Z' }, now), false)
  })

  test('never runs two passes at once; requests during a pass collapse into one follow-up', async () => {
    let active = 0
    let maxActive = 0
    let passes = 0
    const gate: { release?: () => void } = {}
    const service = {
      async reconcileMany(inputs: ReconcileInput[]) {
        passes++
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise<void>(r => { gate.release = r })
        active--
        return inputs.map(i => ({ sessionId: i.sessionId, outcome: null, revision: null, changed: false, deferred: false }))
      },
    } as unknown as ReconciliationService
    const sessions: WatchableSession[] = [{ sessionId: 's1', workspace: repoDir, filesChanged: [] }]
    const watcher = startBackgroundReconciliation({ service, listSessions: () => sessions })
    try {
      for (let i = 0; i < 50 && !gate.release; i++) await tick(20)
      assert.ok(gate.release, 'first pass started')
      watcher.refreshNow()
      watcher.refreshNow()
      watcher.refreshNow()
      const first = gate.release
      gate.release = undefined
      first()
      for (let i = 0; i < 50 && !gate.release; i++) await tick(20)
      const second = gate.release as (() => void) | undefined
      assert.ok(second, 'one follow-up pass started')
      second()
      await tick(100)
      assert.strictEqual(maxActive, 1)
      assert.strictEqual(passes, 2)
    } finally {
      watcher.dispose()
    }
  })
})
