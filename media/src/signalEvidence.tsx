import { useState } from 'preact/hooks'
import type { Insight, SignalStep, TimelineEntry } from './types'
import { SIGNAL_SEVERITY_COLOR } from './signalIcons'
import { formatLlmLabel, formatToolLabel } from './utils'

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

/** "Tool Call Deadlock" out of "[Trace 12] Tool Call Deadlock — 1 tool call(s) executed…". */
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

/** The label the waterfall would draw for this entry, so a step reads the same in both places. */
function stepLabel(step: SignalStep, entry: TimelineEntry | undefined): string {
  if (!entry) return step.label
  if (entry.type === 'llm') return formatLlmLabel(entry) || entry.label || step.label
  if (entry.type === 'tool') return formatToolLabel(entry) || step.label
  return entry.label || step.label
}

const PREVIEW_STEPS = 5

/**
 * The "Why it fired" block on an insight card: the measured value against its threshold, then the
 * steps involved. Inside a trace (`timeline` loaded, `onShowSteps` given) each step is a link into
 * the waterfall; on the Insights tab it's a plain list built from the stored labels.
 */
export function InsightEvidence({ ins, timeline, stepNumber, onShowSteps }: {
  ins: Insight
  timeline?: TimelineEntry[]
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
  const loaded = timeline && timeline.length > 0

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
      {steps.length > 0 && (
        <>
          <ol class="insight-evidence-list">
            {shown.map(step => {
              const idx = loaded ? resolveStepIndex(step, timeline) : -1
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
                  {no !== undefined && <span class="ev-step-no">#{no}</span>}
                  {entry && <span class="ev-badge">{stepBadge(entry)}</span>}
                  {entry?.isError && <span class="ev-error" title="This step errored">✕</span>}
                  <span class="ev-label">{stepLabel(step, entry)}</span>
                  <span class="ev-note">{step.note}</span>
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
    for (const s of steps.slice(0, 12)) lines.push('  - ' + s.label + ' — ' + s.note)
    const total = ins.stepsTotal ?? steps.length
    if (total > 12) lines.push('  … and ' + (total - 12) + ' more')
  }
  return lines
}
