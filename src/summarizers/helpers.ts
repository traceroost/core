import * as fs from 'fs'
import * as path from 'path'
import { Span } from '../types'

export const CLAUDE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const FULL_WRITE_TOOLS   = new Set(['Write', 'create_file'])  // whole-file replacement

/** Returns the longest common directory prefix of a set of absolute file paths. */
export function commonPathPrefix(paths: string[]): string {
  const absPaths = paths.filter(p => p.startsWith('/'))
  if (absPaths.length === 0) { return '' }
  const split = absPaths.map(p => p.split('/').filter(Boolean))
  const first = split[0]
  let common = 0
  for (let i = 0; i < first.length; i++) {
    if (split.every(parts => parts[i] === first[i])) { common = i + 1 } else { break }
  }
  if (common === 0) { return '' }
  // Don't return the full path if it points to a file (last segment has a dot)
  const prefix = first.slice(0, common)
  if (prefix[prefix.length - 1]?.includes('.')) { prefix.pop() }
  return prefix.length > 0 ? '/' + prefix.join('/') : ''
}

/**
 * Walks up from startDir until it finds a directory containing a project root
 * marker (.git or package.json). Falls back to startDir if none is found.
 * Prevents OTEL sessions from being labelled with a deep subdirectory (e.g.
 * src/tabs) when only files there were touched in that session.
 */
export function findProjectRoot(startDir: string): string {
  if (!startDir || !startDir.startsWith('/')) { return startDir }
  let dir = startDir
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) { break }
    dir = parent
  }
  return startDir
}

export function getAttrStr(span: Span, key: string): string {
  const attr = span.attributes?.find(a => a.key === key)
  if (!attr) { return '' }
  return String(attr.value?.stringValue ?? attr.value?.intValue ?? attr.value?.doubleValue ?? '')
}

// Handles the gen_ai.system → gen_ai.provider.name rename in gen_ai_latest_experimental.
export function getGenAiSystem(span: Span): string {
  return getFirstAttr(span, ['gen_ai.system', 'gen_ai.provider.name'])
}

// Handles gen_ai.request.model / gen_ai.response.model with old and new attribute names.
export function getGenAiModel(span: Span): string {
  return getFirstAttr(span, ['gen_ai.request.model', 'gen_ai.response.model', 'model'])
}

export function getAttrInt(span: Span, key: string): number {
  const attr = span.attributes?.find(a => a.key === key)
  if (!attr) { return 0 }
  return Number(attr.value?.intValue ?? attr.value?.doubleValue ?? attr.value?.stringValue ?? 0) || 0
}

export function nanoToMs(nanoStr: string): number {
  try {
    return Number(BigInt(nanoStr || '0') / BigInt(1_000_000))
  } catch {
    return parseInt(nanoStr, 10) / 1_000_000 || 0
  }
}

export function timestampToMs(value: string | number | undefined): number {
  if (value === undefined || value === null || value === '') { return 0 }
  if (typeof value === 'number') { return value }
  const raw = String(value)
  if (/^\d+$/.test(raw)) { return nanoToMs(raw) }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<\/task-notification>/gi

/**
 * True when `text` is nothing but one or more <task-notification> blocks — the harness's way
 * of delivering a background Bash/Agent task's result back into the conversation on a
 * synthetic turn. Not something a person typed, so it shouldn't be shown as the prompt.
 */
export function isTaskNotificationOnly(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.includes('<task-notification>')) { return false }
  return trimmed.replace(TASK_NOTIFICATION_RE, '').trim() === ''
}

/** Pulls a human-readable label out of a <task-notification> block's <summary> field. */
export function summarizeTaskNotification(text: string): string {
  const summary = text.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)?.[1]?.trim()
  return (summary ? `[background task] ${summary}` : '[background task result]').slice(0, 500)
}

export function extractUserRequest(raw: string): string {
  const trimmed = raw.trim()

  // Background task result delivered on a synthetic turn (see isTaskNotificationOnly) —
  // show its summary instead of the raw notification XML.
  if (isTaskNotificationOnly(trimmed)) { return summarizeTaskNotification(trimmed) }

  // Claude Code wraps the user text in <userRequest> when IDE context is attached
  if (trimmed.includes('<userRequest>')) {
    const match = trimmed.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/)
    return match?.[1]?.trim() || trimmed.slice(0, 5000)
  }

  // Codex IDE format: ## My request:
  const codexIdeRequest = trimmed.match(/(?:^|\n)##\s+My request(?:\s+for\s+[^\n:]+)?:\s*\n([\s\S]*)$/i)
  const request = codexIdeRequest?.[1]?.trim()
  if (request) { return request.slice(0, 5000) }

  // Claude Code prepends IDE context tags before the user's typed message.
  // Strip <local-command-caveat>...</local-command-caveat> and <ide_*>...</ide_*> blocks
  // and return whatever is left — that is the actual user prompt.
  const stripped = trimmed
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/gi, '')
    .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/gi, '')
    .trim()
  if (stripped) { return stripped.slice(0, 5000) }

  return trimmed.slice(0, 5000)
}

export function getFirstAttr(span: Span, keys: string[]): string {
  for (const key of keys) {
    const val = getAttrStr(span, key)
    if (val) { return val }
  }
  return ''
}

/**
 * Ranks models by total token volume, descending. Sessions can call more than one
 * model (e.g. a subagent on a cheaper model, or a user switching mid-session) — this
 * gives a token-weighted "primary model" (ranked[0]) that's more representative than
 * whichever model happened to handle the last call, plus the full list for display.
 */
export function rankModelsByWeight(modelTokens: Map<string, number>): string[] {
  return [...modelTokens.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m)
}

export function isCodexPromptSpanName(name: string): boolean {
  return name === 'codex.user_prompt'
    || name === 'codex.prompt'
    || name === 'codex.user_message'
    || name === 'codex.session_start'
}

export function isCodexToolDecisionSpan(name: string): boolean {
  return name === 'codex.tool_decision'
}

export function isCodexToolCallSpan(name: string): boolean {
  return name === 'codex.tool.call'
}

export function isCodexToolResultSpan(name: string): boolean {
  return name === 'codex.tool_result'
}

export function isCodexToolSpanName(name: string): boolean {
  return name === 'codex.tool_result'
    || name === 'codex.tool'
    || name === 'codex.tool_decision'
    || name === 'codex.tool.call'
    || name === 'exec_command'
    || name === 'apply_patch'
    || name.includes('.tool')
}

export function isCodexToolExecSpan(span: Span): boolean {
  if (isCodexToolSpanName(span.name)) return true
  // Codex tool execution spans that don't carry a codex.* prefix but do carry
  // both a call_id and a tool_name attribute (e.g. exec_command, apply_patch)
  return Boolean(getAttrStr(span, 'call_id') && getAttrStr(span, 'tool_name'))
}

export function isCodexLlmSpanName(name: string): boolean {
  return name === 'codex.stream_event'
    || name === 'codex.completion'
    || name === 'codex.response'
    || name === 'codex.sse_event'   // token-bearing completion event
    || name.includes('stream')
    || name.includes('completion')
    || name.includes('response')
}

export function summarizeToolArgs(toolName: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson)
    switch (toolName) {
      case 'read_file': {
        const file = (args.filePath || '').split('/').pop() || args.filePath
        return `${file} L${args.startLine}-${args.endLine}`
      }
      case 'file_search':
        return args.query || argsJson.slice(0, 80)
      case 'grep_search': {
        const q = args.query || '?'
        const inc = args.includePattern || '*'
        return `"${q}" in ${inc}`
      }
      case 'list_dir': {
        const p = args.path || ''
        const parts = p.split('/').filter(Boolean)
        return parts[parts.length - 1] || p
      }
      case 'manage_todo_list': {
        const items = args.todoList || []
        const statuses = items.reduce((acc: Record<string, number>, i: { status: string }) => {
          acc[i.status] = (acc[i.status] || 0) + 1
          return acc
        }, {})
        const parts = Object.entries(statuses).map(([s, n]) => `${n} ${s}`)
        return `${items.length} items (${parts.join(', ')})`
      }
      case 'semantic_search':
        return `"${(args.query || '').slice(0, 60)}"`
      case 'replace_string_in_file':
      case 'multi_replace_string_in_file': {
        const file = (args.filePath || '').split('/').pop()
        return file || 'edit'
      }
      case 'create_file': {
        const file = (args.filePath || '').split('/').pop()
        return file || 'new file'
      }
      case 'apply_patch': {
        const patchContent = args.command || args.patch || args.input || ''
        const files: string[] = []
        for (const line of patchContent.split('\n')) {
          const m = line.match(/^\*\*\*\s+(?:Update File:|Add File:|Delete File:)?\s*(.+)/)
          if (m) {
            const fp = m[1].trim()
            if (fp.includes('/')) { files.push(fp.split('/').pop() || '') }
          }
        }
        return files.length > 0 ? files.filter(Boolean).join(', ') : 'patch'
      }
      case 'run_in_terminal':
        return (args.command || '').slice(0, 80)
      case 'vscode_askQuestions': {
        const qs = args.questions || []
        return `${qs.length} question(s)`
      }
      case 'explore_subagent':
      case 'runSubagent':
        return (args.description || args.query || '').slice(0, 60)
      default:
        return argsJson.slice(0, 80)
    }
  } catch {
    return argsJson.slice(0, 80)
  }
}

export function summarizeToolResult(toolName: string, result: string): string {
  if (!result) { return 'empty' }
  if (result === 'No todo list found.') { return 'no list' }

  const len = result.length
  if (len < 50) { return result }

  if (toolName === 'grep_search') {
    const match = result.match(/(\d+)\s+match/)
    if (match) { return `${match[1]} matches` }
  }
  if (toolName === 'file_search') {
    const match = result.match(/(\d+)\s+total result/)
    if (match) { return `${match[1]} result(s)` }
  }

  if (len > 1000) { return `${(len / 1024).toFixed(1)}KB` }
  return `${len} chars`
}

/**
 * Extracts token counts from any agent span, normalising the many different
 * attribute key schemes used by Copilot, Claude, and Codex into one shape.
 */
export function extractTokenCounts(span: Span): { input: number; output: number; cacheRead: number; cacheCreate: number } {
  const input =
    getAttrInt(span, 'gen_ai.usage.input_tokens') ||
    getAttrInt(span, 'input_tokens') ||
    getAttrInt(span, 'prompt_tokens') ||
    getAttrInt(span, 'input_token_count') ||
    getAttrInt(span, 'codex.turn.token_usage.input_tokens')

  const cacheRead =
    getAttrInt(span, 'gen_ai.usage.cache_read.input_tokens') ||
    getAttrInt(span, 'cache_read_tokens') ||
    getAttrInt(span, 'cached_token_count') ||
    getAttrInt(span, 'codex.turn.token_usage.cached_input_tokens')

  const cacheCreate =
    getAttrInt(span, 'gen_ai.usage.cache_creation.input_tokens') ||
    getAttrInt(span, 'cache_creation_tokens')

  // Codex splits output into output_token_count + reasoning_token_count; try them
  // as a combined fallback after the standard keys.
  const outputStd =
    getAttrInt(span, 'gen_ai.usage.output_tokens') ||
    getAttrInt(span, 'output_tokens') ||
    getAttrInt(span, 'completion_tokens') ||
    getAttrInt(span, 'codex.turn.token_usage.output_tokens')
  const output = outputStd ||
    (getAttrInt(span, 'output_token_count') + getAttrInt(span, 'reasoning_token_count'))

  return { input, output, cacheRead, cacheCreate }
}

/**
 * Produces a consistent user-request label across all agents.
 * - Non-redacted text  → extractUserRequest(text)
 * - Redacted + length  → "[N chars]" (optionally with a caller-supplied note)
 * - Nothing at all     → fallback string
 */
export function normalizeUserRequest(raw: string, length: number, fallback: string, redactionNote?: string): string {
  const isRedacted = !raw || raw === '<REDACTED>' || raw === '[REDACTED]'
  if (!isRedacted) { return extractUserRequest(raw) }
  if (length > 0) {
    return redactionNote ? `[${length} chars — ${redactionNote}]` : `[~${length} chars]`
  }
  return fallback
}

export function extractResponseText(outputMessages: string): string | undefined {
  if (!outputMessages) { return undefined }
  try {
    const msgs = JSON.parse(outputMessages)
    if (!Array.isArray(msgs)) { return undefined }
    for (const msg of msgs) {
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string' && msg.content.trim()) {
          return msg.content
        }
        if (Array.isArray(msg.content)) {
          const textParts = msg.content
            .filter((p: { type: string; text?: string }) => p.type === 'text' && p.text)
            .map((p: { text: string }) => p.text)
          if (textParts.length > 0) { return textParts.join('\n') }
        }
      }
    }
  } catch { /* ignore */ }
  return undefined
}

export function detectOutputAction(outputMessages: string): string {
  if (!outputMessages) { return 'unknown' }
  if (outputMessages.includes('"tool_call"')) {
    const toolNames: string[] = []
    const re = /"name"\s*:\s*"([^"]+)"/g
    let m
    while ((m = re.exec(outputMessages)) !== null) {
      toolNames.push(m[1])
    }
    if (toolNames.length > 0) {
      return `called ${toolNames.join(', ')}`
    }
    return 'tool_calls'
  }
  return 'text response'
}
