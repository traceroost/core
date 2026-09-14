import { sessionSummary, timeRange } from '../state'
import { formatMs, formatCompact } from '../utils'
import { oneShotRate, avgEditsPerFile } from '../sessionMetrics'
import type { SessionSummaryCard } from '../types'

export function computeStats(sessions: SessionSummaryCard[]) {
  let totalInput = 0, totalOutput = 0, totalCache = 0
  let totalLlm = 0, totalTools = 0, ttftSum = 0, ttftCount = 0, durSum = 0
  let filesConsidered = 0, oneShotFiles = 0, totalEdits = 0
  const toolCounts: Record<string, number> = {}
  sessions.forEach(s => {
    totalInput += s.inputTokens ?? 0
    totalOutput += s.outputTokens ?? 0
    totalCache += (s.cacheReadTokens ?? 0) + (s.cacheCreateTokens ?? 0)
    totalLlm += s.totalLlmCalls ?? 0
    totalTools += s.totalToolCalls ?? 0
    durSum += s.durationMs ?? 0
    Object.keys(s.toolCounts ?? {}).forEach(t => {
      toolCounts[t] = (toolCounts[t] ?? 0) + s.toolCounts[t]
    })
    ;(s.timeline ?? []).forEach(e => {
      if (e.type === 'llm' && e.ttft) { ttftSum += e.ttft; ttftCount++ }
    })
    if (s.oneShotStats) {
      filesConsidered += s.oneShotStats.filesConsidered
      oneShotFiles += s.oneShotStats.oneShotFiles
      totalEdits += s.oneShotStats.totalEdits
    }
  })
  // File-level aggregate, not an average of per-session rates — a 1-file session shouldn't
  // weigh the same as a 20-file session. Same MIN_FILES_FOR_RATE gate as the per-session display.
  const oneShot = oneShotRate({ filesConsidered, oneShotFiles })
  const editsPerFile = avgEditsPerFile({ filesConsidered, totalEdits })
  return {
    sessions: sessions.length,
    totalInput, totalOutput, totalCache, totalLlm, totalTools,
    avgTtft: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : 0,
    avgDuration: sessions.length > 0 ? Math.round(durSum / sessions.length) : 0,
    cacheHitRate: totalInput > 0 ? totalCache / totalInput : 0,
    toolCounts,
    oneShotRate: oneShot,
    avgEditsPerFile: editsPerFile,
    oneShotFilesConsidered: filesConsidered,
  }
}

type Stats = ReturnType<typeof computeStats>

function KV({ k, v, accent }: { k: string; v: string | number; accent: string }) {
  return (
    <div style="padding:5px 8px;background:var(--panel-bg);border-radius:4px">
      <div style={'font-size:18px;font-weight:bold;color:' + accent}>{v}</div>
      <div style="font-size:10px;color:var(--muted)">{k}</div>
    </div>
  )
}

function AgentCol({ label, accent, stats }: { label: string; accent: string; stats: Stats }) {
  const topTools = Object.keys(stats.toolCounts)
    .sort((a, b) => stats.toolCounts[b] - stats.toolCounts[a])
    .slice(0, 8)

  return (
    <div style="border:1px solid var(--border);border-radius:6px;padding:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style={'width:10px;height:10px;border-radius:50%;background:' + accent + ';display:inline-block'} />
        <strong style="font-size:13px">{label}</strong>
      </div>
      {stats.sessions === 0 ? (
        <div class="empty-state" style="font-size:12px;padding:12px 0">No agent traces recorded — start a {label} session</div>
      ) : (
        <>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
            <KV k="Traces" v={stats.sessions} accent={accent} />
            <KV k="LLM Calls" v={stats.totalLlm} accent={accent} />
            <KV k="Input Tokens" v={formatCompact(stats.totalInput)} accent={accent} />
            <KV k="Output Tokens" v={formatCompact(stats.totalOutput)} accent={accent} />
            {stats.totalCache > 0 && <KV k="Cache Tokens" v={formatCompact(stats.totalCache)} accent={accent} />}
            {stats.totalCache > 0 && <KV k="Cache Hit Rate" v={(stats.cacheHitRate * 100).toFixed(0) + '%'} accent={accent} />}
            {stats.avgTtft > 0 && <KV k="Avg TTFT" v={formatMs(stats.avgTtft)} accent={accent} />}
            <KV k="Avg Duration" v={formatMs(stats.avgDuration)} accent={accent} />
            <KV k="Total Tools" v={stats.totalTools} accent={accent} />
          </div>
          {topTools.length > 0 && (
            <>
              <div style="font-size:10px;color:var(--muted);font-weight:600;margin-bottom:5px;text-transform:uppercase">Top Tools</div>
              <div style="display:flex;flex-wrap:wrap;gap:4px">
                {topTools.map(t => (
                  <span key={t} style="padding:2px 7px;background:var(--panel-bg);border-radius:3px;font-size:11px">
                    {t} <span style={'color:' + accent}>{stats.toolCounts[t]}</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

export function Agents() {
  // Show all agent types side-by-side — ignore the agent filter (it's hidden on this tab)
  // and apply only the time range filter so the comparison is meaningful.
  const range = timeRange.value
  const raw = sessionSummary.value?.sessions ?? []
  const allSessions = (range.preset === 'all')
    ? raw
    : raw.filter(s => {
        if (!s.startTime) return false
        const ms = new Date(s.startTime).getTime()
        return ms >= (range.since ?? 0) && ms <= (range.until ?? Date.now())
      })
  if (!allSessions.length) {
    return <div id="agents-content"><div class="empty-state">No agent traces recorded — start a Copilot, Claude, Codex, or OpenCode session</div></div>
  }

  const copStats = computeStats(allSessions.filter(s => s.source === 'copilot'))
  const cldStats = computeStats(allSessions.filter(s => s.source === 'claude_code'))
  const cdxStats = computeStats(allSessions.filter(s => s.source === 'codex'))
  const ocStats  = computeStats(allSessions.filter(s => s.source === 'opencode'))

  return (
    <div id="agents-content">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:14px">
        <AgentCol label="GitHub Copilot" accent="#00EAFF" stats={copStats} />
        <AgentCol label="Claude" accent="#FFB085" stats={cldStats} />
        <AgentCol label="Codex" accent="#F0FF42" stats={cdxStats} />
        <AgentCol label="OpenCode" accent="#FFFFFF" stats={ocStats} />
      </div>
    </div>
  )
}
