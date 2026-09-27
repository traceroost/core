import * as assert from 'assert'
import { classifyOtlpPayload, parseLogPayload, parseTracePayload } from '../otlpParser'
import { SpanAttribute } from '../types'

function attr(key: string, value: string | number): SpanAttribute {
  return typeof value === 'string'
    ? { key, value: { stringValue: value } }
    : { key, value: { intValue: value } }
}

function hasAttr(spanAttrs: SpanAttribute[], key: string, value?: string): boolean {
  return spanAttrs.some(a => {
    if (a.key !== key) { return false }
    if (value === undefined) { return true }
    return a.value.stringValue === value
  })
}

suite('otlpParser', () => {
  test('classifies OTLP JSON payloads by shape when path is ambiguous', () => {
    assert.strictEqual(classifyOtlpPayload({ resourceSpans: [] }), 'traces')
    assert.strictEqual(classifyOtlpPayload({ resourceLogs: [] }), 'logs')
    assert.strictEqual(classifyOtlpPayload({ resourceMetrics: [] }), 'metrics')
    assert.strictEqual(classifyOtlpPayload({}), 'unknown')
  })

  test('groups Codex log records into one prompt-to-response session when raw trace IDs differ', () => {
    const spans = parseLogPayload({
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'raw-prompt-trace',
              spanId: 'prompt-span',
              timeUnixNano: '1700000000000000000',
              attributes: [
                attr('event.name', 'codex.user_prompt'),
                attr('conversation.id', 'parser-conversation'),
                attr('prompt', 'Check dispose calls'),
              ],
            },
            {
              traceId: 'raw-llm-trace',
              spanId: 'llm-span',
              timeUnixNano: '1700000001000000000',
              attributes: [
                attr('event.name', 'codex.sse_event'),
                attr('conversation.id', 'parser-conversation'),
                attr('input_token_count', 100),
              ],
            },
            {
              traceId: 'raw-tool-trace',
              spanId: 'tool-span',
              timeUnixNano: '1700000002000000000',
              attributes: [
                attr('event.name', 'codex.tool_result'),
                attr('conversation.id', 'parser-conversation'),
                attr('tool_name', 'exec_command'),
              ],
            },
          ],
        }],
      }],
    })

    assert.strictEqual(spans.length, 3)
    assert.deepStrictEqual(new Set(spans.map(s => s.traceId)).size, 1)
    assert.strictEqual(spans[0].traceId, 'codex:parser-conversation:prompt-1')
    assert.strictEqual(spans[1].parentSpanId, 'prompt-span')
    assert.strictEqual(spans[2].parentSpanId, 'prompt-span')
    assert.ok(hasAttr(spans[2].attributes, 'codex.session.id', 'codex:parser-conversation:prompt-1'))
    assert.ok(hasAttr(spans[2].attributes, 'otel.trace_id', 'raw-tool-trace'))
  })

  test('drops Codex websocket log records', () => {
    const spans = parseLogPayload({
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'raw-prompt-trace',
              spanId: 'prompt-span',
              timeUnixNano: '1700000000000000000',
              attributes: [
                attr('event.name', 'codex.user_prompt'),
                attr('conversation.id', 'parser-websocket-conversation'),
                attr('prompt', 'Check websocket parser filter'),
              ],
            },
            {
              traceId: 'raw-websocket-trace',
              spanId: 'websocket-span',
              timeUnixNano: '1700000001000000000',
              attributes: [
                attr('event.name', 'codex.websocket_event'),
                attr('conversation.id', 'parser-websocket-conversation'),
              ],
            },
            {
              traceId: 'raw-sse-trace',
              spanId: 'sse-span',
              timeUnixNano: '1700000002000000000',
              attributes: [
                attr('event.name', 'codex.sse_event'),
                attr('conversation.id', 'parser-websocket-conversation'),
              ],
            },
          ],
        }],
      }],
    })

    assert.deepStrictEqual(spans.map(s => s.name), ['codex.user_prompt', 'codex.sse_event'])
  })

  test('drops Codex websocket trace spans', () => {
    const spans = parseTracePayload({
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            {
              traceId: 'trace-a',
              spanId: 'prompt-span',
              name: 'codex.user_prompt',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000000000000000',
              attributes: [],
            },
            {
              traceId: 'trace-a',
              spanId: 'websocket-span',
              name: 'codex.websocket_event',
              startTimeUnixNano: '1700000001000000000',
              endTimeUnixNano: '1700000001000000000',
              attributes: [],
            },
          ],
        }],
      }],
    })

    assert.deepStrictEqual(spans.map(s => s.name), ['codex.user_prompt'])
  })

  test('keeps Codex startup logs out of prompt sessions until a user prompt arrives', () => {
    const spans = parseLogPayload({
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'startup-trace',
              spanId: 'startup-span',
              timeUnixNano: '1700000000000000000',
              attributes: [
                attr('event.name', 'codex.conversation_starts'),
                attr('conversation.id', 'startup-conversation'),
              ],
            },
            {
              traceId: 'prewarm-trace',
              spanId: 'prewarm-span',
              timeUnixNano: '1700000001000000000',
              attributes: [
                attr('event.name', 'codex.sse_event'),
                attr('conversation.id', 'startup-conversation'),
                attr('event.kind', 'response.completed'),
              ],
            },
          ],
        }],
      }],
    })

    assert.strictEqual(spans.length, 2)
    assert.deepStrictEqual(spans.map(s => s.traceId), ['startup-trace', 'prewarm-trace'])
    assert.ok(spans.every(s => !hasAttr(s.attributes, 'codex.session.id')))
  })

  test('skips null / non-object elements instead of throwing', () => {
    assert.deepStrictEqual(parseTracePayload({ resourceSpans: [null] }), [])
    assert.deepStrictEqual(parseTracePayload({ resourceSpans: [{ scopeSpans: [null, { spans: [null] }] }] }), [])
    assert.deepStrictEqual(parseTracePayload({ resourceSpans: [{ scopeSpans: { spans: [] } }] }), [])
    const spans = parseTracePayload({ resourceSpans: [{ scopeSpans: [{ spans: [
      { traceId: 't', spanId: 's', name: 'n', attributes: [null, attr('a', 'b')] },
    ] }] }] })
    assert.strictEqual(spans.length, 1)
    assert.deepStrictEqual(spans[0].attributes, [attr('a', 'b')])
    assert.deepStrictEqual(parseLogPayload({ resourceLogs: [null, { scopeLogs: [null, { logRecords: [null] }] }] }), [])
  })
})
