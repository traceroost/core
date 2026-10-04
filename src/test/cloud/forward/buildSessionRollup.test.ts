import * as assert from 'assert'
import * as crypto from 'crypto'
import { buildSessionRollup, sessionRollupPayload, toUuid, type SessionRollupInput } from '../../../cloud/forward/buildSessionRollup'
import { validateRollupPayload } from '../../../cloud/forward/validate'
import { stableStringify } from '../../../cloud/forward/preview'
import { authorHash, type RepoKeyContext } from '../../../repoKey'
import { traceKey } from '../../../traceIdentity'

const CTX: RepoKeyContext = { root: '/repo', key: crypto.createHash('sha256').update('test-key').digest() }
const HOST = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
const BUILD = { repoKey: CTX, branch: 'main', outcome: 'merged', hostId: HOST }

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
  sourceRank: 2,
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

  test('cache read/create tokens are forwarded onto the rollup', () => {
    const payload = sessionRollupPayload(BASE, BUILD)
    assert.strictEqual(payload.session?.tokens_cache_read, 200)
    assert.strictEqual(payload.session?.tokens_cache_create, 50)
  })

  suite('member_author_hash', () => {
    test('present when both repoKey and authorEmail are given, and validates against the schema', () => {
      const payload = sessionRollupPayload(BASE, { ...BUILD, authorEmail: 'dev@example.com' })
      assert.match(payload.member_author_hash ?? '', /^[a-f0-9]{64}$/)
      assert.deepStrictEqual(validateRollupPayload(payload), [])
    })

    test('absent when authorEmail is not given, even with a repoKey', () => {
      const payload = sessionRollupPayload(BASE, BUILD)
      assert.strictEqual(payload.member_author_hash, undefined)
    })

    test('absent when repoKey is not given, even with an authorEmail', () => {
      const { repoKey: _repoKey, branch: _branch, ...rest } = BUILD
      const payload = sessionRollupPayload(BASE, { ...rest, authorEmail: 'dev@example.com' })
      assert.strictEqual(payload.member_author_hash, undefined)
    })

    test('matches repoKey.ts\'s authorHash for the same context and email', () => {
      const payload = sessionRollupPayload(BASE, { ...BUILD, authorEmail: 'dev@example.com' })
      assert.strictEqual(payload.member_author_hash, authorHash(CTX, 'dev@example.com'))
    })
  })

  // A session whose workspace can't be keyed (not a repo, shallow clone, no root commit) is
  // still sent — just without repo grouping, never with a fake hash. See src/repoKey.ts.
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
      {
        ...BASE,
        durationMs: 1e12,
        totalLlmCalls: 1e12,
        inputTokens: 5e8,
        outputTokens: 5e8,
        cacheReadTokens: 5e8,
        cacheCreateTokens: 5e8,
      },
      BUILD,
    )
    assert.strictEqual(payload.session?.tokens_in, 100_000_000)
    assert.strictEqual(payload.session?.tokens_out, 100_000_000)
    assert.strictEqual(payload.session?.tokens_cache_read, 100_000_000)
    assert.strictEqual(payload.session?.tokens_cache_create, 100_000_000)
    assert.strictEqual(payload.session?.duration_ms, 100_000_000)
    assert.strictEqual(payload.session?.turns, 100_000_000)
    assert.strictEqual(payload.session?.models?.[0].calls, 100_000_000)
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

  test('outcome passes merged through unchanged', () => {
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

  test('language and change size: allowlisted ids and counts only, schema-valid', () => {
    const r = buildSessionRollup({ ...BASE, language: 'python', languageSecondary: 'typescript', filesChangedCount: 3, linesAdded: 120, linesRemoved: 40 }, BUILD)
    assert.strictEqual(r.language, 'python')
    assert.strictEqual(r.language_secondary, 'typescript')
    assert.deepStrictEqual([r.files_changed, r.lines_added, r.lines_removed], [3, 120, 40])
    assert.deepStrictEqual(validateRollupPayload(sessionRollupPayload({ ...BASE, language: 'python', languageSecondary: 'typescript', linesAdded: 1, linesRemoved: 0 }, BUILD)), [])
  })

  test('language: single language omits the secondary; unknown ids are never sent', () => {
    const single = buildSessionRollup({ ...BASE, language: 'go', languageSecondary: null }, BUILD)
    assert.strictEqual(single.language, 'go')
    assert.ok(!('language_secondary' in single))
    const none = buildSessionRollup({ ...BASE, language: 'none', languageSecondary: 'none' }, BUILD)
    assert.strictEqual(none.language, 'none')
    assert.ok(!('language_secondary' in none))
    const bogus = buildSessionRollup({ ...BASE, language: 'my secret project', languageSecondary: 'rust' }, BUILD)
    assert.ok(!('language' in bogus) && !('language_secondary' in bogus))
    const legacy = buildSessionRollup(BASE, BUILD)
    assert.ok(!('language' in legacy))
  })

  test('change size: files_changed falls back to the distinct filesChanged count; unknown lines are omitted', () => {
    const r = buildSessionRollup({ ...BASE, filesChanged: ['a.ts', 'a.ts', 'b.md'] }, BUILD)
    assert.strictEqual(r.files_changed, 2)
    assert.ok(!('lines_added' in r) && !('lines_removed' in r))
    assert.strictEqual(buildSessionRollup({ ...BASE, linesAdded: -5, linesRemoved: 2.6 }, BUILD).lines_added, 0)
    assert.strictEqual(buildSessionRollup({ ...BASE, linesAdded: -5, linesRemoved: 2.6 }, BUILD).lines_removed, 3)
  })

  test('the schema accepts a null language_secondary and rejects an unknown one', () => {
    const payload = sessionRollupPayload({ ...BASE, language: 'rust' }, BUILD) as unknown as { session: Record<string, unknown> }
    payload.session.language_secondary = null
    assert.deepStrictEqual(validateRollupPayload(payload), [])
    payload.session.language_secondary = 'none'
    assert.notDeepStrictEqual(validateRollupPayload(payload), [])
    payload.session.language_secondary = 'rust'
    payload.session.language = 'Rust'
    assert.notDeepStrictEqual(validateRollupPayload(payload), [])
  })

  test('source_rank: always sent (clamped to 1–3), schema version "1"; the schema requires it and allows only 1–3', () => {
    const sent = sessionRollupPayload({ ...BASE, sourceRank: 3 }, BUILD)
    assert.strictEqual(sent.session!.source_rank, 3)
    assert.strictEqual(sent.schema_version, '1')
    assert.deepStrictEqual(validateRollupPayload(sent), [])
    for (const [raw, wire] of [[0, 1], [4, 3], [2.4, 2], [NaN, 1]] as const) {
      assert.strictEqual(buildSessionRollup({ ...BASE, sourceRank: raw }, BUILD).source_rank, wire, String(raw))
    }
    const missing = sessionRollupPayload(BASE, BUILD) as unknown as { session: Record<string, unknown> }
    delete missing.session.source_rank
    assert.notDeepStrictEqual(validateRollupPayload(missing), [], 'a rollup without source_rank is rejected')
    const payload = sessionRollupPayload(BASE, BUILD) as unknown as { session: Record<string, unknown> }
    for (const rank of [1, 2, 3]) {
      payload.session.source_rank = rank
      assert.deepStrictEqual(validateRollupPayload(payload), [], String(rank))
    }
    for (const bad of [0, 4, 2.5, '3']) {
      payload.session.source_rank = bad
      assert.notDeepStrictEqual(validateRollupPayload(payload), [], String(bad))
    }
  })

  test('host_id: always sent as the build context gives it; the schema requires a uuid', () => {
    const sent = sessionRollupPayload(BASE, BUILD)
    assert.strictEqual(sent.session!.host_id, HOST)
    assert.deepStrictEqual(validateRollupPayload(sent), [])
    const payload = sessionRollupPayload(BASE, BUILD) as unknown as { session: Record<string, unknown> }
    delete payload.session.host_id
    assert.notDeepStrictEqual(validateRollupPayload(payload), [], 'a rollup without host_id is rejected')
    for (const bad of ['my-laptop', '', 42]) {
      payload.session.host_id = bad
      assert.notDeepStrictEqual(validateRollupPayload(payload), [], String(bad))
    }
  })

  test('a canonical trace key is the wire session_id unchanged', () => {
    const key = traceKey('claude', 'prompt-1')
    assert.strictEqual(buildSessionRollup({ ...BASE, sessionId: key }, BUILD).session_id, key)
  })
})
