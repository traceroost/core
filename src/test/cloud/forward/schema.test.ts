import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  SCHEMA_VERSION,
  schemaViolations,
  toWireAgent,
  toWireLoopSignal,
  toWireSeverity,
  toWireOutcome,
  toWireToolName,
  toWireModel,
  WIRE_LOOP_SIGNALS,
} from '../../../cloud/forward/schema'

// mocha runs from the repo root.
const SCHEMA_PATH = path.join(process.cwd(), 'schema', 'rollup.v1.json')

suite('forward/schema', () => {
  test('the committed schema/rollup.v1.json parses and is version 1', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'))
    assert.strictEqual(schema.$defs !== undefined, true)
    assert.deepStrictEqual(schema.properties.schema_version, { const: SCHEMA_VERSION })
  })

  // The mechanical guard that keeps the privacy invariant true as the schema grows: no string
  // may be left unconstrained, and no object may allow unknown properties. If you added a field
  // and this fails, the field cannot be expressed as a number/enum/hash/timestamp — that is a
  // schema decision requiring a written record, not a routine change.
  test('every string property in the schema is constrained, and every object is closed', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'))
    const violations = schemaViolations(schema)
    assert.deepStrictEqual(violations, [], `schema violations:\n${violations.join('\n')}`)
  })

  test('the guard catches an unconstrained string when one is introduced', () => {
    const bad = {
      type: 'object',
      additionalProperties: false,
      properties: { note: { type: 'string' } },
    }
    assert.deepStrictEqual(schemaViolations(bad), ['#/properties/note: unconstrained string'])
  })

  test('the guard catches an open object', () => {
    const bad = { type: 'object', properties: { n: { type: 'integer' } } }
    assert.deepStrictEqual(schemaViolations(bad), ['#: object without additionalProperties:false'])
  })

  test('toWireAgent maps known sources and collapses the rest to other', () => {
    assert.strictEqual(toWireAgent('claude_code'), 'claude-code')
    assert.strictEqual(toWireAgent('copilot'), 'copilot')
    assert.strictEqual(toWireAgent('codex'), 'codex')
    // OpenCode deliberately never got its own wire identity — collapses to 'other'.
    assert.strictEqual(toWireAgent('opencode'), 'other')
    assert.strictEqual(toWireAgent('something-new'), 'other')
  })

  // Cursor CLI ingestion (support-cursor-cli.md phase 1) makes this case live/reachable for the
  // first time — the wire schema drafted 'cursor' as a forward-looking stub before any real
  // ingestion existed (see toWireAgent's own doc comment). Unlike OpenCode, Cursor gets its own
  // wire identity, not 'other'.
  test('toWireAgent gives Cursor CLI sessions their own wire identity, not other', () => {
    assert.strictEqual(toWireAgent('cursor'), 'cursor')
  })

  test('every WireAgent value toWireAgent can produce is present in the committed schema enum', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'))
    const agentEnum: string[] = schema.$defs.agent.enum
    for (const source of ['claude_code', 'copilot', 'codex', 'opencode', 'cursor', 'something-new']) {
      assert.ok(agentEnum.includes(toWireAgent(source)), `${source} → ${toWireAgent(source)} missing from schema enum`)
    }
  })

  test('toWireLoopSignal only ever returns a value in the schema enum, or null', () => {
    for (const t of ['exact_tool_repeat', 'edit_revert_cycle', 'token_runaway', 'unknown_signal']) {
      const w = toWireLoopSignal(t)
      assert.ok(w === null || WIRE_LOOP_SIGNALS.includes(w), `${t} → ${w}`)
    }
    assert.strictEqual(toWireLoopSignal('unknown_signal'), null)
  })

  test('toWireSeverity is 1–3', () => {
    assert.strictEqual(toWireSeverity('warning'), 2)
    assert.strictEqual(toWireSeverity('critical'), 3)
  })

  test('toWireOutcome maps the session verdicts', () => {
    assert.strictEqual(toWireOutcome('merged'), 'merged')
    assert.strictEqual(toWireOutcome('committed'), 'committed')
    assert.strictEqual(toWireOutcome('abandoned'), 'abandoned')
    assert.strictEqual(toWireOutcome('ambiguous'), 'unknown')
    // No longer produced locally (gitOutcome.ts dropped the 'reverted' verdict), but still a valid
    // wire value for historical rows / other producers — toWireOutcome only maps known internal
    // verdicts, it isn't the place that decides which values are legal on the wire.
    assert.strictEqual(toWireOutcome('reverted'), 'unknown')
  })

  test('toWireToolName produces only [a-z_] and never empty', () => {
    for (const t of ['Bash', 'apply_patch', 'Read File', 'MCP__server__tool', '???']) {
      const w = toWireToolName(t)
      assert.match(w, /^[a-z_]{1,40}$/, `${t} → ${w}`)
    }
  })

  test('toWireModel strips spaces and out-of-charset bytes (no free text on the wire)', () => {
    assert.match(toWireModel('claude sonnet 5'), /^[A-Za-z0-9._:@/-]{1,80}$/)
    assert.strictEqual(toWireModel('claude-sonnet-5'), 'claude-sonnet-5')
    assert.strictEqual(toWireModel('   '), 'other')
    assert.ok(toWireModel('x'.repeat(200)).length <= 80)
  })
})
