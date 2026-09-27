import * as assert from 'assert'
import type * as vscode from 'vscode'
import { SessionStore } from '../sessionStore'
import { summarizeSpans } from '../spanSummarizer'
import { Span } from '../types'

// ── Mock VS Code Extension Context ──

function mockContext(): vscode.ExtensionContext {
  const state: Record<string, unknown> = {}
  return {
    globalState: {
      get: (key: string, defaultVal?: unknown) => state[key] ?? defaultVal,
      update: (key: string, val: unknown) => { state[key] = val; return Promise.resolve() },
      keys: () => Object.keys(state),
      setKeysForSync: () => {},
    },
    subscriptions: [],
    extensionPath: '/mock',
    extensionUri: {} as unknown as vscode.Uri,
    globalStorageUri: {} as unknown as vscode.Uri,
    logUri: {} as unknown as vscode.Uri,
    storageUri: {} as unknown as vscode.Uri,
    storagePath: '/mock/storage',
    globalStoragePath: '/mock/global-storage',
    logPath: '/mock/log',
    extensionMode: 1,
    extension: {} as unknown as vscode.Extension<unknown>,
    environmentVariableCollection: {} as unknown as vscode.GlobalEnvironmentVariableCollection,
    secrets: {} as unknown as vscode.SecretStorage,
    languageModelAccessInformation: {} as unknown as vscode.LanguageModelAccessInformation,
  } as unknown as vscode.ExtensionContext
}


// ── Test helpers ──

function makeSpan(name: string, traceId: string, opts?: {
  spanId?: string
  attributes?: Span['attributes']
  status?: Span['status']
  startTime?: string
  endTime?: string
}): Span {
  return {
    traceId,
    spanId: opts?.spanId ?? 'span-' + Math.random().toString(36).slice(2, 8),
    name,
    startTime: opts?.startTime ?? '1700000000000000000',
    endTime: opts?.endTime ?? '1700000001000000000',
    attributes: opts?.attributes ?? [],
    status: opts?.status,
  }
}

function makeAttr(key: string, value: string | number) {
  if (typeof value === 'string') {return { key, value: { stringValue: value } }}
  return { key, value: { intValue: value } }
}

// ── Tests ──

suite('SessionStore', () => {

  test('initializes with empty state', () => {
    const ctx = mockContext()
    const store = new SessionStore(ctx)
    assert.strictEqual(store.getSpans().length, 0)
    assert.strictEqual(store.getSummary().totalSpans, 0)
  })

  test('adds and retrieves spans', () => {
    const store = new SessionStore(mockContext())
    const span = makeSpan('invoke_agent', 't1')
    store.addSpan(span)
    assert.strictEqual(store.getSpans().length, 1)
    assert.strictEqual(store.getSpans()[0].name, 'invoke_agent')
  })

  test('updates summary on addSpan', () => {
    const store = new SessionStore(mockContext())
    store.addSpan(makeSpan('invoke_agent', 't1'))
    assert.strictEqual(store.getSummary().totalSpans, 1)
    assert.strictEqual(store.getSummary().agentSessions, 1)
  })

  test('tracks tool calls in summary', () => {
    const store = new SessionStore(mockContext())
    store.addSpan(makeSpan('tool/read_file', 't1'))
    store.addSpan(makeSpan('tool/read_file', 't1'))
    store.addSpan(makeSpan('tool/grep_search', 't1'))
    const summary = store.getSummary()
    assert.strictEqual(summary.toolCalls['read_file'], 2)
    assert.strictEqual(summary.toolCalls['grep_search'], 1)
  })

  test('extracts token counts from attributes', () => {
    const store = new SessionStore(mockContext())
    store.addSpan(makeSpan('chat', 't1', {
      attributes: [
        makeAttr('gen_ai.usage.input_tokens', 5000),
        makeAttr('gen_ai.usage.output_tokens', 1000),
      ]
    }))
    assert.strictEqual(store.getSummary().tokensUsed, 6000)
  })

  test('tracks errors from span status', () => {
    const store = new SessionStore(mockContext())
    store.addSpan(makeSpan('tool/run_in_terminal', 't1', {
      status: { code: 2, message: 'failed' }
    }))
    assert.strictEqual(store.getSummary().errors, 1)
  })

  test('tracks files changed from write tools', () => {
    const store = new SessionStore(mockContext())
    store.addSpan(makeSpan('tool/replace_string_in_file', 't1', {
      attributes: [
        makeAttr('gen_ai.tool.name', 'replace_string_in_file'),
        makeAttr('gen_ai.tool.call.arguments', JSON.stringify({ filePath: '/src/foo.ts', oldString: 'a', newString: 'b' })),
      ]
    }))
    const summary = store.getSummary()
    assert.ok(summary.filesChanged.includes('/src/foo.ts'))
  })

  test('deduplicates files changed', () => {
    const store = new SessionStore(mockContext())
    for (let i = 0; i < 3; i++) {
      store.addSpan(makeSpan('tool/replace_string_in_file', 't1', {
        attributes: [
          makeAttr('gen_ai.tool.name', 'replace_string_in_file'),
          makeAttr('gen_ai.tool.call.arguments', JSON.stringify({ filePath: '/src/foo.ts', oldString: 'a', newString: 'b' })),
        ]
      }))
    }
    assert.strictEqual(store.getSummary().filesChanged.length, 1)
  })

  test('clear resets all state', () => {
    const store = new SessionStore(mockContext())
    store.addSpan(makeSpan('invoke_agent', 't1'))
    store.addSpan(makeSpan('tool/read_file', 't1'))
    store.clear()
    assert.strictEqual(store.getSpans().length, 0)
    assert.strictEqual(store.getSummary().totalSpans, 0)
  })

  test('export returns spans and summary', () => {
    const store = new SessionStore(mockContext())
    store.addSpan(makeSpan('invoke_agent', 't1'))
    const data = store.export()
    assert.ok(Array.isArray(data.spans))
    assert.strictEqual(data.spans.length, 1)
    assert.ok(data.summary)
  })

  test('new store instance starts empty (persistence is via SQLite, not globalState)', () => {
    const ctx = mockContext()
    const store1 = new SessionStore(ctx)
    store1.addSpan(makeSpan('invoke_agent', 't1'))
    store1.addSpan(makeSpan('tool/read_file', 't1'))

    // Phase 3: globalState is no longer used for span persistence.
    // A new store starts with an empty in-memory window.
    const store2 = new SessionStore(ctx)
    assert.strictEqual(store2.getSpans().length, 0)
    assert.strictEqual(store2.getSummary().totalSpans, 0)
  })

  suite('span retention', () => {

    test('does not prune sessions beyond the display limit', () => {
      const store = new SessionStore(mockContext())

      for (let i = 0; i < 30; i++) {
        const traceId = `trace-${i.toString().padStart(3, '0')}`
        store.addSpan(makeSpan('invoke_agent', traceId, { spanId: `agent-${i}` }))
        store.addSpan(makeSpan('tool/read_file', traceId))
      }

      const agentSpans = store.getSpans().filter(s => s.name === 'invoke_agent')
      assert.strictEqual(agentSpans.length, 30)
      assert.strictEqual(store.getSpans().length, 60)
    })

    test('retains oldest and newest sessions', () => {
      const store = new SessionStore(mockContext())

      for (let i = 0; i < 30; i++) {
        const traceId = `trace-${i.toString().padStart(3, '0')}`
        store.addSpan(makeSpan('invoke_agent', traceId, { spanId: `agent-${i}` }))
      }

      const hasLatest = store.getSpans().some(s => s.traceId === 'trace-029')
      assert.ok(hasLatest, 'Most recent session should be retained')

      const hasOldest = store.getSpans().some(s => s.traceId === 'trace-000')
      assert.ok(hasOldest, 'Oldest session should be retained')
    })

    test('rolling window retains recently-received spans regardless of their OTLP timestamp', () => {
      // Phase 3: spans are kept in a 5-min rolling window based on receivedAt (set at ingest),
      // not on startTime (which may be historical). All spans added here get receivedAt = now.
      const store = new SessionStore(mockContext())
      const codexSessionId = 'codex:conv-long:prompt-1'

      store.addSpan(makeSpan('invoke_agent', 'copilot-trace', {
        spanId: 'copilot-root',
        attributes: [makeAttr('copilot_chat.user_request', 'copilot baseline task')],
      }))
      store.addSpan(makeSpan('codex.user_prompt', codexSessionId, {
        spanId: 'codex-prompt',
        attributes: [
          makeAttr('codex.session.id', codexSessionId),
          makeAttr('codex.conversation.id', 'conv-long'),
          makeAttr('prompt', 'long codex task'),
        ],
      }))

      for (let i = 0; i < 100; i++) {
        store.addSpan(makeSpan('codex.tool_result', codexSessionId, {
          spanId: `codex-tool-${i}`,
          attributes: [
            makeAttr('codex.session.id', codexSessionId),
            makeAttr('codex.conversation.id', 'conv-long'),
            makeAttr('tool_name', 'exec_command'),
            makeAttr('call_id', `call-${i}`),
          ],
        }))
      }

      // All spans were just added (receivedAt ≈ now) and should be in the window.
      const spans = store.getSpans()
      assert.ok(spans.length >= 100, 'recently-received spans should be retained')
      assert.ok(spans.some(s => s.spanId === 'codex-prompt'), 'codex prompt span should be retained')
      const summary = summarizeSpans(spans)
      assert.ok(summary.sessions.some(s => s.source === 'copilot'), 'copilot session should be in window')
    })
  })

  suite('long-running traces (retention by trace, not by span)', () => {
    const MIN = 60_000
    const claudeLlm = (traceId: string, i: number, extra: Span['attributes'] = []) => makeSpan('claude_code.llm_request', traceId, {
      spanId: `llm-${traceId}-${i}`,
      attributes: [makeAttr('input_tokens', 100), makeAttr('output_tokens', 10), makeAttr('model', 'claude-sonnet-4'), ...extra],
    })

    test('a >5-minute Claude run keeps every span, so the summarized card covers the whole run', () => {
      let now = 1_700_000_000_000
      const store = new SessionStore(mockContext(), () => now)
      // 20 simulated minutes, one LLM call a minute, root interaction arriving at the end.
      for (let i = 0; i < 20; i++) {
        const span = claudeLlm('long', i)
        span.parentSpanId = 'root-long'
        store.addSpan(span)
        now += MIN
      }
      store.addSpan(makeSpan('claude_code.interaction', 'long', { spanId: 'root-long' }))
      const card = summarizeSpans(store.getSpans()).sessions.find(s => s.sessionId === 'root-long')
      assert.ok(card)
      assert.strictEqual(card.totalLlmCalls, 20)
      assert.strictEqual(card.outputTokens, 200)
    })

    test('an open trace (root not yet received) survives a long quiet stretch', () => {
      let now = 1_700_000_000_000
      const store = new SessionStore(mockContext(), () => now)
      const first = claudeLlm('waiting', 0)
      first.parentSpanId = 'root-waiting'
      store.addSpan(first)
      now += 30 * MIN  // e.g. a permission prompt left unanswered
      store.addSpan(makeSpan('claude_code.tool', 'other', { spanId: 'unrelated' }))
      assert.ok(store.getSpans().some(s => s.spanId === 'llm-waiting-0'))
    })

    test('a closed, idle trace is dropped once the window has passed', () => {
      let now = 1_700_000_000_000
      const store = new SessionStore(mockContext(), () => now)
      store.addSpan(claudeLlm('done', 0))
      store.addSpan(makeSpan('claude_code.interaction', 'done', { spanId: 'root-done' }))
      now += 6 * MIN
      store.addSpan(makeSpan('invoke_agent', 'fresh', { spanId: 'fresh-root' }))
      assert.ok(!store.getSpans().some(s => s.traceId === 'done'))
      assert.ok(store.getSpans().some(s => s.traceId === 'fresh'))
    })

    test('a hard cap bounds memory even for open traces', () => {
      const store = new SessionStore(mockContext(), Date.now, 100)
      for (let i = 0; i < 2_000; i++) { store.addSpan(claudeLlm('huge', i)) }
      assert.ok(store.getSpans().length <= 100 + 1_000)
      assert.ok(store.getSpans().some(s => s.spanId === 'llm-huge-1999'), 'newest spans are kept')
    })
  })

  suite('edge cases', () => {

    test('handles span with empty attributes', () => {
      const store = new SessionStore(mockContext())
      store.addSpan(makeSpan('invoke_agent', 't1', { attributes: [] }))
      assert.strictEqual(store.getSummary().totalSpans, 1)
    })

    test('handles malformed tool call arguments JSON', () => {
      const store = new SessionStore(mockContext())
      store.addSpan(makeSpan('tool/replace_string_in_file', 't1', {
        attributes: [
          makeAttr('gen_ai.tool.name', 'replace_string_in_file'),
          makeAttr('gen_ai.tool.call.arguments', 'not valid json'),
        ]
      }))
      // Should not crash
      assert.strictEqual(store.getSummary().filesChanged.length, 0)
    })
  })
})
