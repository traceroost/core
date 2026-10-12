import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { buildPayloadForCard } from '../../../cloud/org/payloadPreview'
import { setCredentialStore, type CredentialStore } from '../../../cloud/org/credentials'
import { branchHash, deriveRepoKey } from '../../../repoKey'
import { LogReader } from '../../../logReader'
import { mergeCardsByKey } from '../../../claudeConversation'
import type { OrgCredentials } from '../../../cloud/org/config'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'

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
    sessionId: id, traceId: 'trace-' + id, source: 'claude_code', dataSource: 'log', workspace,
    userRequest: 'x', model: 'claude', turns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: '2026-01-01T00:00:00.000Z',
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [], toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [], ...overrides,
  }
}

suite('branch_hash comes from the branch recorded at capture time', () => {
  let repo: string
  let tmp: string
  setup(() => {
    setCredentialStore(memoryStore(CREDS))
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'al-branch-repo-'))
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-branch-logs-'))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 't@example.com'])
    git(repo, ['config', 'user.name', 'T'])
    fs.writeFileSync(path.join(repo, 'README.md'), 'branch test\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'root'])
  })
  teardown(() => {
    setCredentialStore(undefined)
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('a turn recorded on a feature branch keeps that branch after the developer checks out main', async () => {
    const rk = await deriveRepoKey(repo, 'org-1')
    assert.ok(rk.ok)
    // HEAD is main now; the turn ran on feature/x.
    const built = await buildPayloadForCard(card('s1', repo, { gitBranch: 'feature/x' }))
    assert.strictEqual(built.payload.session?.branch_hash, branchHash(rk.ctx, 'feature/x'))
    assert.notStrictEqual(built.payload.session?.branch_hash, branchHash(rk.ctx, 'main'))
  })

  test('no recorded branch → no branch_hash, never the current HEAD', async () => {
    const built = await buildPayloadForCard(card('s2', repo))
    assert.ok(built.payload.session?.repo_hash)
    assert.strictEqual(built.payload.session?.branch_hash, undefined)
  })

  test('no workspace → no repository at all, not the repo this process runs in', async () => {
    const built = await buildPayloadForCard(card('s3', ''))
    assert.strictEqual(built.payload.session?.repo_hash, undefined)
    assert.strictEqual(built.payload.repo_key_fp, undefined)
    assert.strictEqual(built.ungroupedReason, 'not-a-repo')
  })

  test('captured from the agents\' own records: Claude transcript gitBranch, Codex session_meta.git.branch', () => {
    const claudeFile = path.join(tmp, 'claude.jsonl')
    fs.writeFileSync(claudeFile, [
      { type: 'user', cwd: '/w', gitBranch: 'feature/y', sessionId: 'c1', promptId: 'p1', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'hi' } },
      { type: 'assistant', cwd: '/w', gitBranch: 'feature/y', sessionId: 'c1', uuid: 'u2', timestamp: '2026-01-01T00:00:01.000Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')
    const reader = new LogReader()
    assert.deepStrictEqual(reader.parseFile(claudeFile, 'claude').map(r => r.card.gitBranch), ['feature/y'])

    const codexFile = path.join(tmp, 'rollout.jsonl')
    const ts = '2026-01-01T00:00:00.000Z'
    fs.writeFileSync(codexFile, [
      { timestamp: ts, type: 'session_meta', payload: { id: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b', cwd: '/w', git: { branch: 'fix/z', commit_hash: 'abc' } } },
      { timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: 't-1' } },
      { timestamp: ts, type: 'turn_context', payload: { model: 'gpt-5', cwd: '/w', turn_id: 't-1' } },
      { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: '2026-01-01T00:00:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')
    const old = Date.now() - 60 * 60_000
    fs.utimesSync(codexFile, old / 1000, old / 1000)
    assert.deepStrictEqual(reader.parseFile(codexFile, 'codex').map(r => r.card.gitBranch), ['fix/z'])
  })

  test('a turn\'s OTEL card, merged over its transcript card, keeps the transcript\'s branch', () => {
    const log = card('k', '/w', { gitBranch: 'feature/y', sourceRank: 2 })
    const otel = card('k', '/w', { dataSource: 'otel', sourceRank: 3 })
    assert.strictEqual(mergeCardsByKey([otel], [log])[0].gitBranch, 'feature/y')
  })
})
