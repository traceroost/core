import { rangedSessions, COLORS } from '../state'
import { getAgentColor, getAgentSourceLabel } from '../utils'
import { LogIngestionNote } from './IngestionNote'
import type { SessionSummaryCard } from '../types'

// ── Shared donut chart (used by Tools tab and Sessions detail) ─────────────────

export function ToolsChart({ sessions }: { sessions: SessionSummaryCard[] }) {
  const counts: Record<string, number> = {}
  const toolAgents: Record<string, Record<string, boolean>> = {}

  sessions.forEach(sess => {
    Object.entries(sess.toolCounts ?? {}).forEach(([tool, count]) => {
      counts[tool] = (counts[tool] ?? 0) + count
      if (!toolAgents[tool]) toolAgents[tool] = {}
      toolAgents[tool][sess.source] = true
    })
  })

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])

  if (entries.length === 0) {
    const allLog = sessions.length > 0 && sessions.every(s => s.dataSource === 'log')
    return (
      <div class="empty-state">
        No tool calls recorded for this session
        {allLog && <LogIngestionNote feature="tool call" />}
      </div>
    )
  }

  const total = entries.reduce((sum, e) => sum + e[1], 0)

  const r = 70, cx = 85, cy = 85, sw = 26
  const angleOffset = -Math.PI / 2
  let currentAngle = angleOffset

  function arcPath(startAngle: number, endAngle: number): string {
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle)
    const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle)
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`
  }

  const slices = entries.map((e, i) => {
    const pct = e[1] / total
    const sliceAngle = pct * 2 * Math.PI
    const color = COLORS[i % COLORS.length]
    const startA = currentAngle
    currentAngle += sliceAngle
    return { name: e[0], count: e[1], pct, color, startA, endA: currentAngle }
  })

  return (
    <div>
      <div class="donut-container">
        <svg width="170" height="170" viewBox="0 0 170 170">
          {slices.map(sl =>
            sl.pct >= 1
              ? <circle key={sl.name} cx={cx} cy={cy} r={r} fill="none" stroke={sl.color} stroke-width={sw} />
              : <path key={sl.name} d={arcPath(sl.startA, sl.endA)} fill="none" stroke={sl.color} stroke-width={sw} stroke-linecap="butt" />
          )}
          <text x={cx} y={cy} text-anchor="middle" dy="4" font-size="16" font-weight="bold" fill="var(--fg)">{total}</text>
          <text x={cx} y={cy + 14} text-anchor="middle" font-size="9" fill="var(--muted)" opacity="0.7">total</text>
        </svg>
        <div class="donut-legend">
          {slices.map(sl => (
            <div key={sl.name} class="donut-legend-item">
              <div class="donut-legend-color" style={'background:' + sl.color} />
              <span>{sl.name} ({sl.count}, {(sl.pct * 100).toFixed(1)}%)</span>
            </div>
          ))}
        </div>
      </div>

      <table class="tool-insights-table" style="margin-top:16px">
        <thead>
          <tr><th>Tool</th><th>Calls</th><th>%</th><th>Agents</th></tr>
        </thead>
        <tbody>
          {entries.map(([name, callCount]) => {
            const agents = toolAgents[name] ? Object.keys(toolAgents[name]) : []
            return (
              <tr key={name}>
                <td>{name}</td>
                <td class="right">{callCount}</td>
                <td class="right">{(callCount / total * 100).toFixed(1)}%</td>
                <td>
                  {agents.map(a => (
                    <span key={a} style={'display:inline-block;width:8px;height:8px;border-radius:50%;background:' + getAgentColor(a) + ';vertical-align:middle;margin-right:4px'} title={getAgentSourceLabel(a)} />
                  ))}
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>Total</strong></td>
            <td class="right"><strong>{total}</strong></td>
            <td /><td />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── Full Tools tab (aggregates all ranged sessions) ───────────────────────────

export function Tools() {
  const sessions = rangedSessions.value

  if (sessions.length === 0) {
    return <div id="tools-content"><div class="empty-state">No agent traces recorded — start a Copilot, Claude, or Codex run</div></div>
  }

  return (
    <div id="tools-content">
      <h3 style="margin:0 0 16px;font-size:13px;color:var(--muted)">TOOL CALL DISTRIBUTION</h3>
      <ToolsChart sessions={sessions} />
    </div>
  )
}
