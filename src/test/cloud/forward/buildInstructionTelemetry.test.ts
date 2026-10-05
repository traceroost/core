import * as assert from 'assert'
import * as crypto from 'crypto'
import {
  buildInstructionFileState,
  buildFileFootprints,
  buildSuggestionEvents,
} from '../../../cloud/forward/buildInstructionTelemetry'
import { validateRollupPayload } from '../../../cloud/forward/validate'
import type { RepoKeyContext } from '../../../repoKey'
import type { RollupPayload } from '../../../cloud/forward/schema'

const CTX: RepoKeyContext = { root: '/repo', key: crypto.createHash('sha256').update('k').digest() }

suite('forward/buildInstructionTelemetry', () => {
  // The AL 03 marker test, extended (AL 08): suggestion prose must never reach the wire.
  test('suggestedText / evidence / title never appear in a built suggestion event', () => {
    const MARKER = 'PROSE_MARKER_7ac1'
    const events = buildSuggestionEvents([
      {
        // A SuggestionCard-shaped object with prose fields it should ignore.
        ...({ suggestedText: MARKER, evidence: MARKER, title: MARKER } as Record<string, unknown>),
        id: `hot_file:src_${MARKER}_ts`,
        category: 'context',
        priority: 'high',
        targetAgents: ['claude_code', 'codex'],
        action: 'surfaced',
        atIso: '2026-03-01T00:00:00.000Z',
      },
    ], CTX)
    const serialized = JSON.stringify(events)
    assert.ok(!serialized.includes(MARKER), `prose leaked: ${serialized}`)
    // The id is hashed, not passed through.
    assert.match(events[0].suggestion_id, /^[a-f0-9]{64}$/)
    assert.ok(!serialized.includes('src_'))
  })

  test('instruction file content becomes a content_hash, never the text', () => {
    const state = buildInstructionFileState({
      present: true,
      kind: 'claude_md',
      path: 'CLAUDE.md',
      content: 'Always read src/secret-config.ts before editing.',
      lineCount: 1,
      lastModifiedIso: '2026-03-01T00:00:00Z',
    }, CTX)
    const s = JSON.stringify(state)
    assert.ok(!s.includes('secret-config'))
    assert.match(state.content_hash!, /^[a-f0-9]{64}$/)
    assert.strictEqual(state.line_count, 1)
  })

  test('file footprints carry a file_hash and the coverage boolean, not the path', () => {
    const fps = buildFileFootprints([
      { path: 'src/hot-file.ts', sessionsRead: 8, sessionsTotal: 10, earlyReads: 6, tokenSize: 1200, coveredByInstructions: false },
    ], CTX)
    assert.strictEqual(fps.length, 1)
    assert.match(fps[0].file_hash, /^[a-f0-9]{64}$/)
    assert.strictEqual(fps[0].covered_by_instructions, false)
    assert.ok(!JSON.stringify(fps).includes('hot-file'))
  })

  test('suggestion_id is keyed by the repo key, not a plain digest of the id', () => {
    const input = { id: 'hot_file:src_auth_ts', category: 'context' as const, priority: 'high' as const, targetAgents: [], action: 'surfaced' as const, atIso: '2026-03-01T00:00:00.000Z' }
    const [a] = buildSuggestionEvents([input], CTX)
    const plain = crypto.createHash('sha256').update(input.id).digest('hex')
    assert.notStrictEqual(a.suggestion_id, plain)
    assert.strictEqual(a.suggestion_id, crypto.createHmac('sha256', CTX.key).update(`suggestion:${input.id}`).digest('hex'))
    // Stable within a repo key (members of one org agree), different under another.
    assert.strictEqual(buildSuggestionEvents([input], CTX)[0].suggestion_id, a.suggestion_id)
    const other: RepoKeyContext = { root: '/repo', key: crypto.createHash('sha256').update('other').digest() }
    assert.notStrictEqual(buildSuggestionEvents([input], other)[0].suggestion_id, a.suggestion_id)
  })

  test('out-of-range counts are clamped to the schema maximum, so the payload still validates', () => {
    const huge = 5e12
    const payload: RollupPayload = {
      schema_version: '1',
      repo_key_fp: 'a'.repeat(64),
      instruction_files: [buildInstructionFileState({ present: true, kind: 'agents_md', path: 'AGENTS.md', content: 'x', lineCount: huge }, CTX)],
      file_footprints: buildFileFootprints([{ path: 'a.ts', sessionsRead: huge, sessionsTotal: huge, earlyReads: huge, tokenSize: huge, coveredByInstructions: true }], CTX),
    }
    assert.strictEqual(payload.instruction_files![0].line_count, 100_000_000)
    const fp = payload.file_footprints![0]
    for (const n of [fp.sessions_read, fp.sessions_total, fp.early_reads, fp.token_size]) assert.strictEqual(n, 100_000_000)
    assert.deepStrictEqual(validateRollupPayload(payload), [])
  })

  test('a full instruction rollup validates against the committed (extended) schema', () => {
    const payload: RollupPayload = {
      schema_version: '1',
      repo_key_fp: 'a'.repeat(64),
      instruction_files: [buildInstructionFileState({ present: true, kind: 'agents_md', path: 'AGENTS.md', content: 'x', lineCount: 1 }, CTX)],
      file_footprints: buildFileFootprints([{ path: 'a.ts', sessionsRead: 1, sessionsTotal: 2, earlyReads: 0, tokenSize: 10, coveredByInstructions: true }], CTX),
      suggestion_events: buildSuggestionEvents([{ id: 'x', category: 'behavior', priority: 'low', targetAgents: ['copilot'], action: 'applied', atIso: '2026-03-01T00:00:00.000Z', baseline: { costAvg: 0.1, turnsAvg: 5, errorRate: 0.2, loopRate: 0.1, insufficient: false } }], CTX),
    }
    assert.deepStrictEqual(validateRollupPayload(payload), [])
  })
})
