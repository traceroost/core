import { Span } from '../types'
import { SessionSummaryCard, TimelineEntry, EditDetail } from './summarizerTypes'
import {
  getAttrStr, getAttrInt, nanoToMs, CLAUDE_WRITE_TOOLS, FULL_WRITE_TOOLS,
  extractResponseText, extractTokenCounts, normalizeUserRequest, getGenAiModel,
  commonPathPrefix, findProjectRoot, rankModelsByWeight,
} from './helpers'

function strOrUndef(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') { return undefined }
  return String(v)
}

export function buildClaudeSessions(
  claudeInteractionSpans: Span[],
  spansByTraceId: Record<string, Span[]>
): SessionSummaryCard[] {
  return claudeInteractionSpans.map(interaction => {
    const traceSpans = (spansByTraceId[interaction.traceId] || [])
      .filter(s => s.spanId !== interaction.spanId)
      .sort((a, b) => nanoToMs(a.startTime) - nanoToMs(b.startTime))

    const topSpans = traceSpans.filter(s =>
      s.name === 'claude_code.llm_request' || s.name === 'claude_code.tool'
    )

    const childrenBySpanId: Record<string, Span[]> = {}
    for (const s of traceSpans) {
      if (s.parentSpanId) {
        if (!childrenBySpanId[s.parentSpanId]) { childrenBySpanId[s.parentSpanId] = [] }
        childrenBySpanId[s.parentSpanId].push(s)
      }
    }

    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreateTokens = 0
    let totalLlmCalls = 0, totalToolCalls = 0, errors = 0
    const modelTokens = new Map<string, number>()
    const toolCounts: Record<string, number> = {}
    const filesRead = new Set<string>()
    const filesSearched = new Set<string>()
    const filesChanged = new Set<string>()
    const filesWritten = new Set<string>()
    const allAbsFilePaths = new Set<string>()
    let missingChangedFilePathCalls = 0

    const timeline: TimelineEntry[] = topSpans.flatMap(child => {
      const childStart = nanoToMs(child.startTime)
      const childEnd = nanoToMs(child.endTime)
      const childDur = childEnd - childStart || getAttrInt(child, 'duration_ms')
      const isError = child.status?.code === 2
      if (isError) { errors++ }
      const ts = childStart > 0 ? new Date(childStart).toISOString() : ''

      if (child.name === 'claude_code.llm_request') {
        totalLlmCalls++
        const { input: inTok, output: outTok, cacheRead, cacheCreate } = extractTokenCounts(child)
        const ttft = getAttrInt(child, 'ttft_ms')
        const childModel = getGenAiModel(child)
        if (childModel) {
          modelTokens.set(childModel, (modelTokens.get(childModel) ?? 0) + inTok + cacheRead + cacheCreate + outTok)
        }
        inputTokens += inTok
        outputTokens += outTok
        cacheReadTokens += cacheRead
        cacheCreateTokens += cacheCreate

        const stopReason = getAttrStr(child, 'stop_reason')
        const action = stopReason === 'tool_use' ? 'called tools'
          : stopReason === 'end_turn' ? 'text response'
          : stopReason || 'unknown'
        const claudeOutputMsgs = getAttrStr(child, 'gen_ai.output.messages')
        const responseText = extractResponseText(claudeOutputMsgs)

        // Extract file paths and edit details from tool_use blocks in the LLM response.
        // Primary source for Claude Code because tool_input on claude_code.tool spans
        // requires CLAUDE_CODE_ENHANCED_TELEMETRY_BETA.
        const llmEditDetails: EditDetail[] = []
        if (claudeOutputMsgs) {
          try {
            const msgs = JSON.parse(claudeOutputMsgs) as unknown[]
            if (Array.isArray(msgs)) {
              for (const msg of msgs) {
                const m = msg as { role?: string; content?: unknown }
                if (m.role !== 'assistant') { continue }
                const content = Array.isArray(m.content) ? m.content : []
                for (const block of content) {
                  const b = block as { type?: string; name?: string; input?: Record<string, unknown> }
                  if (b.type !== 'tool_use' || !b.input) { continue }
                  const toolN = b.name || ''
                  let foundChangedPath = false
                  const fp = String(b.input.file_path || b.input.filePath || '')
                  if (fp) {
                    if (CLAUDE_WRITE_TOOLS.has(toolN)) {
                      filesChanged.add(fp)
                      if (FULL_WRITE_TOOLS.has(toolN)) filesWritten.add(fp)
                      foundChangedPath = true
                      llmEditDetails.push({
                        filePath: fp,
                        toolName: toolN,
                        oldString: strOrUndef(b.input.old_string || b.input.oldString),
                        newString: strOrUndef(b.input.new_string || b.input.newString),
                        content: strOrUndef(b.input.content),
                      })
                    } else if (toolN === 'Read') {
                      filesRead.add(fp.split('/').pop() || fp)
                    } else if (toolN === 'Glob' || toolN === 'Grep') {
                      filesSearched.add(String(b.input.pattern || b.input.query || fp))
                    }
                  }
                  if (toolN === 'MultiEdit' && Array.isArray(b.input.edits)) {
                    for (const e of b.input.edits as Array<Record<string, unknown>>) {
                      const efp = e.file_path || e.filePath
                      if (efp) {
                        filesChanged.add(String(efp))
                        foundChangedPath = true
                        llmEditDetails.push({
                          filePath: String(efp),
                          toolName: 'Edit',
                          oldString: strOrUndef(e.old_string || e.oldString),
                          newString: strOrUndef(e.new_string || e.newString),
                        })
                      }
                    }
                  }
                  if (CLAUDE_WRITE_TOOLS.has(toolN) && !foundChangedPath) {
                    missingChangedFilePathCalls++
                  }
                }
              }
            }
          } catch { /* ignore */ }
        }

        return [{
          type: 'llm' as const,
          spanId: child.spanId,
          label: childModel || 'LLM',
          model: childModel,
          inputTokens: inTok + cacheRead + cacheCreate,
          outputTokens: outTok,
          cacheReadTokens: cacheRead || undefined,
          cacheCreateTokens: cacheCreate || undefined,
          ttft,
          durationMs: childDur,
          action,
          responseText: responseText || undefined,
          isError,
          errorMessage: isError ? (child.status?.message || undefined) : undefined,
          timestamp: ts,
          editDetails: llmEditDetails.length > 0 ? llmEditDetails : undefined,
        }]
      } else {
        // claude_code.tool
        totalToolCalls++
        const toolName = getAttrStr(child, 'tool_name') || child.name
        toolCounts[toolName] = (toolCounts[toolName] || 0) + 1
        const isWriteTool = CLAUDE_WRITE_TOOLS.has(toolName)

        const argsStr = getAttrStr(child, 'tool_input')
          || getAttrStr(child, 'input')
          || getAttrStr(child, 'gen_ai.tool.call.arguments')
          || getAttrStr(child, 'full_command')   // Bash: raw shell command
          || getAttrStr(child, 'file_path')       // Read/Edit/Write: file path
        let foundChangedPath = false
        const toolEditDetails: EditDetail[] = []
        if (argsStr) {
          try {
            const args = JSON.parse(argsStr)
            const fp = args.file_path || args.filePath
            if (fp) {
              const fpStr = String(fp)
              if (fpStr.startsWith('/')) { allAbsFilePaths.add(fpStr) }
              if (CLAUDE_WRITE_TOOLS.has(toolName)) {
                filesChanged.add(fpStr)
                if (FULL_WRITE_TOOLS.has(toolName)) filesWritten.add(fpStr)
                foundChangedPath = true
                toolEditDetails.push({
                  filePath: fpStr,
                  oldString: strOrUndef(args.old_string || args.oldString),
                  newString: strOrUndef(args.new_string || args.newString),
                  content: strOrUndef(args.content),
                })
              } else if (toolName === 'Read') {
                filesRead.add(fpStr.split('/').pop() || fpStr)
              } else if (toolName === 'Glob' || toolName === 'Grep') {
                filesSearched.add(args.pattern || args.query || fpStr)
              }
            }
            if (toolName === 'MultiEdit' && Array.isArray(args.edits)) {
              for (const e of args.edits as Array<Record<string, unknown>>) {
                const efp = e.file_path || e.filePath
                if (efp) {
                  const efpStr = String(efp)
                  if (efpStr.startsWith('/')) { allAbsFilePaths.add(efpStr) }
                  filesChanged.add(efpStr)
                  foundChangedPath = true
                  toolEditDetails.push({
                    filePath: String(efp),
                    oldString: strOrUndef(e.old_string || e.oldString),
                    newString: strOrUndef(e.new_string || e.newString),
                  })
                }
              }
            }
          } catch { /* skip */ }
        }
        // Fallback: claude_code.tool spans expose file_path as a direct attribute
        // even when tool_input is absent (default telemetry without OTEL_LOG_TOOL_DETAILS).
        if (!foundChangedPath) {
          const directFp = getAttrStr(child, 'file_path')
          if (directFp) {
            if (directFp.startsWith('/')) { allAbsFilePaths.add(directFp) }
            if (CLAUDE_WRITE_TOOLS.has(toolName)) {
              filesChanged.add(directFp)
              if (FULL_WRITE_TOOLS.has(toolName)) filesWritten.add(directFp)
              foundChangedPath = true
            } else if (toolName === 'Read') {
              filesRead.add(directFp.split('/').pop() || directFp)
            } else if (toolName === 'Glob' || toolName === 'Grep') {
              filesSearched.add(directFp)
            }
          }
        }
        if (isWriteTool && !foundChangedPath) {
          missingChangedFilePathCalls++
        }

        const toolEntry: TimelineEntry = {
          type: 'tool' as const,
          spanId: child.spanId,
          label: toolName,
          durationMs: childDur || getAttrInt(child, 'duration_ms'),
          toolInput: argsStr || undefined,
          isError,
          errorMessage: isError ? (child.status?.message || undefined) : undefined,
          timestamp: ts,
          editDetails: toolEditDetails.length > 0 ? toolEditDetails : undefined,
        }

        const blockedSpan = (childrenBySpanId[child.spanId] || [])
          .find(c => c.name === 'claude_code.tool.blocked_on_user')
        if (!blockedSpan) { return [toolEntry] }

        const blockedStart = nanoToMs(blockedSpan.startTime)
        const userInputEntry: TimelineEntry = {
          type: 'user_input' as const,
          spanId: blockedSpan.spanId,
          label: 'Permission prompt',
          durationMs: getAttrInt(blockedSpan, 'duration_ms') || (nanoToMs(blockedSpan.endTime) - blockedStart) || 0,
          decision: getAttrStr(blockedSpan, 'decision') || undefined,
          isError: false,
          timestamp: blockedStart > 0 ? new Date(blockedStart).toISOString() : ts,
        }
        return [toolEntry, userInputEntry]
      }
    })

    // Supplement file paths from claude_code.tool_result log-derived spans.
    // These arrive when OTEL_LOG_TOOL_DETAILS=1 and carry tool_input with actual paths.
    // Run this BEFORE computing filesChangedNote so the note reflects final state.
    const toolResultSpans = traceSpans.filter(s => s.name === 'claude_code.tool_result')
    for (const trs of toolResultSpans) {
      const trToolName = getAttrStr(trs, 'tool.name') || getAttrStr(trs, 'tool_name')
      const trArgsStr = getAttrStr(trs, 'tool_input') || getAttrStr(trs, 'input')
      if (!trToolName || !trArgsStr) { continue }
      let fp = ''
      let multiEdits: Array<{ file_path?: string; filePath?: string }> = []
      try {
        // tool_input may be a JSON args object or a bare file path string
        const args = JSON.parse(trArgsStr) as Record<string, unknown>
        fp = String(args.file_path || args.filePath || '')
        if (trToolName === 'MultiEdit' && Array.isArray(args.edits)) {
          multiEdits = args.edits as Array<{ file_path?: string; filePath?: string }>
        }
        if (!fp && trToolName !== 'MultiEdit') {
          // Structured args present but no file_path key — skip
        }
      } catch {
        // Not JSON: treat the raw string as the file path directly
        fp = trArgsStr.trim()
      }
      if (fp) {
        if (fp.startsWith('/')) { allAbsFilePaths.add(fp) }
        if (CLAUDE_WRITE_TOOLS.has(trToolName)) {
          filesChanged.add(fp)
          if (FULL_WRITE_TOOLS.has(trToolName)) filesWritten.add(fp)
        } else if (trToolName === 'Read') { filesRead.add(fp.split('/').pop() || fp) }
        else if (trToolName === 'Glob' || trToolName === 'Grep') { filesSearched.add(fp) }
      }
      for (const e of multiEdits) {
        const efp = e.file_path || e.filePath
        if (efp) {
          const efpStr = String(efp)
          if (efpStr.startsWith('/')) { allAbsFilePaths.add(efpStr) }
          filesChanged.add(efpStr)
        }
      }
    }

    const workspace = findProjectRoot(commonPathPrefix([...allAbsFilePaths]))

    // Sessions can span more than one model (e.g. a Task-tool subagent on a cheaper
    // model, or a mid-session /model switch) — rank by token volume rather than
    // reporting whichever model happened to handle the last call.
    const models = rankModelsByWeight(modelTokens)
    const model = models[0] ?? ''

    const startMs = nanoToMs(interaction.startTime)
    const totalInput = inputTokens + cacheReadTokens + cacheCreateTokens
    const cacheHitRate = (totalInput > 0) ? cacheReadTokens / totalInput : 0
    const durationMs = getAttrInt(interaction, 'interaction.duration_ms')
      || (nanoToMs(interaction.endTime) - startMs)

    const rawPrompt = getAttrStr(interaction, 'user_prompt')
    const promptLength = getAttrInt(interaction, 'user_prompt_length')
    const hasData = totalLlmCalls > 0 || inputTokens > 0 || timeline.length > 0
    const userRequest = normalizeUserRequest(
      rawPrompt, promptLength,
      hasData ? '[prompt redacted]' : '[trace in progress]',
      hasData ? 'prompt redacted' : 'trace in progress',
    )

    // Note is computed AFTER enrichment — if enrichment found files, filesChanged.size > 0
    // and we suppress the note entirely. Only show it when zero paths were found.
    const filesChangedNote = (filesChanged.size === 0 && missingChangedFilePathCalls > 0)
      ? `Changed-file paths are unavailable for ${missingChangedFilePathCalls} write operation${missingChangedFilePathCalls !== 1 ? 's' : ''}. `
        + `Claude Code redacts tool arguments by default. Add OTEL_LOG_TOOL_DETAILS=1 to your Claude environment variables (alongside CLAUDE_CODE_ENABLE_TELEMETRY=1) and restart to enable path tracking.`
      : undefined

    return {
      sessionId: interaction.spanId,
      traceId: interaction.traceId || '',
      source: 'claude_code' as const,
      dataSource: 'otel' as const,
      initiator: (interaction.parentSpanId || getAttrStr(interaction, 'is_sidechain') === 'true') ? 'agent' as const : 'user' as const,
      workspace,
      userRequest,
      model,
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
      filesWritten: Array.from(filesWritten),
      filesChangedNote,
      toolCounts,
      totalToolCalls,
      totalLlmCalls,
      errors,
      outcome: 'unknown' as const,
      timeline,
      backgroundSpans: [],
      loopSignals: [],
    }
  })
}
