import * as assert from 'assert'
import { recordAction, onRunningActionsChanged, onActionLogChanged, getActionLogHistory } from '../actionLog'

// The throttle in actionLog.ts is process-wide (module-scoped), same caveat gitOutcome.test.ts
// notes for the tracker this generalizes — a trailing window left over from a previous test can
// still be open, so each test only asserts on the leading-edge notify it triggers itself, never
// on "no other snapshot ever arrives."

suite('actionLog', () => {
  test('recordAction resolves with the wrapped function\'s result', async () => {
    const result = await recordAction('/repo', 'Doing a thing', 'do-thing --flag', async () => 'ok')
    assert.strictEqual(result, 'ok')
  })

  test('recordAction records the entry in history with startedAt/finishedAt set, not failed', async () => {
    await recordAction('/repo', 'Doing a thing', 'do-thing --flag', async () => 'ok')
    const history = getActionLogHistory()
    const entry = history[history.length - 1]
    assert.strictEqual(entry.cwd, '/repo')
    assert.strictEqual(entry.gloss, 'Doing a thing')
    assert.strictEqual(entry.raw, 'do-thing --flag')
    assert.ok(entry.startedAt > 0)
    assert.ok(entry.finishedAt !== null && entry.finishedAt >= entry.startedAt)
    assert.strictEqual(entry.failed, false)
  })

  test('a null gloss round-trips as null (falls back to the raw command, like describeGitCommand)', async () => {
    await recordAction('/repo', null, 'some-unrecognized-command', async () => undefined)
    const history = getActionLogHistory()
    const entry = history[history.length - 1]
    assert.strictEqual(entry.gloss, null)
  })

  test('a rejected action is recorded as failed and still rethrows to the caller', async () => {
    await assert.rejects(
      recordAction('/repo', 'Doing a thing', 'do-thing --flag', async () => { throw new Error('boom') }),
      /boom/,
    )
    const history = getActionLogHistory()
    const entry = history[history.length - 1]
    assert.strictEqual(entry.failed, true)
    assert.ok(entry.finishedAt !== null)
  })

  test('onRunningActionsChanged reports the action while its promise is still pending', async () => {
    // See gitOutcome.test.ts's identical caveat: the throttle's "is a notify already scheduled"
    // flag is process-wide (actionLog.ts is now the single shared tracker every module funnels
    // through), so a trailing window left open by a preceding test in this file or run alongside
    // it can suppress this test's own leading-edge notify. Wait one out first.
    await new Promise(resolve => setTimeout(resolve, 600))
    const snapshots: string[][] = []
    const unsubscribe = onRunningActionsChanged(lines => snapshots.push(lines))
    try {
      let resolveFn: () => void = () => {}
      const pending = recordAction('/repo', 'Doing a thing', 'do-thing --flag', () => new Promise<void>(resolve => { resolveFn = resolve }))
      assert.ok(snapshots.length > 0, 'expected a leading-edge snapshot before the action settled')
      assert.ok(snapshots[0].some(l => l.includes('Doing a thing')), snapshots[0].join('\n'))
      resolveFn()
      await pending
    } finally {
      unsubscribe()
    }
  })

  test('onActionLogChanged receives the full history snapshot on a new action', async () => {
    await new Promise(resolve => setTimeout(resolve, 600))
    const snapshots: number[] = []
    const unsubscribe = onActionLogChanged(history => snapshots.push(history.length))
    try {
      const before = getActionLogHistory().length
      await recordAction('/repo', 'Doing a thing', 'do-thing --flag', async () => 'ok')
      assert.ok(snapshots.length > 0)
      assert.strictEqual(snapshots[snapshots.length - 1], before + 1)
    } finally {
      unsubscribe()
    }
  })

  test('history is capped, oldest evicted first, past MAX_HISTORY (200)', async () => {
    for (let i = 0; i < 210; i++) {
      await recordAction('/repo', 'Doing a thing', `do-thing --n=${i}`, async () => undefined)
    }
    const history = getActionLogHistory()
    assert.ok(history.length <= 200, `expected history capped at 200, got ${history.length}`)
    // The most recent entries must have survived the eviction — an unbounded ring buffer would
    // never have to prove this, but a broken eviction (e.g. shifting from the wrong end) would
    // drop recent entries instead of old ones.
    assert.ok(history[history.length - 1].raw === 'do-thing --n=209')
    // This loop's burst of notifies leaves a trailing throttle window scheduled ~500ms out —
    // drain it before the suite ends so a later test file sharing this process (gitOutcome.test.ts
    // subscribes to the same shared tracker) doesn't inherit a pending notify from this test.
    await new Promise(resolve => setTimeout(resolve, 600))
  })
})
