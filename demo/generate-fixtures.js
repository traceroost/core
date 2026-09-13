#!/usr/bin/env node
/**
 * Generate deterministic TraceRoost fixture data.
 *
 * These fixtures use the same span shape as demo/capture.ts writes, so they can be:
 * - validated directly through summarizeSpans
 * - replayed into the standalone OTLP server with demo/replay.ts --fixture <name>
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
function flag(name, fallback) {
  const i = args.indexOf('--' + name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
function hasFlag(name) {
  return args.includes('--' + name)
}

const OUT_DIR = path.resolve(flag('dir', path.join(__dirname, 'fixtures')))
const ONLY = flag('fixture', 'all')
const LIST = hasFlag('list')
const BASE_MS = Date.parse('2026-01-01T12:00:00.000Z')

function id(label, bytes) {
  return crypto.createHash('sha256').update(label).digest('hex').slice(0, bytes * 2)
}

function nano(ms) {
  return String(BigInt(Math.round(ms)) * 1_000_000n)
}

function attr(key, value) {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  if (typeof value === 'number') return { key, value: { intValue: value } }
  return { key, value: { stringValue: String(value) } }
}

function span(opts) {
  const startMs = BASE_MS + opts.at
  const endMs = startMs + (opts.durationMs ?? 100)
  return {
    traceId: opts.traceId,
    spanId: opts.spanId,
    parentSpanId: opts.parentSpanId,
    name: opts.name,
    startTime: nano(startMs),
    endTime: nano(endMs),
    attributes: opts.attributes ?? [],
    status: opts.error
      ? { code: 2, message: opts.errorMessage ?? 'simulated error' }
      : { code: 0 },
  }
}

function durationMs(spans) {
  if (spans.length === 0) return 0
  const starts = spans.map(s => BigInt(s.startTime))
  const ends = spans.map(s => BigInt(s.endTime))
  const min = starts.reduce((a, b) => a < b ? a : b)
  const max = ends.reduce((a, b) => a > b ? a : b)
  return Number((max - min) / 1_000_000n)
}

function detectAgents(spans) {
  const agents = new Set()
  for (const s of spans) {
    if (s.name.startsWith('claude_code.')) agents.add('claude_code')
    else if (s.name === 'invoke_agent' || s.name.startsWith('chat/') || s.name.startsWith('execute_tool/')) agents.add('copilot')
    else if (s.name.startsWith('codex.') || s.attributes?.some(a => a.key === 'codex.session.id')) agents.add('codex')
  }
  return [...agents].sort()
}

function fixture(name, spans, expect) {
  return {
    name,
    capturedAt: '2026-01-01T12:00:00.000Z',
    durationMs: durationMs(spans),
    spanCount: spans.length,
    agents: detectAgents(spans),
    expect,
    spans,
  }
}

function claudeAppBuild() {
  const name = 'claude-app-build'
  const traceId = id(name + ':trace', 16)
  const rootId = id(name + ':root', 8)
  const llm1 = id(name + ':llm1', 8)
  const llm2 = id(name + ':llm2', 8)
  const llm3 = id(name + ':llm3', 8)
  const spans = [
    span({
      traceId, spanId: rootId, name: 'claude_code.interaction', at: 0, durationMs: 9200,
      attributes: [
        attr('user_prompt', 'Build a tiny task tracker API with tests'),
        attr('interaction.duration_ms', 9200),
      ],
    }),
    span({
      traceId, spanId: llm1, parentSpanId: rootId, name: 'claude_code.llm_request', at: 200, durationMs: 1200,
      attributes: [
        attr('input_tokens', 8200),
        attr('output_tokens', 520),
        attr('cache_creation_tokens', 8200),
        attr('gen_ai.request.model', 'claude-sonnet-4-6'),
        attr('stop_reason', 'tool_use'),
        attr('ttft_ms', 310),
      ],
    }),
    span({
      traceId, spanId: id(name + ':read-routes', 8), parentSpanId: llm1, name: 'claude_code.tool', at: 1500, durationMs: 160,
      attributes: [
        attr('tool_name', 'Read'),
        attr('tool_input', JSON.stringify({ file_path: 'src/server/routes.ts' })),
        attr('duration_ms', 160),
      ],
    }),
    span({
      traceId, spanId: llm2, parentSpanId: rootId, name: 'claude_code.llm_request', at: 2100, durationMs: 1500,
      attributes: [
        attr('input_tokens', 12400),
        attr('output_tokens', 780),
        attr('cache_read_tokens', 8200),
        attr('cache_creation_tokens', 4200),
        attr('gen_ai.request.model', 'claude-sonnet-4-6'),
        attr('stop_reason', 'tool_use'),
        attr('ttft_ms', 280),
      ],
    }),
    span({
      traceId, spanId: id(name + ':write-api', 8), parentSpanId: llm2, name: 'claude_code.tool', at: 3800, durationMs: 120,
      attributes: [
        attr('tool_name', 'Write'),
        attr('tool_input', JSON.stringify({ file_path: 'src/server/tasks.ts', content: 'export function createTask() {}' })),
        attr('duration_ms', 120),
      ],
    }),
    span({
      traceId, spanId: id(name + ':write-test', 8), parentSpanId: llm2, name: 'claude_code.tool', at: 4100, durationMs: 130,
      attributes: [
        attr('tool_name', 'Write'),
        attr('tool_input', JSON.stringify({ file_path: 'src/server/tasks.test.ts', content: 'test("creates tasks", () => {})' })),
        attr('duration_ms', 130),
      ],
    }),
    span({
      traceId, spanId: id(name + ':test', 8), parentSpanId: llm2, name: 'claude_code.tool', at: 4500, durationMs: 2400,
      attributes: [
        attr('tool_name', 'Bash'),
        attr('tool_input', JSON.stringify({ command: 'pnpm test -- tasks' })),
        attr('duration_ms', 2400),
      ],
    }),
    span({
      traceId, spanId: llm3, parentSpanId: rootId, name: 'claude_code.llm_request', at: 7300, durationMs: 900,
      attributes: [
        attr('input_tokens', 7600),
        attr('output_tokens', 260),
        attr('cache_read_tokens', 12400),
        attr('gen_ai.request.model', 'claude-sonnet-4-6'),
        attr('stop_reason', 'end_turn'),
        attr('ttft_ms', 190),
      ],
    }),
  ]

  return fixture(name, spans, {
    totals: { sessionCount: 1, agents: ['claude_code'] },
    sessions: [{
      source: 'claude_code',
      promptIncludes: 'task tracker API',
      minLlmCalls: 3,
      minToolCalls: 4,
      filesChangedIncludes: ['src/server/tasks.ts', 'src/server/tasks.test.ts'],
    }],
  })
}

function copilotFormValidation() {
  const name = 'copilot-form-validation'
  const traceId = id(name + ':trace', 16)
  const rootId = id(name + ':root', 8)
  const chat1 = id(name + ':chat1', 8)
  const chat2 = id(name + ':chat2', 8)
  const spans = [
    span({
      traceId, spanId: rootId, name: 'invoke_agent', at: 12_000, durationMs: 7800,
      attributes: [
        attr('copilot_chat.user_request', '<userRequest>Add client-side validation to the signup form</userRequest>'),
        attr('copilot_chat.turn_count', 2),
        attr('gen_ai.request.model', 'gpt-4o'),
        attr('gen_ai.usage.input_tokens', 15400),
        attr('gen_ai.usage.output_tokens', 940),
        attr('gen_ai.usage.cache_read.input_tokens', 7300),
      ],
    }),
    span({
      traceId, spanId: chat1, parentSpanId: rootId, name: 'chat/completions', at: 12_400, durationMs: 1700,
      attributes: [
        attr('gen_ai.request.model', 'gpt-4o'),
        attr('gen_ai.usage.input_tokens', 6900),
        attr('gen_ai.usage.output_tokens', 410),
        attr('copilot_chat.time_to_first_token', 480),
        attr('gen_ai.output.messages', JSON.stringify([{ role: 'assistant', content: [{ type: 'tool_call', name: 'read_file' }] }])),
      ],
    }),
    span({
      traceId, spanId: id(name + ':read-form', 8), parentSpanId: chat1, name: 'execute_tool/read_file', at: 14_300, durationMs: 180,
      attributes: [
        attr('gen_ai.tool.name', 'read_file'),
        attr('gen_ai.tool.call.arguments', JSON.stringify({ filePath: 'src/components/SignupForm.tsx', startLine: 1, endLine: 160 })),
        attr('gen_ai.tool.call.result', 'loaded SignupForm.tsx'),
      ],
    }),
    span({
      traceId, spanId: chat2, parentSpanId: rootId, name: 'chat/completions', at: 15_000, durationMs: 2200,
      attributes: [
        attr('gen_ai.request.model', 'gpt-4o'),
        attr('gen_ai.usage.input_tokens', 8500),
        attr('gen_ai.usage.output_tokens', 530),
        attr('copilot_chat.time_to_first_token', 510),
        attr('gen_ai.output.messages', JSON.stringify([{ role: 'assistant', content: [{ type: 'tool_call', name: 'replace_string_in_file' }] }])),
      ],
    }),
    span({
      traceId, spanId: id(name + ':edit-form', 8), parentSpanId: chat2, name: 'execute_tool/replace_string_in_file', at: 17_500, durationMs: 120,
      attributes: [
        attr('gen_ai.tool.name', 'replace_string_in_file'),
        attr('gen_ai.tool.call.arguments', JSON.stringify({
          filePath: 'src/components/SignupForm.tsx',
          oldString: 'const onSubmit = () => submit(form)',
          newString: 'const onSubmit = () => validate(form) && submit(form)',
        })),
        attr('gen_ai.tool.call.result', 'updated SignupForm.tsx'),
      ],
    }),
  ]

  return fixture(name, spans, {
    totals: { sessionCount: 1, agents: ['copilot'] },
    sessions: [{
      source: 'copilot',
      promptIncludes: 'signup form',
      minLlmCalls: 2,
      minToolCalls: 2,
      filesChangedIncludes: ['src/components/SignupForm.tsx'],
    }],
  })
}

function codexDisposeAudit() {
  const name = 'codex-dispose-audit'
  const sessionId = 'codex:codex-thread-dispose:prompt-1'
  const rawTraceId = id(name + ':raw-trace', 16)
  const promptId = id(name + ':prompt', 8)
  const callId = 'call_dispose_audit'
  const baseAttrs = [
    attr('conversation.id', 'codex-thread-dispose'),
    attr('codex.conversation.id', 'codex-thread-dispose'),
    attr('codex.session.id', sessionId),
  ]
  const spans = [
    span({
      traceId: sessionId, spanId: promptId, name: 'codex.user_prompt', at: 24_000, durationMs: 1,
      attributes: [
        ...baseAttrs,
        attr('event.name', 'codex.user_prompt'),
        attr('prompt', 'check for calls to dispose()'),
        attr('prompt_length', 28),
        attr('otel.trace_id', rawTraceId),
      ],
    }),
    span({
      traceId: sessionId, spanId: id(name + ':ttft', 8), parentSpanId: promptId, name: 'codex.turn_ttft', at: 24_600, durationMs: 1,
      attributes: [...baseAttrs, attr('event.name', 'codex.turn_ttft'), attr('duration_ms', 680)],
    }),
    span({
      traceId: sessionId, spanId: id(name + ':decision', 8), parentSpanId: promptId, name: 'codex.tool_decision', at: 25_000, durationMs: 80,
      attributes: [
        ...baseAttrs,
        attr('event.name', 'codex.tool_decision'),
        attr('tool_name', 'exec_command'),
        attr('call_id', callId),
        attr('input_token_count', 34197),
        attr('output_token_count', 432),
        attr('cached_token_count', 7600),
        attr('model', 'gpt-5.5'),
      ],
    }),
    span({
      traceId: sessionId, spanId: id(name + ':tool-result', 8), parentSpanId: promptId, name: 'codex.tool_result', at: 25_300, durationMs: 264,
      attributes: [
        ...baseAttrs,
        attr('event.name', 'codex.tool_result'),
        attr('tool_name', 'exec_command'),
        attr('call_id', callId),
        attr('arguments', JSON.stringify({ cmd: 'rg -n "\\.dispose\\(|\\bdispose\\(\\)" .' })),
        attr('output', 'Chunk ID: abc\nProcess exited with code 1\nOutput:\n'),
        attr('duration_ms', 264),
        attr('success', true),
        attr('otel.trace_id', rawTraceId),
      ],
    }),
    span({
      traceId: sessionId, spanId: id(name + ':exec-span', 8), parentSpanId: promptId, name: 'exec_command', at: 25_310, durationMs: 240,
      attributes: [
        ...baseAttrs,
        attr('otel.trace_id', rawTraceId),
        attr('cmd', 'rg -n "\\.dispose\\(|\\bdispose\\(\\)" .'),
      ],
    }),
    span({
      traceId: sessionId, spanId: id(name + ':complete', 8), parentSpanId: promptId, name: 'codex.sse_event', at: 26_000, durationMs: 1200,
      attributes: [
        ...baseAttrs,
        attr('event.name', 'codex.sse_event'),
        attr('event.kind', 'response.completed'),
        attr('input_token_count', 12500),
        attr('output_token_count', 180),
        attr('model', 'gpt-5.5'),
      ],
    }),
    span({
      traceId: sessionId, spanId: id(name + ':websocket-event', 8), parentSpanId: promptId, name: 'codex.websocket_event', at: 27_400, durationMs: 30,
      attributes: [...baseAttrs, attr('event.name', 'codex.websocket_event'), attr('event.kind', 'response.created')],
    }),
  ]

  return fixture(name, spans, {
    totals: { sessionCount: 1, agents: ['codex'] },
    sessions: [{
      source: 'codex',
      promptIncludes: 'dispose',
      minLlmCalls: 2,
      minToolCalls: 1,
      toolCounts: { exec_command: 1 },
    }],
  })
}

function claudeLoopRegression() {
  const name = 'claude-loop-regression'
  const traceId = id(name + ':trace', 16)
  const rootId = id(name + ':root', 8)
  const spans = [
    span({
      traceId, spanId: rootId, name: 'claude_code.interaction', at: 32_000, durationMs: 16000,
      attributes: [
        attr('user_prompt', 'Build and push the Docker container'),
        attr('interaction.duration_ms', 16000),
      ],
    }),
  ]

  for (let i = 0; i < 6; i++) {
    const llmId = id(`${name}:llm:${i}`, 8)
    spans.push(span({
      traceId, spanId: llmId, parentSpanId: rootId, name: 'claude_code.llm_request', at: 32_400 + i * 2300, durationMs: 900,
      attributes: [
        attr('input_tokens', 6000 + i * 3200),
        attr('output_tokens', 240 - i * 12),
        attr('cache_read_tokens', i === 0 ? 0 : 6000 + (i - 1) * 3200),
        attr('gen_ai.request.model', 'claude-sonnet-4-6'),
        attr('stop_reason', 'tool_use'),
        attr('ttft_ms', 300 + i * 40),
      ],
    }))
    spans.push(span({
      traceId, spanId: id(`${name}:bash:${i}`, 8), parentSpanId: llmId, name: 'claude_code.tool', at: 33_500 + i * 2300, durationMs: 900,
      error: true,
      errorMessage: 'docker daemon unavailable',
      attributes: [
        attr('tool_name', 'Bash'),
        attr('tool_input', JSON.stringify({ command: 'docker build -t traceroost-fixture .' })),
        attr('duration_ms', 900),
      ],
    }))
  }

  return fixture(name, spans, {
    totals: { sessionCount: 1, agents: ['claude_code'] },
    sessions: [{
      source: 'claude_code',
      promptIncludes: 'Docker container',
      minLlmCalls: 6,
      minToolCalls: 6,
      minErrors: 6,
      loopSignals: ['exact_tool_repeat', 'error_recurrence'],
    }],
  })
}

function mixedAgentMatrix() {
  const fixtures = [claudeAppBuild(), copilotFormValidation(), codexDisposeAudit()]
  const spans = fixtures.flatMap(f => f.spans)
  return fixture('agent-matrix', spans, {
    totals: { sessionCount: 3, agents: ['claude_code', 'codex', 'copilot'] },
    sessions: [
      { source: 'claude_code', promptIncludes: 'task tracker API', minLlmCalls: 3, minToolCalls: 4 },
      { source: 'copilot', promptIncludes: 'signup form', minLlmCalls: 2, minToolCalls: 2 },
      { source: 'codex', promptIncludes: 'dispose', minLlmCalls: 2, minToolCalls: 1 },
    ],
  })
}

const builders = [
  claudeAppBuild,
  copilotFormValidation,
  codexDisposeAudit,
  claudeLoopRegression,
  mixedAgentMatrix,
]

function allFixtures() {
  return builders.map(build => build())
}

function main() {
  const fixtures = allFixtures()
  if (LIST) {
    for (const f of fixtures) {
      process.stdout.write(`${f.name}\t${f.spanCount} spans\t[${f.agents.join(', ')}]\n`)
    }
    return
  }

  const selected = ONLY === 'all'
    ? fixtures
    : fixtures.filter(f => f.name === ONLY)

  if (selected.length === 0) {
    process.stderr.write(`Unknown fixture "${ONLY}". Run: node demo/generate-fixtures.js --list\n`)
    process.exit(1)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  for (const f of selected) {
    const fp = path.join(OUT_DIR, `${f.name}.json`)
    fs.writeFileSync(fp, JSON.stringify(f, null, 2) + '\n', 'utf-8')
    process.stdout.write(`[fixtures] wrote ${fp} (${f.spanCount} spans, ${f.agents.join(', ')})\n`)
  }
}

main()
