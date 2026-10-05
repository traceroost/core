import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Span } from '../types'
import type { EditDetail } from './summarizerTypes'

export const CLAUDE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const FULL_WRITE_TOOLS   = new Set(['Write', 'create_file'])  // whole-file replacement

/**
 * Splits an absolute file path into its root, separator and segments; null when it isn't absolute.
 * `/…` paths always count. On win32 so do `C:\…` / `C:/…` and UNC `\\server\share\…`, and both
 * separators split segments there (POSIX paths split on `/` only, exactly as before).
 */
function splitAbsolutePath(p: string, platform: NodeJS.Platform): { root: string; sep: string; segments: string[] } | null {
  const win = platform === 'win32'
  if (!win) {
    return p.startsWith('/') ? { root: '/', sep: '/', segments: p.split('/').filter(Boolean) } : null
  }
  const segments = () => p.split(/[\\/]/).filter(Boolean)
  if (/^[\\/]{2}[^\\/]/.test(p)) { return { root: '\\\\', sep: '\\', segments: segments() } }
  if (p.startsWith('/')) { return { root: '/', sep: '/', segments: segments() } }
  if (/^[A-Za-z]:[\\/]/.test(p)) { return { root: p.slice(0, 2) + '\\', sep: '\\', segments: segments().slice(1) } }
  return null
}

/** True for a path `commonPathPrefix` can use — see splitAbsolutePath for what counts on each platform. */
export function isAbsoluteFilePath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return splitAbsolutePath(p, platform) !== null
}

/** Last segment of a file path — on win32 either separator ends a segment, elsewhere only `/`. */
export function fileBaseName(p: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? p.split(/[\\/]/) : p.split('/')).pop() || p
}

/**
 * Returns the longest common directory prefix of a set of absolute file paths. Windows paths
 * (win32 only) compare drive letters and segments case-insensitively, as the file system does,
 * and come back with `\` separators under the first path's root and casing.
 */
export function commonPathPrefix(paths: string[], platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32'
  const split = paths.map(p => splitAbsolutePath(p, platform)).filter(s => s !== null)
  if (split.length === 0) { return '' }
  const key = (seg: string) => win ? seg.toLowerCase() : seg
  const first = split[0]
  if (!split.every(s => key(s.root) === key(first.root))) { return '' }
  let common = 0
  for (let i = 0; i < first.segments.length; i++) {
    const seg = key(first.segments[i])
    if (split.every(s => s.segments[i] !== undefined && key(s.segments[i]) === seg)) { common = i + 1 } else { break }
  }
  if (common === 0) { return '' }
  // Don't return the full path if it points to a file (last segment has a dot)
  const prefix = first.segments.slice(0, common)
  if (prefix[prefix.length - 1]?.includes('.')) { prefix.pop() }
  return prefix.length > 0 ? first.root + prefix.join(first.sep) : ''
}

/**
 * Walks up from startDir until it finds a directory containing a project root
 * marker (.git or package.json). Prevents OTEL sessions from being labelled
 * with a deep subdirectory (e.g. src/tabs) when only files there were touched
 * in that session.
 *
 * If no marker is found anywhere up the tree, startDir itself is normally a reasonable fallback —
 * except when it's at or above the user's home directory. That shape only shows up when the
 * caller's `startDir` was already an overly shallow guess (e.g. commonPathPrefix collapsing to
 * almost nothing because a session touched only two files in unrelated subtrees) — it *looks* like
 * a real project path but isn't one, and displaying it (e.g. "Users/devuser") is more misleading
 * than showing nothing. `homeDir` is injectable for tests; defaults to the real home directory.
 */
export function findProjectRoot(startDir: string, homeDir: string = os.homedir()): string {
  // path.isAbsolute, not startsWith('/'): on Windows a session directory is `C:\…`.
  if (!startDir || !path.isAbsolute(startDir)) { return startDir }
  let dir = startDir
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) { break }
    dir = parent
  }
  // Windows paths take either separator and compare case-insensitively; POSIX ones neither.
  const win = process.platform === 'win32'
  const segments = (p: string) => (win ? p.toLowerCase().split(/[\\/]/) : p.split('/')).filter(Boolean)
  const startSegments = segments(startDir)
  const homeSegments = segments(homeDir)
  const isHomeOrAboveHome = startSegments.length <= homeSegments.length
    && startSegments.every((seg, i) => seg === homeSegments[i])
  return isHomeOrAboveHome ? '' : startDir
}

export function getAttrStr(span: Span, key: string): string {
  const attr = span.attributes?.find(a => a.key === key)
  if (!attr) { return '' }
  return String(attr.value?.stringValue ?? attr.value?.intValue ?? attr.value?.doubleValue ?? '')
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

function isCodexToolSpanName(name: string): boolean {
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
        const file = (args.filePath || '').split(/[\\/]/).pop() || args.filePath
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
        const parts = p.split(/[\\/]/).filter(Boolean)
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
        const file = (args.filePath || '').split(/[\\/]/).pop()
        return file || 'edit'
      }
      case 'create_file': {
        const file = (args.filePath || '').split(/[\\/]/).pop()
        return file || 'new file'
      }
      case 'apply_patch': {
        const patchContent = args.command || args.patch || args.input || ''
        const files: string[] = []
        for (const line of patchContent.split('\n')) {
          const m = line.match(/^\*\*\*\s+(?:Update File:|Add File:|Delete File:)?\s*(.+)/)
          if (m) {
            const fp = m[1].trim()
            if (/[\\/]/.test(fp)) { files.push(fp.split(/[\\/]/).pop() || '') }
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

  // Codex log events carry output_token_count; their reasoning_token_count is a breakdown of
  // it (OpenAI's output count already includes reasoning), so it is never added on top.
  const output =
    getAttrInt(span, 'gen_ai.usage.output_tokens') ||
    getAttrInt(span, 'output_tokens') ||
    getAttrInt(span, 'completion_tokens') ||
    getAttrInt(span, 'codex.turn.token_usage.output_tokens') ||
    getAttrInt(span, 'output_token_count')

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

/**
 * Per-file edit details from an apply_patch body ("*** Begin Patch / *** Update|Add|Delete File:
 * <path> / @@ / -old / +new / *** End Patch") — Copilot's and Codex's file-editing tool. Each
 * detail carries the hunk's removed (`-`) lines as oldString and added (`+`) lines as newString,
 * context lines dropped, tagged toolName 'apply_patch' so src/editStats.ts counts them as stated
 * rather than re-diffing them.
 */
export function parseApplyPatchEditDetails(patchContent: string): EditDetail[] {
  const details: EditDetail[] = []
  let currentFile = ''
  let oldLines: string[] = []
  let newLines: string[] = []
  for (const line of patchContent.split('\n')) {
    const fileMatch = line.match(/^\*\*\*\s+(?:Update File:|Add File:|Delete File:)?\s*(.+)/)
    if (fileMatch) {
      const candidate = fileMatch[1].trim()
      if (!/[\\/]/.test(candidate)) continue  // skip *** Begin Patch, *** End Patch, etc. (a path has either separator)
      if (currentFile) {
        details.push({
          filePath: currentFile,
          toolName: 'apply_patch',
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
      toolName: 'apply_patch',
      oldString: oldLines.length > 0 ? oldLines.join('\n') : undefined,
      newString: newLines.length > 0 ? newLines.join('\n') : undefined,
    })
  }
  return details
}
