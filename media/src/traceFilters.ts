// What the header's trace filters are set to, in words — shared by the filter bar (App.tsx: the
// Filters button's chips, Clear Filters) and tabs that explain their numbers are filtered (the
// Advisor's instruction suggestions).

import {
  timeRange, TIME_PRESETS, selectedAgentFilter, evidenceSessionIds, evidenceSessionPrompt, evidenceSessionLabel,
  sessionTextFilter, languageFilter, workspaceFilter, outcomeFilter, dataSourceFilter, initiatorFilter,
  sessionLimit, sessionSortKey, sessionSortDir, sessionsPage, type TimeRange,
} from './state'
import type { InitiatorFilter, DataSourceFilter, OutcomeFilter } from './types'
import { DATA_SOURCE_COLORS, INITIATOR_COLORS, getAgentSourceLabel } from './utils'
import { LANGUAGE_LABELS } from './language'

// Blank unless `ms` carries a time other than its edge's own day-boundary default — so reopening
// a date-only custom range shows an empty (not misleadingly "00:00"/"23:59") time field, matching
// what was actually chosen. `time` input to unix ms is dateInputToMs's job; this is its inverse.
export function msToTimeInput(ms: number | undefined, edge: 'start' | 'end'): string {
  if (!ms) return ''
  const msOfDay = ((ms % 86_400_000) + 86_400_000) % 86_400_000
  const boundaryMsOfDay = edge === 'start' ? 0 : 86_400_000 - 1
  if (msOfDay === boundaryMsOfDay) return ''
  const d = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
// A bound's date, plus its time-of-day if it carries one other than the edge's own day-boundary
// default — "Aug 1" or "Aug 1 14:30".
function shortBound(ms: number, edge: 'start' | 'end'): string {
  const time = msToTimeInput(ms, edge)
  return time ? `${shortDate(ms)} ${time}` : shortDate(ms)
}
export function timeRangeLabel(r: TimeRange): string {
  if (r.preset === 'custom') {
    if (r.since && r.until) return `${shortBound(r.since, 'start')}–${shortBound(r.until, 'end')}`
    if (r.since) return `Since ${shortBound(r.since, 'start')}`
    if (r.until) return `Until ${shortBound(r.until, 'end')}`
    return 'Custom'
  }
  return TIME_PRESETS.find(p => p.id === r.preset)?.label ?? 'All'
}

export const DATA_SOURCE_FILTER_OPTIONS: Array<{ value: DataSourceFilter; label: string; color: string }> = [
  { value: 'all',  label: 'All',  color: DATA_SOURCE_COLORS.all },
  { value: 'otel', label: 'OTel', color: DATA_SOURCE_COLORS.otel },
  { value: 'log',  label: 'Log',  color: DATA_SOURCE_COLORS.log },
]

export const INITIATOR_FILTER_OPTIONS: Array<{ value: InitiatorFilter; label: string; color: string }> = [
  { value: 'all',   label: 'All',   color: INITIATOR_COLORS.all },
  { value: 'user',  label: 'User',  color: INITIATOR_COLORS.user },
  { value: 'agent', label: 'Agent', color: INITIATOR_COLORS.agent },
]

// Labels here match Sessions.tsx's own OUTCOME_META and the Glossary's "Git Outcome" entry exactly
// (Merged/Committed/Uncommitted). "Merged" is a real, verified claim, not just wording —
// gitOutcome.ts resolves the repo's trunk branch (main/master) and only reports 'merged' once a
// file's content also matches the trunk tip; a file that's committed but hasn't reached trunk yet
// (e.g. still on a feature branch, or no trunk could be resolved) reports 'committed' instead. See
// help-outcome in Help.tsx for the full definitions. Internal `value`s are unchanged — they're a
// wire format (WireOutcome, schema.ts) shared with traceroost-cloud, not just a display string.
// No 'unknown' pill: an ambiguous/inconclusive outcome (deleted file, no repo, etc.) has nothing
// meaningful to filter on or badge — those sessions just don't show a pill, and only appear under
// "All" (see OUTCOME_META in Sessions.tsx and outcomeToFilterBucket in state.ts).
export const OUTCOME_FILTER_OPTIONS: Array<{ value: OutcomeFilter; label: string; color: string; title: string }> = [
  { value: 'all',       label: 'All',         color: 'var(--fg)',        title: 'Show all traces' },
  { value: 'merged',    label: 'Merged',      color: 'var(--tr-merged)', title: "Changed files are committed and match the tip of this repo's trunk branch (main/master), per git history" },
  { value: 'committed', label: 'Committed',   color: 'var(--accent)',    title: "Changed files are committed, but haven't reached the trunk branch yet (e.g. still on a feature branch) — or no trunk branch could be resolved locally" },
  { value: 'abandoned', label: 'Uncommitted', color: 'var(--vscode-editorWarning-foreground, #f6a623)', title: "Changed files haven't been committed yet — not necessarily abandoned, may still be in progress" },
]

export interface ActiveFilterChip { key: string; label: string; value: string; clear: () => void }

// The secondary filters currently narrowing the traces — the "(n)" on the Filters button and the
// removable chips beside it. Time and Agent stay in the bar itself, so they aren't counted.
export function activeSecondaryFilters(): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = []
  const prompt = sessionTextFilter.value.trim()
  if (prompt !== '') chips.push({ key: 'prompt', label: 'Prompt', value: prompt, clear: () => { sessionTextFilter.value = '' } })
  if (languageFilter.value !== 'all') {
    const id = languageFilter.value
    chips.push({ key: 'language', label: 'Language', value: LANGUAGE_LABELS[id as keyof typeof LANGUAGE_LABELS] ?? id, clear: () => { languageFilter.value = 'all' } })
  }
  const repo = workspaceFilter.value.trim()
  if (repo !== '') chips.push({ key: 'repo', label: 'Repo', value: repo, clear: () => { workspaceFilter.value = '' } })
  if (outcomeFilter.value !== 'all') {
    const v = outcomeFilter.value
    chips.push({ key: 'outcome', label: 'Outcome', value: OUTCOME_FILTER_OPTIONS.find(o => o.value === v)?.label ?? v, clear: () => { outcomeFilter.value = 'all' } })
  }
  if (dataSourceFilter.value !== 'all') {
    const v = dataSourceFilter.value
    chips.push({ key: 'source', label: 'Source', value: DATA_SOURCE_FILTER_OPTIONS.find(o => o.value === v)?.label ?? v, clear: () => { dataSourceFilter.value = 'all' } })
  }
  if (initiatorFilter.value !== 'all') {
    const v = initiatorFilter.value
    chips.push({ key: 'from', label: 'From', value: INITIATOR_FILTER_OPTIONS.find(o => o.value === v)?.label ?? v, clear: () => { initiatorFilter.value = 'all' } })
  }
  return chips
}

// Every filter narrowing the traces, Time and Agent included — for a summary like "Filtered: Last
// 7 days · Agent: Claude". Sort order and page size aren't filters: they don't change which traces
// count.
export function activeTraceFilters(): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = []
  const range = timeRange.value
  if (range.preset !== 'all') chips.push({ key: 'time', label: 'Time', value: timeRangeLabel(range), clear: () => { timeRange.value = { preset: 'all' } } })
  const agent = selectedAgentFilter.value
  if (agent !== 'all') chips.push({ key: 'agent', label: 'Agent', value: getAgentSourceLabel(agent), clear: () => { selectedAgentFilter.value = 'all' } })
  if (evidenceSessionIds.value !== null) {
    chips.push({
      key: 'traces', label: 'Traces', value: `${evidenceSessionIds.value.size} ${evidenceSessionLabel.value}`,
      clear: () => { evidenceSessionIds.value = null; evidenceSessionPrompt.value = null },
    })
  }
  return [...chips, ...activeSecondaryFilters()]
}

// The header's Clear Filters: every filter, plus the Traces table's sort, limit and page.
export function clearTraceFilters(): void {
  sessionTextFilter.value = ''
  evidenceSessionIds.value = null
  evidenceSessionPrompt.value = null
  selectedAgentFilter.value = 'all'
  languageFilter.value = 'all'
  initiatorFilter.value = 'all'
  dataSourceFilter.value = 'all'
  workspaceFilter.value = ''
  outcomeFilter.value = 'all'
  sessionLimit.value = 25
  timeRange.value = { preset: 'all' }
  sessionSortKey.value = 'start_time'
  sessionSortDir.value = 'desc'
  sessionsPage.value = 0
  }

