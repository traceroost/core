/**
 * CSV/Markdown serialization for session exports — generalizes the CSV pattern already used by
 * the Analytics tab's cost-table export (media/src/tabs/Analytics.tsx) to the full session export.
 *
 * JSON stays the default/primary export format (and the only one Import reads back) — these are
 * for external consumption: dropping into a spreadsheet, or sharing a readable report.
 */

import type { LoopSignal } from './types'

export type ExportFormat = 'json' | 'csv' | 'markdown'

// Matches the `exportable` shape built in DashboardPanel.exportSessions / standalone/server.ts's
// browser-side export handler. Kept intentionally loose (readonly, no class) so both callers can
// pass their own plain object literals without extra conversion.
export interface ExportableSession {
  sessionId: string
  traceId: string
  source: string
  dataSource: string
  model: string
  models: string[]
  startTime: string
  durationMs: number
  turns: number
  totalToolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  cacheHitRate: number
  errors: number
  outcome: string
  toolCounts: Record<string, number>
  filesRead: string[]
  filesChanged: string[]
  loopSignals: Pick<LoopSignal, 'type' | 'severity'>[]
  userRequest: string
  /** Allowlisted language ids (src/language.ts); null/absent for a row stored before language
   *  tracking existed. */
  language?: string | null
  languageSecondary?: string | null
  /** Agent-authored change size (src/editStats.ts) — counts only; lines null when unknown. */
  filesChangedCount?: number | null
  linesAdded?: number | null
  linesRemoved?: number | null
}

export function exportFileExtension(format: ExportFormat): string {
  return format === 'csv' ? 'csv' : format === 'markdown' ? 'md' : 'json'
}

// Every field quoted unconditionally (matches the existing Analytics CSV export's convention) —
// simplest approach that's always correct, no need to special-case which fields might contain a
// comma, quote, or newline. A cell a spreadsheet would read as a formula (leading = + - @, tab or
// CR — quoting alone doesn't stop Excel/Sheets evaluating it) gets a leading `'` so it stays text;
// prompts and file paths come from agent traces, so they're attacker-influenced.
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return '"' + safe.replace(/"/g, '""') + '"'
}

function joinList(items: string[]): string {
  return items.join('; ')
}

function joinToolCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([tool, n]) => `${tool}:${n}`).join('; ')
}

function joinLoopSignals(signals: Pick<LoopSignal, 'type' | 'severity'>[]): string {
  return signals.map(s => `${s.type}(${s.severity})`).join('; ')
}

function numCell(n: number | null | undefined): string {
  return typeof n === 'number' ? String(n) : ''
}

const CSV_HEADERS = [
  'Session ID', 'Trace ID', 'Source', 'Data Source', 'Model', 'Models', 'Start Time', 'Duration (ms)', 'Turns',
  'Tool Calls', 'Input Tokens', 'Output Tokens', 'Cache Read Tokens', 'Cache Create Tokens',
  'Cache Hit Rate', 'Errors', 'Outcome', 'Tool Counts', 'Files Read', 'Files Changed',
  'Loop Signals', 'Language', 'Secondary Language',
  'Files Changed (count)', 'Lines Added', 'Lines Removed', 'User Request',
]

export function toCsv(sessions: ExportableSession[]): string {
  const rows = sessions.map(s => [
    s.sessionId,
    s.traceId,
    s.source,
    s.dataSource,
    s.model,
    joinList(s.models),
    s.startTime,
    String(s.durationMs),
    String(s.turns),
    String(s.totalToolCalls),
    String(s.inputTokens),
    String(s.outputTokens),
    String(s.cacheReadTokens),
    String(s.cacheCreateTokens),
    s.cacheHitRate.toFixed(4),
    String(s.errors),
    s.outcome,
    joinToolCounts(s.toolCounts),
    joinList(s.filesRead),
    joinList(s.filesChanged),
    joinLoopSignals(s.loopSignals),
    s.language ?? '',
    s.languageSecondary ?? '',
    numCell(s.filesChangedCount),
    numCell(s.linesAdded),
    numCell(s.linesRemoved),
    s.userRequest,
  ])
  return [CSV_HEADERS, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

function mdEscape(text: string): string {
  return text.replace(/\|/g, '\\|')
}

export function toMarkdown(sessions: ExportableSession[]): string {
  const parts: string[] = [
    `# TraceRoost Session Export`,
    ``,
    `${sessions.length} session${sessions.length === 1 ? '' : 's'}, exported ${new Date().toISOString()}`,
    ``,
  ]

  for (const s of sessions) {
    parts.push(`## ${s.model || 'unknown model'} — ${s.startTime || 'unknown time'}`)
    parts.push('')
    parts.push(`- **Session ID:** ${s.sessionId}`)
    parts.push(`- **Source:** ${s.source} (${s.dataSource === 'log' ? 'log file' : 'OTEL'})`)
    if (s.models.length > 1) parts.push(`- **Models used:** ${joinList(s.models)}`)
    parts.push(`- **Duration:** ${s.durationMs}ms`)
    parts.push(`- **Turns:** ${s.turns} · **Tool calls:** ${s.totalToolCalls} · **Errors:** ${s.errors}`)
    parts.push(`- **Tokens:** ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out `
      + `(cache read ${s.cacheReadTokens.toLocaleString()}, cache write ${s.cacheCreateTokens.toLocaleString()}, `
      + `${(s.cacheHitRate * 100).toFixed(1)}% hit rate)`)
    parts.push(`- **Outcome:** ${s.outcome}`)
    if (typeof s.filesChangedCount === 'number') {
      const lines = typeof s.linesAdded === 'number' && typeof s.linesRemoved === 'number' ? `, +${s.linesAdded} / −${s.linesRemoved} lines` : ''
      parts.push(`- **Change size:** ${s.filesChangedCount} file${s.filesChangedCount === 1 ? '' : 's'} changed${lines}`)
    }
    if (s.language) {
      parts.push(`- **Language:** ${s.language}${s.languageSecondary ? ` (secondary: ${s.languageSecondary})` : ''}`)
    }
    if (Object.keys(s.toolCounts).length > 0) {
      parts.push(`- **Tool counts:** ${joinToolCounts(s.toolCounts)}`)
    }
    if (s.loopSignals.length > 0) {
      parts.push(`- **Loop signals:** ${joinLoopSignals(s.loopSignals)}`)
    }
    if (s.filesRead.length > 0) {
      parts.push(``, `**Files read:**`, ``, ...s.filesRead.map(f => `- \`${mdEscape(f)}\``))
    }
    if (s.filesChanged.length > 0) {
      parts.push(``, `**Files changed:**`, ``, ...s.filesChanged.map(f => `- \`${mdEscape(f)}\``))
    }
    if (s.userRequest) {
      parts.push(``, `**Prompt:**`, ``, `> ${mdEscape(s.userRequest).replace(/\n/g, '\n> ')}`)
    }
    parts.push(``, `---`, ``)
  }

  return parts.join('\n')
}

export function serializeExport(sessions: ExportableSession[], format: ExportFormat): string {
  if (format === 'csv') return toCsv(sessions)
  if (format === 'markdown') return toMarkdown(sessions)
  return JSON.stringify(sessions, null, 2)
}
