/**
 * "Did it work?" for one applied instruction-file suggestion: the repo's traces before against
 * after, per trace, so a lighter week can't pass for a saving. A port of cloud's
 * src/lib/instructions/changes.ts (measureChange, describeMeasure, improved): the same measures,
 * windows, thresholds and wording, so Advisor › Results reads the same in both products.
 *
 * Pure: callers pass the traces and a git-outcome lookup; nothing here reads signals.
 */

import type { SessionSummaryCard, FileOutcome } from './types'
import { calcSessionCost } from './sessionMetrics'

/** The before side: the repo's traces in the 60 days before the change, newest 200 of them. */
export const BEFORE_DAYS = 60
/** At most this many traces on each side (the after side: the first 200 after the change). */
export const MAX_SIDE_TRACES = 200
/** Under this many traces on either side, no measure is shown: "measuring". */
export const MIN_SIDE_TRACES = 10
/** Above this many after-change traces, `high` confidence; from MIN_SIDE_TRACES up to it, `medium`. */
export const HIGH_CONFIDENCE_TRACES = 30
/** A primary model whose share of traces moved at least this much gets a "model mix also changed" note. */
export const MODEL_MIX_SHIFT = 0.2
const FLAT_RELATIVE = 0.05
const FLAT_POINTS = 0.03

export type Confidence = 'insufficient' | 'medium' | 'high'
export type MeasureId = 'turns' | 'cost' | 'cache' | 'signals' | 'errors' | 'landed'

export interface WindowStats {
  traces: number
  turns: number
  costUsd: number
  tokensIn: number
  cacheRead: number
  errors: number
  signalTraces: number
  /** Traces whose work was merged or committed… */
  landed: number
  /** …out of those with a git outcome at all (merged, committed or abandoned). */
  resolved: number
  /** Primary model → traces. */
  models: Record<string, number>
}

export interface MeasureRow {
  id: MeasureId
  label: string
  before: number
  after: number
  /** True when a rise is good (cache reuse, landed). */
  upIsGood: boolean
  format: 'number' | 'usd' | 'pct'
  /** Relative change for amounts, points for rates. */
  delta: number
  /** Under ±5% (amounts) or ±3 points (rates): "about the same", shown, not hidden. */
  flat: boolean
}

export interface ChangeMeasurement {
  before: { traces: number }
  after: { traces: number }
  confidence: Confidence
  /** Empty while `confidence` is `insufficient`. */
  measures: MeasureRow[]
  modelShift: { model: string; before: number; after: number } | null
}

const DAY = 86_400_000
const LANDED: FileOutcome[] = ['merged', 'committed']
const RESOLVED: FileOutcome[] = ['merged', 'committed', 'abandoned']

const startMs = (s: SessionSummaryCard) => (s.startTime ? Date.parse(s.startTime) : NaN)

/** The traces each side is measured on: the 60 days before `atMs` (newest 200) and the first 200 from `atMs` on. */
export function changeWindows(sessions: SessionSummaryCard[], atMs: number): { before: SessionSummaryCard[]; after: SessionSummaryCard[] } {
  const timed = sessions.filter(s => Number.isFinite(startMs(s)))
  const before = timed
    .filter(s => startMs(s) < atMs && startMs(s) >= atMs - BEFORE_DAYS * DAY)
    .sort((a, b) => startMs(b) - startMs(a))
    .slice(0, MAX_SIDE_TRACES)
  const after = timed
    .filter(s => startMs(s) >= atMs)
    .sort((a, b) => startMs(a) - startMs(b))
    .slice(0, MAX_SIDE_TRACES)
  return { before, after }
}

export function windowStats(sessions: SessionSummaryCard[], outcomeOf: (s: SessionSummaryCard) => FileOutcome | null | undefined): WindowStats {
  const w: WindowStats = { traces: 0, turns: 0, costUsd: 0, tokensIn: 0, cacheRead: 0, errors: 0, signalTraces: 0, landed: 0, resolved: 0, models: {} }
  for (const s of sessions) {
    w.traces++
    w.turns += s.totalLlmCalls ?? 0
    w.costUsd += calcSessionCost(s).totalUsd
    w.tokensIn += s.inputTokens ?? 0
    w.cacheRead += s.cacheReadTokens ?? 0
    w.errors += s.errors ?? 0
    if ((s.loopSignals?.length ?? 0) > 0) w.signalTraces++
    const o = outcomeOf(s)
    if (o && RESOLVED.includes(o)) {
      w.resolved++
      if (LANDED.includes(o)) w.landed++
    }
    if (s.model) w.models[s.model] = (w.models[s.model] ?? 0) + 1
  }
  return w
}

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null)

interface MeasureDef {
  id: MeasureId
  label: string
  kind: 'amount' | 'rate'
  upIsGood: boolean
  format: MeasureRow['format']
  value: (s: WindowStats) => number | null
}

// Same order, labels and direction as cloud's MEASURES.
const MEASURES: MeasureDef[] = [
  { id: 'turns',   label: 'Turns per trace',               kind: 'amount', upIsGood: false, format: 'number', value: s => ratio(s.turns, s.traces) },
  { id: 'cost',    label: 'Cost per trace',                kind: 'amount', upIsGood: false, format: 'usd',    value: s => ratio(s.costUsd, s.traces) },
  { id: 'cache',   label: 'Prompt-cache reuse',            kind: 'rate',   upIsGood: true,  format: 'pct',    value: s => { const r = ratio(s.cacheRead, s.tokensIn); return r === null ? null : Math.min(1, r) } },
  { id: 'signals', label: 'Traces with a struggle signal', kind: 'rate',   upIsGood: false, format: 'pct',    value: s => ratio(s.signalTraces, s.traces) },
  { id: 'errors',  label: 'Errors per trace',              kind: 'amount', upIsGood: false, format: 'number', value: s => ratio(s.errors, s.traces) },
  { id: 'landed',  label: 'Landed',                        kind: 'rate',   upIsGood: true,  format: 'pct',    value: s => ratio(s.landed, s.resolved) },
]

export function confidenceFor(before: number, after: number): Confidence {
  if (before < MIN_SIDE_TRACES || after < MIN_SIDE_TRACES) return 'insufficient'
  return after > HIGH_CONFIDENCE_TRACES ? 'high' : 'medium'
}

function primaryShares(models: Record<string, number>): Map<string, number> {
  const total = Object.values(models).reduce((s, n) => s + n, 0)
  return new Map(Object.entries(models).map(([m, n]) => [m, total > 0 ? n / total : 0]))
}

export function measureChange(before: WindowStats, after: WindowStats): ChangeMeasurement {
  const confidence = confidenceFor(before.traces, after.traces)
  const measures: MeasureRow[] = []
  let modelShift: ChangeMeasurement['modelShift'] = null
  if (confidence !== 'insufficient') {
    for (const m of MEASURES) {
      const b = m.value(before)
      const a = m.value(after)
      if (b === null || a === null) continue
      const delta = m.kind === 'amount' ? (b > 0 ? (a - b) / b : 0) : a - b
      measures.push({
        id: m.id, label: m.label, before: b, after: a, upIsGood: m.upIsGood, format: m.format, delta,
        flat: Math.abs(delta) < (m.kind === 'amount' ? FLAT_RELATIVE : FLAT_POINTS),
      })
    }
    const sb = primaryShares(before.models)
    const sa = primaryShares(after.models)
    for (const model of new Set([...sb.keys(), ...sa.keys()])) {
      const b = sb.get(model) ?? 0
      const a = sa.get(model) ?? 0
      if (Math.abs(a - b) >= MODEL_MIX_SHIFT && (!modelShift || Math.abs(a - b) > Math.abs(modelShift.after - modelShift.before))) {
        modelShift = { model, before: b, after: a }
      }
    }
  }
  return { before: { traces: before.traces }, after: { traces: after.traces }, confidence, measures, modelShift }
}

/** True when the measure moved in its good direction (and isn't flat). */
export const improved = (m: MeasureRow): boolean => !m.flat && m.delta > 0 === m.upIsGood

/** "turns per trace −18%", "landed +6 pts", "cost per trace about the same". */
export function describeMeasure(m: MeasureRow): string {
  const label = m.label.charAt(0).toLowerCase() + m.label.slice(1)
  if (m.flat) return `${label} about the same`
  const sign = m.delta > 0 ? '+' : '−'
  return m.format === 'pct'
    ? `${label} ${sign}${Math.round(Math.abs(m.delta) * 100)} pts`
    : `${label} ${sign}${Math.round(Math.abs(m.delta) * 100)}%`
}

export function fmtMeasure(m: MeasureRow, v: number): string {
  if (m.format === 'pct') return `${Math.round(v * 100)}%`
  if (m.format === 'usd') return v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`
  return v >= 10 ? Math.round(v).toString() : v.toFixed(1)
}

/** A change's overall result: every moved measure better, every one worse, both, or none moved. */
export type ChangeVerdict = 'better' | 'worse' | 'mixed' | 'flat' | 'measuring'

export function changeVerdict(c: Pick<ChangeMeasurement, 'confidence' | 'measures'>): ChangeVerdict {
  if (c.confidence === 'insufficient' || c.measures.length === 0) return 'measuring'
  const moved = c.measures.filter(m => !m.flat)
  if (moved.length === 0) return 'flat'
  const up = moved.filter(improved).length
  return up === moved.length ? 'better' : up === 0 ? 'worse' : 'mixed'
}

/** The one-sentence answer for a change: the two measures that moved most, or that nothing did. */
export function changeHeadline(c: ChangeMeasurement): string {
  if (c.confidence === 'insufficient') {
    const need = Math.max(0, MIN_SIDE_TRACES - c.before.traces) + Math.max(0, MIN_SIDE_TRACES - c.after.traces)
    return `Still measuring: needs ${MIN_SIDE_TRACES} traces on each side (${c.before.traces} before, ${c.after.traces} after so far${need > 0 ? `, ${need} to go` : ''}).`
  }
  const moved = c.measures.filter(m => !m.flat).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 2)
  const what = moved.length > 0 ? moved.map(describeMeasure).join(' and ') : 'nothing measured moved much'
  return `Since then, ${what} (${c.after.traces} traces after, ${c.before.traces} before).`
}

/** "3 changes measured: 2 better, 1 about the same; 1 still measuring." For the top of Results. */
export function verdictSummary(verdicts: ChangeVerdict[]): string | null {
  if (verdicts.length === 0) return null
  const n = (v: ChangeVerdict) => verdicts.filter(x => x === v).length
  const measured = verdicts.length - n('measuring')
  const parts = ([['better', 'better'], ['mixed', 'mixed'], ['flat', 'about the same'], ['worse', 'worse']] as const)
    .filter(([v]) => n(v) > 0).map(([v, word]) => `${n(v)} ${word}`)
  const head = measured > 0
    ? `${measured} change${measured === 1 ? '' : 's'} measured: ${parts.join(', ')}`
    : 'No change has enough traces to measure yet'
  return n('measuring') > 0 && measured > 0 ? `${head}; ${n('measuring')} still measuring.` : `${head}.`
}
