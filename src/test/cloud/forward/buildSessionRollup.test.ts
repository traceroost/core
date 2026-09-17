import * as assert from 'assert'
import * as crypto from 'crypto'
import { buildSessionRollup, sessionRollupPayload, toUuid, type SessionRollupInput } from '../../../cloud/forward/buildSessionRollup'
import { validateRollupPayload } from '../../../cloud/forward/validate'
import { stableStringify } from '../../../cloud/forward/preview'
import type { RepoKeyContext } from '../../../cloud/forward/repoKey'

const CTX: RepoKeyContext = { root: '/repo', key: crypto.createHash('sha256').update('test-key').digest() }
const BUILD = { repoKey: CTX, branch: 'main', costUsd: 0.1234, outcome: 'productive' }

const BASE: SessionRollupInput = {
  sessionId: 'sess-abc',
  source: 'claude_code',
  model: 'claude-sonnet-5',
  models: ['claude-sonnet-5'],
  startTime: '2026-03-01T12:00:00.000Z',
  durationMs: 60_000,
  totalLlmCalls: 8,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 200,
  cacheCreateTokens: 50,
  errors: 1,
  toolCounts: { Bash: 5, Read: 3, 'MCP__x__y': 2 },
  filesChanged: ['src/a.ts', './src/b.ts'],
  filesWritten: ['src/c.ts'],
  loopSignals: [{ type: 'exact_tool_repeat', severity: 'warning' }, { type: 'not_a_real_signal', severity: 'critical' }],
  oneShotStats: { filesConsidered: 3, oneShotFiles: 2, totalEdits: 5 },
  dataSource: 'log',
  initiator: 'user',
}

suite('forward/buildSessionRollup', () => {
  // The invariant. Anyone who adds a text field to the builder breaks this. Do not delete it.
  test('NO text field from the source reaches the built rollup', () => {
    const MARKER = 'SENSITIVE_MARKER_9f3c'
    const withText = {
      ...BASE,
      // Fields a real SessionSummaryCard carries that could hold prompts/completions/diffs.
      userRequest: MARKER,
      workspace: `/Users/someone/secret-project-${MARKER}`,
      projectPath: MARKER,
      timeline: [{ type: 'llm', responseText: MARKER, toolInput: MARKER, thinking: MARKER, fullResult: MARKER, model: 'claude-sonnet-5' }],
      editDetails: [{ oldString: MARKER, newString: MARKER }],
      filesRead: [`src/${MARKER}.ts`],
    } as unknown as SessionRollupInput

    const payload = sessionRollupPayload(withText, BUILD)
    const serialized = JSON.stringify(payload)
    assert.ok(!serialized.includes(MARKER), `marker leaked into rollup:\n${serialized}`)
    // The one place a path could sneak through is file_hashes — assert those are hashes.
    for (const h of payload.session?.file_hashes ?? []) assert.match(h, /^[a-f0-9]{64}$/)
  })

  test('the built payload validates against the committed schema', () => {
    const payload = sessionRollupPayload(BASE, BUILD)
    assert.deepStrictEqual(validateRollupPayload(payload), [])
  })

  // A session whose workspace can't be keyed (not a repo, shallow clone, no root commit) is
  // still sent — just without repo grouping, never with a fake hash. See src/cloud/forward/repoKey.ts.
  test('without a repoKey, the payload omits repo_key_fp/repo_hash/branch_hash/file_hashes but still validates', () => {
    const { repoKey: _repoKey, branch: _branch, ...rest } = BUILD
    const payload = sessionRollupPayload(BASE, rest)
    assert.strictEqual(payload.repo_key_fp, undefined)
    assert.strictEqual(payload.session?.repo_hash, undefined)
    assert.strictEqual(payload.session?.branch_hash, undefined)
    assert.strictEqual(payload.session?.file_hashes, undefined)
    // Everything else still gets built and sent.
    assert.strictEqual(payload.session?.session_id, toUuid(BASE.sessionId))
    assert.strictEqual(payload.session?.tool_calls?.bash, 5)
    assert.deepStrictEqual(validateRollupPayload(payload), [])
  })

  // A count or cost over the schema's cap (e.g. a very long, cache-heavy session, or a bad
  // upstream number) must still be sent — clamped, not rejected. Rejecting the whole payload
  // drops the session permanently: this build happens once per closed session with no retry
  // path (see enqueueSession.ts's catch), unlike a queue-level send failure.
  test('a count or cost over the schema cap is clamped, not rejected', () => {
    const payload = sessionRollupPayload(
      { ...BASE, durationMs: 1e12, totalLlmCalls: 1e12, inputTokens: 5e8, outputTokens: 5e8 },
      { ...BUILD, costUsd: 999_999 },
    )
    assert.strictEqual(payload.session?.tokens_in, 100_000_000)
    assert.strictEqual(payload.session?.tokens_out, 100_000_000)
    assert.strictEqual(payload.session?.duration_ms, 100_000_000)
    assert.strictEqual(payload.session?.turns, 100_000_000)
    assert.strictEqual(payload.session?.models?.[0].calls, 100_000_000)
    assert.strictEqual(payload.session?.cost_usd, 100_000)
    assert.deepStrictEqual(validateRollupPayload(payload), [])
  })

  test('tool names are normalised to the schema key form and merged', () => {
    const r = buildSessionRollup(BASE, BUILD)
    for (const k of Object.keys(r.tool_calls ?? {})) assert.match(k, /^[a-z_]{1,40}$/)
    assert.strictEqual(r.tool_calls?.bash, 5)
    assert.ok('mcp__x__y' in (r.tool_calls ?? {}))
  })

  test('an unknown loop signal is dropped, a known one is mapped', () => {
    const r = buildSessionRollup(BASE, BUILD)
    assert.strictEqual(r.loop_signals?.length, 1)
    assert.strictEqual(r.loop_signals?.[0].signal, 'repeated-edit')
    assert.strictEqual(r.loop_signals?.[0].severity, 2)
  })

  test('outcome maps productive → merged', () => {
    assert.strictEqual(buildSessionRollup(BASE, BUILD).outcome, 'merged')
  })

  test('a leading ./ on a changed path does not create a second file hash', () => {
    const r = buildSessionRollup(
      { ...BASE, filesChanged: ['src/x.ts', './src/x.ts'], filesWritten: [] },
      BUILD,
    )
    assert.strictEqual(r.file_hashes?.length, 1)
  })

  test('the output is deterministic and stable-ordered', () => {
    const a = stableStringify(sessionRollupPayload(BASE, BUILD))
    const b = stableStringify(sessionRollupPayload(BASE, BUILD))
    assert.strictEqual(a, b)
  })

  test('conversationId is hashed to conversation_hash, and stably so; absent when not split', () => {
    const withConvo = buildSessionRollup({ ...BASE, conversationId: 'convo-1' }, BUILD)
    assert.match(withConvo.conversation_hash ?? '', /^[a-f0-9]{64}$/)
    assert.strictEqual(
      withConvo.conversation_hash,
      buildSessionRollup({ ...BASE, conversationId: 'convo-1' }, BUILD).conversation_hash,
    )
    assert.notStrictEqual(
      withConvo.conversation_hash,
      buildSessionRollup({ ...BASE, conversationId: 'convo-2' }, BUILD).conversation_hash,
    )
    assert.strictEqual(buildSessionRollup(BASE, BUILD).conversation_hash, undefined)
  })

  test('toUuid passes through a real UUID and folds a non-UUID to a valid one', () => {
    const real = '11111111-2222-4333-8444-555555555555'
    assert.strictEqual(toUuid(real), real)
    const folded = toUuid('claude-session-42')
    assert.match(folded, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.strictEqual(toUuid('claude-session-42'), folded) // stable
  })
})
