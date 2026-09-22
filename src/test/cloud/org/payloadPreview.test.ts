import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { buildPayloadForCard, createPayloadBuildCache } from '../../../cloud/org/payloadPreview'
import { setCredentialStore, type CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00' },
  })
}

// `label` seeds the root commit's content so two repos built with pinned dates (for determinism
// elsewhere in this suite) don't collide on an identical, content-addressed root commit SHA.
function makeRepo(dir: string, label: string): void {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 't@example.com'])
  git(dir, ['config', 'user.name', 'T'])
  fs.writeFileSync(path.join(dir, 'README.md'), `root: ${label}\n`)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', `root: ${label}`])
}

function memoryStore(initial: OrgCredentials | null): CredentialStore {
  let cur = initial
  return { load: () => cur, save: (c) => { cur = c }, clear: () => { cur = null } }
}

function makeCard(id: string, workspace: string): SessionSummaryCard {
  return {
    sessionId: id, traceId: 'trace-' + id, source: 'copilot', dataSource: 'otel', workspace,
    userRequest: 'test', model: 'gpt-4o', turns: 1,
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: '2026-01-01T00:00:00.000Z',
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
  }
}

const CREDS: OrgCredentials = {
  endpoint: 'https://traceroost.com',
  orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1', role: 'member',
  perDeveloperVisibility: false,
  accessToken: 'access-1', refreshToken: 'refresh-1',
  accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
}

suite('org/payloadPreview — createPayloadBuildCache', () => {
  let repoA: string
  let repoB: string

  setup(() => {
    repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'al-payloadcache-a-'))
    repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'al-payloadcache-b-'))
    makeRepo(repoA, 'repo-a')
    makeRepo(repoB, 'repo-b')
    setCredentialStore(memoryStore(CREDS))
  })

  teardown(() => {
    setCredentialStore(undefined)
    fs.rmSync(repoA, { recursive: true, force: true })
    fs.rmSync(repoB, { recursive: true, force: true })
  })

  test('repoKey() memoizes per (workspace, orgId) — a second card in the same repo reuses the same promise', () => {
    const cache = createPayloadBuildCache()
    const p1 = cache.repoKey(repoA, 'org-1')
    const p2 = cache.repoKey(repoA, 'org-1')
    assert.strictEqual(p1, p2)

    const differentRepo = cache.repoKey(repoB, 'org-1')
    assert.notStrictEqual(differentRepo, p1)

    const differentOrg = cache.repoKey(repoA, 'org-2')
    assert.notStrictEqual(differentOrg, p1)
  })

  test('branch() memoizes per root', () => {
    const cache = createPayloadBuildCache()
    const p1 = cache.branch(repoA)
    const p2 = cache.branch(repoA)
    assert.strictEqual(p1, p2)
    assert.notStrictEqual(cache.branch(repoB), p1)
  })

  test('buildPayloadForCard produces the same payload shape with and without a cache', async () => {
    const cardA = makeCard('sA', repoA)
    const cardB = makeCard('sB', repoA)
    const cache = createPayloadBuildCache()

    const uncachedA = await buildPayloadForCard(cardA)
    const cachedA = await buildPayloadForCard(cardA, cache)
    const cachedB = await buildPayloadForCard(cardB, cache)

    assert.strictEqual(uncachedA.payload.repo_key_fp, cachedA.payload.repo_key_fp)
    assert.strictEqual(cachedA.payload.repo_key_fp, cachedB.payload.repo_key_fp, 'two sessions in the same repo must resolve to the same repo key')
    assert.strictEqual(cachedA.ungroupedReason, undefined)
  })

  test('two sessions across two different repos still resolve to their own distinct repo keys under one shared cache', async () => {
    const cache = createPayloadBuildCache()
    const resultA = await buildPayloadForCard(makeCard('sA2', repoA), cache)
    const resultB = await buildPayloadForCard(makeCard('sB2', repoB), cache)
    assert.notStrictEqual(resultA.payload.repo_key_fp, resultB.payload.repo_key_fp)
  })
})
