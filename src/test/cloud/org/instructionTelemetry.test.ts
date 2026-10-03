import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { buildInstructionRollup, maybeEnqueueInstructionTelemetry, EMPTY_LEDGER, type SuggestionLedger } from '../../../cloud/org/instructionTelemetry'
import { setCredentialStore, type CredentialStore } from '../../../cloud/org/credentials'
import type { OrgCredentials } from '../../../cloud/org/config'
import { ForwardQueue } from '../../../cloud/forward/queue'
import { generateSuggestions } from '../../../instructionAdvisor'
import type { SessionSummaryCard } from '../../../summarizers/summarizerTypes'

function store(linked: boolean): CredentialStore {
  let cur: OrgCredentials | null = linked ? {
    endpoint: 'https://test.traceroost.com', orgId: 'org-1', installId: 'install-1', orgName: 'Acme', memberId: 'm-1',
    role: 'developer', perDeveloperVisibility: false, accessToken: 'a', refreshToken: 'r',
    accessTokenExpiresAt: Date.now() + 3600_000, linkedAt: new Date().toISOString(),
  } : null
  return { load: () => cur, save: (c) => { cur = c }, clear: () => { cur = null } }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

const HOT_FILE = 'src/core/engine.ts'
const SECRET_PROSE = 'Never deploy on Fridays'

function card(i: number, repo: string, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: `s${i}`, traceId: `t${i}`, source: 'claude_code', dataSource: 'otel', workspace: repo,
    userRequest: 'task', model: 'claude-sonnet-4-5', turns: 1, inputTokens: 1000, outputTokens: 100,
    cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 1000,
    startTime: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
    filesRead: [HOT_FILE, HOT_FILE, 'a.c', path.join(repo, 'gone/missing-file.ts')], filesSearched: [], filesChanged: [],
    filesWritten: [], toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 5, errors: 0, outcome: 'text_response',
    timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

const realHome = process.env.HOME
const realUserProfile = process.env.USERPROFILE

suite('org/instructionTelemetry', () => {
  let tmp: string
  let repo: string

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-instr-'))
    process.env.HOME = tmp // ForwardQueue() has no injectable baseHome here
    process.env.USERPROFILE = tmp
    repo = path.join(tmp, 'repo')
    fs.mkdirSync(path.join(repo, 'src', 'core'), { recursive: true })
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 't@example.com'])
    git(repo, ['config', 'user.name', 'T'])
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), `# Rules\n${SECRET_PROSE}\n`)
    fs.writeFileSync(path.join(repo, HOT_FILE), 'x'.repeat(4000))
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'root'])
    setCredentialStore(store(true))
  })

  teardown(() => {
    setCredentialStore(undefined)
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('a workspace that is not a git repo produces nothing', async () => {
    const plain = fs.mkdtempSync(path.join(tmp, 'plain-'))
    assert.strictEqual(await buildInstructionRollup(plain, [], EMPTY_LEDGER), null)
  })

  test('reports instruction files, hot-file footprints and suggestion events — hashed, never prose or paths', async () => {
    const sessions = [0, 1, 2, 3, 4].map(i => card(i, repo))
    const surfaced = generateSuggestions(sessions, fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'))
    assert.ok(surfaced.length > 0, 'fixture should produce at least one Advisor suggestion')
    const appliedAt = new Date(Date.UTC(2026, 0, 2)).toISOString()
    const ledger: SuggestionLedger = {
      applied: [
        { id: surfaced[0].id, atIso: appliedAt },
        { id: 'retired:card', atIso: appliedAt, card: { id: 'retired:card', category: 'behavior', priority: 'low', targetAgents: ['codex'] } },
        { id: 'unknown:no-card', atIso: appliedAt },
      ],
      dismissed: [{ id: 'dismissed:x', atIso: appliedAt }],
      reverted: [{ id: surfaced[0].id, atIso: appliedAt }],
    }

    const payload = await buildInstructionRollup(repo, sessions, ledger)
    assert.ok(payload)
    assert.ok(payload.repo_key_fp)

    const files = payload.instruction_files ?? []
    assert.strictEqual(files.length, 4, 'one entry per known instruction file, present or not')
    const claude = files.find(f => f.kind === 'claude_md')
    assert.strictEqual(claude?.present, true)
    assert.strictEqual(claude?.line_count, 3)
    assert.ok(claude?.last_modified)
    assert.deepStrictEqual(files.filter(f => !f.present).map(f => f.kind).sort(), ['agents_md', 'copilot_instructions', 'other'] /* the Cursor rule has no wire kind of its own */)

    const footprints = payload.file_footprints ?? []
    assert.strictEqual(footprints.length, 2, 'the hot file and the deleted one; the 3-char basename is skipped')
    const hot = footprints.find(f => f.token_size === 1000)
    assert.ok(hot, 'token size estimated from the file on disk (4000 bytes / 4)')
    assert.strictEqual(hot.sessions_read, 5)
    assert.strictEqual(hot.sessions_total, 5)
    assert.strictEqual(hot.early_reads, 5)
    assert.strictEqual(hot.covered_by_instructions, false)
    assert.ok(footprints.some(f => f.token_size === 0), 'a file that is gone has no size')

    const events = payload.suggestion_events ?? []
    const count = (a: string) => events.filter(e => e.action === a).length
    assert.strictEqual(count('surfaced'), surfaced.length)
    assert.strictEqual(count('applied'), 2, 'an applied id with neither a live nor a remembered card is dropped')
    assert.strictEqual(count('dismissed'), 1)
    assert.strictEqual(count('reverted'), 1)
    const retired = events.find(e => e.action === 'applied' && e.priority === 'low')
    assert.strictEqual(retired?.category, 'behavior')
    assert.ok(retired?.baseline, 'applied events carry the pre-apply baseline')
    const dismissed = events.find(e => e.action === 'dismissed')
    assert.deepStrictEqual([dismissed?.category, dismissed?.priority], ['context', 'medium'], 'unknown cards get neutral defaults')

    const wire = JSON.stringify(payload)
    for (const leak of [SECRET_PROSE, 'engine.ts', repo, surfaced[0].id, surfaced[0].suggestedText]) {
      assert.ok(!wire.includes(leak), `payload must not contain ${JSON.stringify(leak)}`)
    }
  })

  test('sessions from other workspaces are ignored, and footprints need three sessions', async () => {
    const payload = await buildInstructionRollup(repo, [card(0, repo), card(1, repo), card(2, '/elsewhere')], EMPTY_LEDGER)
    assert.ok(payload)
    assert.strictEqual(payload.file_footprints, undefined)
    assert.strictEqual(payload.suggestion_events, undefined)
  })

  test('enqueues only when linked', async () => {
    const sessions = [0, 1, 2, 3, 4].map(i => card(i, repo))
    setCredentialStore(store(false))
    assert.strictEqual(await maybeEnqueueInstructionTelemetry(repo, sessions, EMPTY_LEDGER), false)
    assert.strictEqual(new ForwardQueue().depth(), 0)

    setCredentialStore(store(true))
    assert.strictEqual(await maybeEnqueueInstructionTelemetry(repo, sessions, EMPTY_LEDGER), true)
    assert.strictEqual(new ForwardQueue().depth(), 1)
    assert.strictEqual(await maybeEnqueueInstructionTelemetry(path.join(tmp, 'nope'), sessions, EMPTY_LEDGER), false)
  })
})
