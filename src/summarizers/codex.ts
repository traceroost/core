import { Span } from '../types'
import { BackgroundSpanSummary, SessionSummaryCard, TimelineEntry } from './summarizerTypes'
import {
  getAttrInt, nanoToMs, getFirstAttr,
  isCodexPromptSpanName, isCodexToolExecSpan, isCodexLlmSpanName,
  isCodexToolDecisionSpan, isCodexToolCallSpan, isCodexToolResultSpan,
  summarizeToolResult, normalizeUserRequest, rankModelsByWeight,
} from './helpers'

// A shell command mentioning a file path doesn't mean the file was changed — `cat foo.ts`,
// `rg pattern foo.ts`, and `git diff foo.ts` are all reads. Only treat the command as a write
// when it contains one of these unambiguous write signals; otherwise the mentioned files are
// reads, not changes (this was previously always treated as a change, which is why sessions
// that only ran read-only shell commands could show files as modified).
const SHELL_WRITE_SIGNS = [
  />{1,2}(?!=)/,             // output redirection: > or >> (not >=)
  /\btee\b/,
  /\bsed\b.*(^|\s)-i\b/,     // sed -i: in-place edit (plain `sed` without -i only prints to stdout)
  /\b(mv|cp|rm|rmdir|mkdir|touch|chmod|ln)\b/,
  // git subcommands that finalize a file's state as part of the agent's work — `git add`/`commit`
  // don't rewrite the file's bytes themselves, but from a "what did this session touch" view they're
  // exactly how an edited file gets wrapped up, and are frequently the ONLY shell evidence of a file
  // touched by a tool call whose own arguments didn't carry a usable file path (e.g. a failed/atypical
  // apply_patch parse). Without these, "git add foo.ts && git commit" reads as a no-op.
  /\bgit\s+(apply|add|commit|rm|mv|restore|checkout|cherry-pick|revert|merge|rebase|stash)\b/,
  /\bpatch\b/,
  /--write\b|--fix\b/,       // prettier --write, eslint --fix, etc.
]

function shellCommandWritesFiles(cmd: string): boolean {
  return SHELL_WRITE_SIGNS.some(re => re.test(cmd))
}

export function buildCodexSessions(spans: Span[]): SessionSummaryCard[] {
  const toMs = (s: Span) => nanoToMs(s.startTime) || s.receivedAt || 0
  const codexBySession = groupCodexSpansBySession(spans)

  return Object.entries(codexBySession).map(([traceId, traceGroup]) => {
    const traceSpans = traceGroup.slice().sort((a, b) => toMs(a) - toMs(b))
    const promptSpan = traceSpans.find(s => isCodexPromptSpanName(s.name))
    const rootSpan = promptSpan || traceSpans[0]

    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreateTokens = 0
    let totalLlmCalls = 0, totalToolCalls = 0, errors = 0
    let model = ''
    const modelTokens = new Map<string, number>()
    const toolCounts: Record<string, number> = {}
    const filesRead = new Set<string>()
    const filesSearched = new Set<string>()
    const filesChanged = new Set<string>()

    // Pre-pass: index tool_decision (tool_name) and tool.call (arguments) by call_id
    // so tool_result entries can merge all three into one coherent timeline entry.
    const toolNameByCallId = new Map<string, string>()
    const toolArgsByCallId = new Map<string, string>()
    const hasCodexCompletionEvents = traceSpans.some(s => {
      if (s.name !== 'codex.sse_event') { return false }
      const { input, output } = extractCodexTokenCounts(s)
      return input > 0 || output > 0
    })
    for (const s of traceSpans) {
      const callId = getFirstAttr(s, ['call_id'])
      if (!callId) { continue }
      if (isCodexToolDecisionSpan(s.name)) {
        const n = getFirstAttr(s, ['tool_name'])
        if (n) { toolNameByCallId.set(callId, n) }
      } else if (isCodexToolCallSpan(s.name)) {
        const a = getFirstAttr(s, ['arguments'])
        if (a) { toolArgsByCallId.set(callId, a) }
      }
    }

    let lastTtftMs = 0
    const timeline: TimelineEntry[] = []
    const backgroundSpans: BackgroundSpanSummary[] = []
    for (const child of traceSpans) {
      if (promptSpan && child.spanId === promptSpan.spanId) { continue }
      if (child.name === 'codex.websocket_event') { continue }

      const childStart = nanoToMs(child.startTime)
      const childEnd = nanoToMs(child.endTime)
      const childDur = childEnd - childStart
        || getAttrInt(child, 'codex.api.duration_ms')
        || getAttrInt(child, 'codex.duration_ms')
        || getAttrInt(child, 'duration_ms')
      const isError = child.status?.code === 2
        || getFirstAttr(child, ['codex.api.success']) === 'false'
        || getFirstAttr(child, ['codex.tool.success']) === 'false'
        || getFirstAttr(child, ['success']) === 'false'
      if (isError) { errors++ }
      const ts = childStart > 0 ? new Date(childStart).toISOString() : ''

      const childModel = getFirstAttr(child, ['gen_ai.request.model', 'gen_ai.response.model', 'model'])
      if (childModel) { model = childModel }
      const effectiveModel = childModel || model

      const { input: inTok, output: outTok, cacheRead, cacheCreate } = extractCodexTokenCounts(child)

      // Real Codex captures can carry the same model usage three ways:
      // terminal codex.sse_event logs, raw handle_responses spans, and a
      // session_task.turn rollup. Prefer the terminal event stream for per-turn
      // timeline entries and avoid adding duplicate rollups to totals.
      if (hasCodexCompletionEvents && isDuplicateCodexTokenRecord(child)) {
        continue
      }

      if (isCodexToolExecSpan(child)) {
        const callId = getFirstAttr(child, ['call_id'])

        // tool_decision represents the model choosing to call a tool — it IS an LLM turn.
        // When sse_events carry tokens (hasCodexCompletionEvents), the response.completed event
        // already accounts for every turn including tool-calling ones, so skip to avoid doubling.
        if (isCodexToolDecisionSpan(child.name)) {
          if (!hasCodexCompletionEvents && (inTok > 0 || outTok > 0)) {
            totalLlmCalls++
            inputTokens += inTok
            outputTokens += outTok
            cacheReadTokens += cacheRead
            cacheCreateTokens += cacheCreate
            if (effectiveModel) {
              modelTokens.set(effectiveModel, (modelTokens.get(effectiveModel) ?? 0) + inTok + outTok + cacheRead + cacheCreate)
            }
            // tool_decision is the only per-turn record of token usage for most Codex
            // sessions (no sse_event completion stream) — without a timeline entry here,
            // charts and detectors that read session.timeline (Context Growth, token
            // runaway) never see any Codex turn, even though totals above are correct.
            const ttftMs = getAttrInt(child, 'ttft_ms') || getAttrInt(child, 'codex.ttft_ms') || lastTtftMs || 0
            lastTtftMs = 0
            timeline.push({
              type: 'llm' as const,
              spanId: child.spanId,
              label: effectiveModel || 'Codex',
              model: effectiveModel || undefined,
              inputTokens: inTok + cacheRead + cacheCreate,
              outputTokens: outTok,
              cacheReadTokens: cacheRead || undefined,
              cacheCreateTokens: cacheCreate || undefined,
              ttft: ttftMs || undefined,
              durationMs: childDur,
              isError,
              errorMessage: isError ? (child.status?.message || undefined) : undefined,
              timestamp: ts,
            })
          }
          continue
        }

        // tool.call: skip when paired with a tool_decision via call_id —
        // the corresponding tool_result will own the timeline entry and carry merged data.
        if (isCodexToolCallSpan(child.name) && callId && toolNameByCallId.has(callId)) { continue }

        totalToolCalls++

        // Resolve tool name: pre-indexed from tool_decision, then span-local attributes.
        const toolName = (callId && toolNameByCallId.get(callId))
          || getFirstAttr(child, ['tool_name', 'codex.tool.name', 'gen_ai.tool.name'])
          || 'tool'
        toolCounts[toolName] = (toolCounts[toolName] || 0) + 1

        // Resolve args: pre-indexed from tool.call, then span-local attributes.
        const argsStr = (callId && toolArgsByCallId.get(callId))
          || getFirstAttr(child, ['gen_ai.tool.call.arguments', 'tool_input', 'input', 'arguments'])

        // tool_result carries end-to-end duration; other spans use span timing.
        const dur = (isCodexToolResultSpan(child.name) ? getAttrInt(child, 'duration_ms') : 0)
          || getAttrInt(child, 'codex.tool.duration_ms')
          || childDur
        const resultText = isCodexToolResultSpan(child.name)
          ? getFirstAttr(child, ['output', 'result', 'tool_result', 'content', 'stdout', 'stderr'])
          : ''

        let foundFilePath = false
        let cmdFromArgs: string | undefined
        if (argsStr) {
          try {
            const args = JSON.parse(argsStr) as Record<string, unknown>
            // apply_patch is Codex's standard file-editing tool — its edit is a unified-diff-style
            // patch string (args.input/patch/command), not a filePath/path key, so it needs its
            // own parse: pull the file path out of each "*** Update/Add/Delete File: <path>" header.
            if (toolName === 'apply_patch') {
              const patchContent = String(args.input || args.patch || args.command || args.cmd || '')
              for (const line of patchContent.split('\n')) {
                const m = line.match(/^\*\*\*\s+(?:Update File:|Add File:|Delete File:)?\s*(.+)/)
                if (m) {
                  const patchFp = m[1].trim()
                  if (patchFp && patchFp.includes('/')) {
                    filesChanged.add(patchFp)
                    foundFilePath = true
                  }
                }
              }
            }
            const fp = args.filePath || args.file_path || args.path
            if (fp) {
              foundFilePath = true
              if (toolName === 'read_file' || toolName === 'Read') {
                filesRead.add(String(fp).split('/').pop() || String(fp))
              } else if (toolName === 'grep_search' || toolName === 'file_search' || toolName === 'Glob' || toolName === 'Grep') {
                filesSearched.add(String(args.query || args.pattern || fp))
              } else if (toolName !== 'apply_patch') {
                filesChanged.add(String(fp))
              }
            }
            // Codex shell tool: command is nested inside args JSON
            if (!foundFilePath && (args.command || args.cmd)) {
              cmdFromArgs = String(args.command || args.cmd)
            }
          } catch { /* ignore malformed args */ }
        }
        // Extract file paths from shell command string (Codex primarily uses bash)
        if (!foundFilePath) {
          const cmd = cmdFromArgs
            || getFirstAttr(child, ['cmd', 'command', 'codex.tool.cmd', 'codex.tool.command', 'shell_command'])
          if (cmd) {
            const isWrite = shellCommandWritesFiles(cmd)
            // Match absolute paths, ./relative paths, AND bare relative paths (e.g. src/file.ts)
            const fileRe = /(?:^|[\s'"<>`|])([./~]?(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|cpp|c|h|cs|php|html|css|scss|json|yaml|yml|toml|md|txt|sh|env))\b/g
            let m: RegExpExecArray | null
            while ((m = fileRe.exec(cmd)) !== null) {
              const p = m[1].replace(/['"]/g, '')
              if (p.length > 2 && !p.includes('*')) {
                if (isWrite) { filesChanged.add(p) }
                else { filesRead.add(p.split('/').pop() || p) }
              }
            }
          }
        }

        timeline.push({
          type: 'tool' as const,
          spanId: child.spanId,
          label: toolName,
          durationMs: dur,
          toolInput: argsStr || undefined,
          isError,
          errorMessage: isError
            ? (child.status?.message || getFirstAttr(child, ['error.message']) || undefined)
            : undefined,
          resultSummary: resultText ? summarizeToolResult(toolName, resultText) : undefined,
          fullResult: resultText || undefined,
          timestamp: ts,
        })
      } else if (isCodexTimelineLlmSpan(child, inTok, outTok)) {
        totalLlmCalls++
        inputTokens += inTok
        outputTokens += outTok
        cacheReadTokens += cacheRead
        cacheCreateTokens += cacheCreate
        if (effectiveModel) {
          modelTokens.set(effectiveModel, (modelTokens.get(effectiveModel) ?? 0) + inTok + outTok + cacheRead + cacheCreate)
        }
        const ttftMs = getAttrInt(child, 'ttft_ms') || getAttrInt(child, 'codex.ttft_ms') || lastTtftMs || 0
        lastTtftMs = 0
        timeline.push({
          type: 'llm' as const,
          spanId: child.spanId,
          label: effectiveModel || 'Codex',
          model: effectiveModel || undefined,
          inputTokens: inTok + cacheRead + cacheCreate,
          outputTokens: outTok,
          cacheReadTokens: cacheRead || undefined,
          cacheCreateTokens: cacheCreate || undefined,
          ttft: ttftMs || undefined,
          action: getFirstAttr(child, ['codex.event.type', 'event.kind', 'stop_reason']) || undefined,
          responseText: getFirstAttr(child, ['output_text', 'assistant_response']) || undefined,
          durationMs: childDur,
          isError,
          errorMessage: isError ? (child.status?.message || undefined) : undefined,
          timestamp: ts,
        })
      } else {
        // Capture TTFT from codex.turn_ttft so the next LLM entry can report it
        if (child.name === 'codex.turn_ttft') {
          const ttft = getAttrInt(child, 'duration_ms') || childDur
          if (ttft > 0) { lastTtftMs = ttft }
        }
        backgroundSpans.push({
          name: child.name,
          model: effectiveModel,
          purpose: child.name,
          inputTokens: inTok,
          outputTokens: outTok,
        })
      }
    }

    const conversationId = traceSpans
      .map(s => getFirstAttr(s, ['conversation.id', 'conversation_id', 'codex.conversation.id']))
      .find(v => v && v.length > 10)

    const workspace = traceSpans
      .map(s => getFirstAttr(s, ['cwd']))
      .find(v => v && v.startsWith('/')) || ''

    const startMs = rootSpan
      ? (nanoToMs(rootSpan.startTime) || rootSpan.receivedAt || 0)
      : (traceSpans[0]?.receivedAt ?? 0)
    const userPromptText = promptSpan
      ? getFirstAttr(promptSpan, [
          'user_prompt', 'prompt', 'codex.user_prompt', 'codex.prompt',
          'message', 'content', 'text', 'user_message', 'input',
          'codex.user_message', 'codex.input',
        ])
      : ''
    const promptLength = promptSpan
      ? getAttrInt(promptSpan, 'user_prompt.length') || getAttrInt(promptSpan, 'user_prompt_length') || getAttrInt(promptSpan, 'prompt_length')
      : 0
    const userRequest = normalizeUserRequest(
      userPromptText, promptLength,
      promptSpan ? '[prompt unavailable]' : '[trace in progress]',
    )

    const lastLlmEntry = [...timeline].reverse().find(e => e.type === 'llm')
    const outcome: SessionSummaryCard['outcome'] =
      lastLlmEntry?.action?.includes('fail') || lastLlmEntry?.action?.includes('cancel') ? 'unknown' :
      lastLlmEntry ? 'text_response' :
      'unknown'

    const totalInput = inputTokens
    const cacheHitRate = totalInput > 0 ? cacheReadTokens / totalInput : 0

    // Rank by token volume rather than reporting whichever model handled the last
    // call — falls back to the last-seen model attribute for in-progress sessions
    // with no measured tokens yet.
    const rankedModels = rankModelsByWeight(modelTokens)
    const primaryModel = rankedModels[0] || model
    const models = rankedModels.length > 0 ? rankedModels : (primaryModel ? [primaryModel] : [])

    const allEndTimes = traceSpans.map(s => nanoToMs(s.endTime) || s.receivedAt || 0).filter(t => t > 0)
    const endMs = allEndTimes.length > 0 ? Math.max(...allEndTimes) : startMs
    const durationMs = endMs - startMs

    return {
      sessionId: promptSpan?.spanId || `codex-${traceId}`,
      traceId,
      source: 'codex' as const,
      dataSource: 'otel' as const,
      conversationId: conversationId || undefined,
      workspace,
      userRequest,
      model: primaryModel,
      models,
      turns: totalLlmCalls,
      inputTokens: totalInput,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      cacheHitRate,
      durationMs,
      startTime: startMs > 0 ? new Date(startMs).toISOString() : '',
      filesRead: Array.from(filesRead),
      filesSearched: Array.from(filesSearched),
      filesChanged: Array.from(filesChanged),
      filesWritten: [],
      toolCounts,
      totalToolCalls,
      totalLlmCalls,
      errors,
      outcome,
      timeline,
      backgroundSpans,
      loopSignals: [],
    }
  })
}

function extractCodexTokenCounts(span: Span): { input: number; output: number; cacheRead: number; cacheCreate: number } {
  const input = getAttrInt(span, 'gen_ai.usage.input_tokens')
    || getAttrInt(span, 'input_token_count')
    || getAttrInt(span, 'input_tokens')
    || getAttrInt(span, 'prompt_tokens')
    || getAttrInt(span, 'codex.turn.token_usage.input_tokens')

  const cacheRead = getAttrInt(span, 'gen_ai.usage.cache_read.input_tokens')
    || getAttrInt(span, 'cached_token_count')
    || getAttrInt(span, 'cache_read_tokens')
    || getAttrInt(span, 'codex.turn.token_usage.cached_input_tokens')

  const cacheCreate = getAttrInt(span, 'gen_ai.usage.cache_creation.input_tokens')
    || getAttrInt(span, 'cache_creation_tokens')

  const reasoning = getAttrInt(span, 'reasoning_token_count')
    || getAttrInt(span, 'codex.usage.reasoning_output_tokens')
    || getAttrInt(span, 'codex.turn.token_usage.reasoning_output_tokens')

  const outputBase = getAttrInt(span, 'gen_ai.usage.output_tokens')
    || getAttrInt(span, 'output_token_count')
    || getAttrInt(span, 'output_tokens')
    || getAttrInt(span, 'completion_tokens')
    || getAttrInt(span, 'codex.turn.token_usage.output_tokens')

  return { input, output: outputBase + reasoning, cacheRead, cacheCreate }
}

function isDuplicateCodexTokenRecord(span: Span): boolean {
  if (span.name === 'handle_responses'
    || span.name === 'session_task.turn'
    || span.name === 'codex.turn') { return true }
  const otelName = getFirstAttr(span, ['otel.name'])
  return otelName === 'session_task.turn' || otelName === 'codex.turn'
}

function isCodexTimelineLlmSpan(span: Span, inputTokens: number, outputTokens: number): boolean {
  if (inputTokens > 0 || outputTokens > 0) { return true }
  if (!isCodexLlmSpanName(span.name)) { return false }

  if (span.name === 'codex.sse_event') {
    const kind = getFirstAttr(span, ['event.kind', 'codex.event.kind', 'codex.event.type']).toLowerCase()
    if (!kind) { return true }
    return kind === 'response.completed'
      || kind === 'response.failed'
      || kind === 'response.cancelled'
      || kind === 'response.incomplete'
  }

  // Only count exact known LLM span names without tokens; broad name.includes() matches
  // (e.g. handle_responses streaming chunks) are not real completions.
  return span.name === 'codex.completion'
    || span.name === 'codex.response'
    || span.name === 'codex.stream_event'
}

function groupCodexSpansBySession(spans: Span[]): Record<string, Span[]> {
  type WorkingGroup = { key: string; spans: Span[]; hasPrompt: boolean }

  const groups = new Map<string, WorkingGroup>()
  const currentByConversation = new Map<string, WorkingGroup>()
  const ordinalByConversation = new Map<string, number>()
  const turnSessionByRawTraceId = new Map<string, string>()
  let activePromptGroup: WorkingGroup | undefined
  let activePromptTraceId: string = ''
  const toMs = (s: Span) => nanoToMs(s.startTime) || s.receivedAt || 0

  for (const span of spans) {
    if (!span.traceId) { continue }
    const explicitSessionId = getFirstAttr(span, ['codex.session.id'])
    const rawOtelTraceId = getFirstAttr(span, ['otel.trace_id'])
    if (explicitSessionId && rawOtelTraceId) {
      turnSessionByRawTraceId.set(rawOtelTraceId, explicitSessionId)
    }
    const conversationId = getFirstAttr(span, [
      'conversation.id', 'conversation_id',
      'codex.conversation.id',
      'thread.id', 'thread_id',
      'session.id', 'session_id',
    ])
    const turnId = getFirstAttr(span, ['turn.id', 'turn_id', 'codex.turn.id'])
    if (conversationId && turnId) {
      turnSessionByRawTraceId.set(span.traceId, getFirstAttr(span, ['codex.session.id']) || `codex:${conversationId}:${turnId}`)
    }
  }

  function createGroup(key: string): WorkingGroup {
    const group = { key, spans: [], hasPrompt: false }
    groups.set(key, group)
    return group
  }

  function getGroup(key: string): WorkingGroup {
    return groups.get(key) ?? createGroup(key)
  }

  function nextPromptKey(conversationId: string): string {
    const next = (ordinalByConversation.get(conversationId) ?? 0) + 1
    ordinalByConversation.set(conversationId, next)
    return `codex:${conversationId}:prompt-${next}`
  }

  const codexSpans = spans
    .filter(span => isCodexSpan(span) || (span.traceId && turnSessionByRawTraceId.has(span.traceId)))
    .sort((a, b) => toMs(a) - toMs(b))

  for (const span of codexSpans) {
    const conversationId = getFirstAttr(span, [
      'conversation.id', 'conversation_id',
      'codex.conversation.id',
      'thread.id', 'thread_id',
      'session.id', 'session_id',
    ])
    const explicitSessionId = getFirstAttr(span, ['codex.session.id'])
    const turnId = getFirstAttr(span, ['turn.id', 'turn_id', 'codex.turn.id'])
    const isPrompt = isCodexPromptSpanName(span.name)
    const turnSessionId = (span.traceId ? turnSessionByRawTraceId.get(span.traceId) : undefined)
      || (conversationId && turnId ? (explicitSessionId || `codex:${conversationId}:${turnId}`) : undefined)

    let group: WorkingGroup | undefined

    if (isPrompt) {
      const current = conversationId ? currentByConversation.get(conversationId) : undefined
      if (turnSessionId && groups.has(turnSessionId)) {
        group = getGroup(turnSessionId)
      } else if (current && !current.hasPrompt) {
        group = current
      }
      if (!group) {
        const fallbackConversation = conversationId || span.traceId || 'unknown'
        const baseKey = explicitSessionId || turnSessionId || nextPromptKey(fallbackConversation)
        group = getGroup(baseKey)
        if (group.hasPrompt) {
          group = createGroup(nextPromptKey(fallbackConversation))
        }
      }
      group.hasPrompt = true
      if (conversationId) { currentByConversation.set(conversationId, group) }
    } else if (activePromptGroup && span.traceId === activePromptTraceId) {
      // Only absorb spans from the same OTEL trace as the prompt to avoid merging
      // spans from unrelated sessions into the last-seen prompt group.
      group = activePromptGroup
      if (conversationId) { currentByConversation.set(conversationId, group) }
    } else if (turnSessionId) {
      group = getGroup(turnSessionId)
      if (conversationId) { currentByConversation.set(conversationId, group) }
    } else if (conversationId) {
      group = currentByConversation.get(conversationId)
    }

    if (!group) {
      continue
    }

    group.spans.push(span)
    if (isPrompt) {
      activePromptGroup = group
      activePromptTraceId = span.traceId
    }
  }

  const result: Record<string, Span[]> = {}
  for (const group of groups.values()) {
    result[group.key] = group.spans
  }
  return result
}

function isCodexSpan(span: Span): boolean {
  if (span.name.startsWith('codex.')) { return true }
  if (getFirstAttr(span, ['codex.session.id'])) { return true }
  return Boolean(getFirstAttr(span, ['thread.id', 'thread_id'])
    && getFirstAttr(span, ['turn.id', 'turn_id', 'codex.turn.id']))
}
