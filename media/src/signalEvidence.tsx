import { useState } from 'preact/hooks'
import type { Insight, SignalStep, TimelineEntry } from './types'
import { SIGNAL_SEVERITY_COLOR } from './signalIcons'
import { formatCompact, formatLlmLabel, formatMs, formatToolLabel } from './utils'
import { calcEntryCost } from './sessionMetrics'
import { fmtUsd } from './sessionMetrics'

// Step-level evidence for an insight: which timeline entries made it fire. Loop signals carry
// theirs from the detectors (src/signalEvidence.ts — the loaded timeline has no tool results or
// edit text, so the webview couldn't recompute most of them); the efficiency checks in
// Insights.tsx build theirs here with evidenceStep/capSteps, against the same timeline.

/** Mirrors MAX_SIGNAL_STEPS in ../../src/signalEvidence.ts. */
const MAX_STEPS = 100
const STEP_LABEL_CHARS = 80

/** A SignalStep for timeline[index] — the webview twin of src/signalEvidence.ts's signalStep. */
export function evidenceStep(
  timeline: TimelineEntry[], index: number, note: string, role: SignalStep['role'] = 'trigger',
): SignalStep {
  const entry = timeline[index]
  const label = (entry?.label || entry?.type || '').trim()
  return {
    index,
    spanId: entry?.spanId ?? '',
    label: label.length > STEP_LABEL_CHARS ? label.slice(0, STEP_LABEL_CHARS - 1) + '…' : label,
    note,
    role,
  }
}

/** Steps in timeline order, one per index, capped — the webview twin of withSteps. */
export function capSteps(steps: SignalStep[]): Pick<Insight, 'steps' | 'stepsTotal'> {
  const seen = new Set<number>()
  const unique = steps
    .filter(s => (seen.has(s.index) ? false : (seen.add(s.index), true)))
    .sort((a, b) => a.index - b.index)
  return {
    ...(unique.length > 0 ? { steps: unique.slice(0, MAX_STEPS) } : {}),
    ...(unique.length > MAX_STEPS ? { stepsTotal: unique.length } : {}),
  }
}

/** Where a step sits in `timeline`: its own index while that entry still carries its spanId, else
 *  the nearest entry that does (a live session's timeline can shift under a cached copy), else -1.
 *  A step with no spanId is trusted at its index. */
export function resolveStepIndex(step: SignalStep, timeline: TimelineEntry[]): number {
  const at = timeline[step.index]
  if (at && (!step.spanId || at.spanId === step.spanId)) return step.index
  if (!step.spanId) return -1
  let best = -1
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].spanId !== step.spanId) continue
    if (best < 0 || Math.abs(i - step.index) < Math.abs(best - step.index)) best = i
  }
  return best
}

/** The stripe color an insight's steps are marked with — the card's own left-border color. */
export function insightColor(ins: Insight): string {
  if (ins.severity === 'loop-critical') return SIGNAL_SEVERITY_COLOR.critical
  if (ins.severity === 'loop-warning') return SIGNAL_SEVERITY_COLOR.warning
  if (ins.severity === 'warning') return '#ffb74d'
  return 'var(--accent)'
}

/** "Tool Call Deadlock" out of "[Trace 12] Tool Call Deadlock — 1 tool call repeated…". */
export function insightShortName(ins: Insight): string {
  const title = ins.title.replace(/^\[Trace\s+\d+\]\s*/, '')
  const dash = title.indexOf(' — ')
  return dash > 0 ? title.slice(0, dash) : title
}

export function hasEvidence(ins: Insight): boolean {
  return (ins.steps?.length ?? 0) > 0 || !!ins.range
}

function stepBadge(entry: TimelineEntry | undefined): string {
  if (!entry) return ''
  if (entry.type === 'llm') return 'LLM'
  if (entry.type === 'tool') return 'TOOL'
  if (entry.type === 'user_input') return 'USER'
  return 'BG'
}

/** The label the waterfall would draw for this entry, so a step reads the same in both places —
 *  except where that label is cut short (formatToolLabel caps a Bash command at 60 characters for
 *  the waterfall's narrow column): this list has the card's full width, so it shows the command
 *  whole and lets CSS ellipsize only what doesn't fit. */
function stepLabel(step: SignalStep, entry: TimelineEntry | undefined): string {
  if (!entry) return step.label
  if (entry.type === 'llm') return formatLlmLabel(entry) || entry.label || step.label
  if (entry.type === 'tool') {
    const pretty = formatToolLabel(entry)
    if (pretty && !pretty.endsWith('…')) return pretty
    return fullCommand(entry) || entry.label || step.label
  }
  return entry.label || step.label
}

/** The whole command a tool call ran: toolInput's `command` when it's JSON, the raw toolInput when
 *  it's a command string, else the full label. */
function fullCommand(entry: TimelineEntry): string {
  const raw = (entry.toolInput ?? '').trim()
  if (raw.startsWith('{')) {
    try {
      const cmd = (JSON.parse(raw) as Record<string, unknown>).command
      if (typeof cmd === 'string' && cmd) return cmd
    } catch { /* not JSON after all — fall through */ }
  } else if (raw) {
    return raw
  }
  return entry.label ?? ''
}

const PREVIEW_STEPS = 5

// ── Stretch summary ──────────────────────────────────────────────────────────

/** What the stretch of the trace between an insight's first and last step amounted to: how long
 *  it ran, the LLM calls inside it, and what those cost. The LLM calls are counted inclusively
 *  (from the first step to the last), so this is the cost of that part of the session — not a
 *  claim that the signal caused all of it. */
function stretchSummary(indices: number[], timeline: TimelineEntry[], model: string): string | null {
  if (indices.length < 2) return null
  const from = Math.min(...indices), to = Math.max(...indices)
  const parts: string[] = []
  const t0 = Date.parse(timeline[from]?.timestamp ?? ''), t1 = Date.parse(timeline[to]?.timestamp ?? '')
  if (!Number.isNaN(t0) && !Number.isNaN(t1) && t1 > t0) parts.push(formatMs(t1 - t0 + (timeline[to]?.durationMs ?? 0)))
  let llm = 0, usd = 0, tokens = 0
  for (let i = from; i <= to; i++) {
    const e = timeline[i]
    if (e?.type !== 'llm') continue
    llm++
    usd += calcEntryCost(e, model)
    tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0)
  }
  if (llm > 0) {
    parts.push(`${llm} model call${llm === 1 ? '' : 's'} in between${tokens > 0 ? ` (${formatCompact(tokens)} tokens)` : ''}`)
    if (usd > 0) parts.push(`~${fmtUsd(usd)}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

// ── Token chart ──────────────────────────────────────────────────────────────

/** Insights about how context or cache behaved call to call — the ones a per-call token chart
 *  explains. Matched by loop type, or by title for the efficiency checks in Insights.tsx. */
export function wantsTokenChart(ins: Insight): boolean {
  if (ins._loopType) return ['token_runaway', 'cache_miss', 'ttl_expiry', 'low_cache_hit_ratio'].includes(ins._loopType)
  return /Context grew|Starts with .* tokens of context|Low cache reuse/.test(ins.title)
}

const CHART_H = 64

/**
 * One column per LLM call: input tokens, split into what was read from cache (muted) and what
 * was processed fresh (accent — new input and cache writes both). The calls the insight names
 * carry a marker in the insight's color above the column and their step number. A legend names
 * the two series; each column's hit area carries the full numbers on hover. Plain flex columns
 * rather than an SVG, so a column is never wider than 24px however wide the card is.
 */
function TokenChart({ ins, timeline, stepNumber, flagged, onPick }: {
  ins: Insight
  timeline: TimelineEntry[]
  stepNumber?: (i: number) => number | undefined
  flagged: Set<number>
  onPick?: (i: number) => void
}) {
  const calls = timeline.flatMap((e, i) => e.type === 'llm' && (e.inputTokens ?? 0) > 0 ? [{ e, i }] : [])
  if (calls.length < 2) return null
  const max = Math.max(...calls.map(c => c.e.inputTokens ?? 0))
  if (max <= 0) return null
  const color = insightColor(ins)
  return (
    <div class="insight-evidence-chart" style={`--ev-color:${color}`}>
      <div class="ev-chart" style={`height:${CHART_H}px`} role="img"
        aria-label={`Tokens sent per model call, ${calls.length} calls, peak ${formatCompact(max)}`}>
        {calls.map(({ e, i }, k) => {
          const input = e.inputTokens ?? 0
          const cached = Math.min(input, e.cacheReadTokens ?? 0)
          const fresh = input - cached
          const isFlag = flagged.has(i)
          const no = stepNumber?.(i)
          const tip = [
            `${no !== undefined ? `Step ${no} · ` : ''}Model call ${k + 1} of ${calls.length}`,
            `${input.toLocaleString()} tokens sent → ${(e.outputTokens ?? 0).toLocaleString()} out`,
            `${cached.toLocaleString()} reused from the cache · ${fresh.toLocaleString()} processed fresh`
              + ((e.cacheCreateTokens ?? 0) > 0 ? ` (${(e.cacheCreateTokens ?? 0).toLocaleString()} saved to the cache)` : ''),
            isFlag ? 'Named by this insight' : '',
          ].filter(Boolean).join('\n')
          return (
            <div
              key={e.spanId + k}
              class={'ev-chart-slot' + (onPick ? ' ev-link' : '') + (isFlag ? ' ev-flag' : '')}
              data-tip={tip}
              onClick={onPick ? ev => { ev.stopPropagation(); onPick(i) } : undefined}
            >
              <div class="ev-chart-col" style={`height:${((input / max) * 100).toFixed(1)}%`}>
                {fresh > 0 && <div class="ev-seg ev-seg-fresh" style={`flex:${fresh} 0 0`} />}
                {cached > 0 && <div class="ev-seg ev-seg-cached" style={`flex:${cached} 0 0`} />}
              </div>
            </div>
          )
        })}
      </div>
      <div class="insight-evidence-legend">
        <span><i class="ev-swatch" style="background:var(--accent);opacity:.7" />processed fresh</span>
        <span><i class="ev-swatch" style="background:var(--muted);opacity:.35" />reused from cache</span>
        <span><i class="ev-swatch ev-swatch-flag" style={`border-top-color:${color}`} />named above</span>
        <span class="ev-legend-peak">peak {formatCompact(max)} tokens sent</span>
      </div>
    </div>
  )
}

// ── The card section ─────────────────────────────────────────────────────────

/**
 * The "Why it fired" section on an insight card: the measured value against its threshold, the
 * stretch it covered, a per-call token chart where tokens are the story, then the steps involved
 * with what each one did. Inside a trace (`timeline` loaded, `onShowSteps` given) each step is a
 * link into the waterfall; on the Insights tab it's a plain list built from the stored labels.
 */
export function InsightEvidence({ ins, timeline, model, stepNumber, onShowSteps }: {
  ins: Insight
  timeline?: TimelineEntry[]
  model?: string
  stepNumber?: (timelineIndex: number) => number | undefined
  onShowSteps?: (ins: Insight, focusIndex?: number) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const steps = ins.steps ?? []
  const total = ins.stepsTotal ?? steps.length

  if (!ins.trigger && steps.length === 0 && !ins.range) {
    // Only loop signals are ever stored; an efficiency insight always carries a trigger.
    if (ins.category !== 'loop') return null
    return (
      <div class="insight-evidence insight-evidence-missing">
        Step-level evidence isn&apos;t available for this signal: the trace was analyzed before TraceRoost
        recorded which steps a signal came from. It appears once the trace is analyzed again.
      </div>
    )
  }

  const shown = showAll ? steps : steps.slice(0, PREVIEW_STEPS)
  const color = insightColor(ins)
  const loaded = !!timeline && timeline.length > 0
  const resolved = loaded ? steps.map(s => resolveStepIndex(s, timeline!)).filter(i => i >= 0) : []
  const flagged = new Set(loaded ? steps.filter(s => s.role === 'trigger').map(s => resolveStepIndex(s, timeline!)).filter(i => i >= 0) : [])
  const stretch = loaded ? stretchSummary(resolved, timeline!, model ?? '') : null
  const stretchFrom = resolved.length > 1 && stepNumber ? stepNumber(Math.min(...resolved)) : undefined
  const stretchTo = resolved.length > 1 && stepNumber ? stepNumber(Math.max(...resolved)) : undefined

  return (
    <div class="insight-evidence" style={`--ev-color:${color}`}>
      <div class="insight-evidence-head">
        <span class="insight-action-label">Why it fired</span>
        {onShowSteps && loaded && hasEvidence(ins) && (
          <button class="insight-evidence-show" onClick={e => { e.stopPropagation(); onShowSteps(ins) }}>
            Highlight {total > 0 ? total + ' step' + (total === 1 ? '' : 's') : 'steps'} in waterfall →
          </button>
        )}
      </div>
      {ins.trigger && <div class="insight-evidence-trigger">{ins.trigger}</div>}
      {ins.range && (
        <div class="insight-evidence-range">
          {(() => {
            const from = loaded && stepNumber ? stepNumber(ins.range.from) : undefined
            const to = loaded && stepNumber ? stepNumber(ins.range.to) : undefined
            return from !== undefined && to !== undefined
              ? `Steps ${from}–${to} are ${ins.range.note}.`
              : `Every step from the first marked one on is ${ins.range.note}.`
          })()}
        </div>
      )}
      {stretch && (
        <div class="insight-evidence-stretch" title="The part of the trace between this insight's first and last step: how long it ran and what the model calls inside it cost. The cost of that stretch, not a claim the signal caused all of it.">
          {stretchFrom !== undefined && stretchTo !== undefined && <span class="ev-stretch-steps">Steps #{stretchFrom}–#{stretchTo}</span>}
          <span>{stretch}</span>
        </div>
      )}
      {loaded && wantsTokenChart(ins) && (
        <TokenChart ins={ins} timeline={timeline!} stepNumber={stepNumber} flagged={flagged}
          onPick={onShowSteps ? i => onShowSteps(ins, i) : undefined} />
      )}
      {steps.length > 0 && (
        <>
          <ol class="insight-evidence-list">
            {shown.map(step => {
              const idx = loaded ? resolveStepIndex(step, timeline!) : -1
              const entry = idx >= 0 ? timeline![idx] : undefined
              const no = idx >= 0 && stepNumber ? stepNumber(idx) : undefined
              const clickable = !!onShowSteps && idx >= 0
              return (
                <li
                  key={step.index + ':' + step.note}
                  class={'insight-evidence-step ev-' + step.role + (clickable ? ' ev-link' : '')}
                  onClick={clickable ? e => { e.stopPropagation(); onShowSteps!(ins, idx) } : undefined}
                  title={clickable ? 'Show this step in the waterfall' : undefined}
                >
                  <div class="ev-step-main">
                    {no !== undefined && <span class="ev-step-no">#{no}</span>}
                    {entry && <span class="ev-badge">{stepBadge(entry)}</span>}
                    {entry?.isError && <span class="ev-error" title="This step errored">✕</span>}
                    <span class="ev-label" title={stepLabel(step, entry)}>{stepLabel(step, entry)}</span>
                    <span class="ev-note">{step.note}</span>
                  </div>
                  {step.detail && <div class="ev-detail" title={step.detail}>{step.detail}</div>}
                </li>
              )
            })}
          </ol>
          {(steps.length > PREVIEW_STEPS || total > steps.length) && (
            <div class="insight-evidence-more">
              {steps.length > PREVIEW_STEPS && (
                <button onClick={e => { e.stopPropagation(); setShowAll(v => !v) }}>
                  {showAll ? 'Show fewer' : `Show all ${steps.length}`}
                </button>
              )}
              {total > steps.length && (
                <span>{showAll || steps.length <= PREVIEW_STEPS ? '' : ' · '}first {steps.length} of {total} listed</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Plain-text evidence for the card's Copy button, so the agent sees the same steps. */
export function evidenceClipboardLines(ins: Insight): string[] {
  const lines: string[] = []
  if (!ins.trigger && !(ins.steps?.length)) return lines
  lines.push('', '--- Why it fired ---')
  if (ins.trigger) lines.push(ins.trigger)
  const steps = ins.steps ?? []
  if (steps.length > 0) {
    lines.push('Steps involved:')
    for (const s of steps.slice(0, 12)) {
      lines.push('  - ' + s.label + ' — ' + s.note)
      if (s.detail) lines.push('      ' + s.detail)
    }
    const total = ins.stepsTotal ?? steps.length
    if (total > 12) lines.push('  … and ' + (total - 12) + ' more')
  }
  return lines
}
