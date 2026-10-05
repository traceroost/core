import type { Span, SpanAttribute, SessionSummaryCard } from './types'
import { sessionSummary, displaySessions } from './state'

// ── HTML escape ───────────────────────────────────────────────────────────────

export function esc(s: unknown): string {
  if (!s) return ''
  const d = document.createElement('div')
  d.textContent = String(s)
  return d.innerHTML
}

export function syntaxHighlightJson(jsonStr: string): string {
  return esc(jsonStr)
    .replace(/("(?:\\.|[^"\\])*")\s*:/g, '<span class="json-key">$1</span>:')
    .replace(/:\s*("(?:\\.|[^"\\])*")/g, (_m, val) => ': <span class="json-string">' + val + '</span>')
    .replace(/:\s*(\d+(?:\.\d+)?)/g, ': <span class="json-number">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>')
}

// ── Number / time formatters ──────────────────────────────────────────────────

export function nanoToMs(n: string | number | undefined): number {
  try { return Number(BigInt(n ?? 0) / BigInt(1000000)) }
  catch { return parseInt(String(n)) / 1000000 || 0 }
}

export function timestampToMs(value: string | number | undefined): number {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value === 'number') return value
  const raw = String(value)
  if (/^\d+$/.test(raw)) return nanoToMs(raw)
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

export function sessionStartMs(session: Pick<SessionSummaryCard, 'startTime'>): number {
  return timestampToMs(session.startTime)
}

export function formatMs(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return ms.toFixed(0) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  if (ms < 3600000) return (ms / 60000).toFixed(1) + 'min'
  return (ms / 3600000).toFixed(1) + 'h'
}

export function formatCompact(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

// ── Span attribute helpers ────────────────────────────────────────────────────

export function getAttr(span: Span, key: string): string | number | boolean | null {
  const a = (span.attributes ?? []).find(x => x.key === key)
  if (!a) return null
  const v = a.value
  return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? null
}

function intAttr(attrs: SpanAttribute[], key: string): number {
  const a = attrs.find(x => x.key === key)
  if (!a) return 0
  return parseInt(String(a.value.intValue ?? a.value.stringValue ?? 0)) || 0
}

export function getInputTokens(span: Span): number {
  const attrs = span.attributes ?? []
  const genAiBase = intAttr(attrs, 'gen_ai.usage.input_tokens')
  const genAiCache = intAttr(attrs, 'gen_ai.usage.cache_read.input_tokens')
    + intAttr(attrs, 'gen_ai.usage.cache_creation.input_tokens')
  if (genAiBase > 0 || genAiCache > 0) return genAiBase + genAiCache
  return intAttr(attrs, 'input_tokens') + intAttr(attrs, 'prompt_tokens')
    + intAttr(attrs, 'cache_read_tokens') + intAttr(attrs, 'cache_creation_tokens')
    + intAttr(attrs, 'input_token_count') + intAttr(attrs, 'cached_token_count')
    + intAttr(attrs, 'codex.turn.token_usage.input_tokens')
    + intAttr(attrs, 'codex.turn.token_usage.cached_input_tokens')
}

/** Same precedence as src/summarizers/helpers.ts's token extraction: Codex log events carry
 *  output_token_count, and their reasoning_token_count is a breakdown of it (OpenAI's output count
 *  already includes reasoning), so it is never added on top. */
export function getOutputTokens(span: Span): number {
  const attrs = span.attributes ?? []
  return intAttr(attrs, 'gen_ai.usage.output_tokens')
    || intAttr(attrs, 'output_tokens')
    || intAttr(attrs, 'completion_tokens')
    || intAttr(attrs, 'codex.turn.token_usage.output_tokens')
    || intAttr(attrs, 'output_token_count')
}

// ── Span classification ───────────────────────────────────────────────────────

export function isLlmSpanName(name: string): boolean {
  return name.indexOf('chat') === 0
    || name === 'claude_code.llm_request'
    || name === 'handle_responses'
    || name === 'codex.stream_event'
    || name === 'codex.api_request'
    || name === 'codex.completion'
    || name === 'codex.response'
    || name === 'codex.sse_event'
}

export function isToolSpanName(name: string): boolean {
  return name.indexOf('execute_tool') === 0
    || name === 'claude_code.tool'
    || name === 'exec_command'
    || name.indexOf('codex.tool') === 0
}

export function getCodexSessionId(span: Span): string {
  const explicit = getAttr(span, 'codex.session.id')
  if (explicit) return String(explicit)

  const conversationId = getAttr(span, 'thread.id')
    ?? getAttr(span, 'thread_id')
    ?? getAttr(span, 'conversation.id')
    ?? getAttr(span, 'conversation_id')
    ?? getAttr(span, 'codex.conversation.id')
  const turnId = getAttr(span, 'turn.id')
    ?? getAttr(span, 'turn_id')
    ?? getAttr(span, 'codex.turn.id')

  if (conversationId && turnId) {
    return 'codex:' + String(conversationId) + ':' + String(turnId)
  }
  return ''
}

export function extractUserRequest(raw: string): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (trimmed.indexOf('<userRequest>') !== -1) {
    const match = trimmed.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/)
    return match ? match[1].trim() : trimmed
  }
  const codexMatch = trimmed.match(/(?:^|\n)##\s+My request(?:\s+for\s+[^\n:]+)?:\s*\n([\s\S]*)$/i)
  if (codexMatch?.[1]?.trim()) return codexMatch[1].trim()
  const stripped = trimmed.replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/gi, '').trim()
  return stripped || trimmed
}

interface OutputBlock {
  type: 'text' | 'tool_use' | 'tool_call' | string
  text?: string
  name?: string
}
interface OutputMessage {
  role?: string
  content?: OutputBlock[]
  parts?: OutputBlock[]
}

/** Parses gen_ai.output.messages and returns the first assistant text block, or null. */
export function extractLlmResponseText(span: Span): string | null {
  const raw = String(getAttr(span, 'gen_ai.output.messages') ?? '')
  if (!raw) return null
  try {
    const msgs = JSON.parse(raw) as OutputMessage[]
    for (const msg of msgs) {
      if (msg.role !== 'assistant') continue
      const blocks: OutputBlock[] = msg.content ?? msg.parts ?? []
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          return b.text
        }
      }
    }
  } catch { /* ignore */ }
  return null
}

/** Returns true if this span is an LLM turn from any agent. */
export function isLlmSpan(span: Span): boolean {
  const name = span.name ?? ''
  return name === 'claude_code.llm_request' || name.startsWith('chat ')
}

// ── Data source / initiator badge helpers ───────────────────────────────────────
//
// Single source of truth for the Source/From column's per-row badges AND the Outcome filter
// bar's own Source/From pills (App.tsx's DATA_SOURCE_FILTER_OPTIONS / INITIATOR_FILTER_OPTIONS,
// which import these same maps) — so a badge's color always matches its pill in the nav above.

export const DATA_SOURCE_COLORS = { all: 'var(--fg)', otel: 'var(--fg)', log: '#90a4ae' } as const
export const INITIATOR_COLORS = { all: 'var(--fg)', user: '#4a90d9', agent: '#90a4ae' } as const

// name/description split (not one sentence) so the tooltip can state the value first, as a bold
// heading, then what it means — matching the Signals column's tooltip format.
const DATA_SOURCE_TOOLTIP = {
  otel: { name: 'OTEL', description: 'Full telemetry: timing, speed, TTFT, loop signals' },
  log:  { name: 'Log',  description: 'Conversation logs: tokens, tool calls, messages (no timing or speed data)' },
}

export function getDataSourceBadgeHtml(dataSource: 'otel' | 'log' | undefined): string {
  const ds = dataSource ?? 'otel'
  const label = ds === 'log' ? 'L' : 'O'
  const color = DATA_SOURCE_COLORS[ds]
  const { name, description } = DATA_SOURCE_TOOLTIP[ds]
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;font-size:9px;font-weight:700;border-radius:3px;border:1px solid ${color};color:${color};vertical-align:middle;cursor:default" title="<b>${name}</b>&#10;${description}" data-tip-html>${label}</span>`
}

// 'agent' and 'api' (isSidechain sub-tasks vs. non-interactive `claude -p` calls) collapse into
// one "Agent" bucket here — see InitiatorFilter's own doc comment (types.ts) for why.
const INITIATOR_TOOLTIP = {
  user:  { name: 'User',  description: 'Typed directly by a human in the chat' },
  agent: { name: 'Agent', description: 'Agent-spawned sub-task, or a non-interactive API call (claude -p)' },
} as const

export function getInitiatorBadgeHtml(initiator: 'user' | 'agent' | 'api' | undefined): string {
  const key = initiator === 'api' ? 'agent' : (initiator ?? 'user')
  const color = INITIATOR_COLORS[key]
  const label = key === 'user' ? 'U' : 'A'
  const { name, description } = INITIATOR_TOOLTIP[key]
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;font-size:9px;font-weight:700;border-radius:3px;border:1px solid ${color};color:${color};vertical-align:middle;cursor:default;margin-left:3px" title="<b>${name}</b>&#10;${description}" data-tip-html>${label}</span>`
}

// ── Agent label / color helpers ───────────────────────────────────────────────

export function getAgentSourceLabel(source: string | null | undefined): string {
  if (source === 'claude_code') return 'Claude'
  if (source === 'codex') return 'Codex'
  if (source === 'opencode') return 'OpenCode'
  if (source === 'cursor') return 'Cursor'
  return 'Copilot'
}

export function getAgentColor(source: string | null | undefined): string {
  if (source === 'claude_code') return '#FFB085'
  if (source === 'codex') return '#F0FF42'
  if (source === 'copilot') return '#00EAFF'
  if (source === 'opencode') return '#FFFFFF'
  if (source === 'cursor') return '#B39DDB'
  return '#90a4ae'
}

// Fixed, visually distinct palette for coloring conversation groups (see getConversationColor) —
// deliberately disjoint from the agent-source colors above so the two don't read as related.
const CONVERSATION_COLORS = [
  '#4dd0e1', '#ba68c8', '#81c784', '#ffb74d', '#e57373',
  '#7986cb', '#a1887f', '#4db6ac', '#f06292', '#9575cd',
] as const

/** Deterministically maps a conversationId to one of a fixed set of colors, so a given split
 *  conversation always gets the same color across reloads with nothing persisted — same idea as
 *  hashing to a palette index. Used to color-code Sessions rows that are really one conversation
 *  split across multiple session cards, so the eye can group them without an extra column. */
export function getConversationColor(conversationId: string): string {
  let hash = 0
  for (let i = 0; i < conversationId.length; i++) {
    hash = (hash * 31 + conversationId.charCodeAt(i)) | 0
  }
  return CONVERSATION_COLORS[Math.abs(hash) % CONVERSATION_COLORS.length]
}

export { formatTraceIdHash } from './hash'

// ── Session helpers (reads from signals) ──────────────────────────────────────

export function getAllSessionsChronological(): SessionSummaryCard[] {
  return sessionSummary.value?.sessions ?? []
}

// Canonical session timestamp: "YYYY-MM-DD HH:MM:SS" — used as the primary session identifier.
export function formatSessionTime(sess: { startTime?: string }): string {
  if (!sess?.startTime) return '—'
  const d = new Date(sess.startTime)
  if (isNaN(d.getTime())) return '—'
  return tsFormat(d)
}

// Full ISO-like format for any Date.
function tsFormat(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// Compact chart-axis label — drops date when within today, drops seconds for wider ranges.
export function formatSessionTimeShort(sess: { startTime?: string }): string {
  if (!sess?.startTime) return '—'
  const d = new Date(sess.startTime)
  if (isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return `${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ISO date string "YYYY-MM-DD" for a session's start time.
export function sessionDateKey(sess: { startTime?: string }): string {
  if (!sess?.startTime) return ''
  const d = new Date(sess.startTime)
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

// Friendly day label for grouping sessions.
export function formatDayLabel(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00')
  const today = new Date(); today.setHours(0,0,0,0)
  const diff = today.getTime() - d.getTime()
  if (diff < 86_400_000)       return 'Today'
  if (diff < 2 * 86_400_000)   return 'Yesterday'
  if (diff < 7 * 86_400_000)   return d.toLocaleDateString('en', { weekday: 'long' })
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: diff > 365 * 86_400_000 ? 'numeric' : undefined })
}

export function getSessionGlobalNumber(sess: SessionSummaryCard): number {
  const all = getAllSessionsChronological()
  if (!sess || all.length === 0) return 0
  const idx = all.indexOf(sess)
  if (idx !== -1) return idx + 1
  for (let i = 0; i < all.length; i++) {
    const s = all[i]
    if (sess.sessionId && s.sessionId === sess.sessionId) return i + 1
    if (sess.traceId && sess.startTime && s.traceId === sess.traceId && s.startTime === sess.startTime) return i + 1
    if (sess.traceId && sess.userRequest && s.traceId === sess.traceId && s.userRequest === sess.userRequest) return i + 1
  }
  return 0
}

export function buildDisplaySummary(sessionsOverride?: SessionSummaryCard[]) {
  const sessions = sessionsOverride ?? displaySessions.value
  let totalInputTokens = 0, totalOutputTokens = 0, totalLlmCalls = 0, cacheRead = 0
  sessions.forEach(s => {
    totalInputTokens += s.inputTokens ?? 0
    totalOutputTokens += s.outputTokens ?? 0
    totalLlmCalls += s.totalLlmCalls ?? 0
    cacheRead += s.cacheReadTokens ?? 0
  })
  return {
    sessions,
    efficiency: {
      totalInputTokens,
      totalOutputTokens,
      totalLlmCalls,
      avgInputPerCall: totalLlmCalls > 0 ? Math.round(totalInputTokens / totalLlmCalls) : 0,
      cacheHitRate: totalInputTokens > 0 ? cacheRead / totalInputTokens : 0,
      toolDefWaste: sessionSummary.value?.efficiency?.toolDefWaste ?? 0,
    },
  }
}

export function getAgentDotHtml(source: string | null | undefined): string {
  if (!source) return ''
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${getAgentColor(source)};vertical-align:middle" title="${getAgentSourceLabel(source)}"></span>`
}

// ── Label formatters ──────────────────────────────────────────────────────────

export function formatLlmLabel(entry: { action?: string }): string {
  const action = entry.action ?? ''
  if (action.indexOf('called ') === 0) {
    const tools = action.substring(7).split(/[,\s]+/).filter(Boolean)
    const counts: Record<string, number> = {}
    tools.forEach(t => { counts[t] = (counts[t] ?? 0) + 1 })
    const parts = Object.keys(counts).map(t => {
      const shortName = t.replace(/^execute_tool\s*/, '')
      return counts[t] > 1 ? counts[t] + '× ' + shortName : shortName
    })
    return 'Decide → ' + parts.join(', ')
  }
  if (action === 'text response') return 'Respond with answer'
  return action || 'LLM call'
}

export function formatToolLabel(entry: { label?: string; toolInput?: string }): string {
  const label = entry.label ?? ''
  const parts = label.match(/^(\S+)\s*([\s\S]*)$/)
  if (!parts) return label
  const toolName = parts[1]
  const args = parts[2] ?? ''

  // For Claude Code tools the label is just the tool name with no args.
  // Parse toolInput (JSON or raw string) to build a meaningful label.
  if (!args.trim() && entry.toolInput) {
    const raw = entry.toolInput.trimStart()
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const fp = String(parsed.file_path || parsed.filePath || '')
        if (fp) {
          const base = fp.split(/[\\/]/).pop() || fp
          // MultiEdit may touch multiple files
          if (toolName === 'MultiEdit' && Array.isArray(parsed.edits)) {
            const count = (parsed.edits as unknown[]).length
            return toolName + ' ' + base + (count > 1 ? ' +' + (count - 1) : '')
          }
          return toolName + ' ' + base
        }
        if (parsed.command) {
          const cmd = String(parsed.command)
          return 'Bash ' + (cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd)
        }
        if (parsed.pattern) return toolName + ' ' + String(parsed.pattern)
        if (parsed.query)   return toolName + ' ' + String(parsed.query)
      } catch { /* fall through */ }
    } else {
      // Raw string — bash command or file path
      const isFilePath = raw.startsWith('/') || raw.startsWith('~') || /^[A-Za-z]:[/\\]/.test(raw)
      if (isFilePath) return toolName + ' ' + (raw.split(/[\\/]/).pop() || raw)
      return 'Bash ' + (raw.length > 60 ? raw.slice(0, 57) + '…' : raw)
    }
  }

  switch (toolName) {
    case 'read_file': {
      const m = args.match(/^(\S+)\s*L(\d+)-(\d+)$/)
      if (m) return 'Read ' + m[1] + ' :' + m[2] + '-' + m[3]
      return 'Read ' + args
    }
    case 'file_search': {
      const file = args.replace(/^\*\*\//, '').split(/[\\/]/).pop() ?? args
      if (file.indexOf('*') !== -1) return 'Find files matching ' + file
      return 'Find ' + file
    }
    case 'grep_search': {
      const gm = args.match(/^"([^"]*?)"\s+in\s+(.*)$/)
      if (gm) {
        const inFile = gm[2].replace(/^\*\*\//, '').split(/[\\/]/).pop() ?? gm[2]
        return 'Grep "' + gm[1] + '" in ' + inFile
      }
      return 'Grep ' + args
    }
    case 'list_dir': return 'List ' + args + '/'
    case 'manage_todo_list': {
      const tm = args.match(/(\d+)\s*items?\s*\(([^)]+)\)/)
      if (tm) return 'Update todos (' + tm[2] + ')'
      const nm = args.match(/(\d+)\s*items?/)
      if (nm) return 'Update todos (' + nm[1] + ' items)'
      return 'Check todos'
    }
    case 'semantic_search': return 'Search codebase ' + args
    case 'replace_string_in_file':
    case 'multi_replace_string_in_file': return 'Edit ' + args
    case 'create_file': return 'Create ' + args
    case 'run_in_terminal': return 'Run: ' + (args.length > 60 ? args.slice(0, 57) + '…' : args)
    case 'explore_subagent':
    case 'runSubagent': return 'Sub-agent: ' + args
    default: return toolName + (args ? ' ' + args : '')
  }
}

export function formatToolResult(entry: { resultSummary?: string }): string {
  const rs = entry.resultSummary ?? ''
  if (!rs || rs === 'empty') return ''
  if (rs === 'No todo list found.') return 'none'
  if (rs.match(/^Successfully/)) return 'ok'
  if (rs === 'no list') return 'none'
  return rs
}

// ── Sparkline / chart helpers ─────────────────────────────────────────────────

export function drawSparkline(containerId: string, dataPoints: number[]): void {
  const el = document.getElementById(containerId)
  if (!el || dataPoints.length < 2) { if (el) el.innerHTML = ''; return }
  const w = el.offsetWidth || 160, h = 30
  const max = Math.max(...dataPoints) || 1
  const pts = dataPoints.map((v, i) =>
    (i / (dataPoints.length - 1)) * w + ',' + (h - (v / max) * (h - 4) - 2)
  ).join(' ')
  el.innerHTML = `<svg width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.7"/></svg>`
}
