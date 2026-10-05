import * as vscode from 'vscode'
import { Span, SpanAttribute, SessionSummary } from './types'
import { nanoToMs } from './summarizers/helpers'
import { pruneSpans, DEFAULT_MAX_SPANS } from './spanStore'

export type { Span, SessionSummary } from './types'

// Ceiling on spans held in memory regardless of the retention rules below — the same cap the
// standalone server uses for its own span list.
const MAX_LIVE_SPANS = DEFAULT_MAX_SPANS

export class SessionStore {
  private spans: Span[] = []
  private summary: SessionSummary = this.emptySummary()
  private onUpdateCallbacks: Array<(traceId?: string) => void> = []
  // Rolling window: a trace's spans are dropped from memory once nothing has arrived for that
  // trace for this long (its sessions have been persisted to SQLite by the phase-2 writer).
  // Retention is per trace, not per span: trimming individual spans older than the window
  // meant any run longer than 5 minutes was summarized — and persisted — from only its last
  // 5 minutes of spans, since the writer re-summarizes the whole card from this window.
  private readonly SPAN_WINDOW_MS = 5 * 60 * 1000
  // A trace whose root span (claude_code.interaction / invoke_agent) hasn't arrived yet is still
  // running — its children can be separated by long quiet stretches (a slow tool call, a
  // permission prompt), so it's kept up to this long past its last activity instead.
  private readonly OPEN_TRACE_MAX_IDLE_MS = 6 * 60 * 60 * 1000
  // trimSpans is O(n); run it at most this often rather than on every single span.
  private readonly TRIM_INTERVAL_MS = 1_000
  private lastTrimMs = 0
  private readonly traceLastActivity = new Map<string, number>()
  private readonly openTraces = new Set<string>()
  private readonly closedTraces = new Set<string>()

  onUpdate(fn: (traceId?: string) => void): { dispose(): void } {
    this.onUpdateCallbacks.push(fn)
    return { dispose: () => {
      const i = this.onUpdateCallbacks.indexOf(fn)
      if (i >= 0) { this.onUpdateCallbacks.splice(i, 1) }
    }}
  }

  // Bumped on every change to `spans` (or a span in it), so readers can tell whether something
  // derived from getSpans() is still current — see SessionRepository.listSessions's memo.
  private _version = 0
  get version(): number { return this._version }

  private notifyUpdate(traceId?: string): void {
    for (const fn of this.onUpdateCallbacks) { fn(traceId) }
  }

  constructor(
    _context: vscode.ExtensionContext,
    private readonly now: () => number = Date.now,
    private readonly maxSpans: number = MAX_LIVE_SPANS,
  ) {}

  addSpan(span: Span) {
    if (span.receivedAt === undefined) { span.receivedAt = this.now() }
    this._version++
    this.spans.push(span)
    this.trackTrace(span)
    this.updateSummary(span)
    this.trimSpans()
    this.notifyUpdate(span.traceId)
  }

  private trackTrace(span: Span): void {
    const traceId = span.traceId
    if (!traceId) { return }
    const at = span.receivedAt ?? this.now()
    if (at > (this.traceLastActivity.get(traceId) ?? 0)) { this.traceLastActivity.set(traceId, at) }
    if (span.name === 'claude_code.interaction' || span.name.startsWith('invoke_agent')) {
      this.closedTraces.add(traceId)
      this.openTraces.delete(traceId)
    } else if (!this.closedTraces.has(traceId) && (
      span.name === 'claude_code.llm_request' || span.name === 'claude_code.tool'
      || span.name.startsWith('chat') || span.name.startsWith('execute_tool')
    )) {
      this.openTraces.add(traceId)
    }
  }

  private trimSpans(): void {
    const now = this.now()
    // Hard memory cap first — cheap length check, so it's enforced on every span.
    if (pruneSpans(this.spans, this.maxSpans) > 0) { this.forgetMissingTraces() }
    if (now - this.lastTrimMs < this.TRIM_INTERVAL_MS) { return }
    this.lastTrimMs = now
    const cutoff = now - this.SPAN_WINDOW_MS
    const openCutoff = now - this.OPEN_TRACE_MAX_IDLE_MS
    const before = this.spans.length
    this.spans = this.spans.filter(s => {
      if (s.traceId) {
        const last = this.traceLastActivity.get(s.traceId) ?? 0
        if (last === 0 || last > cutoff) { return true }
        return this.openTraces.has(s.traceId) && last > openCutoff
      }
      const ms = s.receivedAt ?? nanoToMs(s.startTime)
      return ms === 0 || ms > cutoff
    })
    if (this.spans.length !== before) { this.forgetMissingTraces() }
  }

  /** Drops per-trace bookkeeping for traces that no longer have any span in memory. */
  private forgetMissingTraces(): void {
    const present = new Set<string>()
    for (const s of this.spans) { if (s.traceId) { present.add(s.traceId) } }
    for (const id of [...this.traceLastActivity.keys()]) {
      if (!present.has(id)) {
        this.traceLastActivity.delete(id)
        this.openTraces.delete(id)
        this.closedTraces.delete(id)
      }
    }
  }

  private updateSummary(span: Span) {
    this.summary.totalSpans++
    this.summary.lastUpdated = new Date()

    // Detect agent sessions
    if (span.name.includes('agent') || span.name.includes('session')) {
      this.summary.agentSessions++
    }

    // Track tool calls
    if (span.name.includes('tool')) {
      const toolName = span.name.replace('tool/', '')
      this.summary.toolCalls[toolName] = 
        (this.summary.toolCalls[toolName] ?? 0) + 1
    }

    // Extract token usage — covers Copilot and Claude Code (which splits into cache_read/cache_creation)
    const attrs = span.attributes || []
    const intAttr = (key: string) => {
      const a = attrs.find((x: SpanAttribute) => x.key === key)
      return parseInt(String(a?.value?.intValue ?? a?.value?.stringValue ?? 0)) || 0
    }
    const tokensFound = intAttr('input_tokens') + intAttr('prompt_tokens')
      + intAttr('cache_read_tokens') + intAttr('cache_creation_tokens')
      + intAttr('gen_ai.usage.input_tokens')
      + intAttr('gen_ai.usage.cache_read.input_tokens') + intAttr('gen_ai.usage.cache_creation.input_tokens')
      + intAttr('output_tokens') + intAttr('completion_tokens')
      + intAttr('gen_ai.usage.output_tokens')
    this.summary.tokensUsed += tokensFound

    // Track files changed (write operations only)
    const getAttrVal = (key: string) =>
      span.attributes.find((a: SpanAttribute) => a.key === key)?.value?.stringValue || ''

    // Copilot uses gen_ai.tool.name + gen_ai.tool.call.arguments
    // Claude Code uses tool_name + tool_input
    const toolName = getAttrVal('gen_ai.tool.name') || getAttrVal('tool_name')
    const argsStr = getAttrVal('gen_ai.tool.call.arguments') || getAttrVal('tool_input') || getAttrVal('input')

    const copilotWriteTools = new Set(['replace_string_in_file', 'multi_replace_string_in_file', 'create_file', 'edit_notebook_file', 'apply_patch'])
    const claudeWriteTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
    const isWriteTool = copilotWriteTools.has(toolName) || claudeWriteTools.has(toolName)

    if (isWriteTool && argsStr) {
      try {
        const args = JSON.parse(argsStr)
        // apply_patch: extract file paths from patch content
        if (toolName === 'apply_patch') {
          const patchContent = args.command || args.patch || args.input || ''
          const patchLines = patchContent.split('\n')
          for (const line of patchLines) {
            // Matches: *** Update File: /path, *** Add File: /path, *** Delete File: /path, *** /path
            // Explicitly excludes *** Begin Patch and *** End Patch lines
            const m = line.match(/^\*\*\*\s+(?:Update File:|Add File:|Delete File:)?\s*(.+)/)
            if (m) {
              const fp = m[1].trim()
              if (fp && fp.includes('/') && !this.summary.filesChanged.includes(fp)) {
                this.summary.filesChanged.push(fp)
              }
            }
          }
        } else {
          // filePath (Copilot camelCase) or file_path (Claude Code snake_case)
          const fp = args.filePath || args.file_path
          if (fp && !this.summary.filesChanged.includes(String(fp))) {
            this.summary.filesChanged.push(String(fp))
          }
        }
        // Copilot: multi_replace_string_in_file.replacements[]
        if (args.replacements && Array.isArray(args.replacements)) {
          for (const r of args.replacements) {
            const rfp = r.filePath || r.file_path
            if (rfp && !this.summary.filesChanged.includes(String(rfp))) {
              this.summary.filesChanged.push(String(rfp))
            }
          }
        }
        // Claude Code: MultiEdit.edits[]
        if (args.edits && Array.isArray(args.edits)) {
          for (const e of args.edits) {
            const efp = e.file_path || e.filePath
            if (efp && !this.summary.filesChanged.includes(String(efp))) {
              this.summary.filesChanged.push(String(efp))
            }
          }
        }
      } catch { /* ignore parse errors */ }
    }

    // Track errors
    if (span.status?.code === 2) {this.summary.errors++}
  }

  getSummary() { return this.summary }
  getSpans() { return this.spans }
  export() { return { summary: this.summary, spans: this.spans } }

  // Injects or overwrites a single attribute on an existing span. Used to attach
  // gen_ai log event content (e.g. gen_ai.output.messages) to a span after the fact.
  injectSpanAttribute(traceId: string, spanId: string, key: string, value: string): boolean {
    const span = this.spans.find(s => s.traceId === traceId && s.spanId === spanId)
    if (!span) { return false }
    const existing = span.attributes.find(a => a.key === key)
    if (existing) {
      existing.value = { stringValue: value }
    } else {
      span.attributes.push({ key, value: { stringValue: value } })
    }
    this._version++
    this.notifyUpdate(traceId)
    return true
  }
  
  clear() {
    this._version++
    this.spans = []
    this.summary = this.emptySummary()
    this.traceLastActivity.clear()
    this.openTraces.clear()
    this.closedTraces.clear()
  }

  private emptySummary(): SessionSummary {
    return {
      totalSpans: 0,
      agentSessions: 0,
      toolCalls: {},
      totalDurationMs: 0,
      tokensUsed: 0,
      filesChanged: [],
      errors: 0,
      lastUpdated: new Date()
    }
  }
}
