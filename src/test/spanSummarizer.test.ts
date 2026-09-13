import * as assert from 'assert'
import { summarizeSpans } from '../spanSummarizer'
import { Span } from '../types'

// ── Test helpers ──

function makeSpan(overrides: Partial<Span> & { name: string }): Span {
  return {
    traceId: 'trace-1',
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    name: overrides.name,
    startTime: overrides.startTime ?? '1700000000000000000',
    endTime: overrides.endTime ?? '1700000001000000000',
    attributes: overrides.attributes ?? [],
    status: overrides.status,
    parentSpanId: overrides.parentSpanId,
  }
}

function makeAttr(key: string, value: string | number | boolean) {
  if (typeof value === 'string') {return { key, value: { stringValue: value } }}
  if (typeof value === 'number') {return { key, value: { intValue: value } }}
  return { key, value: { boolValue: value } }
}

function makeAgentSpan(opts: {
  traceId?: string
  spanId?: string
  userRequest?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  startTime?: string
  endTime?: string
}): Span {
  const attrs = []
  if (opts.userRequest) {attrs.push(makeAttr('copilot_chat.user_request', opts.userRequest))}
  if (opts.model) {attrs.push(makeAttr('gen_ai.request.model', opts.model))}
  if (opts.inputTokens) {attrs.push(makeAttr('gen_ai.usage.input_tokens', opts.inputTokens))}
  if (opts.outputTokens) {attrs.push(makeAttr('gen_ai.usage.output_tokens', opts.outputTokens))}
  return {
    traceId: opts.traceId ?? 'trace-1',
    spanId: opts.spanId ?? 'agent-span-1',
    name: 'invoke_agent',
    startTime: opts.startTime ?? '1700000000000000000',
    endTime: opts.endTime ?? '1700000010000000000',
    attributes: attrs,
  }
}

function makeChildSpan(parentSpanId: string, opts: {
  traceId?: string
  name: string
  startTime?: string
  endTime?: string
  attributes?: Span['attributes']
  status?: Span['status']
}): Span {
  return {
    traceId: opts.traceId ?? 'trace-1',
    spanId: 'child-' + Math.random().toString(36).slice(2, 8),
    parentSpanId,
    name: opts.name,
    startTime: opts.startTime ?? '1700000001000000000',
    endTime: opts.endTime ?? '1700000002000000000',
    attributes: opts.attributes ?? [],
    status: opts.status,
  }
}

// ── Tests ──

suite('SpanSummarizer', () => {

  suite('summarizeSpans()', () => {

    test('returns empty summary for empty array', () => {
      const result = summarizeSpans([])
      assert.strictEqual(result.sessions.length, 0)
      assert.strictEqual(result.backgroundSpans.length, 0)
      assert.strictEqual(result.efficiency.totalInputTokens, 0)
      assert.strictEqual(result.efficiency.totalOutputTokens, 0)
    })

    test('returns empty summary for null/undefined input', () => {
      const result = summarizeSpans(null as unknown as Span[])
      assert.strictEqual(result.sessions.length, 0)
      assert.strictEqual(result.efficiency.totalLlmCalls, 0)
    })

    test('creates one session per invoke_agent span', () => {
      const agent1 = makeAgentSpan({ traceId: 'trace-1', spanId: 'a1', userRequest: 'fix the bug' })
      const agent2 = makeAgentSpan({ traceId: 'trace-2', spanId: 'a2', userRequest: 'add tests' })
      const result = summarizeSpans([agent1, agent2])
      assert.strictEqual(result.sessions.length, 2)
    })

    test('extracts user request from <userRequest> tags', () => {
      const agent = makeAgentSpan({
        userRequest: '<context>foo</context><userRequest>deploy to prod</userRequest>'
      })
      const result = summarizeSpans([agent])
      assert.strictEqual(result.sessions[0].userRequest, 'deploy to prod')
    })

    test('extracts model name from attributes', () => {
      const agent = makeAgentSpan({ model: 'claude-sonnet-4-20250514' })
      const result = summarizeSpans([agent])
      assert.strictEqual(result.sessions[0].model, 'claude-sonnet-4-20250514')
    })

    test('aggregates token counts', () => {
      const agent = makeAgentSpan({
        spanId: 'a1',
        inputTokens: 5000,
        outputTokens: 1000
      })
      const result = summarizeSpans([agent])
      assert.strictEqual(result.sessions[0].inputTokens, 5000)
      assert.strictEqual(result.sessions[0].outputTokens, 1000)
    })

    test('Anthropic model: reconstructs totalInput from parts (input + cacheRead + cacheCreate)', () => {
      const agent = makeAgentSpan({ spanId: 'a-anthropic', model: 'claude-sonnet-4-6', inputTokens: 20000 })
      agent.attributes.push(makeAttr('gen_ai.usage.cache_read.input_tokens', 80000))
      const result = summarizeSpans([agent])
      const session = result.sessions[0]
      // totalInput = 20000 + 80000 = 100000; cacheHitRate = 80000/100000 = 0.8
      assert.strictEqual(session.inputTokens, 100000)
      assert.ok(Math.abs(session.cacheHitRate - 0.8) < 0.001)
    })

    test('OpenAI model: does not double-count cached tokens in totalInput', () => {
      const agent = makeAgentSpan({ spanId: 'a-openai', model: 'gpt-5.5', inputTokens: 100000 })
      agent.attributes.push(makeAttr('gen_ai.usage.cache_read.input_tokens', 80000))
      const result = summarizeSpans([agent])
      const session = result.sessions[0]
      // totalInput = 100000 (input already includes cached); cacheHitRate = 80000/100000 = 0.8
      assert.strictEqual(session.inputTokens, 100000)
      assert.ok(Math.abs(session.cacheHitRate - 0.8) < 0.001)
    })

    test('associates child spans with parent session', () => {
      const agent = makeAgentSpan({ spanId: 'a1' })
      const child = makeChildSpan('a1', {
        name: 'tool/read_file',
        attributes: [
          makeAttr('gen_ai.tool.name', 'read_file'),
          makeAttr('gen_ai.tool.call.arguments', '{"filePath":"src/test.ts","startLine":1,"endLine":10}')
        ]
      })
      const result = summarizeSpans([agent, child])
      assert.strictEqual(result.sessions.length, 1)
      assert.ok(result.sessions[0].timeline.length > 0)
    })

    test('detects error spans', () => {
      const agent = makeAgentSpan({ spanId: 'a1' })
      const child = makeChildSpan('a1', {
        name: 'tool/run_in_terminal',
        status: { code: 2, message: 'command failed' }
      })
      const result = summarizeSpans([agent, child])
      assert.strictEqual(result.sessions[0].errors, 1)
    })

    test('classifies orphan spans as background', () => {
      const orphan = makeSpan({
        name: 'telemetry_upload',
        traceId: 'orphan-trace',
      })
      const result = summarizeSpans([orphan])
      assert.strictEqual(result.sessions.length, 0)
    })

    test('computes efficiency metrics', () => {
      const agent = makeAgentSpan({
        spanId: 'a1',
        inputTokens: 10000,
        outputTokens: 500
      })
      const llm = makeChildSpan('a1', {
        name: 'chat',
        attributes: [
          makeAttr('gen_ai.usage.input_tokens', 10000),
          makeAttr('gen_ai.usage.output_tokens', 500),
        ]
      })
      const result = summarizeSpans([agent, llm])
      assert.ok(result.efficiency.totalInputTokens >= 10000)
      assert.ok(result.efficiency.totalOutputTokens >= 500)
    })

    test('computes session duration from timestamps', () => {
      const agent = makeAgentSpan({
        startTime: '1700000000000000000',
        endTime: '1700000005000000000',
      })
      const result = summarizeSpans([agent])
      assert.strictEqual(result.sessions[0].durationMs, 5000)
    })

    test('handles multiple sessions with different traceIds', () => {
      const a1 = makeAgentSpan({ traceId: 't1', spanId: 's1', userRequest: 'req1' })
      const a2 = makeAgentSpan({ traceId: 't2', spanId: 's2', userRequest: 'req2' })
      const c1 = makeChildSpan('s1', { traceId: 't1', name: 'tool/read_file' })
      const c2 = makeChildSpan('s2', { traceId: 't2', name: 'tool/grep_search' })
      const result = summarizeSpans([a1, a2, c1, c2])
      assert.strictEqual(result.sessions.length, 2)
      assert.strictEqual(result.sessions[0].traceId, 't1')
      assert.strictEqual(result.sessions[1].traceId, 't2')
    })

    test('orders mixed agent sessions chronologically with Codex receivedAt fallback', () => {
      const copilot = makeAgentSpan({
        traceId: 'mixed-copilot',
        spanId: 'mixed-copilot-root',
        userRequest: 'first copilot prompt',
        startTime: '1700000000000000000',
        endTime: '1700000001000000000',
      })
      const claude: Span = {
        traceId: 'mixed-claude',
        spanId: 'mixed-claude-root',
        name: 'claude_code.interaction',
        startTime: '1700000002000000000',
        endTime: '1700000003000000000',
        attributes: [makeAttr('user_prompt', 'second claude prompt')],
      }
      const codex: Span = {
        traceId: 'mixed-codex-raw',
        spanId: 'mixed-codex-prompt',
        name: 'codex.user_prompt',
        startTime: '0',
        endTime: '0',
        receivedAt: 1700000004000,
        attributes: [
          makeAttr('event.name', 'codex.user_prompt'),
          makeAttr('conversation.id', 'mixed-codex'),
          makeAttr('prompt', 'third codex prompt'),
        ],
      }

      const result = summarizeSpans([codex, claude, copilot])

      assert.deepStrictEqual(
        result.sessions.map(s => s.userRequest),
        ['first copilot prompt', 'second claude prompt', 'third codex prompt']
      )
      assert.deepStrictEqual(
        result.sessions.map(s => s.source),
        ['copilot', 'claude_code', 'codex']
      )
    })

    test('counts nested Copilot tool spans under chat spans', () => {
      const agent = makeAgentSpan({ traceId: 'copilot-nested', spanId: 'agent-root', userRequest: 'update signup form' })
      const chat = makeChildSpan('agent-root', {
        traceId: 'copilot-nested',
        name: 'chat/completions',
        attributes: [
          makeAttr('gen_ai.usage.input_tokens', 1000),
          makeAttr('gen_ai.usage.output_tokens', 120),
        ],
      })
      const tool = makeChildSpan(chat.spanId, {
        traceId: 'copilot-nested',
        name: 'execute_tool/replace_string_in_file',
        attributes: [
          makeAttr('gen_ai.tool.name', 'replace_string_in_file'),
          makeAttr('gen_ai.tool.call.arguments', JSON.stringify({
            filePath: 'src/components/SignupForm.tsx',
            oldString: 'submit(form)',
            newString: 'validate(form) && submit(form)',
          })),
        ],
      })

      const result = summarizeSpans([agent, chat, tool])
      const copilot = result.sessions.find(s => s.source === 'copilot')
      assert.ok(copilot)
      assert.strictEqual(copilot?.totalToolCalls, 1)
      assert.ok(copilot?.filesChanged.includes('src/components/SignupForm.tsx'))
    })

    test('recovers Copilot tool spans whose parentSpanId never resolves to the session, via traceId', () => {
      const agent = makeAgentSpan({ traceId: 'copilot-orphaned', spanId: 'agent-root-2', userRequest: 'fix the readme' })
      // parentSpanId points at a span that doesn't exist anywhere in this payload — a real-world
      // gap between how Copilot assigns parent IDs and where the root invoke_agent span actually
      // ends up, distinct from the already-handled in-progress case (spanSummarizer.ts:91-134).
      const tool = makeChildSpan('some-parent-id-that-was-never-captured', {
        traceId: 'copilot-orphaned',
        name: 'execute_tool/replace_string_in_file',
        attributes: [
          makeAttr('gen_ai.tool.name', 'replace_string_in_file'),
          makeAttr('gen_ai.tool.call.arguments', JSON.stringify({ filePath: 'README.md' })),
        ],
      })

      const result = summarizeSpans([agent, tool])
      const copilot = result.sessions.find(s => s.source === 'copilot')
      assert.ok(copilot)
      assert.strictEqual(copilot?.totalToolCalls, 1)
      assert.ok(copilot?.filesChanged.includes('README.md'))
    })

    test('does not guess which session owns orphaned spans when a trace has more than one Copilot session', () => {
      const agentA = makeAgentSpan({ traceId: 'copilot-ambiguous', spanId: 'agent-a', userRequest: 'first request' })
      const agentB = makeAgentSpan({ traceId: 'copilot-ambiguous', spanId: 'agent-b', userRequest: 'second request' })
      const tool = makeChildSpan('missing-parent', {
        traceId: 'copilot-ambiguous',
        name: 'execute_tool/replace_string_in_file',
        attributes: [
          makeAttr('gen_ai.tool.name', 'replace_string_in_file'),
          makeAttr('gen_ai.tool.call.arguments', JSON.stringify({ filePath: 'README.md' })),
        ],
      })

      const result = summarizeSpans([agentA, agentB, tool])
      const sessions = result.sessions.filter(s => s.source === 'copilot')
      assert.strictEqual(sessions.length, 2)
      assert.ok(sessions.every(s => s.totalToolCalls === 0))
    })
  })

  suite('edge cases', () => {

    test('handles spans with no attributes', () => {
      const agent = makeAgentSpan({ spanId: 'a1' })
      agent.attributes = []
      const result = summarizeSpans([agent])
      assert.strictEqual(result.sessions.length, 1)
      assert.strictEqual(result.sessions[0].inputTokens, 0)
    })

    test('handles spans with zero timestamps', () => {
      const agent = makeAgentSpan({
        startTime: '0',
        endTime: '0'
      })
      const result = summarizeSpans([agent])
      assert.strictEqual(result.sessions[0].durationMs, 0)
    })

    test('handles very large span counts without crashing', () => {
      const spans: Span[] = []
      const agent = makeAgentSpan({ spanId: 'a1' })
      spans.push(agent)
      for (let i = 0; i < 500; i++) {
        spans.push(makeChildSpan('a1', { name: `tool/step_${i}` }))
      }
      const result = summarizeSpans(spans)
      assert.strictEqual(result.sessions.length, 1)
    })

    test('builds codex session from non-default codex prompt span names', () => {
      const spans: Span[] = [
        makeSpan({
          traceId: 'codex-trace-1',
          spanId: 'cx-root',
          name: 'codex.prompt',
          attributes: [
            makeAttr('prompt', 'Refactor session store pruning'),
          ],
        }),
        makeSpan({
          traceId: 'codex-trace-1',
          spanId: 'cx-llm',
          name: 'codex.response',
          attributes: [
            makeAttr('gen_ai.request.model', 'codex-mini'),
            makeAttr('gen_ai.usage.input_tokens', 200),
            makeAttr('gen_ai.usage.output_tokens', 40),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codex = result.sessions.find(s => s.source === 'codex')
      assert.ok(codex)
      assert.strictEqual(codex?.userRequest, 'Refactor session store pruning')
      assert.strictEqual(codex?.totalLlmCalls, 1)
      assert.strictEqual(codex?.inputTokens, 200)
      assert.strictEqual(codex?.outputTokens, 40)
    })

    test('codex: reports the token-weighted dominant model and includes cache tokens in per-entry inputTokens', () => {
      const root = makeSpan({
        name: 'codex.prompt',
        attributes: [makeAttr('prompt', 'Investigate flaky test')],
      })
      const heavyCall = makeSpan({
        traceId: root.traceId,
        name: 'codex.response',
        attributes: [
          makeAttr('gen_ai.request.model', 'gpt-5.4'),
          makeAttr('gen_ai.usage.input_tokens', 4000),
          makeAttr('gen_ai.usage.cache_read.input_tokens', 500),
          makeAttr('gen_ai.usage.output_tokens', 800),
        ],
      })
      const lightCall = makeSpan({
        traceId: root.traceId,
        name: 'codex.response',
        attributes: [
          makeAttr('gen_ai.request.model', 'gpt-5.4-mini'),
          makeAttr('gen_ai.usage.input_tokens', 30),
          makeAttr('gen_ai.usage.output_tokens', 10),
        ],
      })

      const result = summarizeSpans([root, heavyCall, lightCall])
      const codex = result.sessions.find(s => s.source === 'codex')
      assert.strictEqual(codex?.model, 'gpt-5.4')
      assert.deepStrictEqual(codex?.models, ['gpt-5.4', 'gpt-5.4-mini'])
      const heavyEntry = codex?.timeline.find(e => e.spanId === heavyCall.spanId)
      assert.strictEqual(heavyEntry?.inputTokens, 4500, 'per-entry inputTokens should include cache read tokens')
      assert.strictEqual(heavyEntry?.cacheReadTokens, 500)
    })

    test('flags Claude write sessions when telemetry omits changed-file paths', () => {
      const spans: Span[] = [
        makeSpan({
          traceId: 'claude-trace-1',
          spanId: 'cl-root',
          name: 'claude_code.interaction',
          attributes: [
            makeAttr('user_prompt', 'Update dashboard copy'),
            makeAttr('interaction.duration_ms', 1000),
          ],
        }),
        makeSpan({
          traceId: 'claude-trace-1',
          spanId: 'cl-tool',
          parentSpanId: 'cl-root',
          name: 'claude_code.tool',
          attributes: [
            makeAttr('tool_name', 'Edit'),
            makeAttr('duration_ms', 4),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const claude = result.sessions.find(s => s.source === 'claude_code')
      assert.ok(claude)
      assert.deepStrictEqual(claude?.filesChanged, [])
      assert.ok(claude?.filesChangedNote?.includes('Changed-file paths are unavailable'))
      assert.ok(claude?.filesChangedNote?.includes('tool arguments'))
    })

    test('reports the token-weighted dominant model, not whichever model answered last', () => {
      const root = makeSpan({
        name: 'claude_code.interaction',
        attributes: [makeAttr('user_prompt', 'Refactor auth module')],
      })
      const heavyCall = makeChildSpan(root.spanId, {
        traceId: root.traceId,
        name: 'claude_code.llm_request',
        attributes: [
          makeAttr('gen_ai.request.model', 'claude-opus-4'),
          makeAttr('gen_ai.usage.input_tokens', 5000),
          makeAttr('gen_ai.usage.output_tokens', 1000),
        ],
      })
      // A cheap subagent call that happens to be the LAST one processed — under the
      // old "last write wins" logic this alone would have been reported as the
      // session's model, even though it did a fraction of the actual work.
      const lightSubagentCall = makeChildSpan(root.spanId, {
        traceId: root.traceId,
        name: 'claude_code.llm_request',
        attributes: [
          makeAttr('gen_ai.request.model', 'claude-haiku-4-5'),
          makeAttr('gen_ai.usage.input_tokens', 50),
          makeAttr('gen_ai.usage.output_tokens', 20),
        ],
      })
      const result = summarizeSpans([root, heavyCall, lightSubagentCall])
      const claude = result.sessions.find(s => s.source === 'claude_code')
      assert.strictEqual(claude?.model, 'claude-opus-4')
      assert.deepStrictEqual(claude?.models, ['claude-opus-4', 'claude-haiku-4-5'])
    })

    test('groups codex timeline by trace and captures tool spans', () => {
      const spans: Span[] = [
        makeSpan({
          traceId: 'codex-trace-2',
          spanId: 'cx-root-2',
          name: 'codex.user_message',
          attributes: [makeAttr('user_prompt', 'Update dashboard latency view')],
        }),
        makeSpan({
          traceId: 'codex-trace-2',
          spanId: 'cx-tool-2',
          name: 'codex.tool',
          attributes: [
            makeAttr('codex.tool.name', 'read_file'),
            makeAttr('gen_ai.tool.call.arguments', '{"filePath":"src/fullDashboardPanel.ts"}'),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codex = result.sessions.find(s => s.source === 'codex')
      assert.ok(codex)
      assert.strictEqual(codex?.totalToolCalls, 1)
      assert.ok((codex?.timeline || []).some(t => t.type === 'tool'))
      assert.ok((codex?.filesRead || []).includes('fullDashboardPanel.ts'))
    })

    test('extracts file paths from Codex apply_patch unified-diff arguments', () => {
      const patch = [
        '*** Begin Patch',
        '*** Update File: src/summarizers/codex.ts',
        '@@',
        '-old line',
        '+new line',
        '*** Add File: src/newThing.ts',
        '+created',
        '*** End Patch',
      ].join('\n')
      const spans: Span[] = [
        makeSpan({
          traceId: 'codex-apply-patch-trace',
          spanId: 'cx-root-3',
          name: 'codex.user_message',
          attributes: [makeAttr('user_prompt', 'Fix the summarizer')],
        }),
        makeSpan({
          traceId: 'codex-apply-patch-trace',
          spanId: 'cx-tool-3',
          name: 'codex.tool_result',
          attributes: [
            makeAttr('tool_name', 'apply_patch'),
            makeAttr('arguments', JSON.stringify({ input: patch })),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codex = result.sessions.find(s => s.source === 'codex')
      assert.ok(codex)
      assert.deepStrictEqual(codex?.filesChanged.sort(), ['src/newThing.ts', 'src/summarizers/codex.ts'])
    })

    test('treats a read-only shell command as a file read, not a change', () => {
      const spans: Span[] = [
        makeSpan({
          traceId: 'codex-shell-read-trace',
          name: 'codex.user_message',
          attributes: [makeAttr('user_prompt', 'Where is dispose() defined?')],
        }),
        makeSpan({
          traceId: 'codex-shell-read-trace',
          name: 'codex.tool_result',
          attributes: [
            makeAttr('tool_name', 'exec_command'),
            makeAttr('arguments', JSON.stringify({ cmd: 'rg -n "dispose\\(\\)" src/foo.ts' })),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codex = result.sessions.find(s => s.source === 'codex')
      assert.ok(codex)
      assert.deepStrictEqual(codex?.filesChanged, [])
      assert.ok(codex?.filesRead.includes('foo.ts'))
    })

    test('treats a shell command with an explicit write signal as a file change', () => {
      const spans: Span[] = [
        makeSpan({
          traceId: 'codex-shell-write-trace',
          name: 'codex.user_message',
          attributes: [makeAttr('user_prompt', 'Fix the typo in-place')],
        }),
        makeSpan({
          traceId: 'codex-shell-write-trace',
          name: 'codex.tool_result',
          attributes: [
            makeAttr('tool_name', 'exec_command'),
            makeAttr('arguments', JSON.stringify({ cmd: "sed -i 's/teh/the/' src/foo.ts" })),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codex = result.sessions.find(s => s.source === 'codex')
      assert.ok(codex)
      assert.deepStrictEqual(codex?.filesChanged, ['src/foo.ts'])
      assert.deepStrictEqual(codex?.filesRead, [])
    })

    test('treats output redirection into a file as a change', () => {
      const spans: Span[] = [
        makeSpan({
          traceId: 'codex-shell-redirect-trace',
          name: 'codex.user_message',
          attributes: [makeAttr('user_prompt', 'Write the log to a file')],
        }),
        makeSpan({
          traceId: 'codex-shell-redirect-trace',
          name: 'codex.tool_result',
          attributes: [
            makeAttr('tool_name', 'exec_command'),
            makeAttr('arguments', JSON.stringify({ cmd: 'echo "done" > src/status.txt' })),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codex = result.sessions.find(s => s.source === 'codex')
      assert.ok(codex)
      assert.deepStrictEqual(codex?.filesChanged, ['src/status.txt'])
    })

    test('treats "git add && git commit" as a file change, not a read', () => {
      // Regression: git add/commit don't rewrite the file's bytes, but they're exactly how an
      // agent finalizes an already-edited file, and are frequently the only shell evidence of a
      // touched file when the tool call that actually wrote it didn't parse cleanly. Real-world
      // command captured from a user report of files wrongly showing up as reads.
      const spans: Span[] = [
        makeSpan({
          traceId: 'codex-shell-git-commit-trace',
          name: 'codex.user_message',
          attributes: [makeAttr('user_prompt', 'Commit the fix')],
        }),
        makeSpan({
          traceId: 'codex-shell-git-commit-trace',
          name: 'codex.tool_result',
          attributes: [
            makeAttr('tool_name', 'exec_command'),
            makeAttr('arguments', JSON.stringify({
              cmd: 'git add src/foo.ts && git commit --amend --no-edit && git status --short',
            })),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codex = result.sessions.find(s => s.source === 'codex')
      assert.ok(codex)
      assert.deepStrictEqual(codex?.filesChanged, ['src/foo.ts'])
      assert.deepStrictEqual(codex?.filesRead, [])
    })

    test('shows Codex tool_result output on the summary tool step', () => {
      const spans: Span[] = [
        makeSpan({
          traceId: 'codex-tool-result-trace',
          name: 'codex.user_prompt',
          attributes: [
            makeAttr('conversation.id', 'codex-tool-result-conversation'),
            makeAttr('prompt', 'Run command'),
          ],
        }),
        makeSpan({
          traceId: 'codex-tool-result-trace',
          name: 'codex.tool_result',
          attributes: [
            makeAttr('conversation.id', 'codex-tool-result-conversation'),
            makeAttr('tool_name', 'exec_command'),
            makeAttr('arguments', '{"cmd":"rg -n \\"dispose\\\\(\\\\)\\" ."}'),
            makeAttr('output', 'Chunk ID: abc\nProcess exited with code 1\nOutput:\n'),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codex = result.sessions.find(s => s.source === 'codex')
      const toolStep = codex?.timeline.find(t => t.type === 'tool')
      assert.ok(toolStep)
      assert.strictEqual(toolStep?.label, 'exec_command')
      assert.ok(toolStep?.fullResult?.includes('Process exited with code 1'))
      assert.ok(toolStep?.resultSummary)
    })

    test('moves Codex background spans from summary timeline to background overhead', () => {
      const attrs = (eventName: string, extra: Span['attributes'] = []) => [
        makeAttr('event.name', eventName),
        makeAttr('conversation.id', 'codex-background-conversation'),
        ...extra,
      ]
      const spans: Span[] = [
        makeSpan({
          traceId: 'codex-background-trace',
          name: 'codex.user_prompt',
          attributes: attrs('codex.user_prompt', [makeAttr('prompt', 'Check summary background rows')]),
        }),
        makeSpan({
          traceId: 'codex-background-trace',
          name: 'codex.startup_phase',
          attributes: attrs('codex.startup_phase', [
            makeAttr('startup.phase', 'startup_prewarm_create_turn_context'),
            makeAttr('duration_ms', 10),
          ]),
        }),
        makeSpan({
          traceId: 'codex-background-trace',
          name: 'codex.turn_ttft',
          attributes: attrs('codex.turn_ttft', [makeAttr('duration_ms', 123)]),
        }),
        makeSpan({
          traceId: 'codex-background-trace',
          name: 'codex.websocket_event',
          attributes: attrs('codex.websocket_event', [makeAttr('event.kind', 'response.created')]),
        }),
        makeSpan({
          traceId: 'codex-background-trace',
          name: 'codex.sse_event',
          attributes: attrs('codex.sse_event', [
            makeAttr('input_token_count', 10),
            makeAttr('output_token_count', 2),
          ]),
        }),
      ]

      const result = summarizeSpans(spans)
      const codex = result.sessions.find(s => s.source === 'codex')
      assert.ok(codex)
      assert.ok((codex?.timeline || []).every(t => t.type !== 'background'))
      assert.ok((codex?.timeline || []).some(t => t.type === 'llm' && t.ttft === 123))
      assert.ok((codex?.backgroundSpans || []).some(bg => bg.name === 'codex.startup_phase'))
      assert.ok((codex?.backgroundSpans || []).some(bg => bg.name === 'codex.turn_ttft'))
      assert.ok(result.backgroundSpans.some(bg => bg.name === 'codex.startup_phase'))
      assert.ok(result.backgroundSpans.some(bg => bg.name === 'codex.turn_ttft'))
      assert.ok(!result.backgroundSpans.some(bg => bg.name === 'codex.websocket_event'))
    })

    test('keeps Codex SSE progress events out of the LLM timeline', () => {
      const attrs = (eventKind: string) => [
        makeAttr('event.name', 'codex.sse_event'),
        makeAttr('conversation.id', 'codex-sse-noise-conversation'),
        makeAttr('event.kind', eventKind),
      ]
      const spans: Span[] = [
        makeSpan({
          traceId: 'codex-sse-noise-trace',
          name: 'codex.user_prompt',
          attributes: [
            makeAttr('event.name', 'codex.user_prompt'),
            makeAttr('conversation.id', 'codex-sse-noise-conversation'),
            makeAttr('prompt', 'Make the flow graph readable'),
          ],
        }),
        makeSpan({
          traceId: 'codex-sse-noise-trace',
          name: 'codex.sse_event',
          attributes: attrs('response.created'),
        }),
        makeSpan({
          traceId: 'codex-sse-noise-trace',
          name: 'codex.sse_event',
          attributes: attrs('response.output_text.delta'),
        }),
        makeSpan({
          traceId: 'codex-sse-noise-trace',
          name: 'codex.sse_event',
          attributes: attrs('response.completed'),
        }),
      ]

      const result = summarizeSpans(spans)
      const codex = result.sessions.find(s => s.source === 'codex')
      assert.ok(codex)
      assert.strictEqual((codex?.timeline || []).filter(t => t.type === 'llm').length, 1)
      assert.strictEqual(codex?.timeline.find(t => t.type === 'llm')?.action, 'response.completed')
      assert.strictEqual(codex?.totalLlmCalls, 1)
      assert.strictEqual((codex?.backgroundSpans || []).filter(bg => bg.name === 'codex.sse_event').length, 2)
    })

    test('keeps one Codex prompt together even when OTEL trace IDs differ', () => {
      const attrs = (eventName: string, extra: Span['attributes'] = []) => [
        makeAttr('event.name', eventName),
        makeAttr('conversation.id', 'codex-conversation-1'),
        ...extra,
      ]
      const spans: Span[] = [
        makeSpan({
          traceId: 'otel-trace-a',
          spanId: 'prompt-1',
          name: 'codex.user_prompt',
          startTime: '1700000000000000000',
          endTime: '1700000000000000000',
          attributes: attrs('codex.user_prompt', [makeAttr('prompt', 'Fix Codex trace grouping')]),
        }),
        makeSpan({
          traceId: 'otel-trace-b',
          spanId: 'llm-1',
          name: 'codex.sse_event',
          startTime: '1700000001000000000',
          endTime: '1700000002000000000',
          attributes: attrs('codex.sse_event', [
            makeAttr('event.kind', 'response.completed'),
            makeAttr('input_token_count', 100),
            makeAttr('output_token_count', 20),
          ]),
        }),
        makeSpan({
          traceId: 'otel-trace-c',
          spanId: 'tool-1',
          name: 'codex.tool_result',
          startTime: '1700000003000000000',
          endTime: '1700000004000000000',
          attributes: attrs('codex.tool_result', [
            makeAttr('tool_name', 'shell_command'),
            makeAttr('call_id', 'call-1'),
            makeAttr('arguments', '{"command":"pnpm test"}'),
          ]),
        }),
      ]

      const result = summarizeSpans(spans)
      const codexSessions = result.sessions.filter(s => s.source === 'codex')
      assert.strictEqual(codexSessions.length, 1)
      assert.strictEqual(codexSessions[0].userRequest, 'Fix Codex trace grouping')
      assert.strictEqual(codexSessions[0].totalLlmCalls, 1)
      assert.strictEqual(codexSessions[0].totalToolCalls, 1)
    })

    test('does not split one Codex prompt when startup and child turns use separate session IDs', () => {
      const spans: Span[] = [
        makeSpan({
          traceId: 'startup-trace',
          spanId: 'startup',
          name: 'codex.conversation_starts',
          startTime: '1700000000000000000',
          endTime: '1700000000000000000',
          attributes: [
            makeAttr('event.name', 'codex.conversation_starts'),
            makeAttr('conversation.id', 'conv-main'),
            makeAttr('codex.session.id', 'codex:conv-main:prompt-1'),
          ],
        }),
        makeSpan({
          traceId: 'prewarm-trace',
          spanId: 'prewarm',
          name: 'codex.sse_event',
          startTime: '1700000001000000000',
          endTime: '1700000002000000000',
          attributes: [
            makeAttr('event.name', 'codex.sse_event'),
            makeAttr('conversation.id', 'conv-main'),
            makeAttr('event.kind', 'response.completed'),
            makeAttr('input_token_count', 20475),
          ],
        }),
        makeSpan({
          traceId: 'prompt-trace',
          spanId: 'prompt',
          name: 'codex.user_prompt',
          startTime: '1700000020000000000',
          endTime: '1700000020000000000',
          attributes: [
            makeAttr('event.name', 'codex.user_prompt'),
            makeAttr('conversation.id', 'conv-main'),
            makeAttr('prompt', 'check for calls to dispose()'),
            makeAttr('codex.session.id', 'codex:conv-main:turn-main'),
          ],
        }),
        makeSpan({
          traceId: 'tool-trace',
          spanId: 'tool',
          name: 'codex.tool_result',
          startTime: '1700000025000000000',
          endTime: '1700000026000000000',
          attributes: [
            makeAttr('event.name', 'codex.tool_result'),
            makeAttr('conversation.id', 'conv-main'),
            makeAttr('tool_name', 'exec_command'),
            makeAttr('arguments', '{"cmd":"rg -n \\"dispose\\\\(\\\\)\\" ."}'),
            makeAttr('codex.session.id', 'codex:conv-main:turn-main'),
          ],
        }),
        makeSpan({
          traceId: 'child-trace',
          spanId: 'child-llm',
          name: 'codex.sse_event',
          startTime: '1700000028000000000',
          endTime: '1700000031000000000',
          attributes: [
            makeAttr('event.name', 'codex.sse_event'),
            makeAttr('conversation.id', 'conv-child'),
            makeAttr('event.kind', 'response.completed'),
            makeAttr('input_token_count', 241262),
            makeAttr('output_token_count', 2096),
            makeAttr('codex.session.id', 'codex:conv-child:turn-child'),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codexSessions = result.sessions.filter(s => s.source === 'codex')
      assert.strictEqual(codexSessions.length, 1)
      assert.strictEqual(codexSessions[0].userRequest, 'check for calls to dispose()')
      assert.strictEqual(codexSessions[0].totalLlmCalls, 1)
      assert.strictEqual(codexSessions[0].totalToolCalls, 1)
      assert.strictEqual(codexSessions[0].inputTokens, 241262)
    })

    test('starts a new Codex session for each user prompt in the same conversation', () => {
      const attrs = (eventName: string, prompt: string) => [
        makeAttr('event.name', eventName),
        makeAttr('conversation.id', 'codex-conversation-2'),
        makeAttr('prompt', prompt),
      ]
      const spans: Span[] = [
        makeSpan({
          traceId: 'shared-conversation',
          spanId: 'prompt-a',
          name: 'codex.user_prompt',
          startTime: '1700000000000000000',
          endTime: '1700000000000000000',
          attributes: attrs('codex.user_prompt', 'First prompt'),
        }),
        makeSpan({
          traceId: 'shared-conversation',
          spanId: 'first-response',
          name: 'codex.sse_event',
          startTime: '1700000001000000000',
          endTime: '1700000002000000000',
          attributes: [
            makeAttr('event.name', 'codex.sse_event'),
            makeAttr('conversation.id', 'codex-conversation-2'),
            makeAttr('event.kind', 'response.completed'),
          ],
        }),
        makeSpan({
          traceId: 'shared-conversation',
          spanId: 'prompt-b',
          name: 'codex.user_prompt',
          startTime: '1700000010000000000',
          endTime: '1700000010000000000',
          attributes: attrs('codex.user_prompt', 'Second prompt'),
        }),
      ]

      const result = summarizeSpans(spans)
      const codexSessions = result.sessions.filter(s => s.source === 'codex')
      assert.strictEqual(codexSessions.length, 2)
      assert.deepStrictEqual(codexSessions.map(s => s.userRequest), ['First prompt', 'Second prompt'])
    })

    test('extracts the typed Codex request from IDE context wrappers', () => {
      const wrappedPrompt = [
        '# Context from my IDE setup:',
        '',
        '## Open tabs:',
        '- LICENSE: LICENSE',
        '- esbuild.js: esbuild.js',
        '',
        '## My request for Codex:',
        '',
        'codex sessions should show the prompt I typed',
      ].join('\n')
      const spans: Span[] = [
        makeSpan({
          traceId: 'codex-ide-context',
          spanId: 'prompt-with-context',
          name: 'codex.user_prompt',
          attributes: [
            makeAttr('event.name', 'codex.user_prompt'),
            makeAttr('conversation.id', 'codex-ide-context-conv'),
            makeAttr('prompt', wrappedPrompt),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codexSessions = result.sessions.filter(s => s.source === 'codex')
      assert.strictEqual(codexSessions.length, 1)
      assert.strictEqual(codexSessions[0].userRequest, 'codex sessions should show the prompt I typed')
    })

    test('shows in-progress Codex session from trace spans before prompt log arrives', () => {
      const spans: Span[] = [
        makeSpan({
          traceId: 'raw-trace-1',
          spanId: 'turn-span',
          name: 'turn',
          attributes: [
            makeAttr('thread.id', 'thread-123'),
            makeAttr('turn.id', 'turn-abc'),
            makeAttr('otel.name', 'session_task.turn'),
          ],
        }),
        makeSpan({
          traceId: 'raw-trace-1',
          spanId: 'llm-span',
          parentSpanId: 'turn-span',
          name: 'handle_responses',
          attributes: [
            makeAttr('thread.id', 'thread-123'),
            makeAttr('turn.id', 'turn-abc'),
            makeAttr('gen_ai.usage.input_tokens', 10),
            makeAttr('gen_ai.usage.output_tokens', 2),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codexSessions = result.sessions.filter(s => s.source === 'codex')
      assert.strictEqual(codexSessions.length, 1)
      assert.strictEqual(codexSessions[0].traceId, 'codex:thread-123:turn-abc')
      assert.strictEqual(codexSessions[0].userRequest, '[trace in progress]')
      assert.strictEqual(codexSessions[0].totalLlmCalls, 1)
    })

    test('joins Codex log events to trace spans using the raw OTEL trace ID', () => {
      const spans: Span[] = [
        makeSpan({
          traceId: 'raw-turn-trace',
          spanId: 'turn-span',
          name: 'turn',
          attributes: [
            makeAttr('thread.id', 'thread-join'),
            makeAttr('turn.id', 'turn-join'),
            makeAttr('otel.name', 'session_task.turn'),
          ],
        }),
        makeSpan({
          traceId: 'raw-turn-trace',
          spanId: 'prompt-span',
          name: 'codex.user_prompt',
          attributes: [
            makeAttr('conversation.id', 'thread-join'),
            makeAttr('prompt', 'Join trace and log spans'),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codexSessions = result.sessions.filter(s => s.source === 'codex')
      assert.strictEqual(codexSessions.length, 1)
      assert.strictEqual(codexSessions[0].traceId, 'codex:thread-join:turn-join')
      assert.strictEqual(codexSessions[0].userRequest, 'Join trace and log spans')
    })

    test('deduplicates Codex model token records from logs and raw response spans', () => {
      const spans: Span[] = [
        makeSpan({
          traceId: 'raw-turn-trace',
          spanId: 'prompt-span',
          name: 'codex.user_prompt',
          attributes: [
            makeAttr('conversation.id', 'thread-token'),
            makeAttr('prompt', 'Count Codex tokens once'),
          ],
        }),
        makeSpan({
          traceId: 'conversation-trace',
          spanId: 'sse-complete',
          name: 'codex.sse_event',
          attributes: [
            makeAttr('conversation.id', 'thread-token'),
            makeAttr('event.kind', 'response.completed'),
            makeAttr('input_token_count', 100),
            makeAttr('cached_token_count', 80),
            makeAttr('output_token_count', 10),
            makeAttr('reasoning_token_count', 5),
          ],
        }),
        makeSpan({
          traceId: 'raw-turn-trace',
          spanId: 'turn-rollup',
          parentSpanId: 'prompt-span',
          name: 'session_task.turn',
          attributes: [
            makeAttr('thread.id', 'thread-token'),
            makeAttr('turn.id', 'turn-token'),
            makeAttr('codex.turn.token_usage.input_tokens', 100),
            makeAttr('codex.turn.token_usage.cached_input_tokens', 80),
            makeAttr('codex.turn.token_usage.output_tokens', 10),
            makeAttr('codex.turn.token_usage.reasoning_output_tokens', 5),
          ],
        }),
        makeSpan({
          traceId: 'raw-turn-trace',
          spanId: 'raw-response',
          parentSpanId: 'turn-rollup',
          name: 'handle_responses',
          attributes: [
            makeAttr('thread.id', 'thread-token'),
            makeAttr('turn.id', 'turn-token'),
            makeAttr('gen_ai.usage.input_tokens', 100),
            makeAttr('gen_ai.usage.cache_read.input_tokens', 80),
            makeAttr('gen_ai.usage.output_tokens', 10),
            makeAttr('codex.usage.reasoning_output_tokens', 5),
          ],
        }),
      ]

      const result = summarizeSpans(spans)
      const codex = result.sessions.find(s => s.source === 'codex')
      assert.ok(codex)
      assert.strictEqual(codex.inputTokens, 100)
      assert.strictEqual(codex.outputTokens, 15)
      assert.strictEqual(codex.cacheReadTokens, 80)
      assert.strictEqual(codex.totalLlmCalls, 1)
      assert.strictEqual(codex.timeline.filter(e => e.type === 'llm').length, 1)
    })
  })
})
