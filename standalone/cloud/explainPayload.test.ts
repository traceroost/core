import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { explainSessionBlocks } from './explainPayload'
import { buildPayloadForCard } from '../../src/cloud/org/payloadPreview'
import { stableStringify } from '../../src/cloud/forward/preview'
import { setCredentialStore, type CredentialStore } from '../../src/cloud/org/credentials'
import { branchHash, deriveRepoKey } from '../../src/repoKey'
import type { OrgCredentials } from '../../src/cloud/org/config'
import type { SessionSummaryCard } from '../../src/summarizers/summarizerTypes'

const CREDS: OrgCredentials = {
  endpoint: 'https://traceroost.com', orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1', role: 'developer',
  perDeveloperVisibility: false, accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
}
function memoryStore(initial: OrgCredentials | null): CredentialStore {
  let cur = initial
  return { load: () => cur, save: c => { cur = c }, clear: () => { cur = null } }
}
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00' } })
}
function card(id: string, workspace: string, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: id, traceId: 'trace-' + id, source: 'claude_code', dataSource: 'otel', workspace,
    userRequest: 'x', model: 'claude', turns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: '2026-01-01T00:00:00.000Z', conversationId: 'conv-' + id,
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [], toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [], ...overrides,
  }
}
/** The JSON part of one printed block (after any `#` note lines). */
function json(block: string): { session?: Record<string, unknown> } {
  return JSON.parse(block.split('\n').filter(l => !l.startsWith('#')).join('\n')) as { session?: Record<string, unknown> }
}

suite('--explain-payload prints what the forwarder sends', () => {
  let repo: string
  setup(() => {
    setCredentialStore(memoryStore(CREDS))
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'al-explain-repo-'))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 't@example.com'])
    git(repo, ['config', 'user.name', 'T'])
    fs.writeFileSync(path.join(repo, 'README.md'), 'explain test\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'root'])
    // HEAD is a branch no session recorded — what a re-read of HEAD would wrongly report.
    git(repo, ['checkout', '-q', '-b', 'feature/checked-out-now'])
  })
  teardown(() => {
    setCredentialStore(undefined)
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('no branch recorded at capture time → no branch_hash, not the current HEAD\'s', async () => {
    const [block] = await explainSessionBlocks([card('s1', repo)])
    const session = json(block).session!
    assert.ok(session.repo_hash)
    assert.strictEqual(session.branch_hash, undefined)
  })

  test('a recorded branch is hashed, whatever HEAD is now', async () => {
    const rk = await deriveRepoKey(repo, 'org-1')
    assert.ok(rk.ok)
    const [block] = await explainSessionBlocks([card('s2', repo, { gitBranch: 'feature/x' })])
    assert.strictEqual(json(block).session!.branch_hash, branchHash(rk.ctx, 'feature/x'))
  })

  test('byte-identical to the payload the forwarder enqueues (buildPayloadForCard)', async () => {
    const cards = [card('s3', repo), card('s4', repo, { gitBranch: 'feature/x' })]
    const blocks = await explainSessionBlocks(cards)
    for (let i = 0; i < cards.length; i++) {
      const sent = (await buildPayloadForCard(cards[i])).payload
      assert.strictEqual(blocks[i], stableStringify(sent))
    }
    // conversation_hash is part of what is sent, so it is part of what is printed.
    assert.ok(json(blocks[0]).session!.conversation_hash)
  })

  test('no workspace → printed without a repo grouping, never hashed from this process\'s cwd', async () => {
    const [block] = await explainSessionBlocks([card('s5', '')])
    assert.match(block, /^# s5: no repository grouping — not-a-repo/)
    const session = json(block).session!
    assert.strictEqual(session.repo_hash, undefined)
    assert.strictEqual(session.branch_hash, undefined)
  })
})
