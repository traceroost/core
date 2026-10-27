import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import {
  filteredSessions, sessionSummary, sessionTimelines, gitOutcomes, burnRateData, sessionSignals,
  focusedSessionId, vscode, ignoredInsightKeys,
  sessionSortKey, sessionSortDir, type SortKey, sessionsPage,
  goToHelp,
  getSessionsPagination,
  evidenceSessionIds, evidenceSessionLabel, evidenceSessionPrompt,
  repoInfo, repoDisplayName, repoTooltipName,
  requestGitOutcomesFor, availableWorkspaces, hasAnyWorkspace, logIngestProgress,
} from '../state'
import { PageSizeSelect, SessionsPager } from './Settings'
import {
  getAgentColorVar, getAgentSourceLabel, formatMs, formatCompact, formatSessionTime,
  getDataSourceBadgeHtml, getInitiatorBadgeHtml, getConversationColor, formatTraceIdHash, esc, activateOnKey,
} from '../utils'
import { calcSessionCost, oneShotRate, avgEditsPerFile } from '../sessionMetrics'
import { fmtUsd } from './Cost'
import { generateInsights, InsightCard, InsightIcon } from './Insights'
import { buildDisplaySummary } from '../utils'
import { Step, StepRow, type StepMark } from './Traces'
import { hasEvidence, insightColor, insightShortName, resolveStepIndex } from '../signalEvidence'
import { FlowCanvas } from './Flow'
import { ToolsChart } from './Tools'
import { LogIngestionNote } from './IngestionNote'
import { NoTracesYet } from './GettingStarted'
import type { SessionSummaryCard, FileOutcome, LoopSignal, LoopSignalType, Insight } from '../types'
import { LOOP_SIGNAL_ICON_TYPE, SignalBadge } from '../signalIcons'
import { SIGNAL_FORMULAS } from '../signalFormulas'
import { isNonCodeCategory, languageAbbreviation, languageLabel } from '../language'
import { planUsage, showLimitColumn } from '../planUsage'
import { LimitUsedCell, LimitHitBanner, PlanLimitDetail } from './PlanLimits'
import { scrollBehavior } from '../a11y'

// ── Session detail panel (shown in expanded row) ──────────────────────────────

type Section = 'overview' | 'waterfall' | 'files' | 'flow' | 'tools'

// Each letter is the first letter of its own label (Merged/Committed/Uncommitted), not the
// internal FileOutcome key — 'abandoned' displays as "Uncommitted" so it gets 'U', not 'A'.
// 'merged' vs 'committed' is a real, verified distinction (see gitOutcome.ts's trunk-branch
// check), not just wording — so they get their own letters rather than sharing one. 'ambiguous'
// has no entry at all — there's nothing meaningful to show for it (a deleted/moved file, or
// classification not applicable), so every consumer below renders blank rather than a "?" badge.
// `description` matches App.tsx's OUTCOME_FILTER_OPTIONS titles exactly (kept in sync by hand,
// same as that map's own comment already notes) — the badge tooltip states the value first (bold
// heading), then what it means, then (where available) the specific per-session reason.
export const OUTCOME_META: Partial<Record<FileOutcome, { icon: string; letter: string; color: string; label: string; description: string }>> = {
  merged:    { icon: '✓', letter: 'M', color: 'var(--tr-merged)', label: 'Merged',    description: "Changed files are committed and match the tip of this repo's trunk branch (main/master), per git history." },
  committed: { icon: '●', letter: 'C', color: 'var(--accent)',    label: 'Committed', description: "Changed files are committed, but haven't reached the trunk branch yet (e.g. still on a feature branch) — or no trunk branch could be resolved locally." },
  abandoned: { icon: '◑', letter: 'U', color: 'var(--vscode-editorWarning-foreground, #f6a623)', label: 'Uncommitted', description: "Changed files haven't been committed yet — not necessarily abandoned, may still be in progress." },
}

// Small one-letter badge for the session's overall git outcome — same visual language as the
// Source/From badges in the row above it (getDataSourceBadgeHtml/getInitiatorBadgeHtml, utils.ts):
// a bordered square, colored to match OUTCOME_META / the Outcome filter pills (App.tsx's
// OUTCOME_FILTER_OPTIONS). Renders nothing while the outcome hasn't resolved yet (undefined),
// isn't applicable (null — no repo, no changed files), or is ambiguous (no OUTCOME_META entry)
// rather than reserving space for it.
function GitOutcomeBadge({ sessionId }: { sessionId: string }) {
  const go = gitOutcomes.value[sessionId]
  if (!go) return null
  const meta = OUTCOME_META[go.overall]
  if (!meta) return null
  return (
    <span
      style={`display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;font-size:var(--fs-xs);font-weight:700;border-radius:3px;border:1px solid ${meta.color};color:${meta.color};vertical-align:middle;cursor:default;flex-shrink:0`}
      // data-tip-html renders this as markup: go.reason names the repo's trunk branch, and a ref
      // name may contain `<`/`>` — escape it, the one non-static piece here.
      title={`<b>${meta.label}</b>\n${meta.description}\n${esc(go.reason)}`}
      data-tip-html
    >{meta.letter}</span>
  )
}

// LOOP_SIGNAL_ICON_TYPE/SignalBadge live in ../signalIcons — shared with
// Insights.tsx's InsightCard so a loop signal draws the same glyph whether it's read off this
// row's Signals column or off the Insights list in this same row's expanded panel.
//
// LOOP_SIGNAL_ICON_TYPE collapses onto a smaller set of pictograms than there are LoopSignalTypes
// (it mirrors the ~9-value wire enum cloud's own Signals column groups by — see signalIcons.tsx),
// so it's fine for picking *which glyph* to draw but not for the tooltip text: several distinct,
// unrelated signal types share a glyph (e.g. hallucinated_import and error_recurrence both draw
// the "retry-loop" icon), and exact_tool_repeat's glyph reads as "Repeated edit" even when the
// repeated tool call was a Read or Bash, not an edit at all. Each LoopSignal instead carries its
// own accurate `patternName` (src/loopDetector.ts's PATTERN_NAMES — the same text Insights.tsx's
// InsightCard already titles itself with), so the tooltip is built from those, not from the
// shared glyph's bucket name.
const MAX_SIGNAL_ICONS = 3

// One glyph per distinct pattern type present (worst-severity/most-frequent first, capped at 3
// then a "+N" overflow pill) rather than a bare tally — matches cloud's own Signals column so the
// same struggle pattern reads the same way in both products.
function SignalsCell({ signals }: { signals: LoopSignal[] }) {
  // Blank, not a dash, when there are none: the same as the Outcome and Plan limit cells.
  if (!signals || signals.length === 0) return null
  const byType = new Map<string, { severity: 'warning' | 'critical'; count: number; patterns: Map<string, number>; signalTypes: Set<LoopSignalType>; triggers: string[] }>()
  for (const s of signals) {
    const iconType = LOOP_SIGNAL_ICON_TYPE[s.type] ?? s.type
    const e = byType.get(iconType) ?? { severity: 'warning' as const, count: 0, patterns: new Map<string, number>(), signalTypes: new Set<LoopSignalType>(), triggers: [] }
    if (s.severity === 'critical') e.severity = 'critical'
    e.count += 1
    e.patterns.set(s.patternName, (e.patterns.get(s.patternName) ?? 0) + 1)
    e.signalTypes.add(s.type)
    if (s.trigger) e.triggers.push(s.trigger)
    byType.set(iconType, e)
  }
  const severityRank = { warning: 0, critical: 1 }
  const types = [...byType.entries()].sort((a, b) =>
    severityRank[b[1].severity] - severityRank[a[1].severity] || b[1].count - a[1].count)
  const shown = types.slice(0, MAX_SIGNAL_ICONS)
  const overflow = types.slice(MAX_SIGNAL_ICONS)
  const labelFor = (e: { patterns: Map<string, number> }) =>
    [...e.patterns.entries()].map(([name, n]) => n > 1 ? `${name} ×${n}` : name).join(' + ')
  // One icon bucket can hold more than one distinct LoopSignalType (e.g. hallucinated_import and
  // error_recurrence both draw the "retry-loop" icon — see LOOP_SIGNAL_ICON_TYPE's comment), so the
  // formula shown is every distinct formula among the signal types actually present, not just one.
  // Uses SIGNAL_FORMULAS' short/tip fields (not the full bullets/caveat — that detail lives in
  // Help.tsx) so the tooltip stays skimmable: what fired, then what to do about it. Bolds both as
  // headings via data-tip-html (App.tsx's tooltip effect renders this as HTML instead of text) —
  // safe because every interpolated piece here is a static label/short/tip string — except the
  // signal's own trigger text, which quotes tool labels and error lines from the session and so
  // goes through esc().
  const formulaFor = (e: { signalTypes: Set<LoopSignalType>; triggers: string[] }) =>
    [...e.signalTypes]
      .map(t => SIGNAL_FORMULAS[t] ? `${SIGNAL_FORMULAS[t].short}\n<b>What to do:</b> ${SIGNAL_FORMULAS[t].tip}` : undefined)
      .filter(Boolean)
      .join('\n\n')
    + (e.triggers.length > 0 ? `\n\n<b>In this trace:</b> ${e.triggers.map(esc).join('\n')}` : '')
  // Up to MAX_SIGNAL_ICONS, drawn as small SignalBadge tiles so they fit the Signals column;
  // anything past the cap becomes a "+N" badge (same tile height/radius) whose tooltip lists the
  // rest. Severity isn't colour alone: a critical tile is solid with the glyph knocked out, a
  // warning tile is a soft tint — same tile, different fill weight.
  const overflowTip = overflow.map(([, e]) => `<b>${labelFor(e)}</b> (${e.severity})\n${formulaFor(e)}`).join('\n\n')
  const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ')
  return (
    <span class="sig-cell">
      {shown.map(([type, e]) => {
        const label = labelFor(e)
        return (
          <SignalBadge
            key={type}
            type={type}
            severity={e.severity}
            size="sm"
            role="img"
            tabIndex={0}
            aria-label={`${label} (${e.severity}). ${plain(formulaFor(e))}`}
            title={`<b>${label}</b> (${e.severity})\n${formulaFor(e)}`}
            data-tip-html
          />
        )
      })}
      {overflow.length > 0 && (
        <span
          role="img"
          tabIndex={0}
          aria-label={`${overflow.length} more signal${overflow.length === 1 ? '' : 's'}: ${plain(overflowTip)}`}
          title={`<b>+${overflow.length} more:</b>\n\n${overflowTip}`}
          data-tip-html
          class="sig-more"
        >+{overflow.length}</span>
      )}
    </span>
  )
}

// The expanded trace's Overview spells out what the Signals column's icons only say on hover:
// each distinct signal type, its severity, what fired it and what to do — as plain text.
function SignalList({ signals }: { signals: LoopSignal[] }) {
  if (!signals || signals.length === 0) return null
  const byType = new Map<LoopSignalType, { patternName: string; severity: 'warning' | 'critical'; count: number }>()
  for (const s of signals) {
    const e = byType.get(s.type) ?? { patternName: s.patternName, severity: 'warning' as const, count: 0 }
    if (s.severity === 'critical') e.severity = 'critical'
    e.count += 1
    byType.set(s.type, e)
  }
  const rows = [...byType.entries()].sort((a, b) => (a[1].severity === b[1].severity ? b[1].count - a[1].count : a[1].severity === 'critical' ? -1 : 1))
  return (
    <div style="margin-bottom:10px">
      <div style="font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.4px;color:var(--muted);margin-bottom:6px">Signals</div>
      <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px">
        {rows.map(([type, e]) => {
          const f = SIGNAL_FORMULAS[type]
          return (
            <li key={type} style="display:flex;gap:8px;align-items:flex-start;font-size:11px;line-height:1.5">
              <SignalBadge type={type} severity={e.severity} aria-hidden="true" />
              <div>
                <div>
                  <strong>{e.patternName}</strong>
                  {e.count > 1 && <span style="color:var(--muted)"> ×{e.count}</span>}
                  <span style="color:var(--muted)"> · {e.severity === 'critical' ? 'Critical' : 'Warning'}</span>
                </div>
                {f && <div style="color:var(--muted)">{f.short}</div>}
                {f && <div><strong>What to do:</strong> {f.tip}</div>}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function PromptBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const PREVIEW_CHARS = 300
  const truncated = !expanded && text.length > PREVIEW_CHARS
  const display = truncated ? text.slice(0, PREVIEW_CHARS).trimEnd() + '…' : text
  return (
    <div style="margin-bottom:10px">
      <div style="font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.4px;color:var(--muted);margin-bottom:4px">Prompt</div>
      <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:4px;padding:7px 10px;font-size:11px;white-space:pre-wrap;word-break:break-word;line-height:1.5;color:var(--foreground);max-height:200px;overflow-y:auto">
        {display}
      </div>
      {text.length > PREVIEW_CHARS && (
        <button
          onClick={() => setExpanded(e => !e)}
          style="margin-top:4px;font-size:var(--fs-xs);color:var(--vscode-textLink-foreground,#4fc3f7);background:none;border:none;cursor:pointer;padding:0"
        >
          {expanded ? 'Show less' : 'Show full prompt'}
        </button>
      )}
    </div>
  )
}

// Small copy-to-clipboard icon button: shows a box icon at rest, swaps to a green checkmark
// for a moment after copying (matches the cloud dashboard's trace ID copy affordance).
function CopyIconButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
      onClick={e => {
        e.stopPropagation()
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
      style={`display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:none;background:transparent;cursor:pointer;flex-shrink:0;color:${copied ? 'var(--vscode-charts-green,#81c784)' : 'var(--muted)'}`}
    >
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:block">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

/** "TypeScript", "TypeScript + Python", or "—" for a trace stored before language tracking. */
function sessionLanguageText(sess: SessionSummaryCard): string {
  const primary = languageLabel(sess.language)
  return sess.languageSecondary ? `${primary} + ${languageLabel(sess.languageSecondary)}` : primary
}

function sessionLanguageTitle(sess: SessionSummaryCard): string {
  if (!sess.language) return 'Language not recorded — this trace was stored before language tracking'
  if (sess.language === 'none') return 'No code: files were touched, but none of a recognised kind'
  if (sess.language === 'no_files') return 'No files: no file was read or changed (Codex and Copilot Chat logs record none)'
  if (isNonCodeCategory(sess.language)) {
    const kinds = sess.languageSecondary ? `${languageLabel(sess.language)} and ${languageLabel(sess.languageSecondary)}` : languageLabel(sess.language)
    return `No code — only ${kinds} files were read or changed`
  }
  return sess.languageSecondary
    ? `Primary: ${languageLabel(sess.language)} · Secondary: ${languageLabel(sess.languageSecondary)}`
    : `Language: ${languageLabel(sess.language)}`
}

/** Screen-reader name for the Lang cell, which shows only an abbreviation — the full names. */
function sessionLanguageAriaLabel(sess: SessionSummaryCard): string {
  if (!sess.language) return 'Language: not recorded'
  return `Language: ${sessionLanguageText(sess)}`
}

/** "3f +120 −40" — files changed and agent-authored lines; "3f ?" when lines are unknown. */
function sessionChangesText(sess: SessionSummaryCard): string {
  if (sess.filesChangedCount === undefined) return '—'
  if (sess.filesChangedCount === 0 && !sess.linesAdded && !sess.linesRemoved) return '0'
  const lines = sess.linesAdded !== undefined && sess.linesRemoved !== undefined
    ? ` +${formatCompact(sess.linesAdded)} −${formatCompact(sess.linesRemoved)}`
    : ' ?'
  return `${sess.filesChangedCount}f${lines}`
}

function sessionChangesTitle(sess: SessionSummaryCard): string {
  if (sess.filesChangedCount === undefined) return 'Not recorded — this trace was stored before change-size tracking'
  const files = `${sess.filesChangedCount} file${sess.filesChangedCount === 1 ? '' : 's'} changed`
  return sess.linesAdded !== undefined && sess.linesRemoved !== undefined
    ? `${files} · ${sess.linesAdded} lines added, ${sess.linesRemoved} removed by the agent's own edits`
    : `${files} · line counts unavailable (this agent's data records no edit contents)`
}

// Each insight's evidence steps resolved against the loaded timeline: the timeline positions it
// names (only those the waterfall draws), and its note for each.
interface ResolvedEvidence {
  ins: Insight
  key: string
  name: string
  color: string
  indices: number[]
  notes: Map<number, { note: string; role: 'trigger' | 'context' }>
  range?: { from: number; to: number }
}

function resolveEvidence(insights: Insight[], timeline: SessionSummaryCard['timeline'], drawn: Set<number>): ResolvedEvidence[] {
  const out: ResolvedEvidence[] = []
  for (const ins of insights) {
    if (!hasEvidence(ins)) continue
    const notes = new Map<number, { note: string; role: 'trigger' | 'context' }>()
    for (const step of ins.steps ?? []) {
      const i = resolveStepIndex(step, timeline)
      if (i >= 0 && drawn.has(i) && !notes.has(i)) notes.set(i, { note: step.note, role: step.role })
    }
    const range = ins.range && timeline[ins.range.from] && timeline[ins.range.to] ? { from: ins.range.from, to: ins.range.to } : undefined
    if (notes.size === 0 && !range) continue
    out.push({
      ins, key: ins.title, name: insightShortName(ins), color: insightColor(ins),
      indices: [...notes.keys()].sort((a, b) => a - b), notes, range,
    })
  }
  return out
}

function SessionDetail({ sess }: { sess: SessionSummaryCard }) {
  const [section, setSection] = useState<Section>('overview')
  // The signal being inspected in the waterfall (its insight title), and the row to bring into
  // view — `nonce` re-triggers the scroll when the same row is asked for twice.
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [scrollTarget, setScrollTarget] = useState<{ index: number; nonce: number } | null>(null)
  const waterfallRef = useRef<HTMLDivElement>(null)
  const traceIdHash = formatTraceIdHash(sess.traceId || sess.sessionId)
  const repo = sess.workspace ? repoInfo.value[sess.workspace] : null
  const timelines = sessionTimelines.value
  const timeline = timelines[sess.sessionId] ?? sess.timeline ?? []
  const cost = calcSessionCost(sess)
  const cacheRate = sess.inputTokens > 0 ? Math.round(sess.cacheReadTokens / sess.inputTokens * 100) : 0
  const burnRate = burnRateData.value
  const gitOutcome = gitOutcomes.value[sess.sessionId]

  useEffect(() => {
    if (!timelines[sess.sessionId] && vscode) {
      vscode.postMessage({ type: 'loadSessionDetail', sessionId: sess.sessionId })
    }
  }, [sess.sessionId])

  useEffect(() => {
    // undefined = not yet requested; null = requested but not applicable (no repo, no files, etc)
    if (gitOutcomes.value[sess.sessionId] === undefined && sess.filesChanged.length > 0 && vscode) {
      const endTime = sess.startTime && sess.durationMs && !Number.isNaN(Date.parse(sess.startTime))
        ? new Date(new Date(sess.startTime).getTime() + sess.durationMs).toISOString()
        : sess.startTime
      vscode.postMessage({
        type: 'getGitOutcome',
        sessionId: sess.sessionId,
        workspace: sess.workspace,
        filesChanged: sess.filesChanged,
        startTime: sess.startTime,
        endTime,
      })
    }
  }, [sess.sessionId])

  const ignored = ignoredInsightKeys.value
  // The summary card's own timeline is empty for a stored trace; the efficiency checks need the
  // loaded one to find anything — and to name the steps behind what they find.
  const sessForInsights = { ...sess, timeline: timeline.length > 0 ? timeline : sess.timeline, loopSignals: sessionSignals(sess) }
  const summary = buildDisplaySummary([sessForInsights])
  const sessInsights = generateInsights(summary, [sessForInsights]).filter(i => !ignored.has(i.title))

  const visible = timeline.flatMap((entry, i) => entry.type !== 'background' ? [{ entry, i }] : [])
  const visibleEntries = visible.map(v => v.entry)
  const stepNoByIndex = new Map(visible.map((v, n) => [v.i, n + 1]))
  const stepNumber = (i: number) => stepNoByIndex.get(i)
  const evidence = resolveEvidence(sessInsights, timeline, new Set(stepNoByIndex.keys()))
  const focused = focusKey ? evidence.find(e => e.key === focusKey) : undefined

  function showSteps(ins: Insight, focusIndex?: number) {
    const ev = evidence.find(e => e.key === ins.title)
    if (!ev) return
    setSection('waterfall')
    setFocusKey(ev.key)
    const index = focusIndex ?? ev.indices[0] ?? ev.range?.from
    if (index !== undefined) setScrollTarget({ index, nonce: Date.now() })
  }

  // Brings the target row into view and flashes it, once the waterfall has rendered it.
  useLayoutEffect(() => {
    if (section !== 'waterfall' || !scrollTarget) return
    const row = waterfallRef.current?.querySelector<HTMLElement>(`[data-tl-index="${scrollTarget.index}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row.classList.remove('wf-ev-flash')
    void row.offsetWidth
    row.classList.add('wf-ev-flash')
  }, [scrollTarget, section, visible.length])

  // Every row's part in the evidence. Without a focused signal, involved rows just carry a dot per
  // signal; with one, its steps are lit and everything else steps back.
  const markFor = (i: number, stepNo: number): StepMark | undefined => {
    if (focused) {
      const n = focused.notes.get(i)
      if (n) return { state: 'focused', stepNo, color: focused.color, notes: [{ name: focused.name, note: n.note, color: focused.color, role: n.role }] }
      if (focused.range && i >= focused.range.from && i <= focused.range.to) {
        return { state: 'range', stepNo, color: focused.color, notes: [] }
      }
      return { state: 'dimmed', stepNo, color: focused.color, notes: [] }
    }
    const notes = evidence.flatMap(e => {
      const n = e.notes.get(i)
      return n ? [{ name: e.name, note: n.note, color: e.color, role: n.role }] : []
    })
    return notes.length > 0 ? { state: 'marked', stepNo, color: notes[0].color, notes } : undefined
  }

  // Prev/next walk the focused signal's steps from wherever the last jump landed.
  const cursor = focused && scrollTarget ? focused.indices.indexOf(scrollTarget.index) : -1
  const jump = (delta: number) => {
    if (!focused || focused.indices.length === 0) return
    const at = cursor < 0 ? (delta > 0 ? -1 : focused.indices.length) : cursor
    const next = Math.min(Math.max(at + delta, 0), focused.indices.length - 1)
    setScrollTarget({ index: focused.indices[next], nonce: Date.now() })
  }

  const sessionStartMs = sess.startTime ? new Date(sess.startTime).getTime() : 0
  let sessionDur = sess.durationMs || 1

  const steps: Step[] = visibleEntries.map(entry => {
    const entryStart = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
    const offset = sessionStartMs > 0 && entryStart > 0 ? entryStart - sessionStartMs : 0
    return { entry, offsetMs: Math.max(offset, 0), durationMs: entry.durationMs || 0 }
  })
  if (steps.length > 0) {
    const maxEnd = Math.max(...steps.map(s => s.offsetMs + s.durationMs))
    if (maxEnd > sessionDur) sessionDur = maxEnd
  }
  if (sessionDur <= 0) sessionDur = 1

  const tabIdBase = `trace-${sess.sessionId}`
  const sections: Section[] = ['overview', 'waterfall', 'flow', 'tools', 'files']
  // Arrow keys move between the sub-tabs (WAI-ARIA tabs pattern, automatic activation).
  function onTabKey(e: KeyboardEvent) {
    const i = sections.indexOf(section)
    const next = e.key === 'ArrowRight' ? sections[(i + 1) % sections.length]
      : e.key === 'ArrowLeft' ? sections[(i - 1 + sections.length) % sections.length]
      : e.key === 'Home' ? sections[0] : e.key === 'End' ? sections[sections.length - 1] : null
    if (!next) return
    e.preventDefault()
    setSection(next)
    document.getElementById(`${tabIdBase}-tab-${next}`)?.focus()
  }
  const navBtn = (s: Section, label: string) => (
    <button
      type="button"
      role="tab"
      id={`${tabIdBase}-tab-${s}`}
      aria-selected={section === s}
      aria-controls={`${tabIdBase}-panel`}
      tabIndex={section === s ? 0 : -1}
      onKeyDown={onTabKey}
      onClick={e => { e.stopPropagation(); setSection(s) }}
      style={[
        'padding:3px 10px;font-size:11px;cursor:pointer;border:none;border-bottom:2px solid transparent;background:transparent;',
        section === s ? 'color:var(--fg);border-bottom-color:var(--accent);font-weight:600' : 'color:var(--muted)',
      ].join('')}
    >{label}</button>
  )

  return (
    <div style="border-top:1px solid var(--border)" onClick={e => e.stopPropagation()}>
      <LimitHitBanner sessionId={sess.sessionId} />
      <PlanLimitDetail sessionId={sess.sessionId} />
      {/* Identity line (Trace ID, Repo) on top, section tabs on their own line beneath it. */}
      <div style="display:flex;align-items:center;gap:0;padding:2px 8px 0;background:var(--vscode-editorWidget-background,var(--bg));overflow-x:auto">
        <span
          style="display:flex;align-items:center;gap:5px;padding:3px 4px;margin-right:4px;font-size:var(--fs-xs);color:var(--muted);white-space:nowrap"
        >
          <span style="text-transform:uppercase;letter-spacing:.3px">Trace ID</span>
          <span style="font-family:monospace;color:var(--fg)">{traceIdHash}</span>
          <CopyIconButton value={traceIdHash} label="Copy trace ID" />
        </span>
        {sess.workspace && (
          <span
            style="display:flex;align-items:center;gap:5px;padding:3px 4px;margin-right:4px;font-size:var(--fs-xs);color:var(--muted);white-space:nowrap"
            title={`${repoTooltipName(sess.workspace, repoInfo.value)}\nLocal: ${sess.workspace}`}
          >
            <span style="text-transform:uppercase;letter-spacing:.3px">Repo (ID)</span>
            {/* With a hash, the copy button sits inside its parentheses and copies the full hash;
                with none (core edition, or not a keyable repo), it follows the name and copies that. */}
            {repo?.hash
              ? <span style="display:inline-flex;align-items:center;font-family:monospace;color:var(--fg)">
                  {repo.name}&nbsp;({repo.hash.slice(0, 4)}…<CopyIconButton value={repo.hash} label="Copy repo hash" />)
                </span>
              : <>
                  <span style="font-family:monospace;color:var(--fg)">{repoDisplayName(sess.workspace, repoInfo.value)}</span>
                  <CopyIconButton value={repoDisplayName(sess.workspace, repoInfo.value)} label="Copy repo name" />
                </>
            }
          </span>
        )}
      </div>
      <div role="tablist" aria-label="Trace detail" style="display:flex;align-items:center;gap:0;padding:0 8px;border-bottom:1px solid var(--border);background:var(--vscode-editorWidget-background,var(--bg));overflow-x:auto">
        {navBtn('overview', 'Overview')}
        {navBtn('waterfall', `Waterfall${visibleEntries.length > 0 ? ' (' + visibleEntries.length + ')' : ''}`)}
        {navBtn('flow', `Flow${sess.totalLlmCalls > 0 ? ' (' + sess.totalLlmCalls + ')' : ''}`)}
        {navBtn('tools', `Tools${sess.totalToolCalls > 0 ? ' (' + sess.totalToolCalls + ')' : ''}`)}
        {navBtn('files', `Files${sess.filesChanged.length > 0 ? ' (' + sess.filesChanged.length + ')' : ''}`)}
      </div>

      <div style="padding:12px 14px" role="tabpanel" id={`${tabIdBase}-panel`} aria-labelledby={`${tabIdBase}-tab-${section}`}>

        {section === 'overview' && (
          <div>
            {sess.dataSource === 'log' && (() => {
              const isCopilot = sess.source === 'copilot'
              const isOpenCode = sess.source === 'opencode'
              const isCursor = sess.source === 'cursor'
              // Pre-~Feb 2026 Copilot Chat sessions (.json snapshot format): VS Code did not
              // record token counts at all — outputTokens=0 with turns>0 is the fingerprint.
              if (isCopilot && sess.outputTokens === 0 && sess.turns > 0) {
                return (
                  <div style="margin-bottom:10px;padding:7px 10px;border-radius:4px;border-left:3px solid var(--vscode-editorWarning-foreground,#cca700);background:var(--hover);font-size:11px;color:var(--muted);line-height:1.5">
                    <span style="color:var(--vscode-editorWarning-foreground,#cca700);font-weight:600">Log-only trace — no token data</span>
                    {' — '}
                    VS Code Copilot Chat did not record token counts in this era. Token counts and cost estimates are unavailable and cannot be recovered.
                  </div>
                )
              }
              if (isOpenCode) {
                return (
                  <div style="margin-bottom:10px;padding:7px 10px;border-radius:4px;border-left:3px solid var(--vscode-editorInfo-foreground,#4fc3f7);background:var(--hover);font-size:11px;color:var(--muted);line-height:1.5">
                    <span style="color:var(--vscode-editorInfo-foreground,#4fc3f7);font-weight:600">OpenCode SQLite trace</span>
                    {' — '}
                    Token counts, tools, and files sourced from OpenCode&apos;s local database. OTel traces and TTFT are not available for OpenCode.
                  </div>
                )
              }
              if (isCursor) {
                // Real, confirmed gaps in cursor-agent's local transcript format (no OTEL export
                // exists for it to fall back to, unlike Claude Code/Codex/Copilot) — see
                // ARCHITECTURE.md §4 "Cursor CLI — transcript log". Cost/token/model are honestly zero/unknown
                // here, never a guessed number.
                return (
                  <div style="margin-bottom:10px;padding:7px 10px;border-radius:4px;border-left:3px solid var(--vscode-editorInfo-foreground,#4fc3f7);background:var(--hover);font-size:11px;color:var(--muted);line-height:1.5">
                    <span style="color:var(--vscode-editorInfo-foreground,#4fc3f7);font-weight:600">Cursor CLI trace</span>
                    {' — '}
                    Token counts, cost, and model name aren&apos;t recorded anywhere on disk by cursor-agent, so they show as unpriced/unknown here rather than a guess. Session start/end times fall back to the transcript file&apos;s own timestamps. There is no OTel path for Cursor CLI to enable instead.
                  </div>
                )
              }
              const missingTokens = isCopilot && sess.inputTokens === 0
              const parts: string[] = ['traces & TTFT']
              if (missingTokens) parts.push('input tokens & cache stats')
              if (isCopilot) parts.push('tool details')
              return (
                <div style="margin-bottom:10px;padding:7px 10px;border-radius:4px;border-left:3px solid var(--vscode-editorWarning-foreground,#cca700);background:var(--hover);font-size:11px;color:var(--muted);line-height:1.5">
                  <span style="color:var(--vscode-editorWarning-foreground,#cca700);font-weight:600">Log-only trace</span>
                  {' — '}
                  {parts.join(', ')} not available from local logs.{' '}
                  <button type="button" class="link-btn" onClick={() => goToHelp('help-config')}>
                    Enable OTel ingestion
                  </button>{' '}for full telemetry.
                </div>
              )
            })()}

            {sess.userRequest
              ? <PromptBlock text={sess.userRequest} />
              : sess.turns === 0
                ? <div style="margin-bottom:10px;font-size:11px;color:var(--muted);font-style:italic">Waiting for first turn…</div>
                : <div style="margin-bottom:10px;font-size:11px;color:var(--muted)">Prompt not captured for this trace</div>
            }
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;margin-bottom:10px">
              {[
                { k: 'Turns',      v: String(sess.totalLlmCalls) },
                { k: 'Language',   v: sessionLanguageText(sess) },
                ...(sess.filesChangedCount !== undefined ? [{ k: 'Files changed', v: String(sess.filesChangedCount) }] : []),
                ...(sess.linesAdded !== undefined && sess.linesRemoved !== undefined ? [{ k: 'Lines +/−', v: `+${formatCompact(sess.linesAdded)} / −${formatCompact(sess.linesRemoved)}` }] : []),
                ...((sess.models?.length ?? 0) > 1 ? [{ k: 'Models', v: sess.models!.join(', ') }] : []),
                { k: 'Tool calls', v: String(sess.totalToolCalls) },
                { k: 'Input tokens', v: formatCompact(sess.inputTokens) },
                { k: 'Output tokens', v: formatCompact(sess.outputTokens) },
                { k: 'Cache hit',  v: cacheRate + '%' },
                ...(sess.peakContextPerTurn ? [{ k: 'Peak ctx/turn', v: formatCompact(sess.peakContextPerTurn) }] : []),
                { k: 'Duration',   v: formatMs(sess.durationMs) },
                ...(sess.errors > 0 ? [{ k: 'Errors', v: String(sess.errors) }] : []),
                ...(!cost.modelUnknown && cost.totalUsd > 0 ? [{ k: 'Est. cost', v: fmtUsd(cost.totalUsd) }] : []),
              ].map(({ k, v }) => (
                <div key={k} style="background:var(--card-bg);border:1px solid var(--border);border-radius:4px;padding:5px 8px">
                  <div style="font-size:var(--fs-xs);color:var(--muted);text-transform:uppercase;letter-spacing:.3px">{k}</div>
                  <div style="font-size:14px;font-weight:600;color:var(--accent)">{v}</div>
                </div>
              ))}
            </div>

            {burnRate && burnRate.sessionId === sess.sessionId && (
              <div style="margin-bottom:10px;padding:6px 10px;border-radius:4px;border-left:3px solid #56D364;background:var(--hover);font-size:11px">
                <span style="color:var(--vscode-charts-green, #56D364);font-weight:600">{formatCompact(Math.round(burnRate.burnRate.tokensPerMinute))} tok/min</span>
                {burnRate.burnRate.costPerHour > 0.001 && <span style="color:var(--muted);margin-left:8px">~{fmtUsd(burnRate.burnRate.costPerHour)}/hr</span>}
                {burnRate.projection && <span style="color:var(--muted);margin-left:8px">{burnRate.projection.contextFillPct.toFixed(0)}% context used</span>}
              </div>
            )}

            <SignalList signals={sess.loopSignals} />

            {sessInsights.length > 0 && (
              <div>
                <div style="font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.4px;color:var(--muted);margin-bottom:6px">Insights</div>
                {sessInsights.slice(0, 4).map(ins => (
                  <InsightCard
                    key={ins.title} ins={ins} isIgnored={false} sessions={[sess]}
                    timeline={timeline} stepNumber={stepNumber} onShowSteps={showSteps}
                  />
                ))}
              </div>
            )}

          </div>
        )}

        {section === 'waterfall' && (
          <div>
            {steps.length === 0
              ? (timelines[sess.sessionId] !== undefined
                  ? (
                    <div class="empty-state" style="padding:12px 0">
                      No span data for this trace
                      {sess.dataSource === 'log' && <LogIngestionNote feature="trace" />}
                    </div>
                  )
                  : <div class="empty-state" style="padding:12px 0">Loading…</div>)
              : (
                <>
                  {evidence.length > 0 && (
                    <WaterfallEvidenceBar
                      evidence={evidence}
                      focused={focused}
                      cursor={cursor}
                      stepNumber={stepNumber}
                      onFocus={ev => {
                        if (focused?.key === ev.key) { setFocusKey(null); return }
                        setFocusKey(ev.key)
                        const index = ev.indices[0] ?? ev.range?.from
                        if (index !== undefined) setScrollTarget({ index, nonce: Date.now() })
                      }}
                      onJump={jump}
                      onClear={() => setFocusKey(null)}
                    />
                  )}
                  <div class="waterfall" ref={waterfallRef}>
                    <div class="wf-time-ruler">
                      {Array.from({ length: 6 }, (_, t) => <span key={t}>{formatMs(sessionDur * t / 5)}</span>)}
                    </div>
                    {evidence.length > 0 && (
                      <EvidenceTrack
                        evidence={focused ? [focused] : evidence}
                        steps={steps}
                        visible={visible}
                        sessionDur={sessionDur}
                        onPick={i => setScrollTarget({ index: i, nonce: Date.now() })}
                      />
                    )}
                    {steps.map((step, si) => (
                      <StepRow
                        key={step.entry.spanId + si}
                        step={step}
                        idx={si}
                        sessIdx={0}
                        sessionDur={sessionDur}
                        sessionModel={sess.model ?? ''}
                        tlIndex={visible[si].i}
                        mark={markFor(visible[si].i, si + 1)}
                      />
                    ))}
                  </div>
                </>
              )
            }
          </div>
        )}

        {section === 'flow' && (
          <FlowCanvas sess={sess} height={420} />
        )}

        {section === 'tools' && (
          <ToolsChart sessions={[sess]} />
        )}

        {section === 'files' && (
          <div>
            {sess.filesChanged.length === 0
              ? (
                <div class="empty-state" style="padding:12px 0">
                  No files modified
                  {sess.dataSource === 'log' && <LogIngestionNote feature="file change" />}
                </div>
              )
              : (
                <div style="display:flex;flex-direction:column;gap:3px">
                  {sess.oneShotStats && sess.oneShotStats.filesConsidered > 0 && (() => {
                    const rate = oneShotRate(sess.oneShotStats)
                    const avg = avgEditsPerFile(sess.oneShotStats)
                    return (
                      <div
                        data-tip="Counts edit passes per file — a file edited once is 'one-shot', edited again is a retry. This is a proxy for correction effort, not a signal that the code actually worked."
                        style="display:flex;align-items:center;gap:6px;padding:5px 8px;margin-bottom:2px;font-size:11px;color:var(--muted);cursor:help"
                      >
                        <span>
                          {rate === null
                            ? `Not enough edited files for a one-shot rate (${sess.oneShotStats.filesConsidered} considered)`
                            : `${Math.round(rate * 100)}% one-shot (${sess.oneShotStats.oneShotFiles}/${sess.oneShotStats.filesConsidered} files, avg ${avg?.toFixed(1)} edit passes/file)`}
                        </span>
                      </div>
                    )
                  })()}
                  {gitOutcome && OUTCOME_META[gitOutcome.overall] && (
                    <div
                      data-tip={`<b>Estimated from local git history</b>\nCompares each file's content right before this trace against its content now. Not available without a local git repo, and doesn't cover files git can't see (e.g. gitignored).`}
                      data-tip-html
                      style={`display:flex;align-items:center;gap:6px;padding:5px 8px;margin-bottom:2px;font-size:11px;color:${OUTCOME_META[gitOutcome.overall]!.color};cursor:help`}
                    >
                      <span>{OUTCOME_META[gitOutcome.overall]!.icon}</span>
                      <span>{gitOutcome.reason}</span>
                    </div>
                  )}
                  {sess.filesChanged.map(f => {
                    const fileOutcome = gitOutcome?.files[f]
                    const meta = fileOutcome ? OUTCOME_META[fileOutcome] : null
                    return (
                      <div
                        key={f}
                        style={`display:flex;align-items:center;gap:8px;padding:4px 8px;background:var(--hover);border-radius:4px;font-size:11px${vscode ? ';cursor:pointer' : ''}`}
                        onClick={() => vscode?.postMessage({ type: 'openFile', filePath: f })}
                        {...(vscode ? { role: 'button', tabIndex: 0, onKeyDown: activateOnKey(() => vscode?.postMessage({ type: 'openFile', filePath: f })) } : {})}
                        title={vscode ? 'Click to open in editor' : f}
                      >
                        <span style="color:var(--vscode-charts-green,#81c784);font-size:var(--fs-xs);flex-shrink:0">M</span>
                        <span style={`font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1${vscode ? ';color:var(--accent)' : ''}`}>{f}</span>
                        {meta && (
                          <span style={`color:${meta.color};font-size:var(--fs-xs);flex-shrink:0`} title={`<b>${meta.label}</b>\n${meta.description}`} data-tip-html>{meta.icon} {meta.label}</span>
                        )}
                      </div>
                    )
                  })}
                  {sess.filesChangedNote && (
                    <div style="font-size:var(--fs-xs);color:var(--muted);margin-top:3px">{sess.filesChangedNote}</div>
                  )}
                </div>
              )
            }
          </div>
        )}

      </div>
    </div>
  )
}

// A thin track under the time ruler with a tick at each evidence step's moment, in its signal's
// color, so a burst of retries reads as a cluster and a slow drift as a spread — the time-axis
// view of what the row dots show row by row. Only the focused signal's ticks while one is chosen.
function EvidenceTrack({ evidence, steps, visible, sessionDur, onPick }: {
  evidence: ResolvedEvidence[]
  steps: Step[]
  visible: Array<{ i: number }>
  sessionDur: number
  onPick: (timelineIndex: number) => void
}) {
  const rowOf = new Map(visible.map((v, n) => [v.i, n]))
  const ticks = evidence.flatMap(ev => ev.indices.flatMap(i => {
    const row = rowOf.get(i)
    if (row === undefined) return []
    const left = sessionDur > 0 ? (steps[row].offsetMs / sessionDur) * 100 : 0
    const n = ev.notes.get(i)
    return [{ i, left, color: ev.color, tip: `Step ${row + 1} · ${ev.name}${n ? ': ' + n.note : ''}` }]
  }))
  if (ticks.length === 0) return null
  return (
    <div class="wf-ev-track" aria-label="When each evidence step happened">
      <span class="wf-ev-track-pad" />
      <div class="wf-ev-track-area">
        {ticks.map((t, k) => (
          <button
            key={k}
            class="wf-ev-tick"
            style={`left:${t.left.toFixed(2)}%;background:${t.color}`}
            title={t.tip}
            onClick={e => { e.stopPropagation(); onPick(t.i) }}
          />
        ))}
      </div>
      <span class="wf-ev-track-info" />
    </div>
  )
}

// The strip above a trace's waterfall: one chip per insight that names steps in it. Choosing one
// lights its steps and dims the rest; the banner under the chips says why it fired and walks its
// steps one at a time.
function WaterfallEvidenceBar({ evidence, focused, cursor, stepNumber, onFocus, onJump, onClear }: {
  evidence: ResolvedEvidence[]
  focused: ResolvedEvidence | undefined
  cursor: number
  stepNumber: (i: number) => number | undefined
  onFocus: (ev: ResolvedEvidence) => void
  onJump: (delta: number) => void
  onClear: () => void
}) {
  const rangeFrom = focused?.range ? stepNumber(focused.range.from) : undefined
  const rangeTo = focused?.range ? stepNumber(focused.range.to) : undefined
  return (
    <div class="wf-ev-panel">
      <div class="wf-ev-bar">
        <span class="wf-ev-bar-label">Signal evidence</span>
        {evidence.map(ev => (
          <button
            key={ev.key}
            class={'wf-ev-chip' + (focused?.key === ev.key ? ' active' : '')}
            style={'--ev-color:' + ev.color}
            title={ev.ins.trigger ?? ev.name}
            aria-pressed={focused?.key === ev.key}
            onClick={e => { e.stopPropagation(); onFocus(ev) }}
          >
            <span class="wf-ev-chip-icon"><InsightIcon ins={ev.ins} size="sm" /></span>
            {ev.name}
            <span class="wf-ev-chip-count">{ev.indices.length}</span>
          </button>
        ))}
      </div>
      {focused
        ? (
          <div class="wf-ev-banner" style={'--ev-color:' + focused.color}>
            <div class="wf-ev-banner-text">
              <b>{focused.name}</b>
              {focused.ins.trigger && <> — {focused.ins.trigger}</>}
              {rangeFrom !== undefined && rangeTo !== undefined && focused.range && (
                <> Steps {rangeFrom}–{rangeTo} are {focused.ins.range?.note} (shaded).</>
              )}
            </div>
            <div class="wf-ev-nav">
              {focused.indices.length > 0 && (
                <>
                  <button onClick={e => { e.stopPropagation(); onJump(-1) }} disabled={cursor === 0} aria-label="Previous step">‹</button>
                  <span>{cursor >= 0 ? `${cursor + 1} of ${focused.indices.length}` : `${focused.indices.length} step${focused.indices.length === 1 ? '' : 's'}`}</span>
                  <button onClick={e => { e.stopPropagation(); onJump(1) }} disabled={cursor === focused.indices.length - 1} aria-label="Next step">›</button>
                </>
              )}
              <button class="wf-ev-clear" onClick={e => { e.stopPropagation(); onClear() }}>Clear</button>
            </div>
          </div>
        )
        : <div class="wf-ev-hint">Rows marked with a dot are evidence for a signal. Pick one to light up its steps.</div>}
    </div>
  )
}

// A log file can now split into several session cards when a large idle gap separates two real
// conversations within it (see splitLinesOnPromptGaps in logReader.ts) — those cards share a
// conversationId. Builds a per-sessionId lookup (color + "part X of Y") for every session that
// still has 2+ siblings visible in the given list, so the Sessions table can color-code and label
// rows that are really one conversation split across multiple cards. Computed over the full
// filtered list (not just the current page) so a group's color/labels stay consistent regardless
// of which page a sibling happens to land on; a sibling hidden by an active filter just means that
// group won't be colored at all here (nothing misleading — no "phantom" sibling implied).
function buildConversationInfo(sessions: SessionSummaryCard[]): Map<string, { color: string; index: number; total: number; memberIds: string[]; firstPrompt: string }> {
  const byConversation = new Map<string, SessionSummaryCard[]>()
  for (const s of sessions) {
    if (!s.conversationId) continue
    const group = byConversation.get(s.conversationId)
    if (group) group.push(s)
    else byConversation.set(s.conversationId, [s])
  }
  const info = new Map<string, { color: string; index: number; total: number; memberIds: string[]; firstPrompt: string }>()
  for (const [conversationId, members] of byConversation) {
    if (members.length < 2) continue
    const color = getConversationColor(conversationId)
    const ordered = [...members].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    const memberIds = ordered.map(m => m.sessionId)
    const firstPrompt = ordered[0].userRequest ?? ''
    ordered.forEach((m, i) => info.set(m.sessionId, { color, index: i + 1, total: ordered.length, memberIds, firstPrompt }))
  }
  return info
}

// Whether evidenceSessionIds is currently isolated to exactly this conversation's members — used
// to render the active marker as "you are here" and to make clicking it again a toggle-off,
// rather than the only way out being the filter banner's separate "×" elsewhere on the page.
function isSameIdSet(current: Set<string> | null, ids: string[]): boolean {
  return current !== null && current.size === ids.length && ids.every(id => current.has(id))
}

// ── Table row ─────────────────────────────────────────────────────────────────

// The prompt cell truncates in JS to this many characters, rather than leaving it to CSS
// ellipsis alone, so the trailing "(<trace id>)" always survives intact — CSS text-overflow would
// otherwise just as happily cut the id off mid-character as the prompt text. Not a measured
// number, same honesty standard as every other threshold in this project — picked to leave room
// for the id suffix within the column's own max-width.
const PROMPT_PREVIEW_CHARS = 60

function SessionRow({ sess, showWorkspace, showOutcome, showLimit, conversation }: {
  sess: SessionSummaryCard; showWorkspace: boolean; showOutcome: boolean; showLimit: boolean
  conversation?: { color: string; index: number; total: number; memberIds: string[]; firstPrompt: string }
}) {
  const [expanded, setExpanded] = useState(false)
  const isFocused = focusedSessionId.value === sess.sessionId
  const rowRef = useRef<HTMLTableRowElement>(null)
  const cost = calcSessionCost(sess)
  const color = getAgentColorVar(sess.source)
  const prompt = sess.userRequest ?? ''
  const isIsolatedToThisGroup = conversation ? isSameIdSet(evidenceSessionIds.value, conversation.memberIds) : false

  const detailRef = useRef<HTMLTableRowElement>(null)

  // Scrolls the table's scroll region (the active .panel) so `target`'s top sits flush under the
  // table's sticky thead — never hidden beneath it, which plain scrollIntoView would do.
  function scrollUnderHeader(target: HTMLElement, offset: number, smooth: boolean) {
    const scroller = target.closest('.panel')
    const thead = target.closest('table')?.tHead
    if (!scroller || !thead) return
    const delta = target.getBoundingClientRect().top - thead.getBoundingClientRect().bottom - offset
    if (Math.abs(delta) > 1) scroller.scrollBy({ top: delta, behavior: smooth ? scrollBehavior() : 'auto' })
  }

  // An expanded row pins itself just under the table's own sticky thead, so its collapse chevron
  // stays reachable while scrolling a long detail. The offset is measured rather than hardcoded
  // since the header's height follows the webview's font size.
  const [stickyTop, setStickyTop] = useState(0)
  useLayoutEffect(() => {
    if (!expanded) return
    setStickyTop(rowRef.current?.closest('table')?.tHead?.offsetHeight ?? 0)
    // On expand, bring the row to the top with the very top of its detail right below it. Measured
    // off the detail row, not the row itself: a row that's already pinned reports its pinned
    // position, not where it really sits in the table.
    if (detailRef.current) scrollUnderHeader(detailRef.current, rowRef.current?.offsetHeight ?? 0, true)
  }, [expanded])

  useEffect(() => {
    if (focusedSessionId.value !== sess.sessionId) return
    // Focused from elsewhere (another tab, the context bar): expanding scrolls it into place via
    // the layout effect above; an already-open row just needs the scroll.
    if (expanded && detailRef.current) scrollUnderHeader(detailRef.current, rowRef.current?.offsetHeight ?? 0, true)
    else setExpanded(true)
  }, [focusedSessionId.value])

  function toggle() {
    const next = !expanded
    // Collapsing a pinned row (scrolled down into its detail) would otherwise leave the view
    // somewhere below it once the detail disappears — bring the row back into view instead.
    const row = rowRef.current
    const pinned = !next && row !== null && row.getBoundingClientRect().top <= (row.closest('table')?.tHead?.getBoundingClientRect().bottom ?? 0) + 1
    setExpanded(next)
    focusedSessionId.value = next ? sess.sessionId : null
    if (pinned) requestAnimationFrame(() => scrollUnderHeader(row!, 0, false))
  }

  // Opaque when pinned, so detail content scrolling underneath doesn't show through.
  const rowBg = isFocused ? 'linear-gradient(var(--hover),var(--hover)),var(--bg)' : expanded ? 'var(--bg)' : 'transparent'
  const stickyStyle = expanded ? `;position:sticky;top:${stickyTop}px;z-index:1` : ''

  return (
    <>
      <tr
        ref={rowRef}
        onClick={toggle}
        style={`cursor:pointer;background:${rowBg};border-bottom:1px solid var(--vscode-panel-border)${stickyStyle}`}
      >
        {/* Conversation-group marker — colored bar for sessions that are really one conversation
            split into multiple cards by a long gap (see buildConversationInfo above). An empty
            <td> collapses to zero width under table-layout:auto regardless of the width style, so
            the bar is a real child element instead of a background painted on the cell itself.
            Clicking it toggles isolating the conversation's sessions (stopPropagation so it
            doesn't also trigger the row's own expand-on-click) via the same evidenceSessionIds
            filter the Advisor tab's "View sessions" button already uses — click again (same
            gesture, same spot) to clear it, same as the banner's "×" but without needing to look
            away to find it. A currently-active bar renders wider as a visible "you are here." */}
        <td style={`padding:0;width:${isIsolatedToThisGroup ? 8 : 5}px`}>
          {conversation ? (
            <button
              type="button"
              class="conv-marker"
              aria-pressed={isIsolatedToThisGroup}
              aria-label={`Part ${conversation.index} of ${conversation.total} of the same conversation — show just this conversation`}
              title={isIsolatedToThisGroup
                ? `Part ${conversation.index} of ${conversation.total} — showing just this conversation. Click again to clear.`
                : `Part ${conversation.index} of ${conversation.total} of the same conversation — split into separate rows by a long gap. Click to show just this conversation.`}
              onClick={(e: MouseEvent) => {
                e.stopPropagation()
                if (isIsolatedToThisGroup) {
                  evidenceSessionIds.value = null
                  evidenceSessionPrompt.value = null
                } else {
                  evidenceSessionIds.value = new Set(conversation.memberIds)
                  evidenceSessionLabel.value = 'from this conversation'
                  evidenceSessionPrompt.value = conversation.firstPrompt || null
                }
              }}
              style={`display:block;width:${isIsolatedToThisGroup ? 8 : 5}px;height:100%;min-height:20px;padding:0;border:0;cursor:pointer;background:${conversation.color}`}
            />
          ) : (
            <div style="width:5px;height:100%;min-height:20px" />
          )}
        </td>

        {/* Chevron */}
        <td style="padding:4px 2px 4px 4px;width:16px;color:var(--muted);font-size:var(--fs-xs);white-space:nowrap">
          <button class="trace-expand" aria-label={expanded ? 'Collapse trace' : 'Expand trace'} aria-expanded={expanded} onClick={e => { e.stopPropagation(); toggle() }}>{expanded ? '▼' : '▶'}</button>
        </td>

        {/* Agent / Start / Source / From, merged into one column, in that left-to-right order
            (colors match the Outcome bar's own Source/From pills — see
            DATA_SOURCE_COLORS/INITIATOR_COLORS in utils.ts) */}
        <td style="padding:4px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          <span style={`display:inline-block;width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0;vertical-align:middle`} title={getAgentSourceLabel(sess.source)} />
          <span style="margin-left:6px;font-size:var(--fs-xs);color:var(--muted);font-variant-numeric:tabular-nums">{formatSessionTime(sess)}</span>
          <span style="margin-left:6px" dangerouslySetInnerHTML={{ __html: getDataSourceBadgeHtml(sess.dataSource ?? 'otel') }} />
          <span dangerouslySetInnerHTML={{ __html: getInitiatorBadgeHtml(sess.initiator) }} />
        </td>

        {/* Model */}
        <td style="padding:4px 2px;white-space:nowrap;font-size:var(--fs-xs);color:var(--muted);max-width:100px;overflow:hidden;text-overflow:ellipsis" title={sess.model || undefined}>
          {sess.model || '—'}
          {(sess.models?.length ?? 0) > 1 && (
            <span
              title={`Multiple models used in this trace: ${sess.models!.join(', ')}`}
              style="margin-left:4px;padding:0 4px;border-radius:3px;background:var(--hover);color:var(--muted);font-size:var(--fs-xs);vertical-align:middle"
            >+{sess.models!.length - 1}</span>
          )}
        </td>

        {/* Language — the primary's short form (LANGUAGE_ABBREVIATIONS: "TS", "Py"), since this is a
            compact cell; the full names stay in the title and aria-label. The "+1" badge's own
            title names both full languages. */}
        <td class="trace-language" style="padding:4px 2px;white-space:nowrap;font-size:var(--fs-xs);color:var(--muted);overflow:hidden;text-overflow:ellipsis" title={sessionLanguageTitle(sess)} aria-label={sessionLanguageAriaLabel(sess)}>
          {languageAbbreviation(sess.language)}
          {sess.languageSecondary && (
            <span
              class="trace-language-secondary"
              title={`Primary: ${languageLabel(sess.language)} · Secondary: ${languageLabel(sess.languageSecondary)}`}
              style="margin-left:4px;padding:0 4px;border-radius:3px;background:var(--hover);color:var(--muted);font-size:var(--fs-xs);vertical-align:middle"
            >+1</span>
          )}
        </td>

        {/* Changes — agent-authored change size (src/editStats.ts), not git stats */}
        <td class="trace-changes" style="padding:4px 2px;white-space:nowrap;font-size:var(--fs-xs);color:var(--muted);overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums" title={sessionChangesTitle(sess)}>
          {sessionChangesText(sess)}
        </td>

        {/* Prompt (Trace ID) */}
        <td style="padding:4px 2px;overflow:hidden;max-width:140px">
          {prompt
            ? <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px" title={prompt}>
                <span style="font-style:italic;color:var(--foreground)">
                  {prompt.length > PROMPT_PREVIEW_CHARS ? prompt.slice(0, PROMPT_PREVIEW_CHARS).trimEnd() + '…' : prompt}
                </span>
                <span style="font-family:monospace;color:var(--muted)"> ({formatTraceIdHash(sess.traceId || sess.sessionId).slice(0, 8)})</span>
              </span>
            : sess.turns === 0
              ? <span style="color:var(--muted);font-size:11px">…</span>
              : <span style="color:var(--muted);font-size:11px">—</span>
          }
        </td>

        {showWorkspace && (
          <td
            style="padding:4px 2px;font-size:var(--fs-xs);color:var(--muted);max-width:110px"
            title={sess.workspace ? `${repoTooltipName(sess.workspace, repoInfo.value)}\nLocal: ${sess.workspace}` : undefined}
          >
            <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              {sess.workspace ? repoDisplayName(sess.workspace, repoInfo.value) : '—'}
            </span>
          </td>
        )}

        {/* Git outcome — own column so the single-letter pill (GitOutcomeBadge) always lines up
            under the "O" header instead of riding along inside the Repo cell. */}
        {showOutcome && (
          <td style="padding:4px 0;text-align:left">
            <GitOutcomeBadge sessionId={sess.sessionId} />
          </td>
        )}

        {/* Signals — own column, unconditional (unlike Repo/Outcome above, doesn't need a
            workspace) so a struggle pattern is visible regardless of showWorkspace. */}
        <td style="padding:4px 2px 4px 4px;text-align:left">
          <SignalsCell signals={sessionSignals(sess)} />
        </td>

        {/* Turns */}
        <td style="padding:4px 2px;text-align:left;white-space:nowrap;font-size:var(--fs-xs);color:var(--muted)">
          {sess.turns}
          {sess.errors > 0 && <> · <span style="color:var(--error)" title={`${sess.errors} error${sess.errors === 1 ? '' : 's'}`}>{sess.errors}</span></>}
        </td>

        {/* Duration */}
        <td style="padding:4px 2px;text-align:left;white-space:nowrap;font-size:var(--fs-xs);color:var(--muted)">
          {formatMs(sess.durationMs)}
        </td>

        {/* Tokens */}
        <td style="padding:4px 2px;text-align:left;white-space:nowrap;font-size:var(--fs-xs);color:var(--muted)" title={sess.turns > 1 ? 'Input is accumulated across all turns (cache reads counted each turn). See Peak ctx/turn in trace detail for actual context window size.' : undefined}>
          {formatCompact(sess.inputTokens + sess.outputTokens)}
        </td>

        {/* Cost */}
        <td style="padding:4px 6px 4px 2px;text-align:left;white-space:nowrap;font-size:var(--fs-xs)">
          {/* Plain text colour: green read as "good", not "a cost". An unpriced trace shows "—" with
              the reason; its error count stays in the Turns column. */}
          {!cost.modelUnknown && cost.totalUsd > 0
            ? <span style="color:var(--fg)">{fmtUsd(cost.totalUsd)}</span>
            : (() => {
                const why = cost.modelUnknown
                  ? `Couldn't be priced — ${sess.model ? `no rates for ${sess.model} in the pricing table` : 'the model wasn\'t recorded'}`
                  : 'No cost — this trace recorded no billable tokens'
                return <span style="color:var(--muted)" title={why} aria-label={why} tabIndex={0}>—</span>
              })()
          }
        </td>

        {/* Limit — one Claude Code / Codex subscription window (5h, else weekly); blank when there's no value. */}
        {showLimit && (
          <td style="padding:4px 6px 4px 2px;text-align:left;font-size:var(--fs-xs);color:var(--muted)">
            <LimitUsedCell sessionId={sess.sessionId} />
          </td>
        )}
      </tr>

      {expanded && (
        <tr ref={detailRef} style="border-bottom:1px solid var(--vscode-panel-border)">
          <td colspan={12 + (showWorkspace ? 1 : 0) + (showOutcome ? 1 : 0) + (showLimit ? 1 : 0)} style="padding:0">
            <SessionDetail sess={sess} />
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main Sessions component ───────────────────────────────────────────────────

export function Sessions() {
  const sessions = filteredSessions.value
  const hasAny = (sessionSummary.value?.sessions?.length ?? 0) > 0
  const showWorkspace = availableWorkspaces.value.length > 1
  const showOutcome = hasAnyWorkspace.value

  const sortKey = sessionSortKey.value
  const sortDir = sessionSortDir.value

  function sortArrow(key: SortKey) {
    if (sortKey !== key) return <span aria-hidden="true" class="sort-indicator" style="opacity:0.3">↕</span>
    return <span aria-hidden="true" class="sort-indicator" style="color:var(--accent)">{sortDir === 'desc' ? '▼' : '▲'}</span>
  }

  function onSortClick(key: SortKey) {
    if (sessionSortKey.value === key) {
      sessionSortDir.value = sessionSortDir.value === 'desc' ? 'asc' : 'desc'
    } else {
      sessionSortKey.value = key
      sessionSortDir.value = 'desc'
    }
    // A new order makes page 3's rows an arbitrary slice — start again from the top.
    sessionsPage.value = 0
  }

  const thBase = 'padding:3px 2px;font-size:var(--fs-xs);font-weight:600;white-space:nowrap;user-select:none'
  const thSort = thBase + ';cursor:pointer;color:var(--fg)'
  function sortHeader(key: SortKey, label: string, align: 'left' | 'right' | 'center' = 'left', title?: string) {
    return <th scope="col" aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} style={'text-align:' + align + ';' + thSort}>
      <button class="sort-button" onClick={() => onSortClick(key)} title={title} {...(title ? { 'data-tip-html': true } : {})}>{label}{sortArrow(key)}</button>
    </th>
  }

  // Rendering every matching session as its own live component with no cap is what made the table
  // unusable on a long history — see getSessionsPagination's own doc comment (state.ts) for why the
  // clamping happens there rather than here.
  const { page, totalPages, pageSize } = getSessionsPagination(sessions.length)
  const pageSessions = sessions.slice(page * pageSize, (page + 1) * pageSize)
  // Only when a row on this page has a value — an all-blank column is UI without data.
  const showLimit = showLimitColumn(pageSessions, planUsage.value)
  const conversationInfo = buildConversationInfo(sessions)

  // Fetches git outcomes for just the current page (bounded by pagination already, same cap/
  // stagger the Outcome filter uses — see requestGitOutcomesFor) so the one-letter outcome badge
  // next to each repo name has data without computing it for every off-screen session.
  useEffect(() => { if (showOutcome) requestGitOutcomesFor(pageSessions) }, [showOutcome, pageSessions])

  return (
    <div id="sessions-content" style="padding-top:8px">
      <div role="region" aria-label="Traces table" tabIndex={0}>
      {/* Every column but Prompt has a fixed width, so a wide panel's spare space all goes to
          Prompt instead of being spread across the narrow number columns as gaps. min-width
          keeps Prompt at least 160px when every optional column is showing. */}
      <table class="trace-table" style={`width:100%;border-collapse:collapse;font-size:11px;min-width:${768 + (showWorkspace ? 110 : 0) + (showOutcome ? 40 : 0) + (showLimit ? 72 : 0) + 160}px`}>
        <colgroup>
          <col style="width:8px" /><col style="width:18px" /><col style="width:196px" /><col style="width:100px" /><col style="width:64px" /><col style="width:80px" />
          <col />
          {showWorkspace && <col style="width:110px" />}
          {showOutcome && <col style="width:40px" />}
          <col style="width:76px" /><col style="width:50px" /><col style="width:66px" /><col style="width:58px" /><col style="width:68px" />
          {showLimit && <col style="width:72px" />}
        </colgroup>
        <thead>
          <tr style="border-bottom:2px solid var(--vscode-panel-border)">
            <th style="width:5px;padding:0" tabIndex={0} aria-label="Conversation marker" title={`<b>Conversation marker</b>\nA colored bar marks traces that are really one conversation split into multiple rows by a long gap between them.`} data-tip-html />
            <th style="width:16px;padding:3px 2px 3px 4px" />
            <th scope="col" aria-sort={sortKey === 'start_time' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} style={'text-align:left;' + thSort}>
              <button class="sort-button" onClick={() => onSortClick('start_time')} title={`<b>Agent / Start / Source / From</b>\nSorted by start time only — Agent/Source/From aren't part of the sort`} data-tip-html>
                Agent / <strong style="font-weight:800">Start</strong> / Source / From{sortArrow('start_time')}
              </button>
            </th>
            <th scope="col" aria-sort={sortKey === 'model' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} style={'text-align:left;' + thSort}>
              <button class="sort-button" onClick={() => onSortClick('model')}>Model{sortArrow('model')}</button>
            </th>
            {sortHeader('language', 'Lang', 'left', '<b>Language</b>\nMost common code language among the files the agent read or changed (README/config/lockfiles excluded), abbreviated (TS, Py, C++…) — hover a cell for the full name. "+1" means a second language was touched too — hover it for both. "—" means a trace stored before language tracking.')}
            {sortHeader('lines', 'Changes', 'left', '<b>Changes</b>\nFiles the agent edited or wrote, and lines its own edit/write tool calls added (+) and removed (−). Agent-authored edits, not git commit stats. Lines show "?" when the agent\'s data records no edit contents.')}
            {sortHeader('prompt', 'Prompt (ID)')}
            {showWorkspace && (
              <th scope="col" aria-sort={sortKey === 'workspace' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} style={'text-align:left;' + thSort}>
                <button class="sort-button" onClick={() => onSortClick('workspace')} title={`<b>Repo (ID)</b>\nSort by repo`} data-tip-html>Repo (ID){sortArrow('workspace')}</button>
              </th>
            )}
            {showOutcome && (
              <th scope="col" aria-sort={sortKey === 'outcome' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} style={thSort + ';text-align:left;color:var(--tr-brand);padding-left:0;padding-right:0'}>
                <button class="sort-button" onClick={() => onSortClick('outcome')} title={`<b>Git outcome</b>\nWhether each trace's changed files are merged into the trunk branch (M), committed but not yet merged (C), or still uncommitted (U), per local git history`} data-tip-html>Out{sortArrow('outcome')}</button>
              </th>
            )}
            <th scope="col" aria-sort={sortKey === 'signals' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} style={thSort + ';text-align:left;color:var(--fg);padding-left:0'}>
              <button class="sort-button" onClick={() => onSortClick('signals')} title={`<b>Signals</b>\nBehavioral signals detected during the trace — context flooding, retry loops, runaway cost, and similar patterns Advisor also flags. Based on general heuristics and may include false positives — review before acting on them.`} data-tip-html>Signals{sortArrow('signals')}</button>
            </th>
            {sortHeader('turns', 'Turns')}
            {sortHeader('duration_ms', 'Duration')}
            {sortHeader('total_tokens', 'Tokens', 'left', '<b>Tokens</b>\nAccumulated input and output tokens across all turns')}
            {sortHeader('cost', 'Est Cost')}
            {showLimit && (
              <th scope="col" tabIndex={0} style={thSort + ';text-align:left'} title={`<b>Limit</b>\nShare of your Claude or ChatGPT plan's 5-hour window this trace used (weekly when there's no 5-hour reading). Expand a trace for every window and any limit hits. ≈ means estimated. ⛔ means the trace hit a limit.`} data-tip-html>Limit</th>
            )}
          </tr>
        </thead>
        <tbody>
          {sessions.length === 0 && <tr><td colspan={12 + (showWorkspace ? 1 : 0) + (showOutcome ? 1 : 0) + (showLimit ? 1 : 0)}><div class="empty-state" role="status">{hasAny ? 'No traces match the active filters. Change a filter or use Clear Filters to show all traces.' : logIngestProgress.value ? 'Loading traces from local logs…' : <NoTracesYet />}</div></td></tr>}
          {pageSessions.map(sess => (
            <SessionRow key={sess.sessionId} sess={sess} showWorkspace={showWorkspace} showOutcome={showOutcome} showLimit={showLimit} conversation={conversationInfo.get(sess.sessionId)} />
          ))}
        </tbody>
      </table>
      </div>
      <div class="trace-pagination" style="padding:6px 8px;font-size:11px;color:var(--muted);border-top:1px solid var(--vscode-panel-border);display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:8px">
        {window.__VERSION__ && <span title="TraceRoost version">v{window.__VERSION__}</span>}
        <span style="display:flex;align-items:center;gap:8px;margin-left:auto">
            <PageSizeSelect />
            <SessionsPager page={page} totalPages={totalPages} />
        </span>
      </div>
    </div>
  )
}
