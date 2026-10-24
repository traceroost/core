import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { startBackgroundReconciliation, isRecentlyActive, type WatchableSession } from '../../reconcile/backgroundWatcher'
import type { ReconciliationService, ReconcileInput } from '../../reconcile/reconciliationService'
import type { RepoTips } from '../../gitOutcome'

type ManyOpts = { trustedTips?: ReadonlyMap<string, RepoTips>; onTips?: (tips: Map<string, RepoTips>) => void }

function tick(ms = 0): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

suite('backgroundWatcher', () => {
  let repoDir: string
  setup(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-bgwatch-'))
    execFileSync('git', ['init', '-q'], { cwd: repoDir })
  })

  function commit(cwd: string, msg: string): void {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', msg], { cwd })
  }
  function topLevel(cwd: string): string {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8' }).trim()
  }
  async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
    for (const end = Date.now() + ms; !cond(); await tick(20)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    }
  }
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

  test('fallback ticks reuse the last pass\'s tips until the repo\'s .git changes', async () => {
    commit(repoDir, 'root')
    const root = topLevel(repoDir)
    // An old session too, so a full pass (2 inputs) is told apart from a fallback tick (1 input).
    const sessions: WatchableSession[] = [
      { sessionId: 'live', workspace: repoDir, filesChanged: [] },
      { sessionId: 'old', workspace: repoDir, filesChanged: [], endTime: '2020-01-01T00:00:00Z' },
    ]
    const calls: Array<{ inputs: number; trusted: RepoTips | undefined }> = []
    let reads = 0
    const service = {
      async reconcileMany(inputs: ReconcileInput[], opts: ManyOpts = {}) {
        const trusted = opts.trustedTips?.get(root)
        calls.push({ inputs: inputs.length, trusted })
        // Stands in for reading HEAD/trunk: a fresh value every time nothing was trusted.
        if (!trusted) opts.onTips?.(new Map([[root, { head: `h${++reads}`, trunk: null }]]))
        return inputs.map(i => ({ sessionId: i.sessionId, outcome: null, revision: null, changed: false, deferred: false }))
      },
    } as unknown as ReconciliationService
    const watcher = startBackgroundReconciliation({ service, listSessions: () => sessions, fallbackPollMs: 100 })
    try {
      await until(() => calls.some(c => c.inputs === 1 && c.trusted !== undefined), 'a tick that trusts the last tips')
      const trustedHead = calls.find(c => c.inputs === 1 && c.trusted)!.trusted!.head
      const mark = calls.length
      commit(repoDir, 'second')
      await until(() => calls.slice(mark).some(c => c.inputs === 1 && c.trusted === undefined), 'a tick that re-reads after the commit')
      await until(() => calls.slice(mark).some(c => c.inputs === 1 && c.trusted !== undefined && c.trusted.head !== trustedHead), 'a tick trusting the re-read tips')
    } finally {
      watcher.dispose()
    }
  })

  test('a linked worktree is also watched through the main repo\'s common dir, where its refs live', async () => {
    commit(repoDir, 'root')
    const worktree = `${repoDir}-wt`
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt', worktree], { cwd: repoDir })
    let passes = 0
    const service = {
      async reconcileMany(inputs: ReconcileInput[]) {
        passes++
        return inputs.map(i => ({ sessionId: i.sessionId, outcome: null, revision: null, changed: false, deferred: false }))
      },
    } as unknown as ReconciliationService
    const watcher = startBackgroundReconciliation({ service, listSessions: () => [{ sessionId: 's', workspace: worktree, filesChanged: [] }] })
    try {
      await until(() => passes === 1, 'the startup pass')
      await tick(200)
      // What a fetch does: moves a remote-tracking ref, which only the common dir holds.
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repoDir })
      await until(() => passes === 2, 'a pass triggered by the ref update')
    } finally {
      watcher.dispose()
      fs.rmSync(worktree, { recursive: true, force: true })
    }
  })
})
