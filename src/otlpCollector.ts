import * as http from 'http'
import * as vscode from 'vscode'
import { SessionStore } from './sessionStore'
import { SpanAttribute } from './types'

const MAX_BODY_BYTES = 50 * 1024 * 1024 // 50 MB

export class OtlpCollector {
  private server!: http.Server
  // Sticky fallback trace ID for Codex: reused across payloads in the same session
  // (resets after 30 s of inactivity so back-to-back sessions don't merge).
  private ingestionEnabled = true
  private codexFallbackTraceId = ''
  private codexLastActivityMs = 0
  // Maps traceId → root spanId so child Codex spans get a synthetic parentSpanId.
  private codexSessionRootByTrace = new Map<string, string>()
  private codexCurrentSessionByConversation = new Map<string, string>()
  private codexSessionStateById = new Map<string, { hasPrompt: boolean }>()
  private codexSessionByOtelTraceId = new Map<string, string>()
  private codexPromptOrdinalByConversation = new Map<string, number>()
  private codexActivePromptSessionId = ''
  // Buffers gen_ai.choice / gen_ai.assistant.message log event content keyed by traceId:spanId.
  // Spans and their log events arrive on separate HTTP requests; this handles either ordering.
  // Capped at 500 entries to evict orphaned entries when a span is dropped by the agent exporter.
  private genAiResponseBuffer = new Map<string, string>()
  private readonly GEN_AI_BUFFER_MAX = 500

  constructor(
    private port: number,
    private store: SessionStore,
    private output: vscode.OutputChannel
  ) {}

  setIngestionEnabled(on: boolean) {
    this.ingestionEnabled = on
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      let size = 0
      let aborted = false

      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          aborted = true
          req.destroy()
          this.log(req.method ?? '?', req.url ?? '/', 413, size, 'body too large')
          res.writeHead(413)
          res.end()
          return
        }
        chunks.push(chunk)
      })

      req.on('error', (err) => {
        this.log(req.method ?? '?', req.url ?? '/', 400, size, `request error: ${err.message}`)
        if (!res.headersSent) {
          res.writeHead(400)
          res.end()
        }
      })

      req.on('end', () => {
        if (aborted || req.destroyed) {return}

        const body = Buffer.concat(chunks).toString('utf-8')
        const bodyLen = body.length
        
        if (req.method === 'GET' && req.url === '/traceroost/plugin') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ traceroost: true, kind: 'plugin' }))
          return
        }

        if (req.method !== 'POST') {
          this.log(req.method ?? '?', req.url ?? '/', 200, bodyLen, 'ignored (non-POST)')
          res.writeHead(200)
          res.end()
          return
        }

        let payload: unknown
        try {
          payload = JSON.parse(body)
        } catch {
          this.log('POST', req.url ?? '/', 200, bodyLen, 'non-JSON payload (protobuf?)')
          res.writeHead(200)
          res.end()
          return
        }

        if (!this.ingestionEnabled) {
          res.writeHead(200)
          res.end()
          return
        }

        let summary: string
        if (req.url === '/v1/traces' || this.isOtlpTracePayload(payload)) {
          const count = this.processTraces(payload, req.url ?? '/v1/traces')
          summary = `${count} span${count !== 1 ? 's' : ''} ingested`
        } else if (req.url === '/v1/logs' || this.isOtlpLogPayload(payload)) {
          const count = this.processLogs(payload)
          summary = `${count} log${count !== 1 ? 's' : ''} ingested`
        } else if (req.url === '/v1/metrics' || this.isOtlpMetricPayload(payload)) {
          const { metrics, points } = this.processMetrics(payload)
          summary = `${metrics} metric${metrics !== 1 ? 's' : ''}, ${points} point${points !== 1 ? 's' : ''}`
        } else {
          summary = 'unrecognized payload'
        }

        this.log('POST', req.url ?? '/', 200, bodyLen, summary)
        res.writeHead(200)
        res.end()
      })
    })

    this.server.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        this.output.appendLine(`[OTLP] ERR server: ${err.message}`)
      }
    })
    
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
  }

  /** Single structured log line per request: method, path, status, size, summary */
  private log(method: string, path: string, status: number, bytes: number, summary: string) {
    this.output.appendLine(`[OTLP] ${method} ${path} ${status} ${bytes}B → ${summary}`)
  }

  private isOtlpTracePayload(payload: unknown): payload is { resourceSpans: unknown[] } {
    if (typeof payload !== 'object' || payload === null) {return false}
    return Array.isArray((payload as Record<string, unknown>).resourceSpans)
  }

  private isOtlpLogPayload(payload: unknown): payload is { resourceLogs: unknown[] } {
    if (typeof payload !== 'object' || payload === null) {return false}
    return Array.isArray((payload as Record<string, unknown>).resourceLogs)
  }

  private isOtlpMetricPayload(payload: unknown): payload is { resourceMetrics: unknown[] } {
    if (typeof payload !== 'object' || payload === null) {return false}
    return Array.isArray((payload as Record<string, unknown>).resourceMetrics)
  }

  private processMetrics(payload: unknown): { metrics: number; points: number } {
    type MetricPoint = Record<string, unknown>
    type Metric = {
      sum?: { dataPoints?: MetricPoint[] }
      gauge?: { dataPoints?: MetricPoint[] }
      histogram?: { dataPoints?: MetricPoint[] }
      exponentialHistogram?: { dataPoints?: MetricPoint[] }
    }
    type ScopeMetrics = { metrics?: Metric[] }
    type ResourceMetrics = { scopeMetrics?: ScopeMetrics[] }

    const p = payload as { resourceMetrics?: ResourceMetrics[] }
    const rms = p.resourceMetrics ?? []

    let metricCount = 0
    let pointCount = 0
    for (const rm of rms) {
      for (const sm of rm.scopeMetrics ?? []) {
        const metrics = sm.metrics ?? []
        metricCount += metrics.length
        for (const m of metrics) {
          pointCount += m.sum?.dataPoints?.length ?? 0
          pointCount += m.gauge?.dataPoints?.length ?? 0
          pointCount += m.histogram?.dataPoints?.length ?? 0
          pointCount += m.exponentialHistogram?.dataPoints?.length ?? 0
        }
      }
    }

    return { metrics: metricCount, points: pointCount }
  }

  private findAttr(attrs: SpanAttribute[], key: string): SpanAttribute | undefined {
    return attrs.find(a => a.key === key)
  }

  private getAttrFrom(attrs: SpanAttribute[], keys: string[]): string {
    for (const key of keys) {
      const a = this.findAttr(attrs, key)
      if (!a) {continue}
      const val = a.value?.stringValue ?? a.value?.intValue ?? a.value?.doubleValue
      if (val !== undefined && val !== null && String(val).length > 0) {
        return String(val)
      }
    }
    return ''
  }

  private withStringAttr(attrs: SpanAttribute[], key: string, value: string): SpanAttribute[] {
    if (!value || attrs.some(a => a.key === key)) { return attrs }
    return [...attrs, { key, value: { stringValue: value } }]
  }

  private setStringAttr(attrs: SpanAttribute[], key: string, value: string): SpanAttribute[] {
    if (!value) { return attrs }
    let replaced = false
    const next = attrs.map(attr => {
      if (attr.key !== key) { return attr }
      replaced = true
      return { key, value: { stringValue: value } }
    })
    return replaced ? next : [...next, { key, value: { stringValue: value } }]
  }

  private getCodexSessionState(sessionId: string): { hasPrompt: boolean } {
    let state = this.codexSessionStateById.get(sessionId)
    if (!state) {
      state = { hasPrompt: false }
      this.codexSessionStateById.set(sessionId, state)
    }
    return state
  }

  private nextCodexPromptSessionId(conversationId: string): string {
    const next = (this.codexPromptOrdinalByConversation.get(conversationId) ?? 0) + 1
    this.codexPromptOrdinalByConversation.set(conversationId, next)
    return `codex:${conversationId}:prompt-${next}`
  }

  private isCodexPromptSpanName(name: string): boolean {
    return name === 'codex.user_prompt'
      || name === 'codex.prompt'
      || name === 'codex.user_message'
      || name === 'codex.session_start'
  }

  private resolveCodexSessionId(opts: {
    conversationId: string
    otlpTraceId?: string
    turnId?: string
    spanName: string
  }): string | undefined {
    const conversationId = opts.conversationId
    const isPrompt = this.isCodexPromptSpanName(opts.spanName)
    let sessionId = opts.otlpTraceId ? this.codexSessionByOtelTraceId.get(opts.otlpTraceId) : undefined

    if (isPrompt) {
      const currentSessionId = this.codexCurrentSessionByConversation.get(conversationId)
      const currentState = currentSessionId ? this.getCodexSessionState(currentSessionId) : undefined
      if (!sessionId && currentSessionId && !currentState?.hasPrompt) {
        sessionId = currentSessionId
      }
      if (!sessionId) {
        sessionId = opts.turnId
          ? `codex:${conversationId}:${opts.turnId}`
          : this.nextCodexPromptSessionId(conversationId)
      } else if (this.getCodexSessionState(sessionId).hasPrompt) {
        sessionId = opts.turnId
          ? `codex:${conversationId}:${opts.turnId}`
          : this.nextCodexPromptSessionId(conversationId)
      }
    } else if (sessionId) {
      // Keep using the already-normalized prompt-to-response session for this OTLP trace.
    } else if (this.codexCurrentSessionByConversation.has(conversationId)) {
      sessionId = this.codexCurrentSessionByConversation.get(conversationId)
    } else if (this.codexActivePromptSessionId) {
      sessionId = this.codexActivePromptSessionId
    } else if (opts.turnId) {
      sessionId = `codex:${conversationId}:${opts.turnId}`
    } else {
      return undefined
    }

    if (!sessionId) { return undefined }
    this.codexCurrentSessionByConversation.set(conversationId, sessionId)
    if (opts.otlpTraceId) { this.codexSessionByOtelTraceId.set(opts.otlpTraceId, sessionId) }
    const state = this.getCodexSessionState(sessionId)
    if (isPrompt) {
      state.hasPrompt = true
      this.codexActivePromptSessionId = sessionId
    }
    return sessionId
  }

  private isCodexTraceSpan(spanName: string, attrs: SpanAttribute[]): boolean {
    const threadId = this.getAttrFrom(attrs, ['thread.id', 'thread_id'])
    const turnId = this.getAttrFrom(attrs, ['turn.id', 'turn_id'])
    if (threadId && turnId) { return true }

    const otelName = this.getAttrFrom(attrs, ['otel.name'])
    return otelName.startsWith('session_task.')
      || otelName === 'completed'
      || spanName === 'handle_responses'
  }

  private isCodexWebsocketSpan(spanName: string, attrs: SpanAttribute[]): boolean {
    const name = spanName.toLowerCase()
    if (!name.includes('websocket')) { return false }
    const eventName = this.getAttrFrom(attrs, ['event.name', 'event_name', 'name', 'event']).toLowerCase()
    const hasCodexAttr = Boolean(this.getAttrFrom(attrs, [
      'codex.session.id',
      'codex.conversation.id',
      'codex.turn.id',
    ]))
    return name.startsWith('codex.') || eventName.startsWith('codex.') || hasCodexAttr
  }

  private toSpanAttributes(raw: unknown): SpanAttribute[] {
    if (!Array.isArray(raw)) {return []}
    return raw
      .map(item => {
        const obj = item as Record<string, unknown>
        const key = typeof obj.key === 'string' ? obj.key : ''
        const value = obj.value as SpanAttribute['value'] | undefined
        if (!key || !value || typeof value !== 'object') {return undefined}
        return { key, value }
      })
      .filter((x): x is SpanAttribute => Boolean(x))
  }

  private mergeAttributes(...lists: SpanAttribute[][]): SpanAttribute[] {
    const out: SpanAttribute[] = []
    const seen = new Set<string>()
    for (const list of lists) {
      for (const attr of list) {
        if (seen.has(attr.key)) {continue}
        seen.add(attr.key)
        out.push(attr)
      }
    }
    return out
  }

  private attrsFromBodyKv(body: unknown): SpanAttribute[] {
    if (typeof body !== 'object' || body === null) {return []}
    const obj = body as Record<string, unknown>
    const kv = obj.kvlistValue as Record<string, unknown> | undefined
    const values = kv?.values
    if (!Array.isArray(values)) {return []}
    const attrs: SpanAttribute[] = []
    for (const v of values) {
      const entry = v as Record<string, unknown>
      const key = typeof entry.key === 'string' ? entry.key : ''
      const value = entry.value as SpanAttribute['value'] | undefined
      if (!key || !value || typeof value !== 'object') {continue}
      attrs.push({ key, value })
    }
    return attrs
  }

  private processLogs(payload: unknown): number {
    type LogRecord = Record<string, unknown>
    type ScopeLogs = { logRecords?: LogRecord[]; scope?: { attributes?: unknown } }
    type ResourceLogs = { scopeLogs?: ScopeLogs[]; resource?: { attributes?: unknown } }
    const p = payload as { resourceLogs?: ResourceLogs[] }

    const now = Date.now()
    // Refresh the sticky Codex trace ID if more than 30 s have passed since last Codex activity.
    if (!this.codexFallbackTraceId || now - this.codexLastActivityMs > 30_000) {
      this.codexFallbackTraceId = `codex-${now}`
    }
    // Per-payload fallback for Claude tool_result logs (session.id is the primary key there).
    const claudeLogFallbackTraceId = `claude-log-${now}`

    let count = 0
    const resourceLogs = p?.resourceLogs ?? []
    for (const rl of resourceLogs) {
      const resourceAttrs = this.toSpanAttributes(rl.resource?.attributes)
      for (const sl of rl.scopeLogs ?? []) {
        const scopeAttrs = this.toSpanAttributes(sl.scope?.attributes)
        for (const rec of sl.logRecords ?? []) {
          const recordAttrs = this.toSpanAttributes(rec.attributes)
          const bodyAttrs = this.attrsFromBodyKv(rec.body)
          let attrs = this.mergeAttributes(recordAttrs, bodyAttrs, scopeAttrs, resourceAttrs)

          const bodyObj = (typeof rec.body === 'object' && rec.body !== null)
            ? (rec.body as Record<string, unknown>)
            : undefined

          const eventName = this.getAttrFrom(attrs, ['event.name', 'event_name', 'name', 'event'])
            || (typeof bodyObj?.stringValue === 'string' ? bodyObj.stringValue : '')

          const logToolName = this.getAttrFrom(attrs, ['tool.name'])
          const isCodexEvent = eventName.startsWith('codex.')
          const isClaudeToolResult = eventName === 'tool_result' && logToolName !== ''

          // gen_ai_latest_experimental: response content arrives as log events rather than span attributes.
          // Buffer by traceId:spanId so it can be injected when the matching LLM span arrives,
          // or injected retroactively if the span is already stored.
          const isGenAiContent = eventName === 'gen_ai.choice' || eventName === 'gen_ai.assistant.message'
          if (isGenAiContent) {
            const logTraceId = typeof rec.traceId === 'string' ? rec.traceId : ''
            const logSpanId = typeof rec.spanId === 'string' ? rec.spanId : ''
            if (logTraceId && logSpanId) {
              const raw = this.getAttrFrom(attrs, ['gen_ai.event.content'])
              const formatted = raw ? this.formatGenAiEventContent(raw, eventName) : ''
              if (formatted) {
                const bufKey = `${logTraceId}:${logSpanId}`
                this.genAiResponseBuffer.set(bufKey, formatted)
                // Evict oldest entry when cap is exceeded (guards against orphaned entries
                // if the matching span is never received).
                if (this.genAiResponseBuffer.size > this.GEN_AI_BUFFER_MAX) {
                  const firstKey = this.genAiResponseBuffer.keys().next().value
                  if (firstKey !== undefined) { this.genAiResponseBuffer.delete(firstKey) }
                }
                // If the span already exists in the store, inject immediately and remove
                // from buffer — the span-before-log ordering means processTraces already
                // ran and will not call genAiResponseBuffer.delete() for this key.
                const injected = this.store.injectSpanAttribute(logTraceId, logSpanId, 'gen_ai.output.messages', formatted)
                if (injected) { this.genAiResponseBuffer.delete(bufKey) }
              }
            }
            continue
          }

          if (!isCodexEvent && !isClaudeToolResult) {continue}
          if (isCodexEvent && this.isCodexWebsocketSpan(eventName, attrs)) {continue}

          let traceId: string
          let spanName: string

          const spanId = (typeof rec.spanId === 'string' && rec.spanId)
            ? rec.spanId
            : this.getAttrFrom(attrs, ['span_id', 'spanId']) || `cl-${Math.random().toString(36).slice(2, 10)}`

          if (isClaudeToolResult) {
            // Use the OTLP-level traceId if Claude Code propagated trace context to the log record;
            // fall back to session.id attribute which Claude Code sets on every tool_result event.
            traceId = (typeof rec.traceId === 'string' && rec.traceId)
              ? rec.traceId
              : this.getAttrFrom(attrs, ['session.id', 'session_id']) || claudeLogFallbackTraceId
            spanName = 'claude_code.tool_result'
          } else {
            const otlpTraceId = typeof rec.traceId === 'string' && rec.traceId ? rec.traceId : ''
            const convId = this.getAttrFrom(attrs, [
              'conversation.id', 'conversation_id',
              'codex.conversation.id',
              'thread.id', 'thread_id',
              'session.id', 'session_id',
              'trace_id', 'traceId',
            ])
            // Drop background Codex API calls (e.g. GET /models) that have no conversation context.
            // These would otherwise pollute the active session via the fallback traceId.
            if (!otlpTraceId && !convId) { continue }
            spanName = eventName
            const turnId = this.getAttrFrom(attrs, ['turn.id', 'turn_id', 'codex.turn.id'])
            const conversationKey = convId || otlpTraceId || this.codexFallbackTraceId
            const sessionId = this.resolveCodexSessionId({
              conversationId: conversationKey,
              otlpTraceId,
              turnId,
              spanName,
            })
            traceId = sessionId || otlpTraceId || conversationKey
            if (sessionId) {
              attrs = this.setStringAttr(attrs, 'codex.session.id', sessionId)
              attrs = this.setStringAttr(attrs, 'codex.conversation.id', conversationKey)
              if (turnId) { attrs = this.setStringAttr(attrs, 'codex.turn.id', turnId) }
            }
            if (otlpTraceId && sessionId && otlpTraceId !== traceId) {
              attrs = this.withStringAttr(attrs, 'otel.trace_id', otlpTraceId)
            }
            this.codexLastActivityMs = now
          }

          let parentSpanId = this.getAttrFrom(attrs, ['parent_span_id', 'parentSpanId']) || undefined

          // Synthesize parent-child links for Codex spans (they carry no parentSpanId).
          // Session root spans become depth-0 anchors; all other spans become their children.
          if (isCodexEvent) {
            if (this.isCodexPromptSpanName(spanName)) {
              this.codexSessionRootByTrace.set(traceId, spanId)
            } else if (traceId && !parentSpanId) {
              parentSpanId = this.codexSessionRootByTrace.get(traceId)
            }
          }

          // Codex doesn't populate timeUnixNano; it puts an ISO timestamp in event.timestamp.
          // Use it to derive real start/end times so Latency and sorting work correctly.
          let startTimeNano = String(rec.timeUnixNano ?? rec.observedTimeUnixNano ?? '0')
          let endTimeNano = startTimeNano
          if (startTimeNano === '0') {
            const ts = this.getAttrFrom(attrs, ['event.timestamp'])
            if (ts) {
              const ms = new Date(ts).getTime()
              if (ms > 0) {
                const endNs = String(BigInt(ms) * BigInt(1_000_000))
                const durMs = parseInt(this.getAttrFrom(attrs, ['duration_ms']) || '0') || 0
                endTimeNano = endNs
                startTimeNano = durMs > 0
                  ? String(BigInt(endNs) - BigInt(durMs) * BigInt(1_000_000))
                  : endNs
              }
            }
          }

          this.store.addSpan({
            traceId,
            spanId,
            parentSpanId,
            name: spanName,
            startTime: startTimeNano,
            endTime: endTimeNano,
            attributes: attrs,
            status: undefined,
          })
          count++
        }
      }
    }
    return count
  }

  private processTraces(payload: unknown, collectorPath = '/v1/traces'): number {
    const p = payload as {
      resourceSpans?: Array<{ resource?: { attributes?: unknown }; scopeSpans?: Array<{ spans?: unknown[] }> }>
    }
    const resourceSpans = p?.resourceSpans ?? []

    let count = 0
    for (const rs of resourceSpans) {
      // Resource attributes (e.g. session.id) apply to every span emitted by this
      // process — merge them in so per-span attribute lookups can see them too.
      // Mirrors the same merge already done for log records in processLogs().
      const resourceAttrs = this.toSpanAttributes(rs.resource?.attributes)
      const rawSpans = rs.scopeSpans?.flatMap((ss) => ss.spans ?? []) ?? []

      for (const raw of rawSpans) {
        const span = raw as Record<string, unknown>
        if (typeof span.traceId !== 'string' || typeof span.spanId !== 'string' || typeof span.name !== 'string') {
          continue
        }

        let attrs = this.mergeAttributes(this.toSpanAttributes(span.attributes), resourceAttrs)
        if (this.isCodexWebsocketSpan(span.name, attrs)) { continue }
        let traceId = span.traceId
        const parentSpanId = (span.parentSpanId as string) || undefined
        const mappedCodexSessionId = this.codexSessionByOtelTraceId.get(span.traceId)
        if (mappedCodexSessionId) {
          traceId = mappedCodexSessionId
          attrs = this.setStringAttr(attrs, 'codex.session.id', mappedCodexSessionId)
          attrs = this.withStringAttr(attrs, 'otel.trace_id', span.traceId)
        } else if (this.isCodexTraceSpan(span.name, attrs)) {
          const conversationId = this.getAttrFrom(attrs, [
            'thread.id', 'thread_id',
            'conversation.id', 'conversation_id',
            'codex.conversation.id',
          ])
          const turnId = this.getAttrFrom(attrs, ['turn.id', 'turn_id', 'codex.turn.id'])
          if (conversationId && turnId) {
            const sessionId = this.resolveCodexSessionId({
              conversationId,
              otlpTraceId: span.traceId,
              turnId,
              spanName: span.name,
            })
            if (sessionId) {
              traceId = sessionId
              attrs = this.setStringAttr(attrs, 'codex.session.id', sessionId)
              attrs = this.setStringAttr(attrs, 'codex.conversation.id', conversationId)
              attrs = this.setStringAttr(attrs, 'codex.turn.id', turnId)
            }
            if (sessionId && span.traceId !== traceId) {
              attrs = this.withStringAttr(attrs, 'otel.trace_id', span.traceId)
            }
            if (sessionId && !parentSpanId && !this.codexSessionRootByTrace.has(traceId)) {
              this.codexSessionRootByTrace.set(traceId, span.spanId)
            }
          }
        }
        // Inject gen_ai response content buffered from a prior log event, if available.
        const bufKey = `${traceId}:${span.spanId}`
        const bufferedContent = this.genAiResponseBuffer.get(bufKey)
        if (bufferedContent) {
          attrs = this.setStringAttr(attrs, 'gen_ai.output.messages', bufferedContent)
          this.genAiResponseBuffer.delete(bufKey)
        }
        this.store.addSpan({
          traceId,
          spanId: span.spanId,
          parentSpanId,
          name: span.name,
          startTime: span.startTimeUnixNano as string,
          endTime: span.endTimeUnixNano as string,
          attributes: this.setStringAttr(attrs, '_traceroost.collector_path', collectorPath),
          status: span.status as { code: number; message?: string } | undefined
        })
        count++
      }
    }
    return count
  }

  // Normalises a gen_ai.choice or gen_ai.assistant.message event content value into the
  // gen_ai.output.messages array format expected by extractResponseText in the summarizer.
  private formatGenAiEventContent(raw: string, eventName: string): string {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      // gen_ai.choice wraps the message: { finish_reason, index, message: { role, content } }
      const msg: Record<string, unknown> = eventName === 'gen_ai.choice' && parsed.message
        ? parsed.message as Record<string, unknown>
        : parsed
      const role = msg.role ?? 'assistant'
      let content = msg.content
      // Normalise string content to block array format for extractResponseText compatibility
      if (typeof content === 'string') {
        content = [{ type: 'text', text: content }]
      }
      return JSON.stringify([{ role, content }])
    } catch { return '' }
  }

  async stop() {
    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => resolve())
      // Force close after 2 seconds
      setTimeout(() => resolve(), 2000)
    })
  }
}
