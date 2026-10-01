import * as assert from 'assert'
import { classifyOtlpPayload, getAttrFrom, parseLogPayload, parseTracePayload, toSpanAttributes } from '../otlpParser'
import type { Span, SpanAttribute } from '../types'

function attr(key: string, value: string | number): SpanAttribute {
  return typeof value === 'string' ? { key, value: { stringValue: value } } : { key, value: { intValue: value } }
}
const logs = (records: unknown[], extra: { resource?: unknown; scope?: unknown } = {}) => ({
  resourceLogs: [{ resource: extra.resource, scopeLogs: [{ scope: extra.scope, logRecords: records }] }],
})
const get = (s: Span, key: string) => s.attributes.find(a => a.key === key)?.value.stringValue

suite('otlpParser — edge cases', () => {
  test('non-object payloads classify as unknown', () => {
    assert.strictEqual(classifyOtlpPayload(null), 'unknown')
    assert.strictEqual(classifyOtlpPayload('{"resourceSpans":[]}'), 'unknown')
    assert.strictEqual(classifyOtlpPayload({ resourceSpans: {} }), 'unknown')
  })

  test('attributes without a string key or an object value are dropped', () => {
    assert.deepStrictEqual(toSpanAttributes([
      { key: 'ok', value: { stringValue: 'v' } }, { key: 1, value: { stringValue: 'v' } }, { key: 'no-value' },
      { key: 'scalar', value: 'v' }, null, 'x',
    ]), [{ key: 'ok', value: { stringValue: 'v' } }])
    assert.deepStrictEqual(toSpanAttributes({ key: 'not-an-array' }), [])
  })

  test('getAttrFrom takes the first non-empty string, int or double, in key order', () => {
    const attrs: SpanAttribute[] = [
      { key: 'empty', value: { stringValue: '' } }, { key: 'int', value: { intValue: 0 } },
      { key: 'dbl', value: { doubleValue: 1.5 } }, { key: 'bool', value: { boolValue: true } },
    ]
    assert.strictEqual(getAttrFrom(attrs, 'missing', 'empty', 'int'), '0')
    assert.strictEqual(getAttrFrom(attrs, 'dbl'), '1.5')
    assert.strictEqual(getAttrFrom(attrs, 'bool', 'empty'), '')
  })

  test('trace spans missing an id or name are skipped; an empty parent id becomes undefined', () => {
    const spans = parseTracePayload({ resourceSpans: [{ scopeSpans: [{ spans: [
      { traceId: 't', spanId: 's1', name: 'ok', parentSpanId: '', startTimeUnixNano: '1', endTimeUnixNano: '2', status: { code: 2 } },
      { traceId: 't', name: 'no-span-id' }, { spanId: 's3', name: 'no-trace' }, { traceId: 't', spanId: 's4' },
      { traceId: 't', spanId: 's5', name: 'Websocket ping', attributes: [attr('event.name', 'codex.websocket')] },
      { traceId: 't', spanId: 's6', name: 'websocket upgrade' },
    ] }] }] })
    assert.deepStrictEqual(spans.map(s => s.spanId), ['s1', 's6'], 'only Codex websocket spans are dropped')
    assert.strictEqual(spans[0].parentSpanId, undefined)
    assert.deepStrictEqual(spans[0].status, { code: 2 })
  })

  test('log records take their event name and attributes from a kvlist body, scope and resource', () => {
    const [span] = parseLogPayload(logs([{
      traceId: 'raw', spanId: 'p', observedTimeUnixNano: '42',
      attributes: [attr('model', 'record-wins')],
      body: { kvlistValue: { values: [attr('event.name', 'codex.user_prompt'), attr('model', 'body-loses'), { key: '', value: {} }, { key: 'novalue' }, null] } },
    }], { scope: { attributes: [attr('conversation.id', 'conv-scope')] }, resource: { attributes: [attr('service.name', 'codex')] } }))
    assert.strictEqual(span.name, 'codex.user_prompt')
    assert.strictEqual(get(span, 'model'), 'record-wins', 'record attributes win over body, scope and resource')
    assert.strictEqual(get(span, 'service.name'), 'codex')
    assert.strictEqual(get(span, 'codex.conversation.id'), 'conv-scope')
    assert.strictEqual(span.startTime, '42', 'falls back to the observed time')
    assert.strictEqual(get(span, 'otel.trace_id'), 'raw')
  })

  test('a plain string body names the event; non-Codex and unkeyed records are skipped', () => {
    const spans = parseLogPayload(logs([
      { body: { stringValue: 'codex.user_prompt' }, attributes: [attr('thread_id', 'th')] },
      { body: { stringValue: 'claude_code.api_request' }, traceId: 'x' },
      { body: 'codex.user_prompt', traceId: 'x' },
      { attributes: [attr('event.name', 'codex.sse_event')] },
      { attributes: [attr('event.name', 'codex.websocket_event'), attr('conversation.id', 'c')] },
    ]))
    assert.strictEqual(spans.length, 1)
    assert.strictEqual(spans[0].traceId, 'codex:th:prompt-1')
    assert.match(spans[0].spanId, /^cl-[a-z0-9]+$/, 'no span id anywhere → a generated one')
    assert.strictEqual(spans[0].startTime, '0')
  })

  test('turn ids key prompt sessions; a second prompt in a conversation starts a new session', () => {
    const spans = parseLogPayload(logs([
      { spanId: 'p1', attributes: [attr('event.name', 'codex.user_prompt'), attr('conversation.id', 'c'), attr('turn.id', 'T1')] },
      { attributes: [attr('event.name', 'codex.tool_result'), attr('conversation.id', 'c'), attr('span_id', 'tool-1'), attr('parent_span_id', 'explicit')] },
      { spanId: 'p2', attributes: [attr('event.name', 'codex.user_message'), attr('conversation.id', 'c')] },
      { spanId: 'p3', attributes: [attr('event.name', 'codex.prompt'), attr('conversation.id', 'c'), attr('turn_id', 'T3')] },
      { spanId: 'r3', attributes: [attr('event.name', 'codex.sse_event'), attr('conversation.id', 'c')] },
    ]))
    assert.deepStrictEqual(spans.map(s => s.traceId), ['codex:c:T1', 'codex:c:T1', 'codex:c:prompt-1', 'codex:c:T3', 'codex:c:T3'])
    assert.strictEqual(spans[1].spanId, 'tool-1')
    assert.strictEqual(spans[1].parentSpanId, 'explicit', 'an explicit parent is kept')
    assert.strictEqual(spans[4].parentSpanId, 'p3')
    assert.strictEqual(get(spans[0], 'codex.turn.id'), 'T1')
  })

  test('events before any prompt start a turn session, or ride along with the last active prompt', () => {
    const turnOnly = parseLogPayload(logs([
      { attributes: [attr('event.name', 'codex.sse_event'), attr('conversation.id', 'c'), attr('turn.id', 'T0')] },
    ]))
    assert.strictEqual(turnOnly[0].traceId, 'codex:c:T0')

    const crossConversation = parseLogPayload(logs([
      { attributes: [attr('event.name', 'codex.user_prompt'), attr('conversation.id', 'a')] },
      { attributes: [attr('event.name', 'codex.sse_event'), attr('conversation.id', 'b')] },
    ]))
    assert.strictEqual(crossConversation[1].traceId, 'codex:a:prompt-1', 'joins the active prompt cycle')

    const orphan = parseLogPayload(logs([
      { traceId: 'raw-only', attributes: [attr('event.name', 'codex.sse_event')] },
    ]))
    assert.strictEqual(orphan[0].traceId, 'raw-only', 'no session to join: keyed by the raw trace id')
    assert.strictEqual(get(orphan[0], 'codex.session.id'), undefined)
  })

  test('a raw trace id already mapped to a prompt session keeps later records in it', () => {
    const spans = parseLogPayload(logs([
      { traceId: 'raw', attributes: [attr('event.name', 'codex.session_start'), attr('conversation.id', 'c')] },
      { traceId: 'raw', attributes: [attr('event.name', 'codex.user_prompt'), attr('conversation.id', 'c')] },
      { traceId: 'raw', attributes: [attr('event.name', 'codex.sse_event'), attr('conversation.id', 'c')] },
    ]))
    assert.deepStrictEqual(spans.map(s => s.traceId), ['codex:c:prompt-1', 'codex:c:prompt-2', 'codex:c:prompt-2'])
  })
})
