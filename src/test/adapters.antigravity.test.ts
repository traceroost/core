import * as assert from 'assert'
import {
  decodeExecutor, decodeGeneration, encodeProto, executorModelFor, modelString, parseProto, readVarint,
  repeatedVarints, resolveModel, usageFrom, MAX_PLAUSIBLE_TOKENS, WIRE_BYTES, WIRE_FIXED32, WIRE_FIXED64, WIRE_VARINT,
  type EncodeField,
} from '../adapters/antigravity/proto'
import { ANTIGRAVITY_RECORDS } from '../adapters/antigravity/known'
import { classifyRecord, observeAntigravity, observeRecords } from '../adapters/classify'
import { adapterForLogKey, agentKeyLabel } from '../adapters/registry'
import { lookupRates, normalizeCostKey } from '../pricing'

// SYNTHETIC: every blob here is encoded in the test from the field numbers agentsview recorded
// (src/adapters/antigravity/proto.ts). No real agy capture exists.

suite('Antigravity protobuf walker', () => {
  test('readVarint: one byte, multi-byte, beyond 32 bits, truncated, over-long', () => {
    assert.deepStrictEqual(readVarint(Uint8Array.from([0x05]), 0), { value: 5, next: 1 })
    assert.deepStrictEqual(readVarint(Uint8Array.from([0xac, 0x02]), 0), { value: 300, next: 2 })
    // 2^35 + 1 — past where 32-bit bit ops would wrap.
    const big = encodeProto([[1, 2 ** 35 + 1]])
    assert.strictEqual(parseProto(big)![0].varint, 2 ** 35 + 1)
    assert.strictEqual(readVarint(Uint8Array.from([0x80, 0x80]), 0), null)
    assert.strictEqual(readVarint(new Uint8Array(11).fill(0x80), 0), null)
  })

  test('parseProto decodes every wire type and keeps nested messages as bytes', () => {
    const buf = Uint8Array.from([
      0x08, 0x96, 0x01,                     // 1: varint 150
      0x11, 1, 2, 3, 4, 5, 6, 7, 8,         // 2: fixed64
      0x1a, 0x03, 0x61, 0x62, 0x63,         // 3: bytes "abc"
      0x25, 9, 9, 9, 9,                     // 4: fixed32
    ])
    const f = parseProto(buf)!
    assert.deepStrictEqual(f.map(x => [x.num, x.wire]), [[1, WIRE_VARINT], [2, WIRE_FIXED64], [3, WIRE_BYTES], [4, WIRE_FIXED32]])
    assert.strictEqual(f[0].varint, 150)
    assert.strictEqual(Buffer.from(f[2].bytes!).toString(), 'abc')
  })

  test('parseProto rejects malformed input rather than guessing', () => {
    assert.strictEqual(parseProto(Uint8Array.from([0x00, 0x01])), null)         // field number 0
    assert.strictEqual(parseProto(Uint8Array.from([0x0b])), null)               // start group
    assert.strictEqual(parseProto(Uint8Array.from([0x0a, 0x05, 0x61])), null)   // length past the end
    assert.strictEqual(parseProto(Uint8Array.from([0x11, 1, 2])), null)         // short fixed64
    assert.strictEqual(parseProto(Uint8Array.from([0x08])), null)               // missing varint
    assert.deepStrictEqual(parseProto(new Uint8Array(0)), [])
    // Field budget: 200k minimal fields is past what one blob may decode.
    assert.strictEqual(parseProto(new Uint8Array(400_000).map((_, i) => (i % 2 === 0 ? 0x08 : 0x01))), null)
  })

  test('repeatedVarints reads packed and unpacked forms; a malformed pack fails', () => {
    const f = parseProto(encodeProto([[2, { packed: [1, 300, 7] }], [2, 9]]))!
    assert.deepStrictEqual(repeatedVarints(f, 2), [1, 300, 7, 9])
    assert.strictEqual(repeatedVarints(parseProto(Uint8Array.from([0x12, 0x01, 0x80]))!, 2), null)
  })

  test('modelString accepts printable names only', () => {
    const str = (s: string | Uint8Array) => parseProto(encodeProto([[1, s]]))![0]
    assert.strictEqual(modelString(str('gemini-3.7-flash')), 'gemini-3.7-flash')
    assert.strictEqual(modelString(str('Gemini 3.7 Flash (High)')), 'Gemini 3.7 Flash (High)')
    assert.strictEqual(modelString(str(Uint8Array.from([0x08, 0x96, 0x01]))), null)   // a nested message
    assert.strictEqual(modelString(str('12345')), null)                                // no letter
    assert.strictEqual(modelString(str('x'.repeat(65))), null)
    assert.strictEqual(modelString(str(Uint8Array.from([0xff, 0xfe]))), null)        // invalid UTF-8
    assert.strictEqual(modelString(parseProto(encodeProto([[1, 5]]))![0]), null)       // a varint
  })
})

suite('Antigravity gen_metadata / executor_metadata', () => {
  const genBlob = (usage: EncodeField[], extra: EncodeField[] = [], steps = [1, 2]) =>
    encodeProto([[1, [[4, usage], ...extra]], [2, { packed: steps }]])

  test('the minimal row agentsview builds: tokens, display name, step indices', () => {
    const g = decodeGeneration(genBlob([[1, 1020], [2, 2400], [3, 180]], [[21, 'Test Gemini 3.5']]))!
    assert.deepStrictEqual(g, { usage: { input: 2400, output: 180, cacheRead: 0 }, model: 'Test Gemini 3.5', displayName: true, stepIndices: [1, 2] })
  })

  test('cache read is read when present; cache write is never added; response_model when no display name', () => {
    const g = decodeGeneration(genBlob([[1, 1020], [2, 300], [3, 220], [4, 0], [5, 2400]], [[19, 'gemini-3.7-flash-exp-b']]))!
    assert.deepStrictEqual(g.usage, { input: 300, output: 220, cacheRead: 2400 })
    assert.strictEqual(g.model, 'gemini-3.7-flash-exp-b')
    assert.strictEqual(g.displayName, false)
  })

  test('plausibility caps: model enum range, per-count and combined caps, required fields', () => {
    assert.strictEqual(usageFrom(parseProto(encodeProto([[1, 999], [2, 1], [3, 1]]))!), null)
    assert.strictEqual(usageFrom(parseProto(encodeProto([[1, 5000], [2, 1], [3, 1]]))!), null)
    assert.strictEqual(usageFrom(parseProto(encodeProto([[1, 1020], [2, MAX_PLAUSIBLE_TOKENS + 1], [3, 1]]))!), null)
    assert.strictEqual(usageFrom(parseProto(encodeProto([[1, 1020], [2, 1_500_000], [3, 600_000]]))!), null)
    assert.strictEqual(usageFrom(parseProto(encodeProto([[1, 1020], [2, 10], [3, 1], [5, MAX_PLAUSIBLE_TOKENS + 1]]))!), null)
    assert.strictEqual(usageFrom(parseProto(encodeProto([[1, 1020], [2, 10]]))!), null)   // no output
    assert.strictEqual(usageFrom(parseProto(encodeProto([[1, 1020], [2, 'x'], [3, 1]]))!), null)
    assert.deepStrictEqual(usageFrom(parseProto(encodeProto([[1, 4999], [2, 0], [3, 0]]))!), { input: 0, output: 0, cacheRead: 0 })
  })

  test('a legacy record with no chat_model wrapper is found by the bounded walk', () => {
    const legacy = encodeProto([[7, [[3, [[1, 2001], [2, 50], [3, 40], [5, 10]]], [21, 'gemini-3-pro']]], [2, { packed: [4] }]])
    const g = decodeGeneration(legacy)!
    assert.deepStrictEqual(g.usage, { input: 50, output: 40, cacheRead: 10 })
    assert.strictEqual(g.model, 'gemini-3-pro')
    assert.deepStrictEqual(g.stepIndices, [4])
    // A decoy shaped like usage but over the caps is not taken.
    assert.strictEqual(decodeGeneration(encodeProto([[7, [[1, 1500], [2, 3_000_000], [3, 1]]]]))!.usage, null)
  })

  test('a blob that is not protobuf decodes to null', () => {
    assert.strictEqual(decodeGeneration(Uint8Array.from([0x0b, 0x00])), null)
  })

  test('executor metadata: last step and effort-qualified model; incomplete rows are dropped', () => {
    assert.deepStrictEqual(decodeExecutor(encodeProto([[3, 6], [10, [[1, [[28, 'gemini-3.7-flash-high']]]]]])), { lastStepIdx: 6, modelName: 'gemini-3.7-flash-high' })
    assert.strictEqual(decodeExecutor(encodeProto([[10, [[1, [[28, 'gemini-3.7-flash-high']]]]]])), null)
    assert.strictEqual(decodeExecutor(encodeProto([[3, 6], [10, [[1, [[27, 'x']]]]]])), null)
  })

  test('executorModelFor picks the first executor whose range reaches the step', () => {
    const ex = [{ lastStepIdx: 10, modelName: 'b-medium' }, { lastStepIdx: 4, modelName: 'a-high' }]
    assert.strictEqual(executorModelFor(ex, 2), 'a-high')
    assert.strictEqual(executorModelFor(ex, 4), 'a-high')
    assert.strictEqual(executorModelFor(ex, 7), 'b-medium')
    assert.strictEqual(executorModelFor(ex, 11), null)
  })

  test('resolveModel follows agentsview: display name wins, only -exp-b is stripped, effort must agree', () => {
    assert.strictEqual(resolveModel('gemini-3.7-flash', false, 'gemini-3.7-flash-high'), 'gemini-3.7-flash-high')
    assert.strictEqual(resolveModel('gemini-3.7-flash-exp-b', false, 'gemini-3.7-flash-high'), 'gemini-3.7-flash-high')
    assert.strictEqual(resolveModel('claude-sonnet-4-6', false, 'gemini-3.7-flash-high'), 'claude-sonnet-4-6')
    assert.strictEqual(resolveModel('Gemini 3.7 Flash (High)', true, 'gemini-3.7-flash-medium'), 'Gemini 3.7 Flash (High)')
    assert.strictEqual(resolveModel('gemini-3.7-flash-high', false, null), 'gemini-3.7-flash-high')
    assert.strictEqual(resolveModel('gemini-3.7-flash-exp-b', false, 'claude-sonnet-4-6'), 'gemini-3.7-flash-exp-b')
    assert.strictEqual(resolveModel('gemini-3.7-flash-low', false, 'gemini-3.7-flash-high'), 'gemini-3.7-flash-low')
    assert.strictEqual(resolveModel('gemini-2.0-flash-exp', false, 'gemini-2.0-flash-high'), 'gemini-2.0-flash-exp')
  })
})

suite('Antigravity vocabulary and registry', () => {
  test('transcript lines are named by type; prompts and planner steps are known, tool steps ignored', () => {
    assert.deepStrictEqual(classifyRecord(ANTIGRAVITY_RECORDS, { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'x' }), { cls: 'known', name: 'USER_INPUT' })
    assert.deepStrictEqual(classifyRecord(ANTIGRAVITY_RECORDS, { step_index: 3, type: 'PLANNER_RESPONSE' }), { cls: 'known', name: 'PLANNER_RESPONSE' })
    for (const t of ['CONVERSATION_HISTORY', 'SYSTEM_MESSAGE', 'CHECKPOINT', 'ERROR_MESSAGE', 'RUN_COMMAND', 'VIEW_FILE', 'CODE_ACTION', 'GREP_SEARCH', 'LIST_DIRECTORY']) {
      assert.strictEqual(classifyRecord(ANTIGRAVITY_RECORDS, { step_index: 1, type: t }).cls, 'ignored', t)
    }
    assert.deepStrictEqual(classifyRecord(ANTIGRAVITY_RECORDS, { step_index: 1, type: 'BRAND_NEW_STEP' }), { cls: 'unknown', name: 'BRAND_NEW_STEP' })
    assert.deepStrictEqual(classifyRecord(ANTIGRAVITY_RECORDS, { type: 'USER_INPUT' }), { cls: 'unknown', name: 'USER_INPUT missing step_index' })
    assert.strictEqual(classifyRecord(ANTIGRAVITY_RECORDS, { step_index: 1 }).name, '(no type)')
  })

  test('the transcript records no version; without a database the version stays unknown', () => {
    const obs = observeRecords('antigravity', [{ step_index: 0, type: 'USER_INPUT' }, undefined, { step_index: 1, type: 'PLANNER_RESPONSE' }])!
    assert.strictEqual(obs.adapter, 'antigravity')
    assert.strictEqual(obs.version, 'unknown')
    assert.strictEqual(obs.unknownNames['(unparseable)'], 1)
    assert.strictEqual(observeAntigravity(null, null).version, 'unknown')
  })

  test('registry: best-effort, files + sqlite, the CLI root, no verified version', () => {
    const a = adapterForLogKey('antigravity')!
    assert.strictEqual(a.key, 'antigravity')
    assert.strictEqual(a.support, 'best-effort')
    assert.strictEqual(a.lastVerifiedVersion, null)
    assert.deepStrictEqual(a.sources, ['files', 'sqlite'])
    assert.strictEqual(a.dataDir, '~/.gemini/antigravity-cli/')
    assert.strictEqual(agentKeyLabel('antigravity'), 'Antigravity')
  })
})

suite('pricing — Antigravity Gemini model names', () => {
  test('effort suffixes, display labels and the -exp-b canary price at the base model', () => {
    for (const id of ['gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low', 'gemini-3.7-flash-exp-b', 'Gemini 3.7 Flash (High)', 'gemini-3.7-flash']) {
      assert.strictEqual(normalizeCostKey(id), 'gemini-3-7-flash', id)
      assert.deepStrictEqual(lookupRates(id), lookupRates('gemini-3.7-flash'), id)
    }
  })

  test('only those exact suffixes, and only on Gemini ids', () => {
    assert.strictEqual(normalizeCostKey('gemini-2.0-flash-exp'), 'gemini-2-0-flash-exp')
    assert.strictEqual(normalizeCostKey('gpt-5-high'), 'gpt-5-high')
    assert.strictEqual(normalizeCostKey('Test Gemini 3.5'), 'test-gemini-3-5')
    assert.strictEqual(lookupRates('agy'), null)
  })
})
