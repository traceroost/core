// End to end against a fake TraceRoost Cloud on a real local HTTP server: the forwarding
// scheduler drains ranked rollups, then sends the trace manifest —
// and a row this install delivered but no longer holds is retired, while a re-send retires nothing
// more. The fake mirrors cloud's rules (src/lib/ingest/manifest.ts, retire_absent_rollups): this
// install's rows only, the [from, to) window, the missing_keys and empty_unconfirmed gates, and
// schema version "1" with a required source_rank.

import * as assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'net'
import { startForwardScheduler } from '../../../cloud/forward/scheduler'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { manifestDays, manifestStatePath, senderLeasePath } from '../../../cloud/forward/traceManifest'
import { setCredentialStore, type CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'
import type { RollupPayload, TraceManifestChunk } from '../../../cloud/forward/schema'
import type { TraceManifestSource } from '../../../cloudBridge'
import { toUuid } from '../../../traceIdentity'

interface FakeCloudState {
  rows: Map<string, { startedAt: number; rank: number }>
  retired: Set<string>
  manifestBodies: TraceManifestChunk[]
  responses: Array<{ retired: number; missing: number; gated?: string }>
  /** Every request line, in order. */
  requests: string[]
}

function startFakeCloud(state: FakeCloudState): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      state.requests.push(`${req.method} ${req.url}`)
      if (req.headers.authorization !== 'Bearer access-1') return send(401, { error: 'bad token' })
      if (req.method === 'POST' && req.url === '/api/ingest/batch') {
        const { items } = JSON.parse(raw) as { items: RollupPayload[] }
        const results = items.map(p => {
          // The cloud's schema: version "1" only, source_rank required.
          if (p.schema_version !== '1' || p.session?.source_rank === undefined) return { status: 400, error: 'schema' }
          const s = p.session
          state.rows.set(s.session_id, { startedAt: Date.parse(s.started_at), rank: s.source_rank })
          state.retired.delete(s.session_id)
          return { status: 202 }
        })
        return send(200, { results })
      }
      if (req.method === 'POST' && req.url === '/api/ingest/manifest') {
        const m = JSON.parse(raw) as TraceManifestChunk
        if (m.schema_version !== '1') return send(400, { error: 'schema' })
        state.manifestBodies.push(m)
        const from = Date.parse(m.window.from), to = Date.parse(m.window.to)
        const keys = new Set(m.keys)
        const missing = m.keys.filter(k => !state.rows.has(k) && !state.retired.has(k)).length
        let out: FakeCloudState['responses'][number]
        if (missing > 0) out = { retired: 0, missing, gated: 'missing_keys' }
        else if (m.keys.length === 0 && m.confirm_empty !== true) out = { retired: 0, missing: 0, gated: 'empty_unconfirmed' }
        else {
          let retired = 0
          for (const [id, row] of state.rows) {
            if (row.startedAt >= from && row.startedAt < to && !keys.has(id)) {
              state.rows.delete(id)
              state.retired.add(id)
              retired++
            }
          }
          out = { retired, missing: 0 }
        }
        state.responses.push(out)
        return send(200, { ...out, window: m.window })
      }
      send(404, { error: 'not found' })
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function memStore(initial: OrgCredentials | null): CredentialStore {
  let cur = initial
  return { load: () => cur, save: c => { cur = c }, clear: () => { cur = null } }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 20))
  }
}

suite('forward/traceManifest — end to end against a fake cloud', () => {
  let home: string
  let server: http.Server
  let state: FakeCloudState
  let creds: OrgCredentials

  setup(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-manifest-e2e-'))
    state = { rows: new Map(), retired: new Set(), manifestBodies: [], responses: [], requests: [] }
    server = await startFakeCloud(state)
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    creds = {
      endpoint, orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1', role: 'developer',
      perDeveloperVisibility: false, accessToken: 'access-1', refreshToken: 'refresh-1',
      accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
    }
    setCredentialStore(memStore(creds))
    process.env.TRACEROOST_ORG_URL = endpoint // the ingest routes resolve through orgEndpoint()
  })
  teardown(async () => {
    delete process.env.TRACEROOST_ORG_URL
    setCredentialStore(undefined)
    await new Promise(r => server.close(r))
    fs.rmSync(home, { recursive: true, force: true })
  })

  const hourAgo = (h: number) => Date.now() - h * 3600_000
  const rollup = (id: string, startedAt: number): RollupPayload => ({
    schema_version: '1', repo_key_fp: 'a'.repeat(64),
    session: { session_id: id, agent: 'claude-code', repo_hash: 'b'.repeat(64), started_at: new Date(startedAt).toISOString(), duration_ms: 1, revision: 1, source_rank: 2 },
  })

  function source(held: Array<{ id: string; ms: number }>): TraceManifestSource {
    const inWin = (f: number, t: number) => held.filter(h => h.ms >= f && h.ms <= t)
    return {
      isWriter: () => true,
      isReady: () => true,
      localHorizonMs: () => (held.length ? Math.min(...held.map(h => h.ms)) : null),
      listTraceKeys: (f, t) => inWin(f, t).map(h => h.id),
      countTraces: (f, t) => inWin(f, t).length,
    }
  }

  test('rank goes out, then the manifest retires the delivered row this install no longer holds — once', async () => {
    const a = toUuid('turn-a'), b = toUuid('turn-b'), stale = toUuid('old-log-segment')
    const tA = hourAgo(30), tB = hourAgo(3), tStale = hourAgo(3) + 60_000
    const q = new ForwardQueue(home)
    q.enqueue(rollup(a, tA)); q.enqueue(rollup(b, tB)); q.enqueue(rollup(stale, tStale))
    // The stale key was merged into `b` locally: the install now holds only a and b.
    const held = [{ id: a, ms: tA }, { id: b, ms: tB }]

    const days = manifestDays(tA, Date.now()).length
    const scheduler = startForwardScheduler({ baseHome: home, intervalMs: 3600_000, traceManifest: source(held) })
    try {
      await waitFor(() => state.manifestBodies.length >= days)
    } finally {
      scheduler.dispose()
    }

    assert.strictEqual(state.rows.get(a)?.rank, 2, 'source_rank was sent')
    assert.ok(state.requests.every(r => r === 'POST /api/ingest/batch' || r === 'POST /api/ingest/manifest'), 'no probe, nothing else asked')
    assert.ok(state.requests.indexOf('POST /api/ingest/manifest') > state.requests.lastIndexOf('POST /api/ingest/batch'), 'the manifest waits for the drain')
    assert.deepStrictEqual([...state.rows.keys()].sort(), [a, b].sort())
    assert.deepStrictEqual([...state.retired], [stale])
    assert.strictEqual(state.responses.reduce((n, r) => n + r.retired, 0), 1)
    assert.ok(state.responses.every(r => !r.gated), JSON.stringify(state.responses))
    for (const m of state.manifestBodies) {
      for (const k of m.keys) assert.ok([a, b].includes(k), 'only keys this install holds')
    }

    // Re-sending the same manifest (its per-day record forgotten, so every day goes again) retires
    // nothing more.
    fs.rmSync(manifestStatePath(home), { force: true })
    fs.rmSync(senderLeasePath(home), { force: true }) // the first "process" is gone
    const before = state.manifestBodies.length
    const again = startForwardScheduler({ baseHome: home, intervalMs: 3600_000, traceManifest: source(held) })
    try {
      await waitFor(() => state.manifestBodies.length >= before + days)
    } finally {
      again.dispose()
    }
    assert.deepStrictEqual(state.responses.slice(-days).map(r => r.retired), new Array(days).fill(0))
    assert.deepStrictEqual([...state.retired], [stale])
  })
})
