import * as assert from 'assert'
import * as http from 'http'
import { OtlpCollector } from '../otlpCollector'
import { SessionStore } from '../sessionStore'

// ── Mock VS Code OutputChannel ──

function mockOutputChannel(): import('vscode').OutputChannel {
  const lines: string[] = []
  return {
    name: 'test',
    append: (s: string) => { lines.push(s) },
    appendLine: (s: string) => { lines.push(s) },
    replace: () => {},
    clear: () => { lines.length = 0 },
    show: () => {},
    hide: () => {},
    dispose: () => {},
    _lines: lines,
  } as unknown as import('vscode').OutputChannel
}

// ── Mock SessionStore ──

function mockStore() {
  const addedSpans: unknown[] = []
  return {
    addedSpans,
    addSpan: (s: unknown) => { addedSpans.push(s) },
    getSpans: () => addedSpans,
    getSummary: () => ({}),
    clear: () => { addedSpans.length = 0 },
    export: () => ({ spans: addedSpans, summary: {} }),
  } as unknown as SessionStore & { addedSpans: unknown[] }
}

// ── HTTP helpers ──

function postJson(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function postRaw(port: number, path: string, body: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      res.on('data', () => {})
      res.on('end', () => resolve({ status: res.statusCode! }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function request(port: number, opts: {
  method?: string; path?: string; body?: string; headers?: Record<string, string>
}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? ''
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: opts.path ?? '/v1/traces',
      method: opts.method ?? 'POST',
      headers: { 'Content-Length': Buffer.byteLength(body), ...opts.headers },
    }, (res) => {
      res.on('data', () => {})
      res.on('end', () => resolve({ status: res.statusCode! }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── Test data ──

function validOtlpPayload(spans: Array<{ name: string; traceId?: string; spanId?: string }>) {
  return {
    resourceSpans: [{
      scopeSpans: [{
        spans: spans.map((s, i) => ({
          traceId: s.traceId ?? 'trace-' + i,
          spanId: s.spanId ?? 'span-' + i,
          name: s.name,
          startTimeUnixNano: '1700000000000000000',
          endTimeUnixNano: '1700000001000000000',
          attributes: [],
          status: { code: 0 }
        }))
      }]
    }]
  }
}

// ── Tests ──

suite('OtlpCollector', () => {
  let collector: OtlpCollector
  let store: ReturnType<typeof mockStore>
  let output: ReturnType<typeof mockOutputChannel>
  const TEST_PORT = 14318 + Math.floor(Math.random() * 1000)

  setup(async () => {
    store = mockStore()
    output = mockOutputChannel()
    collector = new OtlpCollector(TEST_PORT, store as unknown as SessionStore, output)
    await collector.start()
  })

  teardown(async () => {
    await collector.stop()
  })

  test('starts and listens on configured port', async () => {
    const res = await postJson(TEST_PORT, '/v1/traces', { resourceSpans: [] })
    assert.strictEqual(res.status, 200)
  })

  test('processes valid OTLP trace payload', async () => {
    const payload = validOtlpPayload([
      { name: 'invoke_agent', traceId: 't1', spanId: 's1' },
      { name: 'tool/read_file', traceId: 't1', spanId: 's2' }
    ])
    const res = await postJson(TEST_PORT, '/v1/traces', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 2)
  })

  test('skips spans with missing required fields', async () => {
    const payload = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            { name: 'valid', traceId: 't1', spanId: 's1', startTimeUnixNano: '0', endTimeUnixNano: '0', attributes: [] },
            { name: null, traceId: 't1' },  // missing spanId and name
            { traceId: 't1', spanId: 's3' },  // missing name
          ]
        }]
      }]
    }
    await postJson(TEST_PORT, '/v1/traces', payload)
    assert.strictEqual(store.addedSpans.length, 1)
  })

  test('handles non-JSON body gracefully', async () => {
    const res = await postRaw(TEST_PORT, '/v1/traces', 'not json at all')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 0)
  })

  test('handles empty POST body', async () => {
    const res = await postRaw(TEST_PORT, '/v1/traces', '')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 0)
  })

  test('handles non-trace JSON payload', async () => {
    const res = await postJson(TEST_PORT, '/v1/metrics', { someMetric: 42 })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 0)
  })

  test('handles GET request without crashing', async () => {
    return new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/v1/traces`, (res) => {
        assert.strictEqual(res.statusCode, 200)
        res.resume()
        res.on('end', resolve)
      }).on('error', reject)
    })
  })

  test('processes multiple spans from single request', async () => {
    const payload = validOtlpPayload([
      { name: 'invoke_agent' },
      { name: 'tool/grep_search' },
      { name: 'tool/read_file' },
      { name: 'chat' },
    ])
    await postJson(TEST_PORT, '/v1/traces', payload)
    assert.strictEqual(store.addedSpans.length, 4)
  })

  test('drops Codex websocket trace spans at ingest', async () => {
    const payload = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            {
              traceId: 'codex-trace',
              spanId: 'prompt-span',
              name: 'codex.user_prompt',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000000000000000',
              attributes: [],
            },
            {
              traceId: 'codex-trace',
              spanId: 'websocket-span',
              name: 'codex.websocket_event',
              startTimeUnixNano: '1700000001000000000',
              endTimeUnixNano: '1700000001000000000',
              attributes: [],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/traces', payload)
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual((store.addedSpans as Array<{ name: string }>).map(s => s.name), ['codex.user_prompt'])
  })

  test('handles payload with empty resourceSpans', async () => {
    const res = await postJson(TEST_PORT, '/v1/traces', { resourceSpans: [] })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 0)
  })

  test('handles null elements at every level without hanging the socket', async () => {
    const cases: unknown[] = [
      { resourceSpans: [null] },
      { resourceSpans: [{ scopeSpans: [null] }] },
      { resourceSpans: [{ scopeSpans: { spans: [] } }] },
      { resourceSpans: [{ scopeSpans: [{ spans: [null, 1, 'x'] }] }] },
      { resourceSpans: [{ resource: { attributes: [null] }, scopeSpans: [{ spans: [
        { traceId: 't', spanId: 's', name: 'n', attributes: [null, { key: 'a', value: { stringValue: 'b' } }] },
      ] }] }] },
      { resourceLogs: [null, { scopeLogs: [null, { logRecords: [null] }] }] },
      { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [null], body: { kvlistValue: { values: [null] } } }] }] }] },
      { resourceMetrics: [null, { scopeMetrics: [null, { metrics: [null] }] }] },
    ]
    for (const payload of cases) {
      const res = await postJson(TEST_PORT, '/v1/traces', payload)
      assert.strictEqual(res.status, 200, JSON.stringify(payload))
    }
    // Only the one well-formed span among the cases is stored, with the null attribute skipped.
    assert.strictEqual(store.addedSpans.length, 1)
    const span = store.addedSpans[0] as { attributes: Array<{ key: string }> }
    assert.ok(span.attributes.some(a => a.key === 'a'))
  })

  test('rejects cross-origin browser requests', async () => {
    const body = JSON.stringify(validOtlpPayload([{ name: 'fake' }]))
    const res = await request(TEST_PORT, {
      body, headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    })
    assert.strictEqual(res.status, 403)
    const nullOrigin = await request(TEST_PORT, {
      body, headers: { 'Content-Type': 'application/json', Origin: 'null' },
    })
    assert.strictEqual(nullOrigin.status, 403)
    assert.strictEqual(store.addedSpans.length, 0)
  })

  test('rejects the no-preflight text/plain and form content types', async () => {
    const body = JSON.stringify(validOtlpPayload([{ name: 'fake' }]))
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await request(TEST_PORT, { body, headers: { 'Content-Type': type } })
      assert.strictEqual(res.status, 415, type)
    }
    assert.strictEqual(store.addedSpans.length, 0)
  })

  test('rejects a DNS-rebinding Host header', async () => {
    const res = await request(TEST_PORT, {
      body: JSON.stringify(validOtlpPayload([{ name: 'fake' }])),
      headers: { 'Content-Type': 'application/json', Host: 'attacker.example:4318' },
    })
    assert.strictEqual(res.status, 403)
    assert.strictEqual(store.addedSpans.length, 0)
  })

  test('accepts JSON from a loopback Origin', async () => {
    const res = await request(TEST_PORT, {
      body: JSON.stringify(validOtlpPayload([{ name: 'ok' }])),
      headers: { 'Content-Type': 'application/json; charset=utf-8', Origin: 'http://localhost:3000' },
    })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 1)
  })

  test('handles malformed resourceSpans structure', async () => {
    const res = await postJson(TEST_PORT, '/v1/traces', { resourceSpans: [{ scopeSpans: null }] })
    assert.strictEqual(res.status, 200)
  })

  test('merges resource-level attributes (e.g. session.id) onto every span', async () => {
    const payload = {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'session.id', value: { stringValue: 'native-session-uuid' } },
          ]
        },
        scopeSpans: [{
          spans: [
            {
              traceId: 't1', spanId: 's1', name: 'claude_code.interaction',
              startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
              attributes: [], status: { code: 0 },
            },
            {
              traceId: 't1', spanId: 's2', name: 'claude_code.llm_request', parentSpanId: 's1',
              startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
              // span-level attribute should win over the resource-level one on key collision
              attributes: [{ key: 'session.id', value: { stringValue: 'span-level-override' } }],
              status: { code: 0 },
            },
          ]
        }]
      }]
    }
    const res = await postJson(TEST_PORT, '/v1/traces', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 2)
    const spans = store.addedSpans as Array<{ spanId: string; attributes: Array<{ key: string; value: { stringValue?: string } }> }>
    const root = spans.find(s => s.spanId === 's1')!
    const child = spans.find(s => s.spanId === 's2')!
    assert.strictEqual(root.attributes.find(a => a.key === 'session.id')?.value.stringValue, 'native-session-uuid')
    assert.strictEqual(child.attributes.find(a => a.key === 'session.id')?.value.stringValue, 'span-level-override')
  })

  test('stop resolves cleanly', async () => {
    await collector.stop()
    // Second stop should also resolve without error
    await collector.stop()
  })

  test('processes codex log payload and groups by prompt-to-response session when traceId is missing', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-123' } },
                { key: 'user_prompt', value: { stringValue: 'Fix latency chart' } },
              ],
            },
            {
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.response' } },
                { key: 'conversation.id', value: { stringValue: 'conv-123' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: 321 } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 2)

    const first = store.addedSpans[0] as { traceId: string; name: string }
    const second = store.addedSpans[1] as { traceId: string; name: string }
    assert.strictEqual(first.name, 'codex.user_prompt')
    assert.strictEqual(second.name, 'codex.response')
    assert.strictEqual(first.traceId, 'codex:conv-123:prompt-1')
    assert.strictEqual(second.traceId, 'codex:conv-123:prompt-1')
  })

  test('drops Codex websocket log events at ingest', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'codex-log-trace',
              spanId: 'prompt-span',
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-websocket' } },
                { key: 'prompt', value: { stringValue: 'Check websocket filter' } },
              ],
            },
            {
              traceId: 'codex-log-trace',
              spanId: 'websocket-span',
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.websocket_event' } },
                { key: 'conversation.id', value: { stringValue: 'conv-websocket' } },
                { key: 'event.kind', value: { stringValue: 'response.created' } },
              ],
            },
            {
              traceId: 'codex-log-trace',
              spanId: 'sse-span',
              timeUnixNano: '1700000002000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
                { key: 'conversation.id', value: { stringValue: 'conv-websocket' } },
                { key: 'event.kind', value: { stringValue: 'response.completed' } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual(
      (store.addedSpans as Array<{ name: string }>).map(s => s.name),
      ['codex.user_prompt', 'codex.sse_event']
    )
  })

  test('does not create a Codex session for startup logs before the user prompt', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'startup-trace',
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.conversation_starts' } },
                { key: 'conversation.id', value: { stringValue: 'conv-startup' } },
              ],
            },
            {
              traceId: 'prewarm-trace',
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
                { key: 'conversation.id', value: { stringValue: 'conv-startup' } },
                { key: 'event.kind', value: { stringValue: 'response.completed' } },
                { key: 'input_token_count', value: { intValue: 20475 } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 2)

    const spans = store.addedSpans as Array<{ traceId: string; attributes: Array<{ key: string }> }>
    assert.deepStrictEqual(spans.map(s => s.traceId), ['startup-trace', 'prewarm-trace'])
    assert.ok(spans.every(s => !s.attributes.some(a => a.key === 'codex.session.id')))
  })

  test('folds child Codex turns into the active prompt-to-response session', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'prompt-trace',
              spanId: 'prompt-span',
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-main' } },
                { key: 'prompt', value: { stringValue: 'check for calls to dispose()' } },
              ],
            },
            {
              traceId: 'child-trace',
              spanId: 'child-ttft',
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.turn_ttft' } },
                { key: 'conversation.id', value: { stringValue: 'conv-child' } },
                { key: 'turn.id', value: { stringValue: 'turn-child' } },
                { key: 'duration_ms', value: { intValue: 3435 } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 2)

    const spans = store.addedSpans as Array<{ traceId: string; attributes: Array<{ key: string; value: { stringValue?: string } }> }>
    assert.strictEqual(spans[0].traceId, spans[1].traceId)
    assert.ok(spans[1].attributes.some(a => a.key === 'codex.turn.id' && a.value.stringValue === 'turn-child'))
  })

  test('keeps one codex prompt together when log records have different OTEL trace IDs', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'otel-trace-a',
              spanId: 'prompt-span',
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-split' } },
                { key: 'prompt', value: { stringValue: 'Fix trace split' } },
              ],
            },
            {
              traceId: 'otel-trace-b',
              spanId: 'response-span',
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
                { key: 'conversation.id', value: { stringValue: 'conv-split' } },
                { key: 'event.kind', value: { stringValue: 'response.completed' } },
              ],
            },
            {
              traceId: 'otel-trace-c',
              spanId: 'tool-span',
              timeUnixNano: '1700000002000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.tool_result' } },
                { key: 'conversation.id', value: { stringValue: 'conv-split' } },
                { key: 'tool_name', value: { stringValue: 'shell_command' } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 3)

    const traceIds = new Set((store.addedSpans as Array<{ traceId: string }>).map(s => s.traceId))
    assert.strictEqual(traceIds.size, 1)
    assert.ok([...traceIds][0].startsWith('codex:conv-split:'))
  })

  test('normalizes raw trace spans that share a Codex log OTEL trace ID', async () => {
    const logPayload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'raw-tool-trace',
              spanId: 'prompt-log',
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-tool-trace' } },
                { key: 'prompt', value: { stringValue: 'run a command' } },
              ],
            },
            {
              traceId: 'raw-tool-trace',
              spanId: 'tool-result-log',
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.tool_result' } },
                { key: 'conversation.id', value: { stringValue: 'conv-tool-trace' } },
                { key: 'tool_name', value: { stringValue: 'exec_command' } },
              ],
            },
          ],
        }],
      }],
    }
    await postJson(TEST_PORT, '/v1/logs', logPayload)
    const sessionTraceId = (store.addedSpans[0] as { traceId: string }).traceId

    const tracePayload = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            {
              traceId: 'raw-tool-trace',
              spanId: 'exec-span',
              name: 'exec_command',
              startTimeUnixNano: '1700000001000000000',
              endTimeUnixNano: '1700000002000000000',
              attributes: [],
            },
          ],
        }],
      }],
    }
    const res = await postJson(TEST_PORT, '/v1/traces', tracePayload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 3)

    const execSpan = store.addedSpans[2] as { traceId: string; name: string; attributes: Array<{ key: string; value: { stringValue?: string } }> }
    assert.strictEqual(execSpan.name, 'exec_command')
    assert.strictEqual(execSpan.traceId, sessionTraceId)
    assert.ok(execSpan.attributes.some(a => a.key === 'codex.session.id' && a.value.stringValue === sessionTraceId))
    assert.ok(execSpan.attributes.some(a => a.key === 'otel.trace_id' && a.value.stringValue === 'raw-tool-trace'))
  })

  test('starts a new codex log session for the next user prompt in the same conversation', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-two-prompts' } },
                { key: 'prompt', value: { stringValue: 'First prompt' } },
              ],
            },
            {
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
                { key: 'conversation.id', value: { stringValue: 'conv-two-prompts' } },
              ],
            },
            {
              timeUnixNano: '1700000010000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-two-prompts' } },
                { key: 'prompt', value: { stringValue: 'Second prompt' } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 3)

    const spans = store.addedSpans as Array<{ traceId: string }>
    assert.strictEqual(spans[0].traceId, spans[1].traceId)
    assert.notStrictEqual(spans[0].traceId, spans[2].traceId)
  })

  test('normalizes codex trace spans by thread and turn IDs', async () => {
    const payload = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            {
              traceId: 'raw-trace-1',
              spanId: 'turn-span',
              name: 'turn',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'thread.id', value: { stringValue: 'thread-123' } },
                { key: 'turn.id', value: { stringValue: 'turn-abc' } },
                { key: 'otel.name', value: { stringValue: 'session_task.turn' } },
              ],
            },
            {
              traceId: 'raw-trace-1',
              spanId: 'llm-span',
              parentSpanId: 'turn-span',
              name: 'handle_responses',
              startTimeUnixNano: '1700000000100000000',
              endTimeUnixNano: '1700000000900000000',
              attributes: [
                { key: 'thread.id', value: { stringValue: 'thread-123' } },
                { key: 'turn.id', value: { stringValue: 'turn-abc' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: 12 } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/traces', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 2)

    const spans = store.addedSpans as Array<{ traceId: string; attributes: Array<{ key: string; value: { stringValue?: string } }> }>
    assert.strictEqual(spans[0].traceId, 'codex:thread-123:turn-abc')
    assert.strictEqual(spans[1].traceId, 'codex:thread-123:turn-abc')
    assert.ok(spans[0].attributes.some(a => a.key === 'codex.session.id' && a.value.stringValue === 'codex:thread-123:turn-abc'))
  })
})
