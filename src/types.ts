export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: string
  endTime: string
  attributes: SpanAttribute[]
  status?: SpanStatus
  /** Wall-clock ms when this span was received by the collector. Always present on new spans. */
  receivedAt?: number
}

export interface SpanAttribute {
  key: string
  value: {
    stringValue?: string
    intValue?: number
    doubleValue?: number
    boolValue?: boolean
    arrayValue?: unknown
    kvlistValue?: unknown
  }
}

export interface SpanStatus {
  code: number
  message?: string
}

// ── Loop detection ──────────────────────────────────────────────────────────

export type LoopSignalType =
  | 'exact_tool_repeat'
  | 'edit_revert_cycle'
  | 'error_recurrence'
  | 'runaway_steps'
  | 'token_runaway'
  | 'chronic_tool_failures'
  | 'context_flooding_risk'
  // Detected post-hoc by src/sessionRiskSignals.ts, not by the real-time loopDetector.ts — a
  // session completing cleanly doesn't rule out these two, so they're checked on demand alongside
  // git-outcome classification rather than eagerly for every session. See that file's docstring.
  | 'hallucinated_import'
  | 'failed_check_submission'
  // Added from the 2026-09-26 signal-catalog research pass (stages 01-04; the catalog and its
  // calibration are runbooks/SIGNAL_CALIBRATION.md) — all real-time, computed by loopDetector.ts
  // alongside the nine above.
  | 'tool_call_cycle'
  | 'file_reread'
  | 'cache_miss'
  | 'ttl_expiry'
  | 'low_cache_hit_ratio'
  | 'budget_overrun'
  | 'model_tier_mismatch'

export interface LoopSignal {
  type: LoopSignalType
  /** 'warning' = likely loop, 'critical' = strong evidence */
  severity: 'warning' | 'critical'
  /** Human-readable explanation of what was detected */
  evidence: string
  /** Count of the primary metric (repeats, steps, etc.) */
  count: number
  /** Up to 3 concrete examples (tool labels, file paths, error messages) */
  examples: string[]
  /** Named pattern from the agent failure-mode taxonomy */
  patternName: string
  /** Actionable recommendation for the user */
  action: string
  /** Estimated avoidable cost in USD, for the signals that can price it (file_reread,
   *  cache_miss). The Advisor converts it to plan-limit points for subscription users. */
  wasteUsd?: number
  /** Why it fired, as the measured value against the threshold it crossed — e.g. "Longest streak:
   *  34 identical calls in a row (warning at 30+, critical at 50+)". Absent on signals stored before
   *  evidence tracking existed. */
  trigger?: string
  /** The timeline entries that made this signal fire, in timeline order, so the trace view can list
   *  them and highlight them in the waterfall. Capped at MAX_SIGNAL_STEPS (src/signalEvidence.ts);
   *  `stepsTotal` is the uncapped count when the cap was hit. Absent on signals stored before
   *  evidence tracking existed, and on signals with no per-step cause (low_cache_hit_ratio on a
   *  source with no per-call tokens, say). */
  steps?: SignalStep[]
  stepsTotal?: number
  /** A contiguous stretch of the timeline the signal covers as a whole, rather than step by step —
   *  runaway_steps' "every step past the threshold". Indices into the session's timeline, inclusive. */
  range?: { from: number; to: number; note: string }
}

/** One timeline entry behind a signal. `index` is the entry's position in the session's timeline
 *  (the same order timeline_entries.position stores and the waterfall draws); `spanId` lets a reader
 *  confirm that position still names the same entry, and find it if not. */
export interface SignalStep {
  index: number
  spanId: string
  /** The entry's own label, truncated — enough to list it where the timeline isn't loaded. */
  label: string
  /** Why this entry counts: "repeat 31 of 34", "reverts the edit at step 12", "+18,402 cache-write tokens". */
  note: string
  /** 'trigger' entries are the ones that crossed the line; 'context' entries are what they're
   *  measured against (the edit a revert undoes, the baseline call a growth is measured from). */
  role: 'trigger' | 'context'
  /** The thing itself, excerpted: the edit's old → new text, the error line, the import line,
   *  the failing output. Only where a signal has one; capped at MAX_STEP_DETAIL_CHARS. */
  detail?: string
}

export interface SessionSummary {
  totalSpans: number
  agentSessions: number
  toolCalls: Record<string, number>
  totalDurationMs: number
  tokensUsed: number
  filesChanged: string[]
  errors: number
  lastUpdated: Date
}
