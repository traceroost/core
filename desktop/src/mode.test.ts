import * as assert from 'assert'
import { type AttachVerdict, type CollectorIdentity } from './handshake'
import { describeMode, resolveMode } from './mode'

function identity(over: Partial<CollectorIdentity> = {}): CollectorIdentity {
  return {
    pid: 2000, hostname: 'box-a', startedAt: '2026-10-13T12:00:00.000Z', service: false,
    uiPort: 3000, otlpPort: 4318, mcpPort: 4316, version: '0.19.1', ...over,
  }
}

suite('mode', () => {
  test('a free data dir means owning a collector', () => {
    const verdict: AttachVerdict = { ok: false, reason: 'no-collector', detail: 'nothing holds it' }
    assert.strictEqual(resolveMode(verdict).mode, 'own')
    assert.strictEqual(resolveMode({ ok: false, reason: 'stale-lock', detail: 'leftover' }).mode, 'own')
  })

  test('a validated collector means attaching', () => {
    const resolved = resolveMode({ ok: true, needsConfirmation: false, identity: identity() })
    assert.strictEqual(resolved.mode, 'attach')
    assert.ok(resolved.mode === 'attach' && resolved.identity.uiPort === 3000)
  })

  test('an unknown version asks instead of deciding, and the question names what was found', () => {
    const resolved = resolveMode({
      ok: true, needsConfirmation: true, unverified: 'version-unknown', identity: identity({ service: true }),
    })
    assert.strictEqual(resolved.mode, 'confirm-attach')
    assert.ok(resolved.mode === 'confirm-attach')
    assert.match(resolved.question, /background service/)
    assert.match(resolved.question, /does not report its version/)
  })

  test('transient verdicts wait and retry rather than starting a second writer', () => {
    for (const reason of ['starting', 'ports-unbound'] as const) {
      const resolved = resolveMode({ ok: false, reason, detail: 'mid-startup' })
      assert.strictEqual(resolved.mode, 'wait', reason)
      assert.ok(resolved.mode === 'wait' && resolved.retryInMs > 0)
    }
  })

  test('a collector that cannot be attached to or owned blocks, and never silently becomes "own"', () => {
    for (const reason of ['other-host', 'not-traceroost', 'version-incompatible'] as const) {
      const resolved = resolveMode({ ok: false, reason, detail: `because ${reason}` })
      assert.strictEqual(resolved.mode, 'blocked', reason)
      assert.ok(resolved.mode === 'blocked' && resolved.detail.includes(reason))
    }
  })

  test('the attached status line says whose collector it is', () => {
    assert.match(describeMode(resolveMode({ ok: true, needsConfirmation: false, identity: identity({ service: true }) })), /background service/)
    assert.match(describeMode(resolveMode({ ok: true, needsConfirmation: false, identity: identity({ service: false }) })), /pid 2000/)
  })

  test('the confirm question names the pid when the collector is not the service', () => {
    const resolved = resolveMode({
      ok: true, needsConfirmation: true, unverified: 'version-unknown', identity: identity({ service: false, pid: 4242 }),
    })
    assert.ok(resolved.mode === 'confirm-attach')
    assert.match(resolved.question, /pid 4242/)
    assert.match(resolved.question, /started 2026-10-13T12:00:00\.000Z/)
  })

  test('every mode has a status line, and the transient ones do not claim collection', () => {
    assert.match(describeMode({ mode: 'own' }), /Starting collection/)
    assert.match(describeMode({ mode: 'confirm-attach', identity: identity(), question: 'q' }), /confirm/)
    assert.match(describeMode({ mode: 'wait', detail: 'x', retryInMs: 1 }), /Waiting/)
  })

  test('a blocked shell says it is not collecting, rather than implying it is', () => {
    assert.match(describeMode({ mode: 'blocked', detail: 'x' }), /Not collecting/)
  })
})
