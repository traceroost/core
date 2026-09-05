import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { SchemaValidator } from '../../forward/jsonSchemaValidate'

const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'schema', 'rollup.v1.json'), 'utf-8'))
const v = new SchemaValidator(schema)

const VALID = {
  schema_version: '1',
  repo_key_fp: 'a'.repeat(64),
  session: {
    session_id: '11111111-2222-4333-8444-555555555555',
    agent: 'claude-code',
    repo_hash: 'b'.repeat(64),
    started_at: '2026-03-01T12:00:00.000Z',
    duration_ms: 1000,
    tool_calls: { bash: 3 },
    loop_signals: [{ signal: 'retry-loop', severity: 2 }],
    outcome: 'merged',
  },
}

suite('forward/jsonSchemaValidate', () => {
  test('accepts a well-formed payload', () => {
    assert.deepStrictEqual(v.validate(VALID), [])
  })

  test('rejects an unknown top-level property', () => {
    const errs = v.validate({ ...VALID, sneaky: 'code here' })
    assert.ok(errs.some(e => /unknown property "sneaky"/.test(e.message)))
  })

  test('rejects an unknown property inside session (additionalProperties:false)', () => {
    const errs = v.validate({ ...VALID, session: { ...VALID.session, note: 'a prompt' } })
    assert.ok(errs.some(e => /unknown property "note"/.test(e.message)))
  })

  test('rejects a bad enum value', () => {
    const errs = v.validate({ ...VALID, session: { ...VALID.session, agent: 'chatgpt' } })
    assert.ok(errs.some(e => /must be one of/.test(e.message)))
  })

  test('rejects a hash that is not 64 hex chars', () => {
    const errs = v.validate({ ...VALID, repo_key_fp: 'nope' })
    assert.ok(errs.some(e => /must match/.test(e.message)))
  })

  test('rejects a non-uuid session_id', () => {
    const errs = v.validate({ ...VALID, session: { ...VALID.session, session_id: 'sess-1' } })
    assert.ok(errs.some(e => /must be a uuid/.test(e.message)))
  })

  test('rejects a tool_calls key outside ^[a-z_]{1,40}$', () => {
    const errs = v.validate({ ...VALID, session: { ...VALID.session, tool_calls: { 'Bad Key': 1 } } })
    assert.ok(errs.length > 0)
  })

  test('rejects a missing required field', () => {
    const { repo_key_fp, ...rest } = VALID
    void repo_key_fp
    const errs = v.validate(rest)
    assert.ok(errs.some(e => /missing required property "repo_key_fp"/.test(e.message)))
  })

  test('rejects severity out of range', () => {
    const errs = v.validate({ ...VALID, session: { ...VALID.session, loop_signals: [{ signal: 'retry-loop', severity: 9 }] } })
    assert.ok(errs.some(e => /must be ≤ 3/.test(e.message)))
  })

  test('the validator refuses a schema with a construct it does not understand', () => {
    assert.throws(() => new SchemaValidator({ type: 'object', additionalProperties: false, properties: { x: { type: 'string', multipleOf: 2 } } }), /unsupported schema keyword/)
  })
})
