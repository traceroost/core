import * as assert from 'assert'
import * as crypto from 'crypto'
import { buildInstructionFileState } from '../../../cloud/forward/buildInstructionTelemetry'
import { validateRollupPayload } from '../../../cloud/forward/validate'
import type { RepoKeyContext } from '../../../repoKey'
import type { RollupPayload } from '../../../cloud/forward/schema'

const CTX: RepoKeyContext = { root: '/repo', key: crypto.createHash('sha256').update('k').digest() }

suite('forward/buildInstructionTelemetry', () => {
  // The AL 03 marker test, extended (AL 08): suggestion prose must never reach the wire.
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

  test('content_hash is keyed by the repo key: a stock template can\'t be recognised from a plain sha256; same repo, same hash', () => {
    const content = '# CLAUDE.md\nUse pnpm.\n'
    const input = { present: true, kind: 'claude_md' as const, path: 'CLAUDE.md', content, lineCount: 2 }
    const state = buildInstructionFileState(input, CTX)
    assert.notStrictEqual(state.content_hash, crypto.createHash('sha256').update(content).digest('hex'))
    assert.strictEqual(state.content_hash, crypto.createHmac('sha256', CTX.key).update(`instruction-content:${content}`).digest('hex'))
    assert.strictEqual(buildInstructionFileState(input, { ...CTX, root: '/elsewhere' }).content_hash, state.content_hash, 'another clone of the repo agrees')
    const other: RepoKeyContext = { root: '/repo', key: crypto.createHash('sha256').update('other').digest() }
    assert.notStrictEqual(buildInstructionFileState(input, other).content_hash, state.content_hash)
  })

  test('out-of-range counts are clamped to the schema maximum, so the payload still validates', () => {
    const huge = 5e12
    const payload: RollupPayload = {
      schema_version: '1',
      repo_key_fp: 'a'.repeat(64),
      instruction_files: [buildInstructionFileState({ present: true, kind: 'agents_md', path: 'AGENTS.md', content: 'x', lineCount: huge }, CTX)],
    }
    assert.strictEqual(payload.instruction_files![0].line_count, 100_000_000)
    assert.deepStrictEqual(validateRollupPayload(payload), [])
  })

  test('a full instruction rollup validates against the committed (extended) schema', () => {
    const payload: RollupPayload = {
      schema_version: '1',
      repo_key_fp: 'a'.repeat(64),
      instruction_files: [buildInstructionFileState({ present: true, kind: 'agents_md', path: 'AGENTS.md', content: 'x', lineCount: 1 }, CTX)],
    }
    assert.deepStrictEqual(validateRollupPayload(payload), [])
  })
})
