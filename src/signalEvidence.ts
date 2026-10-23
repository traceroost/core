/**
 * Builds the per-step evidence a LoopSignal carries (`steps`, `stepsTotal`, `trigger`) — the
 * timeline entries that made it fire, so the trace view can show *which* calls a signal is about
 * and highlight them in the waterfall, not just say that it fired.
 *
 * Steps are referenced by timeline position plus spanId rather than copied: the detectors run on
 * the same `session.timeline` the writer persists position by position (timeline_entries.position),
 * so the index is what the trace view's lazily loaded timeline uses too, and the spanId lets it
 * confirm that. Only a truncated label rides along, so a signal can still be listed where the
 * timeline isn't loaded (the Insights tab across all traces).
 */

import type { SignalStep, LoopSignal } from './types'
import type { TimelineEntry } from './summarizers/summarizerTypes'

/** Stored per signal in the sessions.loop_signals JSON, so bounded: a 300-repeat deadlock lists
 *  its first 100 steps and says how many there were. */
export const MAX_SIGNAL_STEPS = 100
const STEP_LABEL_CHARS = 80
export const MAX_STEP_DETAIL_CHARS = 160

export function signalStep(
  timeline: TimelineEntry[], index: number, note: string, role: SignalStep['role'] = 'trigger', detail?: string,
): SignalStep {
  const entry = timeline[index]
  const label = (entry?.label || entry?.type || '').trim()
  const excerpt = detail ? oneLine(detail, MAX_STEP_DETAIL_CHARS) : ''
  return {
    index,
    spanId: entry?.spanId ?? '',
    label: label.length > STEP_LABEL_CHARS ? label.slice(0, STEP_LABEL_CHARS - 1) + '…' : label,
    note,
    role,
    ...(excerpt ? { detail: excerpt } : {}),
  }
}

/** Text collapsed onto one line and cut to `max` characters, with an ellipsis when cut. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/** `"old" → "new"` for an edit, each side excerpted — the diff a revert is judged by. */
export function editExcerpt(oldText: string, newText: string): string {
  const half = Math.floor((MAX_STEP_DETAIL_CHARS - 8) / 2)
  return `"${oneLine(oldText, half)}" → "${oneLine(newText, half)}"`
}

/** The first line of `text`, or the first line matching `prefer` when given. */
export function firstLine(text: string, prefer?: RegExp): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (prefer) {
    const hit = lines.find(l => prefer.test(l))
    if (hit) return hit
  }
  return lines[0] ?? ''
}

/** The evidence fields to spread into a LoopSignal: steps in timeline order (one entry per index —
 *  the first note given for an index wins), capped at MAX_SIGNAL_STEPS. */
export function withSteps(steps: SignalStep[], trigger: string): Pick<LoopSignal, 'steps' | 'stepsTotal' | 'trigger'> {
  const seen = new Set<number>()
  const unique = steps
    .filter(s => (seen.has(s.index) ? false : (seen.add(s.index), true)))
    .sort((a, b) => a.index - b.index)
  return {
    trigger,
    ...(unique.length > 0 ? { steps: unique.slice(0, MAX_SIGNAL_STEPS) } : {}),
    ...(unique.length > MAX_SIGNAL_STEPS ? { stepsTotal: unique.length } : {}),
  }
}

/** "1,234" — the detectors' evidence strings already use toLocaleString for token counts. */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString()
}
