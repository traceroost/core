import { Span, SpanAttribute } from './types'

export type OtlpPayloadKind = 'traces' | 'logs' | 'metrics' | 'unknown'

export function classifyOtlpPayload(payload: unknown): OtlpPayloadKind {
  if (typeof payload !== 'object' || payload === null) { return 'unknown' }
  const obj = payload as Record<string, unknown>
  if (Array.isArray(obj.resourceSpans)) { return 'traces' }
  if (Array.isArray(obj.resourceLogs)) { return 'logs' }
  if (Array.isArray(obj.resourceMetrics)) { return 'metrics' }
  return 'unknown'
}

/**
 * The elements of `raw` that are non-null objects, or `[]` when `raw` isn't an array. OTLP JSON
 * comes from outside the process — `resourceSpans: [null]`, `attributes: [null]` or a
 * `scopeSpans` that is an object rather than an array must be skipped, not crash the handler.
 */
export function objectItems<T = Record<string, unknown>>(raw: unknown): T[] {
  if (!Array.isArray(raw)) { return [] }
  return raw.filter(item => typeof item === 'object' && item !== null) as T[]
}

export function toSpanAttributes(raw: unknown): SpanAttribute[] {
  return objectItems(raw)
    .map(obj => {
      const key = typeof obj.key === 'string' ? obj.key : ''
      const value = obj.value as SpanAttribute['value'] | undefined
      if (!key || !value || typeof value !== 'object') { return undefined }
      return { key, value }
    })
    .filter((x): x is SpanAttribute => Boolean(x))
}

function attrsFromBodyKv(body: unknown): SpanAttribute[] {
  if (typeof body !== 'object' || body === null) { return [] }
  const obj = body as Record<string, unknown>
  const kv = obj.kvlistValue as Record<string, unknown> | undefined
  const values = kv?.values
  if (!Array.isArray(values)) { return [] }
  const attrs: SpanAttribute[] = []
  for (const entry of objectItems(values)) {
    const key = typeof entry.key === 'string' ? entry.key : ''
    const value = entry.value as SpanAttribute['value'] | undefined
    if (!key || !value || typeof value !== 'object') { continue }
    attrs.push({ key, value })
  }
  return attrs
}

function mergeAttributes(...lists: SpanAttribute[][]): SpanAttribute[] {
  const out: SpanAttribute[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const attr of list) {
      if (seen.has(attr.key)) { continue }
      seen.add(attr.key)
      out.push(attr)
    }
  }
  return out
}

function setStringAttr(attrs: SpanAttribute[], key: string, value: string): SpanAttribute[] {
  if (!value) { return attrs }
  let replaced = false
  const next = attrs.map(attr => {
    if (attr.key !== key) { return attr }
    replaced = true
    return { key, value: { stringValue: value } }
  })
  return replaced ? next : [...next, { key, value: { stringValue: value } }]
}

function withStringAttr(attrs: SpanAttribute[], key: string, value: string): SpanAttribute[] {
  if (!value || attrs.some(attr => attr.key === key)) { return attrs }
  return [...attrs, { key, value: { stringValue: value } }]
}

export function getAttrFrom(attrs: SpanAttribute[], ...keys: string[]): string {
  for (const key of keys) {
    const a = attrs.find(x => x.key === key)
    if (!a) { continue }
    const val = a.value?.stringValue ?? a.value?.intValue ?? a.value?.doubleValue
    if (val !== undefined && val !== null && String(val).length > 0) {
      return String(val)
    }
  }
  return ''
}

function isCodexWebsocketSpan(spanName: string, attrs: SpanAttribute[]): boolean {
  const name = spanName.toLowerCase()
  if (!name.includes('websocket')) { return false }
  const eventName = getAttrFrom(attrs, 'event.name', 'event_name', 'name', 'event').toLowerCase()
  const hasCodexAttr = Boolean(getAttrFrom(attrs, 'codex.session.id', 'codex.conversation.id', 'codex.turn.id'))
  return name.startsWith('codex.') || eventName.startsWith('codex.') || hasCodexAttr
}

export function parseTracePayload(payload: unknown): Span[] {
  const p = payload as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: unknown[] }> }> }
  const rawSpans = objectItems<{ scopeSpans?: unknown }>(p?.resourceSpans).flatMap(rs =>
    objectItems<{ spans?: unknown }>(rs.scopeSpans).flatMap(ss => objectItems(ss.spans))
  )

  const result: Span[] = []
  for (const raw of rawSpans) {
    const span = raw as Record<string, unknown>
    if (typeof span.traceId !== 'string' || typeof span.spanId !== 'string' || typeof span.name !== 'string') {
      continue
    }
    const attrs = toSpanAttributes(span.attributes)
    if (isCodexWebsocketSpan(span.name, attrs)) { continue }
    result.push({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: (span.parentSpanId as string) || undefined,
      name: span.name,
      startTime: span.startTimeUnixNano as string,
      endTime: span.endTimeUnixNano as string,
      attributes: attrs,
      status: span.status as { code: number; message?: string } | undefined,
    })
  }
  return result
}

function isCodexPromptEventName(name: string): boolean {
  return name === 'codex.user_prompt'
    || name === 'codex.prompt'
    || name === 'codex.user_message'
    || name === 'codex.session_start'
}

export function parseLogPayload(payload: unknown): Span[] {
  type LogRecord = Record<string, unknown>
  type ScopeLogs = { logRecords?: LogRecord[]; scope?: { attributes?: unknown } }
  type ResourceLogs = { scopeLogs?: ScopeLogs[]; resource?: { attributes?: unknown } }
  const p = payload as { resourceLogs?: ResourceLogs[] }
  const codexSessionByOtelTraceId = new Map<string, string>()
  const codexCurrentSessionByConversation = new Map<string, string>()
  const codexSessionStateById = new Map<string, { hasPrompt: boolean }>()
  const codexPromptOrdinalByConversation = new Map<string, number>()
  const codexSessionRootByTrace = new Map<string, string>()
  let codexActivePromptSessionId = ''

  function getSessionState(sessionId: string): { hasPrompt: boolean } {
    let state = codexSessionStateById.get(sessionId)
    if (!state) {
      state = { hasPrompt: false }
      codexSessionStateById.set(sessionId, state)
    }
    return state
  }

  function nextPromptSessionId(conversationId: string): string {
    const next = (codexPromptOrdinalByConversation.get(conversationId) ?? 0) + 1
    codexPromptOrdinalByConversation.set(conversationId, next)
    return `codex:${conversationId}:prompt-${next}`
  }

  function resolveSessionId(opts: {
    conversationId: string
    otlpTraceId?: string
    turnId?: string
    spanName: string
  }): string | undefined {
    const isPrompt = isCodexPromptEventName(opts.spanName)
    let sessionId = opts.otlpTraceId ? codexSessionByOtelTraceId.get(opts.otlpTraceId) : undefined

    if (isPrompt) {
      const currentSessionId = codexCurrentSessionByConversation.get(opts.conversationId)
      const currentState = currentSessionId ? getSessionState(currentSessionId) : undefined
      if (!sessionId && currentSessionId && !currentState?.hasPrompt) {
        sessionId = currentSessionId
      }
      if (!sessionId) {
        sessionId = opts.turnId
          ? `codex:${opts.conversationId}:${opts.turnId}`
          : nextPromptSessionId(opts.conversationId)
      } else if (getSessionState(sessionId).hasPrompt) {
        sessionId = opts.turnId
          ? `codex:${opts.conversationId}:${opts.turnId}`
          : nextPromptSessionId(opts.conversationId)
      }
    } else if (sessionId) {
      // Existing raw OTEL trace was already mapped to the active prompt cycle.
    } else if (codexCurrentSessionByConversation.has(opts.conversationId)) {
      sessionId = codexCurrentSessionByConversation.get(opts.conversationId)
    } else if (codexActivePromptSessionId) {
      sessionId = codexActivePromptSessionId
    } else if (opts.turnId) {
      sessionId = `codex:${opts.conversationId}:${opts.turnId}`
    } else {
      return undefined
    }

    if (!sessionId) { return undefined }
    codexCurrentSessionByConversation.set(opts.conversationId, sessionId)
    if (opts.otlpTraceId) { codexSessionByOtelTraceId.set(opts.otlpTraceId, sessionId) }
    const state = getSessionState(sessionId)
    if (isPrompt) {
      state.hasPrompt = true
      codexActivePromptSessionId = sessionId
    }
    return sessionId
  }

  const result: Span[] = []
  for (const rl of objectItems<ResourceLogs>(p?.resourceLogs)) {
    const resourceAttrs = toSpanAttributes(rl.resource?.attributes)
    for (const sl of objectItems<ScopeLogs>(rl.scopeLogs)) {
      const scopeAttrs = toSpanAttributes(sl.scope?.attributes)
      for (const rec of objectItems<LogRecord>(sl.logRecords)) {
        const recordAttrs = toSpanAttributes(rec.attributes)
        const bodyAttrs = attrsFromBodyKv(rec.body)
        let attrs = mergeAttributes(recordAttrs, bodyAttrs, scopeAttrs, resourceAttrs)

        const bodyObj = (typeof rec.body === 'object' && rec.body !== null)
          ? (rec.body as Record<string, unknown>)
          : undefined

        const eventName = getAttrFrom(attrs, 'event.name', 'event_name', 'name', 'event')
          || (typeof bodyObj?.stringValue === 'string' ? bodyObj.stringValue : '')

        if (!eventName.startsWith('codex.')) { continue }
        if (isCodexWebsocketSpan(eventName, attrs)) { continue }

        const otlpTraceId = (typeof rec.traceId === 'string' && rec.traceId) ? rec.traceId : ''
        const conversationId = getAttrFrom(attrs,
          'conversation.id',
          'conversation_id',
          'codex.conversation.id',
          'thread.id',
          'thread_id',
          'session.id',
          'session_id',
          'trace_id',
          'traceId',
        )
        if (!otlpTraceId && !conversationId) { continue }

        const spanId = (typeof rec.spanId === 'string' && rec.spanId)
          ? rec.spanId
          : getAttrFrom(attrs, 'span_id', 'spanId') || `cl-${Math.random().toString(36).slice(2, 10)}`
        const turnId = getAttrFrom(attrs, 'turn.id', 'turn_id', 'codex.turn.id')
        const conversationKey = conversationId || otlpTraceId
        const sessionId = resolveSessionId({
          conversationId: conversationKey,
          otlpTraceId,
          turnId,
          spanName: eventName,
        })
        const traceId = sessionId || otlpTraceId || conversationKey

        if (sessionId) {
          attrs = setStringAttr(attrs, 'codex.session.id', sessionId)
          attrs = setStringAttr(attrs, 'codex.conversation.id', conversationKey)
          if (turnId) { attrs = setStringAttr(attrs, 'codex.turn.id', turnId) }
        }
        if (otlpTraceId && sessionId && otlpTraceId !== traceId) {
          attrs = withStringAttr(attrs, 'otel.trace_id', otlpTraceId)
        }

        let parentSpanId = getAttrFrom(attrs, 'parent_span_id', 'parentSpanId') || undefined
        if (isCodexPromptEventName(eventName)) {
          codexSessionRootByTrace.set(traceId, spanId)
        } else if (traceId && !parentSpanId) {
          parentSpanId = codexSessionRootByTrace.get(traceId)
        }
        const timeNano = String(rec.timeUnixNano ?? rec.observedTimeUnixNano ?? '0')

        result.push({
          traceId,
          spanId,
          parentSpanId,
          name: eventName,
          startTime: timeNano,
          endTime: timeNano,
          attributes: attrs,
          status: undefined,
        })
      }
    }
  }
  return result
}
