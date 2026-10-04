import * as assert from 'assert'
import { OtlpIngest, type OtlpSpanSink } from '../otlpIngest'
import type { Span } from '../types'

// OtlpIngest is the one OTLP parser both hosts run (the extension's OtlpCollector and the
// standalone server), so these pin the cross-payload behaviour the standalone used to lack.

function sink(): OtlpSpanSink & { spans: Span[] } {
  const spans: Span[] = []
  return {
    spans,
    addSpan: s => { spans.push(s) },
    injectSpanAttribute(traceId, spanId, key, value) {
      const span = spans.find(s => s.traceId === traceId && s.spanId === spanId)
      if (!span) { return false }
      span.attributes = [...span.attributes.filter(a => a.key !== key), { key, value: { stringValue: value } }]
      return true
    },
  }
}

const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } })
const attrOf = (span: Span, key: string) => span.attributes.find(a => a.key === key)?.value?.stringValue

const codexPromptLog = {
  resourceLogs: [{
    scopeLogs: [{
      logRecords: [{
        traceId: 'otel-trace-1',
        spanId: 'prompt-span',
        timeUnixNano: '1700000000000000000',
        attributes: [attr('event.name', 'codex.user_prompt'), attr('conversation.id', 'conv-1')],
      }],
    }],
  }],
}

const codexSpanOnSameOtelTrace = {
  resourceSpans: [{
    scopeSpans: [{
      spans: [{
        traceId: 'otel-trace-1',
        spanId: 'handle-span',
        name: 'handle_responses',
        startTimeUnixNano: '1700000001000000000',
        endTimeUnixNano: '1700000002000000000',
        attributes: [],
      }],
    }],
  }],
}

suite('OtlpIngest', () => {
  test('a Codex trace span lands under the prompt session its OTEL trace was mapped to by the logs', () => {
    const s = sink()
    const ingest = new OtlpIngest(s)
    assert.strictEqual(ingest.processLogs(codexPromptLog), 1)
    assert.strictEqual(ingest.processTraces(codexSpanOnSameOtelTrace, '/v1/traces'), 1)

    const [prompt, handle] = s.spans
    assert.strictEqual(prompt.traceId, 'codex:conv-1:prompt-1')
    assert.strictEqual(handle.traceId, prompt.traceId, 'the span joins the prompt session, not its raw OTEL trace')
    assert.strictEqual(attrOf(handle, 'otel.trace_id'), 'otel-trace-1')
    assert.strictEqual(attrOf(handle, 'codex.session.id'), prompt.traceId)
    assert.strictEqual(attrOf(handle, '_traceroost.collector_path'), '/v1/traces')
  })

  test('the remap state is per instance — a fresh parser keeps the raw OTEL trace id', () => {
    const s = sink()
    new OtlpIngest(s).processTraces(codexSpanOnSameOtelTrace)
    assert.strictEqual(s.spans[0].traceId, 'otel-trace-1')
  })

  const genAiLog = {
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [{
          traceId: 't1',
          spanId: 's1',
          attributes: [
            attr('event.name', 'gen_ai.choice'),
            attr('gen_ai.event.content', JSON.stringify({ message: { role: 'assistant', content: 'hi' } })),
          ],
        }],
      }],
    }],
  }
  const llmSpan = {
    resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 't1', spanId: 's1', name: 'chat', attributes: [] }] }] }],
  }
  const expected = JSON.stringify([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }])

  test('gen_ai response content logged before its span is attached when the span arrives', () => {
    const s = sink()
    const ingest = new OtlpIngest(s)
    assert.strictEqual(ingest.processLogs(genAiLog), 0, 'the content event is not a span of its own')
    ingest.processTraces(llmSpan)
    assert.strictEqual(attrOf(s.spans[0], 'gen_ai.output.messages'), expected)
  })

  test('gen_ai response content logged after its span is injected into the stored span', () => {
    const s = sink()
    const ingest = new OtlpIngest(s)
    ingest.processTraces(llmSpan)
    ingest.processLogs(genAiLog)
    assert.strictEqual(attrOf(s.spans[0], 'gen_ai.output.messages'), expected)
  })

  test('log spans carry the collector path only when the host passes one', () => {
    const withPath = sink()
    new OtlpIngest(withPath).processLogs(codexPromptLog, '/v1/logs')
    assert.strictEqual(attrOf(withPath.spans[0], '_traceroost.collector_path'), '/v1/logs')

    const without = sink()
    new OtlpIngest(without).processLogs(codexPromptLog)
    assert.strictEqual(attrOf(without.spans[0], '_traceroost.collector_path'), undefined)
  })
})
