import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  manifestDays, planManifestDay, buildManifestChunk, syncTraceManifest, TraceManifestSender, previewManifestChunk,
  claimSenderLease, senderLeasePath, manifestStatePath,
  DAY_MS, MANIFEST_SETTLE_MS, MANIFEST_MAX_AGE_MS, MANIFEST_MAX_KEYS, MANIFEST_HOURLY_BUDGET,
} from '../../../cloud/forward/traceManifest'
import { capabilitiesPath, cloudAcceptsSourceRank, resetCapabilityProbeState } from '../../../cloud/forward/cloudCapabilities'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { drainQueue } from '../../../cloud/forward/sender'
import { SchemaValidator } from '../../../cloud/forward/jsonSchemaValidate'
import { setCredentialStore, type CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'
import type { RollupPayload, TraceManifestChunk } from '../../../cloud/forward/schema'
import type { TraceManifestSource } from '../../../cloudBridge'
import { toUuid } from '../../../traceIdentity'

const CREDS: OrgCredentials = {
  endpoint: 'https://traceroost.com',
  orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1', role: 'developer',
  perDeveloperVisibility: false,
  accessToken: 'access-1', refreshToken: 'refresh-1',
  accessTokenExpiresAt: Date.now() + 24 * 3600_000, linkedAt: new Date().toISOString(),
}

function memStore(initial: OrgCredentials | null): CredentialStore {
  let cur = initial
  return { load: () => cur, save: c => { cur = c }, clear: () => { cur = null } }
}

interface Held { id: string; ms: number; legacy?: boolean }

/** A store in memory: `held` is what the install holds; flags are mutable for the gate tests. */
function memSource(held: Held[], flags = { writer: true, ready: true }): TraceManifestSource & { held: Held[]; flags: typeof flags } {
  return {
    held, flags,
    isWriter: () => flags.writer,
    isReady: () => flags.ready,
    localHorizonMs: () => {
      const ms = held.filter(h => !h.legacy).map(h => h.ms)
      return ms.length ? Math.min(...ms) : null
    },
    listTraceKeys: (from, to) => [...new Set(held.filter(h => !h.legacy && h.ms >= from && h.ms <= to).map(h => toUuid(h.id)))],
    countTraces: (from, to) => held.filter(h => h.ms >= from && h.ms <= to).length,
  }
}

const SCHEMA = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'schema', 'rollup.v1.json'), 'utf-8'))
const manifestValidator = new SchemaValidator({ $defs: SCHEMA.$defs, ...SCHEMA.$defs.trace_manifest })
const SUPPORTED_SCHEMA = { $defs: { session: { properties: { source_rank: {} } }, trace_manifest: {} } }

// A fixed "now": 2026-10-04 12:00 UTC.
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0)
const at = (daysAgo: number, hourUtc = 9) => Date.UTC(2026, 9, 4 - daysAgo, hourUtc, 0, 0)

const realFetch = globalThis.fetch

interface FakeCloud {
  manifests: TraceManifestChunk[]
  schemaRequests: number
  /** Status (and optional body / headers) the manifest route answers with. */
  manifestReply: (chunk: TraceManifestChunk) => { status: number; body?: unknown; headers?: Record<string, string> }
  schemaStatus: number
}

function installFakeCloud(): FakeCloud {
  const cloud: FakeCloud = {
    manifests: [], schemaRequests: 0, schemaStatus: 200,
    manifestReply: () => ({ status: 200, body: { retired: 0, missing: 0, window: {} } }),
  }
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    const url = String(u)
    if (url.endsWith('/api/ingest/schema')) {
      cloud.schemaRequests++
      return cloud.schemaStatus === 200 ? new Response(JSON.stringify(SUPPORTED_SCHEMA), { status: 200 }) : new Response('', { status: cloud.schemaStatus })
    }
    if (url.endsWith('/api/ingest/manifest')) {
      const chunk = JSON.parse(String(init?.body)) as TraceManifestChunk
      cloud.manifests.push(chunk)
      const r = cloud.manifestReply(chunk)
      return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: r.headers })
    }
    if (url.endsWith('/api/ingest/batch')) {
      const items = (JSON.parse(String(init?.body)) as { items: unknown[] }).items
      return new Response(JSON.stringify({ results: items.map(() => ({ status: 202 })) }), { status: 200 })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
  return cloud
}

suite('forward/traceManifest — window math', () => {
  test('no horizon (nothing held) → no window at all', () => {
    assert.deepStrictEqual(manifestDays(null, NOW), [])
  })

  test('[horizon, now − settle], split at UTC midnights, newest first, each ≤ 24 h', () => {
    const horizon = at(2, 15)
    const days = manifestDays(horizon, NOW)
    assert.deepStrictEqual(days.map(d => d.day), ['2026-10-04', '2026-10-03', '2026-10-02'])
    assert.strictEqual(days[2].fromMs, horizon, 'starts at the horizon, not the day start')
    assert.strictEqual(days[0].toMs, NOW - MANIFEST_SETTLE_MS, 'ends a settle margin before now')
    assert.strictEqual(days[1].fromMs, Date.UTC(2026, 9, 3))
    assert.strictEqual(days[1].toMs, Date.UTC(2026, 9, 4))
    for (const d of days) assert.ok(d.toMs > d.fromMs && d.toMs - d.fromMs <= DAY_MS)
  })

  test('never reaches back more than 60 days, however old the horizon', () => {
    const days = manifestDays(at(400), NOW)
    const oldest = days[days.length - 1]
    assert.strictEqual(oldest.fromMs, NOW - MANIFEST_MAX_AGE_MS)
    assert.ok(days.length <= 61)
  })

  test('a horizon inside the settle margin → nothing settled yet', () => {
    assert.deepStrictEqual(manifestDays(NOW - 60_000, NOW), [])
  })
})

suite('forward/traceManifest — planning a day', () => {
  const day = { day: '2026-10-03', fromMs: Date.UTC(2026, 9, 3), toMs: Date.UTC(2026, 9, 4) }

  test('lists the day\'s keys — [from, to): a trace starting exactly at `to` belongs to the next day', () => {
    const src = memSource([{ id: 'a', ms: at(1) }, { id: 'b', ms: day.toMs }, { id: 'c', ms: day.fromMs }])
    const plan = planManifestDay(src, day, day.fromMs)!
    assert.strictEqual(plan.chunks.length, 1)
    assert.deepStrictEqual(plan.chunks[0].keys, [toUuid('a'), toUuid('c')].sort())
    assert.strictEqual(plan.chunks[0].confirm_empty, undefined)
  })

  test('confirm_empty only when the store positively holds no trace there, inside the horizon', () => {
    const empty = memSource([{ id: 'later', ms: at(0) }])
    const plan = planManifestDay(empty, day, day.fromMs - DAY_MS)!
    assert.deepStrictEqual(plan.chunks, [buildManifestChunk(day.fromMs, day.toMs, [], true)])
    assert.strictEqual(plan.chunks[0].confirm_empty, true)

    // Only a legacy row there: not positively empty → the day is skipped, not sent empty.
    const legacyOnly = memSource([{ id: 'old', ms: at(1), legacy: true }, { id: 'later', ms: at(0) }])
    assert.strictEqual(planManifestDay(legacyOnly, day, day.fromMs - DAY_MS), null)

    // Outside the horizon (before the oldest trace held): never confirmed empty.
    assert.strictEqual(planManifestDay(empty, day, day.fromMs + 1), null)
  })

  test('a day over the key cap is split into shorter windows, never truncated', () => {
    const n = MANIFEST_MAX_KEYS + 10
    const held = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, ms: day.fromMs + Math.floor((i * DAY_MS) / n) }))
    const plan = planManifestDay(memSource(held), day, day.fromMs)!
    assert.ok(plan.chunks.length >= 2)
    const all = plan.chunks.flatMap(c => c.keys)
    assert.strictEqual(new Set(all).size, n, 'every key is in exactly one chunk')
    for (const c of plan.chunks) {
      assert.ok(c.keys.length <= MANIFEST_MAX_KEYS)
      assert.deepStrictEqual(manifestValidator.validate(c), [])
    }
  })

  test('a chunk is exactly schema_version + window + uuid keys — valid against $defs/trace_manifest', () => {
    const chunk = buildManifestChunk(day.fromMs, day.toMs, [toUuid('x'), toUuid('y')])
    assert.deepStrictEqual(Object.keys(chunk).sort(), ['keys', 'schema_version', 'window'])
    assert.deepStrictEqual(Object.keys(chunk.window).sort(), ['from', 'to'])
    assert.strictEqual(chunk.schema_version, '2')
    assert.deepStrictEqual(manifestValidator.validate(chunk), [])
    assert.deepStrictEqual(manifestValidator.validate(buildManifestChunk(day.fromMs, day.toMs, [], true)), [])
    // The validator really checks: a key that isn't a uuid, or an extra field, fails.
    assert.notDeepStrictEqual(manifestValidator.validate({ ...chunk, keys: ['prompt text'] }), [])
    assert.notDeepStrictEqual(manifestValidator.validate({ ...chunk, path: '/home/me' }), [])
  })

  test('previewManifestChunk is the newest non-empty chunk, built by the same code', () => {
    const src = memSource([{ id: 'a', ms: at(3) }, { id: 'b', ms: at(1) }])
    const chunk = previewManifestChunk(src, NOW)!
    assert.deepStrictEqual(chunk.keys, [toUuid('b')])
  })
})

suite('forward/traceManifest — sending', () => {
  let home: string
  let clock: number
  const now = () => clock
  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-manifest-'))
    setCredentialStore(memStore(CREDS))
    resetCapabilityProbeState()
    clock = NOW
  })
  teardown(() => {
    globalThis.fetch = realFetch
    setCredentialStore(undefined)
    fs.rmSync(home, { recursive: true, force: true })
  })

  const sync = (src: TraceManifestSource, extra: { fullSweep?: boolean; holderId?: string; log?: (m: string) => void } = {}) =>
    syncTraceManifest(src, { now, baseHome: home, holderId: extra.holderId ?? 'host-a', fullSweep: extra.fullSweep, log: extra.log })

  const threeDays = () => memSource([{ id: 'a', ms: at(2) }, { id: 'b', ms: at(1) }, { id: 'c', ms: at(1, 10) }, { id: 'd', ms: at(0, 8) }])

  test('unlinked → nothing is sent, nothing probed', async () => {
    setCredentialStore(memStore(null))
    const cloud = installFakeCloud()
    const res = await sync(threeDays(), { fullSweep: true })
    assert.strictEqual(res.skipped, 'not-linked')
    assert.strictEqual(cloud.schemaRequests + cloud.manifests.length, 0)
  })

  test('not the store\'s single writer (data-dir lock / database owner) → nothing is sent', async () => {
    const cloud = installFakeCloud()
    const src = threeDays()
    src.flags.writer = false
    assert.strictEqual((await sync(src, { fullSweep: true })).skipped, 'not-writer')
    assert.strictEqual(cloud.manifests.length, 0)
  })

  test('store still loading → nothing is sent', async () => {
    const cloud = installFakeCloud()
    const src = threeDays()
    src.flags.ready = false
    assert.strictEqual((await sync(src, { fullSweep: true })).skipped, 'not-ready')
    assert.strictEqual(cloud.manifests.length, 0)
  })

  test('a cloud that predates the manifest (schema 404) → no manifest, and no source_rank either', async () => {
    const cloud = installFakeCloud()
    cloud.schemaStatus = 404
    const res = await sync(threeDays(), { fullSweep: true })
    assert.strictEqual(res.skipped, 'unsupported')
    assert.strictEqual(cloud.manifests.length, 0)
    assert.strictEqual(cloudAcceptsSourceRank(CREDS, home), false)
  })

  test('a manifest route that 404s (a rolled-back deploy) → both version-2 parts stop until re-probed', async () => {
    const cloud = installFakeCloud()
    cloud.manifestReply = () => ({ status: 404 })
    assert.strictEqual((await sync(threeDays(), { fullSweep: true })).stopped, 'unsupported')
    assert.strictEqual(cloudAcceptsSourceRank(CREDS, home), false)
    assert.strictEqual((await sync(threeDays(), { fullSweep: true })).skipped, 'unsupported')
    assert.strictEqual(cloud.manifests.length, 1)
  })

  test('a supporting cloud → one chunk per day of the window, and source_rank is accepted', async () => {
    const cloud = installFakeCloud()
    const res = await sync(threeDays(), { fullSweep: true })
    assert.strictEqual(res.stopped, undefined)
    assert.strictEqual(res.chunks, 3)
    assert.deepStrictEqual(cloud.manifests.map(m => m.keys.length), [1, 2, 1])
    assert.strictEqual(cloudAcceptsSourceRank(CREDS, home), true)
    for (const m of cloud.manifests) {
      assert.deepStrictEqual(manifestValidator.validate(m), [])
      // Window bounds are the only timestamps; nothing but uuids otherwise.
      assert.deepStrictEqual(Object.keys(m).sort(), ['keys', 'schema_version', 'window'])
    }
  })

  test('the capability answer is cached per link and re-checked daily, and at once after a re-link', async () => {
    const cloud = installFakeCloud()
    await sync(threeDays(), { fullSweep: true })
    await sync(threeDays())
    assert.strictEqual(cloud.schemaRequests, 1)
    clock += DAY_MS + 1
    await sync(threeDays())
    assert.strictEqual(cloud.schemaRequests, 2)
    setCredentialStore(memStore({ ...CREDS, installId: 'install-2' }))
    await sync(threeDays())
    assert.strictEqual(cloud.schemaRequests, 3)
  })

  test('regular syncs send only the days whose key set changed', async () => {
    const cloud = installFakeCloud()
    const src = threeDays()
    src.held.push({ id: 'oldest', ms: at(3) }) // keeps the horizon put when 'a' goes, below
    await sync(src, { fullSweep: true })
    cloud.manifests = []

    assert.strictEqual((await sync(src)).chunks, 0, 'nothing changed → nothing sent')
    src.held.push({ id: 'e', ms: at(1, 20) })
    const res = await sync(src)
    assert.strictEqual(res.chunks, 1)
    assert.strictEqual(cloud.manifests[0].window.from, new Date(Date.UTC(2026, 9, 3)).toISOString())
    assert.strictEqual(cloud.manifests[0].keys.length, 3)

    // A trace that disappeared locally (merged into another key) changes its day too.
    src.held.splice(src.held.findIndex(h => h.id === 'a'), 1)
    cloud.manifests = []
    await sync(src)
    assert.strictEqual(cloud.manifests.length, 1)
    assert.ok(cloud.manifests[0].confirm_empty, 'day 2 is now positively empty inside the horizon')
  })

  test('a re-link (new install) starts over with a full sweep of every day', async () => {
    const cloud = installFakeCloud()
    const sender = new TraceManifestSender(threeDays(), { baseHome: home, now })
    await sender.run()
    assert.strictEqual(cloud.manifests.length, 3)
    await sender.run()
    assert.strictEqual(cloud.manifests.length, 3, 'unchanged → nothing more')
    setCredentialStore(memStore({ ...CREDS, installId: 'install-2' }))
    await sender.run()
    assert.strictEqual(cloud.manifests.length, 6)
  })

  test('nothing goes out while the forwarding queue still holds session rollups', async () => {
    const cloud = installFakeCloud()
    new ForwardQueue(home).enqueue(payload(toUuid('a')))
    assert.strictEqual((await sync(threeDays(), { fullSweep: true })).skipped, 'queue-not-drained')
    assert.strictEqual(cloud.manifests.length, 0)
  })

  test('429 → stops the sweep and waits out Retry-After', async () => {
    const cloud = installFakeCloud()
    cloud.manifestReply = () => ({ status: 429, headers: { 'Retry-After': '120' } })
    const res = await sync(threeDays(), { fullSweep: true })
    assert.strictEqual(res.stopped, 'rate-limited')
    assert.strictEqual(cloud.manifests.length, 1, 'no further chunk after the 429')
    cloud.manifestReply = () => ({ status: 200, body: { retired: 0, missing: 0 } })
    clock += 60_000
    assert.strictEqual((await sync(threeDays(), { fullSweep: true })).skipped, 'paused')
    clock += 61_000
    assert.strictEqual((await sync(threeDays(), { fullSweep: true })).chunks, 3)
  })

  test('5xx → backs off instead of retrying on the next tick', async () => {
    const cloud = installFakeCloud()
    cloud.manifestReply = () => ({ status: 503 })
    assert.strictEqual((await sync(threeDays(), { fullSweep: true })).stopped, 'failed')
    assert.strictEqual((await sync(threeDays(), { fullSweep: true })).skipped, 'paused')
    assert.strictEqual(cloud.manifests.length, 1)
  })

  test('the hourly budget holds well under the cloud\'s 300 chunks/hour', async () => {
    const cloud = installFakeCloud()
    const held = Array.from({ length: 70 }, (_, i) => ({ id: `t${i}`, ms: at(i, 9) }))
    const src = memSource(held)
    let sent = 0
    for (let i = 0; i < 5; i++) {
      // Every day changes every run: a worst case for the budget.
      src.held.push({ id: `n${i}`, ms: at(0, 1) })
      for (let d = 1; d < 60; d++) src.held.push({ id: `n${i}-${d}`, ms: at(d, 1) })
      sent += (await sync(src, { fullSweep: true })).chunks
      clock += 60_000
    }
    assert.ok(sent <= MANIFEST_HOURLY_BUDGET, `${sent} chunks in 5 minutes`)
    assert.ok(cloud.manifests.length <= MANIFEST_HOURLY_BUDGET)
  })

  test('gated missing_keys → re-sent only after the queue has drained, with backoff', async () => {
    const cloud = installFakeCloud()
    cloud.manifestReply = (c) => c.keys.includes(toUuid('d'))
      ? { status: 200, body: { retired: 0, missing: 1, gated: 'missing_keys' } }
      : { status: 200, body: { retired: 0, missing: 0 } }
    const res = await sync(threeDays(), { fullSweep: true })
    assert.strictEqual(res.gated, 1)
    cloud.manifests = []

    // Not again right away (no hammering)…
    assert.strictEqual((await sync(threeDays())).chunks, 0)
    // …and not while the rollup it is waiting on is still queued.
    clock += 10 * 60_000
    new ForwardQueue(home).enqueue(payload(toUuid('d')))
    assert.strictEqual((await sync(threeDays())).skipped, 'queue-not-drained')
    // Once the queue drains, the gated day (only) goes again.
    new ForwardQueue(home).clear()
    cloud.manifestReply = () => ({ status: 200, body: { retired: 0, missing: 0 } })
    const again = await sync(threeDays())
    assert.strictEqual(again.chunks, 1)
    assert.ok(cloud.manifests[0].keys.includes(toUuid('d')))
  })

  test('empty_unconfirmed is logged once, not retried', async () => {
    const cloud = installFakeCloud()
    cloud.manifestReply = () => ({ status: 200, body: { retired: 0, missing: 0, gated: 'empty_unconfirmed' } })
    const logs: string[] = []
    const sender = new TraceManifestSender(memSource([{ id: 'a', ms: at(2) }, { id: 'b', ms: at(0, 8) }]), { baseHome: home, now, log: m => logs.push(m) })
    await sender.run()
    clock += 3 * 3600_000
    await sender.run()
    assert.strictEqual(logs.filter(l => l.includes('unconfirmed')).length, 1)
  })

  test('one summary line per run — counts only, never a key', async () => {
    const cloud = installFakeCloud()
    cloud.manifestReply = () => ({ status: 200, body: { retired: 2, missing: 0 } })
    const logs: string[] = []
    await sync(threeDays(), { fullSweep: true, log: m => logs.push(m) })
    assert.strictEqual(logs.length, 1)
    assert.match(logs[0], /sent 3 chunk\(s\), retired 6 trace\(s\), 0 gated/)
    for (const id of ['a', 'b', 'c', 'd']) assert.ok(!logs[0].includes(toUuid(id)))
  })

  test('one sender per machine: a second host defers, and while both run neither sends', async () => {
    const cloud = installFakeCloud()
    assert.strictEqual((await sync(threeDays(), { fullSweep: true, holderId: 'host-a' })).chunks, 3)
    const second = await sync(threeDays(), { fullSweep: true, holderId: 'host-b' })
    assert.strictEqual(second.skipped, 'other-host')
    const first = await sync(threeDays(), { fullSweep: true, holderId: 'host-a' })
    assert.strictEqual(first.skipped, 'contended', 'the two hosts\' stores differ — neither speaks for the install')
    assert.strictEqual(cloud.manifests.length, 3)
    // The second host stops asking: once its claim lapses, the holder resumes.
    clock += 31 * 60_000
    assert.strictEqual((await sync(threeDays(), { holderId: 'host-a' })).skipped, undefined)
  })

  test('a lapsed lease is taken over', () => {
    fs.mkdirSync(path.dirname(senderLeasePath(home)), { recursive: true })
    fs.writeFileSync(senderLeasePath(home), JSON.stringify({ holder: 'gone', pid: process.pid, hostname: os.hostname(), at: NOW - 31 * 60_000 }))
    assert.strictEqual(claimSenderLease('host-a', NOW, home), 'ours')
  })

  test('the per-link record keeps hashes and results, never keys', async () => {
    installFakeCloud()
    await sync(threeDays(), { fullSweep: true })
    const raw = fs.readFileSync(manifestStatePath(home), 'utf-8')
    for (const id of ['a', 'b', 'c', 'd']) assert.ok(!raw.includes(toUuid(id)))
    assert.ok(fs.existsSync(capabilitiesPath(home)))
  })
})

function payload(id: string, rank?: 1 | 2 | 3): RollupPayload {
  return {
    schema_version: rank ? '2' : '1', repo_key_fp: 'a'.repeat(64),
    session: { session_id: id, agent: 'claude-code', repo_hash: 'b'.repeat(64), started_at: '2026-10-01T00:00:00.000Z', duration_ms: 1, ...(rank ? { source_rank: rank } : {}) },
  }
}

suite('forward/traceManifest — source_rank on the wire follows the cloud', () => {
  let home: string
  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-rank-'))
    setCredentialStore(memStore(CREDS))
    resetCapabilityProbeState()
  })
  teardown(() => {
    globalThis.fetch = realFetch
    setCredentialStore(undefined)
    fs.rmSync(home, { recursive: true, force: true })
  })

  const sentBodies = () => {
    const bodies: RollupPayload[] = []
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const items = (JSON.parse(String(init?.body)) as { items: RollupPayload[] }).items
      bodies.push(...items)
      return new Response(JSON.stringify({ results: items.map(() => ({ status: 202 })) }), { status: 200 })
    }) as typeof fetch
    return bodies
  }

  test('a ranked rollup still queued goes out as version 1 without the field to a cloud not known to accept it', async () => {
    new ForwardQueue(home).enqueue(payload(toUuid('a'), 3))
    const bodies = sentBodies()
    await drainQueue({ baseHome: home })
    assert.strictEqual(bodies.length, 1)
    assert.strictEqual(bodies[0].schema_version, '1')
    assert.strictEqual('source_rank' in bodies[0].session!, false)
  })

  test('…and with it, as version 2, once the cloud is seen to accept it', async () => {
    fs.mkdirSync(path.dirname(capabilitiesPath(home)), { recursive: true })
    fs.writeFileSync(capabilitiesPath(home), JSON.stringify({ endpoint: CREDS.endpoint, installId: CREDS.installId, checkedAt: Date.now(), sourceRank: true, traceManifest: true }))
    new ForwardQueue(home).enqueue(payload(toUuid('a'), 3))
    const bodies = sentBodies()
    await drainQueue({ baseHome: home })
    assert.strictEqual(bodies[0].schema_version, '2')
    assert.strictEqual(bodies[0].session!.source_rank, 3)
  })
})
