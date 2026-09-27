import { Span } from '../types'
import { SessionSummaryCard, TimelineEntry, EditDetail } from './summarizerTypes'
import {
  getAttrStr, getAttrInt, nanoToMs, extractUserRequest,
  summarizeToolArgs, summarizeToolResult, extractResponseText, detectOutputAction,
  extractTokenCounts, getGenAiModel, rankModelsByWeight,
} from './helpers'

export function buildCopilotSessions(
  invokeAgentSpans: Span[],
  childrenOf: Record<string, Span[]>,
  spansByTraceId: Record<string, Span[]> = {}
): SessionSummaryCard[] {
  // How many invoke_agent spans share each traceId — used below to guard the orphan fallback,
  // since attributing orphaned children by traceId alone would be ambiguous if a trace ever
  // legitimately contains more than one Copilot session.
  const invokeAgentCountByTrace = new Map<string, number>()
  for (const a of invokeAgentSpans) {
    if (!a.traceId) { continue }
    invokeAgentCountByTrace.set(a.traceId, (invokeAgentCountByTrace.get(a.traceId) ?? 0) + 1)
  }

  return invokeAgentSpans.map(agent => {
    let children = collectDescendants(agent.spanId, childrenOf)

    // Some real Copilot sessions report a normal invoke_agent span (correct turns/tokens/prompt)
    // but its chat/execute_tool children carry a parentSpanId that never resolves back to it —
    // collectDescendants then finds nothing, so tools/files/timeline all read empty even though
    // the session clearly did work. This mirrors a parent-linking gap already known to affect
    // in-progress Copilot sessions (see the orphan-parent synthesis in spanSummarizer.ts) — this
    // is the completed-session sibling of that same class of bug. Fall back to every same-trace
    // span that looks like a Copilot child, but only when the strict parent chain found nothing
    // and the trace unambiguously belongs to this one session.
    if (children.length === 0 && agent.traceId && invokeAgentCountByTrace.get(agent.traceId) === 1) {
      children = (spansByTraceId[agent.traceId] ?? [])
        .filter(s => s.spanId !== agent.spanId && (s.name.startsWith('chat') || s.name.startsWith('execute_tool')))
    }

    children = children
      .slice()
      .sort((a, b) => nanoToMs(a.startTime) - nanoToMs(b.startTime))

    const userReq = extractUserRequest(getAttrStr(agent, 'copilot_chat.user_request')) || '[Copilot session]'
    const model = getGenAiModel(agent)
    const chatSpan = children.find(s => s.name.startsWith('chat'))
    const conversationId = chatSpan ? getAttrStr(chatSpan, 'gen_ai.conversation.id') : undefined
    const turns = getAttrInt(agent, 'copilot_chat.turn_count')
    const { input: inputTokens, output: outputTokens, cacheRead, cacheCreate } = extractTokenCounts(agent)
    // OpenAI convention: input_tokens = total context (cached tokens already included).
    // Anthropic convention: input_tokens = new non-cached only; add cacheRead + cacheCreate to reconstruct total.
    const isOpenAIModel = /^gpt-|^o\d/i.test(model ?? '')
    const totalInput = isOpenAIModel
      ? inputTokens
      : inputTokens + cacheRead + cacheCreate
    const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0

    const startMs = nanoToMs(agent.startTime)
    const endMs = nanoToMs(agent.endTime)
    const durationMs = endMs - startMs

    const filesRead = new Set<string>()
    const filesSearched = new Set<string>()
    const filesChanged = new Set<string>()
    const toolCounts: Record<string, number> = {}
    let totalToolCalls = 0
    let totalLlmCalls = 0
    let errors = 0
    let lastOutcome: 'text_response' | 'tool_calls' | 'unknown' = 'unknown'
    // Seed with the agent-level model (Copilot's own authoritative total) so it's
    // always represented even if per-turn chat spans report something different —
    // Copilot lets users switch models mid-conversation via the model picker.
    const modelTokens = new Map<string, number>()
    if (model) { modelTokens.set(model, totalInput + outputTokens) }

    const timeline: TimelineEntry[] = children.map(child => {
      const childStart = nanoToMs(child.startTime)
      const childEnd = nanoToMs(child.endTime)
      const childDur = childEnd - childStart
      const isError = child.status?.code === 2
      if (isError) { errors++ }
      const ts = childStart > 0 ? new Date(childStart).toISOString() : ''

      if (child.name.startsWith('execute_tool')) {
        const toolName = getAttrStr(child, 'gen_ai.tool.name')
        const argsStr = getAttrStr(child, 'gen_ai.tool.call.arguments')
        const resultStr = getAttrStr(child, 'gen_ai.tool.call.result')

        toolCounts[toolName] = (toolCounts[toolName] || 0) + 1
        totalToolCalls++

        if (toolName === 'read_file') {
          try {
            const args = JSON.parse(argsStr)
            const file = (args.filePath || '').split('/').pop()
            if (file) { filesRead.add(file) }
          } catch { /* skip */ }
        }
        if (toolName === 'file_search' || toolName === 'grep_search') {
          try {
            const args = JSON.parse(argsStr)
            filesSearched.add(args.query || args.includePattern || '')
          } catch { /* skip */ }
        }
        if (toolName === 'replace_string_in_file' || toolName === 'create_file' || toolName === 'edit_notebook_file') {
          try {
            const args = JSON.parse(argsStr)
            if (args.filePath) { filesChanged.add(String(args.filePath)) }
          } catch { /* skip */ }
        }
        if (toolName === 'multi_replace_string_in_file') {
          try {
            const args = JSON.parse(argsStr)
            if (args.replacements && Array.isArray(args.replacements)) {
              for (const r of args.replacements) {
                if (r.filePath) { filesChanged.add(String(r.filePath)) }
              }
            }
          } catch { /* skip */ }
        }
        if (toolName === 'apply_patch') {
          try {
            const args = JSON.parse(argsStr)
            const patchContent = args.command || args.patch || args.input || ''
            for (const line of patchContent.split('\n')) {
              const m = line.match(/^\*\*\*\s+(?:Update File:|Add File:|Delete File:)?\s*(.+)/)
              if (m) {
                const fp = m[1].trim()
                if (fp && fp.includes('/')) { filesChanged.add(fp) }
              }
            }
          } catch { /* skip */ }
        }

        const label = `${toolName} ${summarizeToolArgs(toolName, argsStr)}`
        const resultSummary = summarizeToolResult(toolName, resultStr)
        const editDetails = extractCopilotEditDetails(toolName, argsStr)

        return {
          type: 'tool' as const,
          spanId: child.spanId,
          label,
          durationMs: childDur,
          resultSummary,
          fullResult: resultStr || undefined,
          toolInput: argsStr || undefined,
          isError,
          errorMessage: isError ? (child.status?.message || undefined) : undefined,
          timestamp: ts,
          editDetails,
        }
      } else if (child.name.startsWith('chat')) {
        totalLlmCalls++
        const childModel = getGenAiModel(child)
        const { input: inTok, output: outTok, cacheRead: childCacheRead, cacheCreate: childCacheCreate } = extractTokenCounts(child)
        // Same OpenAI-vs-Anthropic input-token convention as the session aggregate above.
        const childIsOpenAIModel = /^gpt-|^o\d/i.test(childModel ?? '')
        const childTotalInput = childIsOpenAIModel ? inTok : inTok + childCacheRead + childCacheCreate
        if (childModel) {
          modelTokens.set(childModel, (modelTokens.get(childModel) ?? 0) + childTotalInput + outTok)
        }
        const ttft = getAttrInt(child, 'copilot_chat.time_to_first_token')
        const thinking = getAttrStr(child, 'copilot_chat.reasoning_content')
        const outputMsgs = getAttrStr(child, 'gen_ai.output.messages')
        const action = detectOutputAction(outputMsgs)
        const responseText = extractResponseText(outputMsgs)

        if (action === 'text response') {
          lastOutcome = 'text_response'
        } else if (action.startsWith('called')) {
          lastOutcome = 'tool_calls'
        }

        return {
          type: 'llm' as const,
          spanId: child.spanId,
          label: childModel,
          model: childModel,
          thinking: thinking ? thinking.slice(0, 200) : undefined,
          inputTokens: childTotalInput,
          outputTokens: outTok,
          cacheReadTokens: childCacheRead || undefined,
          cacheCreateTokens: childCacheCreate || undefined,
          ttft,
          durationMs: childDur,
          action,
          responseText: responseText || undefined,
          isError,
          errorMessage: isError ? (child.status?.message || undefined) : undefined,
          timestamp: ts,
        }
      } else {
        return {
          type: 'background' as const,
          spanId: child.spanId,
          label: child.name,
          durationMs: childDur,
          isError,
          timestamp: ts,
        }
      }
    })

    return {
      sessionId: agent.spanId,
      traceId: agent.traceId || '',
      source: 'copilot' as const,
      dataSource: 'otel' as const,
      // invoke_agent is the GenAI semconv span name for "an agent ran" and is emitted for every
      // Copilot session regardless of who started it — it does not by itself mean this session
      // was agent-spawned. A nested invoke_agent (this span has a parent) is the real signal:
      // it means another agent/orchestrator invoked this one, rather than a human starting it
      // directly in Chat or the CLI.
      initiator: agent.parentSpanId ? 'agent' as const : 'user' as const,
      conversationId: conversationId || undefined,
      workspace: '',
      userRequest: userReq,
      model,
      models: rankModelsByWeight(modelTokens),
      turns,
      inputTokens: totalInput,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheCreateTokens: cacheCreate,
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
      outcome: lastOutcome,
      timeline,
      backgroundSpans: [],
      loopSignals: [],
    }
  })
}

function collectDescendants(rootSpanId: string, childrenOf: Record<string, Span[]>): Span[] {
  const result: Span[] = []
  const seen = new Set<string>()
  const stack = [...(childrenOf[rootSpanId] || [])]

  while (stack.length > 0) {
    const span = stack.shift()
    if (!span || seen.has(span.spanId)) { continue }
    seen.add(span.spanId)
    result.push(span)
    stack.push(...(childrenOf[span.spanId] || []))
  }

  return result
}

function extractCopilotEditDetails(toolName: string, argsStr: string): EditDetail[] | undefined {
  try {
    if (toolName === 'replace_string_in_file') {
      const args = JSON.parse(argsStr)
      if (args.filePath) {
        return [{ filePath: args.filePath, oldString: args.oldString, newString: args.newString }]
      }
    } else if (toolName === 'multi_replace_string_in_file') {
      const args = JSON.parse(argsStr)
      if (args.replacements && Array.isArray(args.replacements)) {
        return args.replacements
          .filter((r: { filePath?: string }) => r.filePath)
          .map((r: { filePath: string; oldString?: string; newString?: string }) => ({
            filePath: r.filePath,
            oldString: r.oldString,
            newString: r.newString,
          }))
      }
    } else if (toolName === 'create_file') {
      const args = JSON.parse(argsStr)
      if (args.filePath) {
        return [{ filePath: args.filePath, content: args.content }]
      }
    } else if (toolName === 'apply_patch') {
      const args = JSON.parse(argsStr)
      const patchContent = args.command || args.patch || args.input || ''
      const details: EditDetail[] = []
      let currentFile = ''
      let oldLines: string[] = []
      let newLines: string[] = []
      for (const line of patchContent.split('\n')) {
        const fileMatch = line.match(/^\*\*\*\s+(?:Update File:|Add File:|Delete File:)?\s*(.+)/)
        if (fileMatch) {
          const candidate = fileMatch[1].trim()
          if (!candidate.includes('/')) continue  // skip *** Begin Patch, *** End Patch, etc.
          if (currentFile) {
            details.push({
              filePath: currentFile,
              oldString: oldLines.length > 0 ? oldLines.join('\n') : undefined,
              newString: newLines.length > 0 ? newLines.join('\n') : undefined,
            })
          }
          currentFile = candidate
          oldLines = []; newLines = []
          continue
        }
        // Unified diff format: @@ context @@ lines are separators, skip them
        if (line.startsWith('@@')) continue
        // Lines starting with - are removed, + are added, space is context (skip)
        if (line.startsWith('-')) { oldLines.push(line.slice(1)) }
        else if (line.startsWith('+')) { newLines.push(line.slice(1)) }
      }
      if (currentFile) {
        details.push({
          filePath: currentFile,
          oldString: oldLines.length > 0 ? oldLines.join('\n') : undefined,
          newString: newLines.length > 0 ? newLines.join('\n') : undefined,
        })
      }
      if (details.length > 0) { return details }
    }
  } catch { /* skip */ }
  return undefined
}
