import * as assert from 'assert'
import * as crypto from 'crypto'
import {
  buildInstructionFileState,
  buildFileFootprints,
  buildSuggestionEvents,
} from '../../../cloud/forward/buildInstructionTelemetry'
import { validateRollupPayload } from '../../../cloud/forward/validate'
import type { RepoKeyContext } from '../../../cloud/forward/repoKey'
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
