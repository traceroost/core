import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fetchClusterResolution, matchLocalSessions, type ClusterResolution } from '../../../cloud/org/clusterResolve'
import { setCredentialStore, type CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'

const CREDS: OrgCredentials = {
  endpoint: 'https://traceroost.com',
  orgId: 'org-1', orgName: 'Acme', memberId: 'm-1', role: 'member',
  perDeveloperVisibility: false,
  accessToken: 'access-1', refreshToken: 'refresh-1',
  accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
}

function memStore(initial: OrgCredentials | null): CredentialStore {
  let cur = initial
  return { load: () => cur, save: c => { cur = c }, clear: () => { cur = null } }
}

function session(overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 's1', traceId: 's1', source: 'claude_code', dataSource: 'log',
    workspace: '/workspace', userRequest: 'fix the bug', model: 'claude-sonnet-5',
    turns: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: '2026-01-01T00:00:00.000Z',
    filesRead: [], filesSearched: [], filesChanged: ['a.ts'], toolCounts: {}, totalToolCalls: 0,
    totalLlmCalls: 1, errors: 0, outcome: 'text_response', timeline: [], backgroundSpans: [],
    loopSignals: [], filesWritten: [],
    ...overrides,
  }
}

const realFetch = globalThis.fetch

suite('org/clusterResolve', () => {
  let home: string
  setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-clusterresolve-')) })
  teardown(() => {
    globalThis.fetch = realFetch
    setCredentialStore(undefined)
    fs.rmSync(home, { recursive: true, force: true })
  })

  suite('fetchClusterResolution', () => {
    test('returns null on an unlinked install — no network call made', async () => {
      setCredentialStore(memStore(null))
      let called = false
      globalThis.fetch = (async () => { called = true; return new Response('{}') }) as typeof fetch
      const result = await fetchClusterResolution('repo-hash', 'cluster-key')
      assert.strictEqual(result, null)
      assert.strictEqual(called, false)
    })

    test('returns the parsed resolution on success', async () => {
      setCredentialStore(memStore(CREDS))
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ sessionIds: ['s1', 's2'], sessions: 2, members: 2, files: 3, topTools: ['Read'] }),
        { status: 200 },
      )) as typeof fetch
      const result = await fetchClusterResolution('repo-hash', 'cluster-key')
      assert.deepStrictEqual(result, { sessionIds: ['s1', 's2'], sessions: 2, members: 2, files: 3, topTools: ['Read'] })
    })

    test('returns null on a non-ok response (404, 401, 5xx alike)', async () => {
      setCredentialStore(memStore(CREDS))
      globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch
      assert.strictEqual(await fetchClusterResolution('repo-hash', 'cluster-key'), null)
    })

    test('returns null when fetch itself throws (offline / DNS / dropped connection)', async () => {
      setCredentialStore(memStore(CREDS))
      globalThis.fetch = (async () => { throw new Error('network down') }) as typeof fetch
      assert.strictEqual(await fetchClusterResolution('repo-hash', 'cluster-key'), null)
    })

    test('returns null on a malformed body (no sessionIds array)', async () => {
      setCredentialStore(memStore(CREDS))
      globalThis.fetch = (async () => new Response(JSON.stringify({ oops: true }), { status: 200 })) as typeof fetch
      assert.strictEqual(await fetchClusterResolution('repo-hash', 'cluster-key'), null)
    })

    test('sends the repo hash and cluster id as query params, bearer auth in the header', async () => {
      setCredentialStore(memStore(CREDS))
      let seenUrl: string | undefined
      let seenAuth: string | null | undefined
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        seenUrl = String(input)
        seenAuth = (init?.headers as Record<string, string> | undefined)?.['Authorization']
        return new Response(JSON.stringify({ sessionIds: [] }), { status: 200 })
      }) as typeof fetch
      await fetchClusterResolution('repo-hash-1', 'cluster-key-1')
      assert.ok(seenUrl?.includes('repo=repo-hash-1'))
      assert.ok(seenUrl?.includes('id=cluster-key-1'))
      assert.strictEqual(seenAuth, `Bearer ${CREDS.accessToken}`)
    })
  })

  suite('matchLocalSessions', () => {
    const resolution: ClusterResolution = { sessionIds: ['s1', 's2', 's3'], sessions: 3, members: 2, files: 2, topTools: ['Read'] }

    test('matches the subset of cluster session ids this machine actually recorded', () => {
      const local = [session({ sessionId: 's1' }), session({ sessionId: 's3', workspace: '/other' })]
      const { matched, unmatchedCount } = matchLocalSessions(resolution, local)
      assert.strictEqual(matched.length, 2)
      assert.deepStrictEqual(matched.map(m => m.sessionId).sort(), ['s1', 's3'])
      assert.strictEqual(unmatchedCount, 1) // s2 belongs to a teammate's machine
    })

    test('carries the real workspace, prompt, and file list for a matched session', () => {
      const local = [session({ sessionId: 's1', workspace: '/repo/core', userRequest: 'add tests', filesChanged: ['x.ts', 'y.ts'] })]
      const { matched } = matchLocalSessions({ ...resolution, sessionIds: ['s1'] }, local)
      assert.deepStrictEqual(matched[0], {
        sessionId: 's1', workspace: '/repo/core', userRequest: 'add tests',
        filesChanged: ['x.ts', 'y.ts'], startTime: '2026-01-01T00:00:00.000Z',
      })
    })

    test('every session id unrecognized locally counts toward unmatchedCount, not an error', () => {
      const { matched, unmatchedCount } = matchLocalSessions(resolution, [])
      assert.strictEqual(matched.length, 0)
      assert.strictEqual(unmatchedCount, 3)
    })
  })
})
