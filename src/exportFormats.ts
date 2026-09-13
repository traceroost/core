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
}

export function exportFileExtension(format: ExportFormat): string {
  return format === 'csv' ? 'csv' : format === 'markdown' ? 'md' : 'json'
}

// Every field quoted unconditionally (matches the existing Analytics CSV export's convention) —
// simplest approach that's always correct, no need to special-case which fields might contain a
// comma, quote, or newline.
function csvCell(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"'
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

const CSV_HEADERS = [
  'Session ID', 'Trace ID', 'Source', 'Data Source', 'Model', 'Models', 'Start Time', 'Duration (ms)', 'Turns',
  'Tool Calls', 'Input Tokens', 'Output Tokens', 'Cache Read Tokens', 'Cache Create Tokens',
  'Cache Hit Rate', 'Errors', 'Outcome', 'Tool Counts', 'Files Read', 'Files Changed',
  'Loop Signals', 'User Request',
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
