import * as assert from 'assert'
import { decidePipeline, takeoverStep } from '../ownerGate'

// The extension host has no test harness; the decision of which window runs the ingest/reconcile/
// forward pipeline is pinned here instead (extension.ts only wires the result).

suite('ownerGate.decidePipeline', () => {
  test('the owning window runs the pipeline and never polls', () => {
    assert.deepStrictEqual(
      decidePipeline({ hasDb: true, isOwner: true, loadError: false }),
      { runPipeline: true, viewer: false, tryTakeOver: false },
    )
  })

  test('a read-only window is a viewer that tries to take over on each tick', () => {
    assert.deepStrictEqual(
      decidePipeline({ hasDb: true, isOwner: false, loadError: false }),
      { runPipeline: false, viewer: true, tryTakeOver: true },
    )
  })

  test('a window whose database file could not be loaded does neither', () => {
    assert.deepStrictEqual(
      decidePipeline({ hasDb: true, isOwner: false, loadError: true }),
      { runPipeline: false, viewer: false, tryTakeOver: false },
    )
    // The owner lock is only ever taken by a window without a load error, but pin the combination.
    assert.deepStrictEqual(
      decidePipeline({ hasDb: true, isOwner: true, loadError: true }),
      { runPipeline: false, viewer: false, tryTakeOver: false },
    )
  })

  test('no database at all: nothing to write, nothing to view', () => {
    assert.deepStrictEqual(
      decidePipeline({ hasDb: false, isOwner: false, loadError: false }),
      { runPipeline: false, viewer: false, tryTakeOver: false },
    )
  })
})

suite('ownerGate.takeoverStep', () => {
  const base = { isOwner: false, loadError: false, lockHeldByLiveProcess: false, diskChangedSinceLoad: false }

  test('an owner stays the owner', () => {
    assert.strictEqual(takeoverStep({ ...base, isOwner: true, lockHeldByLiveProcess: true }), 'already-owner')
  })

  test('a window that could not load the file never becomes its writer', () => {
    assert.strictEqual(takeoverStep({ ...base, loadError: true }), 'blocked-load-error')
  })

  test('a live owner blocks the takeover, whatever the disk looks like', () => {
    assert.strictEqual(takeoverStep({ ...base, lockHeldByLiveProcess: true }), 'lock-held')
    assert.strictEqual(takeoverStep({ ...base, lockHeldByLiveProcess: true, diskChangedSinceLoad: true }), 'lock-held')
  })

  test('a free lock with a stale copy reloads from disk before acquiring', () => {
    assert.strictEqual(takeoverStep({ ...base, diskChangedSinceLoad: true }), 'reload-then-acquire')
  })

  test('a free lock with an up-to-date copy acquires directly', () => {
    assert.strictEqual(takeoverStep(base), 'acquire')
  })
})
