import * as assert from 'assert'
import * as path from 'path'
import { LOCK_FILENAME, type DataDirLockInfo } from '../../standalone/dataDirLock'
import {
  describeVerdict, inspectCollector, meansDataDirIsFree, versionsCompatible,
  type HandshakeEnv,
} from './handshake'

const DATA_DIR = '/data/traceroost'
const LOCK_PATH = path.join(DATA_DIR, LOCK_FILENAME)
const OURS = '0.19.1'

function lock(over: Partial<DataDirLockInfo> = {}): DataDirLockInfo {
  return {
    pid: 2000, hostname: 'box-a', startedAt: '2026-10-13T12:00:00.000Z', service: false,
    token: 'abc123', uiPort: 3000, otlpPort: 4318, mcpPort: 4316, version: OURS, ...over,
  }
}

/** `files` maps a path to its contents; everything else does not exist. */
function env(over: Partial<HandshakeEnv> & { files?: Record<string, string> } = {}): HandshakeEnv {
  const files = over.files ?? { [LOCK_PATH]: JSON.stringify(lock()) }
  return {
    readFile: p => files[p],
    mtimeMs: p => (p in files ? Date.now() : undefined),
    hostname: 'box-a',
    now: () => Date.now(),
    isPidAlive: () => true,
    probeOtlpOwner: async () => 'standalone',
    ...over,
  }
}

suite('handshake — versionsCompatible', () => {
  test('pre-1.0 versions must agree on major.minor, where this project\'s breaking changes land', () => {
    assert.ok(versionsCompatible('0.19.1', '0.19.4'))
    assert.ok(!versionsCompatible('0.19.1', '0.20.0'))
    assert.ok(!versionsCompatible('0.19.1', '0.18.9'))
  })

  test('from 1.0 the major alone decides', () => {
    assert.ok(versionsCompatible('1.2.3', '1.9.0'))
    assert.ok(!versionsCompatible('1.2.3', '2.0.0'))
  })

  test('an unparseable version is never called compatible', () => {
    assert.ok(!versionsCompatible('0.19.1', 'nightly'))
    assert.ok(!versionsCompatible('', '0.19.1'))
  })
})

suite('handshake — inspectCollector', () => {
  test('no lock means the data dir is free, so the shell may start its own collector', async () => {
    const verdict = await inspectCollector(DATA_DIR, OURS, env({ files: {} }))
    assert.ok(!verdict.ok)
    assert.strictEqual(verdict.reason, 'no-collector')
    assert.ok(meansDataDirIsFree(verdict.reason))
  })

  test('a lock whose holder has died is a crashed collector\'s leftover — also a free dir', async () => {
    const verdict = await inspectCollector(DATA_DIR, OURS, env({ isPidAlive: () => false }))
    assert.ok(!verdict.ok)
    assert.strictEqual(verdict.reason, 'stale-lock')
    assert.ok(meansDataDirIsFree(verdict.reason))
    assert.match(verdict.detail, /no longer running/)
  })

  test('an unreadable lock is a holder mid-startup, and never grounds to start a second writer', async () => {
    const verdict = await inspectCollector(DATA_DIR, OURS, env({ files: { [LOCK_PATH]: '{half-writ' } }))
    assert.ok(!verdict.ok)
    assert.strictEqual(verdict.reason, 'starting')
    assert.ok(!meansDataDirIsFree(verdict.reason))
  })

  test('a holder on another machine can be neither attached to nor taken over', async () => {
    const verdict = await inspectCollector(DATA_DIR, OURS, env({
      files: { [LOCK_PATH]: JSON.stringify(lock({ hostname: 'box-b' })) },
    }))
    assert.ok(!verdict.ok)
    assert.strictEqual(verdict.reason, 'other-host')
    assert.ok(!meansDataDirIsFree(verdict.reason))
    assert.match(verdict.detail, /box-b/)
  })

  test('hostname comparison ignores case, so a Mac\'s .local name does not read as another host', async () => {
    const verdict = await inspectCollector(DATA_DIR, OURS, env({
      files: { [LOCK_PATH]: JSON.stringify(lock({ hostname: 'BOX-A' })) },
      hostname: 'box-a',
    }))
    assert.ok(verdict.ok)
  })

  test('a holder that has not bound its ports yet is transient, not attachable', async () => {
    const verdict = await inspectCollector(DATA_DIR, OURS, env({
      files: { [LOCK_PATH]: JSON.stringify(lock({ uiPort: undefined, otlpPort: undefined, mcpPort: undefined })) },
    }))
    assert.ok(!verdict.ok)
    assert.strictEqual(verdict.reason, 'ports-unbound')
  })

  test('the OTLP port is probed, so an unrelated app on a recycled port is not mistaken for a collector', async () => {
    const verdict = await inspectCollector(DATA_DIR, OURS, env({ probeOtlpOwner: async () => 'foreign' }))
    assert.ok(!verdict.ok)
    assert.strictEqual(verdict.reason, 'not-traceroost')
    assert.match(verdict.detail, /4318/)
  })

  test('the VS Code extension\'s collector is not this data dir\'s writer and is not attached to', async () => {
    const verdict = await inspectCollector(DATA_DIR, OURS, env({ probeOtlpOwner: async () => 'plugin' }))
    assert.ok(!verdict.ok)
    assert.strictEqual(verdict.reason, 'not-traceroost')
    assert.match(verdict.detail, /VS Code extension/)
  })

  test('a validated same-version collector is attached to without asking', async () => {
    const verdict = await inspectCollector(DATA_DIR, OURS, env())
    assert.ok(verdict.ok)
    assert.strictEqual(verdict.needsConfirmation, false)
    assert.strictEqual(verdict.identity.uiPort, 3000)
    assert.strictEqual(verdict.identity.pid, 2000)
    assert.strictEqual(verdict.identity.service, false)
  })

  test('the background service is identified as such — the case where Quit must not stop it', async () => {
    const verdict = await inspectCollector(DATA_DIR, OURS, env({
      files: { [LOCK_PATH]: JSON.stringify(lock({ service: true })) },
    }))
    assert.ok(verdict.ok)
    assert.strictEqual(verdict.identity.service, true)
  })

  test('a collector that predates the version field is offered, not silently attached to', async () => {
    const verdict = await inspectCollector(DATA_DIR, OURS, env({
      files: { [LOCK_PATH]: JSON.stringify(lock({ version: undefined })) },
    }))
    assert.ok(verdict.ok)
    assert.strictEqual(verdict.needsConfirmation, true)
    assert.strictEqual(verdict.identity.version, undefined)
    assert.match(describeVerdict(verdict), /confirm before attaching/)
  })

  test('an incompatible version is refused outright, in both directions', async () => {
    for (const theirs of ['0.20.0', '0.18.0', '1.0.0']) {
      const verdict = await inspectCollector(DATA_DIR, OURS, env({
        files: { [LOCK_PATH]: JSON.stringify(lock({ version: theirs })) },
      }))
      assert.ok(!verdict.ok, `expected ${theirs} to be refused`)
      assert.strictEqual(verdict.reason, 'version-incompatible')
      assert.ok(!meansDataDirIsFree(verdict.reason))
    }
  })

  test('nothing is probed once the lock has already ruled attachment out', async () => {
    let probes = 0
    await inspectCollector(DATA_DIR, OURS, env({
      files: { [LOCK_PATH]: JSON.stringify(lock({ hostname: 'box-b' })) },
      probeOtlpOwner: async () => { probes++; return 'standalone' },
    }))
    assert.strictEqual(probes, 0)
  })
})
