import { useState } from 'preact/hooks'
import { useEffect, useRef } from 'preact/hooks'
import { sessionSummary, displaySessions, filteredSessions, dailyStats, lifetimeStats, selectedAgentFilter, timeRange, makeTimeRange, focusedSessionId, activeTab } from '../state'
import type { TimePreset } from '../state'
import { getAgentColor, getSessionGlobalNumber, formatCompact, getAgentSourceLabel, formatSessionTime } from '../utils'
import { calcSessionCost, sessionCostMode, dayKeyUtc } from '../sessionMetrics'
import { PRICING_LAST_UPDATED } from '../pricing'
import type { PricingMode } from '../sessionMetrics'
import type { SessionSummaryCard, DailyStatRow } from '../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

export function fmtUsd(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.001) return '<$0.001'
  if (usd < 1) return '$' + usd.toFixed(3)
  return '$' + usd.toFixed(2)
}

function fmtCredits(credits: number): string {
  if (credits === 0) return '0'
  if (credits < 0.1) return '<0.1'
  return credits.toFixed(1)
}

// ── 30-day history chart (SVG) ────────────────────────────────────────────────

// day is 'YYYY-MM-DD HH' for hourly rows
function rowHourMs(day: string): number {
  // '2026-05-30 14' → parse as UTC hour
  const [datePart, hourPart] = day.split(' ')
  return new Date(datePart + 'T' + (hourPart ?? '00').padStart(2, '0') + ':00:00Z').getTime()
}

export function HistoryChart({ rows }: { rows: DailyStatRow[] }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const isHourly = rows.length > 0 && rows[0].day.length > 10

  if (rows.length === 0) {
    return <div class="empty-state" style="margin-bottom:16px">No historical data yet — traces will appear here as they are recorded.</div>
  }

  const W = 600, H = 190
  const pad = { top: 20, right: 54, bottom: 28, left: 58 }
  const chartW = W - pad.left - pad.right
  const chartH = H - pad.top - pad.bottom

  // Stacked bars: input, cache read, cache write (3 segments)
  // Output tokens shown as a separate line (always visible regardless of quantity)
  const maxBar  = Math.max(...rows.map(r => r.totalTokens + r.cacheReadTokens + r.cacheCreateTokens), 1)
  const maxCost = Math.max(...rows.map(r => r.costUsd), 0.001)

  const barW = Math.max(2, Math.floor(chartW / rows.length) - 1)
  const gap  = Math.max(0, Math.floor((chartW - barW * rows.length) / (rows.length + 1)))
  const startX = pad.left + gap

  const gridLines = [0, 1, 2, 3, 4].map(i => ({
    y: pad.top + chartH * (1 - i / 4),
    label: formatCompact(Math.round(maxBar * i / 4)),
  }))

  const cx = (i: number) => startX + i * (barW + gap) + barW / 2

  const costPoints   = rows.map((r, i) => `${cx(i)},${r.costUsd > 0 ? pad.top + chartH * (1 - r.costUsd / maxCost) : pad.top + chartH}`)
  const outputPoints = rows.map((r, i) => `${cx(i)},${r.outputTokens > 0 ? pad.top + chartH * (1 - r.outputTokens / maxBar) : pad.top + chartH}`)

  const hovRow = hovered !== null ? rows[hovered] : null

  // Day boundaries for hourly view
  const dayBoundaries: number[] = []
  if (isHourly) {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].day.slice(0, 10) !== rows[i - 1].day.slice(0, 10)) dayBoundaries.push(i)
    }
  }
  const labelEvery = rows.length > 120 ? 24 : rows.length > 48 ? 12 : rows.length > 24 ? 6 : 4

  // Daily mode: compute label stride from bar pixel width so labels never overlap.
  const pixelsPerBar = (barW + gap) || 1
  const DAILY_STRIDES = [1, 2, 3, 7, 14, 30]
  const labelEveryNDaily = DAILY_STRIDES.find(s => s >= Math.ceil(28 / pixelsPerBar)) ?? 30

  return (
    <div style="position:relative;margin-bottom:8px">
      <svg viewBox={`0 0 ${W} ${H}`} style="width:100%;height:190px;display:block" onMouseLeave={() => setHovered(null)}>

        {/* Y-axis title: Tokens (left) */}
        <text
          x={10} y={pad.top + chartH / 2}
          transform={`rotate(-90,10,${pad.top + chartH / 2})`}
          text-anchor="middle" fill="var(--vscode-descriptionForeground,#888)" font-size="9"
        >Tokens</text>

        {/* Y-axis title: Cost (right) */}
        <text
          x={W - 8} y={pad.top + chartH / 2}
          transform={`rotate(90,${W - 8},${pad.top + chartH / 2})`}
          text-anchor="middle" fill="var(--vscode-charts-green,#81c784)" font-size="9"
        >Cost</text>

        {/* Grid + left labels */}
        {gridLines.map(gl => (
          <g key={gl.y}>
            <line x1={pad.left} y1={gl.y} x2={W - pad.right} y2={gl.y} stroke="var(--vscode-panel-border,#333)" stroke-width="0.5" />
            <text x={pad.left - 4} y={gl.y} text-anchor="end" dominant-baseline="middle" fill="var(--vscode-descriptionForeground,#888)" font-size="9">{gl.label}</text>
          </g>
        ))}

        {/* Cost axis labels (right) */}
        {[0, 1, 2, 3, 4].map(i => (
          <text key={i} x={W - pad.right + 4} y={pad.top + chartH * (1 - i / 4)} text-anchor="start" dominant-baseline="middle" fill="var(--vscode-charts-green,#81c784)" font-size="9">
            {'$' + (maxCost * i / 4).toFixed(maxCost < 0.1 ? 3 : 2)}
          </text>
        ))}

        {/* Day boundary lines */}
        {dayBoundaries.map(idx => {
          const bx = startX + idx * (barW + gap) - gap / 2
          return (
            <g key={idx}>
              <line x1={bx} y1={pad.top} x2={bx} y2={pad.top + chartH} stroke="var(--vscode-panel-border,#555)" stroke-width="0.8" stroke-dasharray="2 2" />
              <text x={bx + 2} y={H - pad.bottom + 10} fill="var(--vscode-descriptionForeground,#888)" font-size="7">{rows[idx].day.slice(5, 10)}</text>
            </g>
          )
        })}

        {/* Stacked bars: input, cache read, cache write */}
        {rows.map((r, i) => {
          const x = startX + i * (barW + gap)
          const inputH      = Math.max(0, r.totalTokens      / maxBar * chartH)
          const cacheReadH  = Math.max(0, r.cacheReadTokens   / maxBar * chartH)
          const cacheWriteH = Math.max(0, r.cacheCreateTokens / maxBar * chartH)

          let yBase = pad.top + chartH
          const segs = [
            { fill: 'var(--vscode-charts-blue,#4fc3f7)',   h: inputH },
            { fill: 'var(--vscode-charts-green,#81c784)',  h: cacheReadH },
            { fill: 'var(--vscode-charts-yellow,#ffb74d)', h: cacheWriteH },
          ]

          const showLabel = isHourly && (i % labelEvery === 0) && !dayBoundaries.includes(i)

          return (
            <g key={i} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} style="cursor:default">
              {segs.map((seg, si) => {
                const renderH = seg.h
                yBase -= renderH
                if (renderH < 0.2) return null
                return <rect key={si} x={x} y={yBase} width={barW} height={renderH} fill={seg.fill} opacity={hovered === i ? 1 : 0.8} />
              })}
              {showLabel && (
                <text x={x + barW / 2} y={H - pad.bottom + 10} text-anchor="middle" fill="var(--vscode-descriptionForeground,#888)" font-size="7">
                  {r.day.slice(11) + 'h'}
                </text>
              )}
              {!isHourly && i % labelEveryNDaily === 0 && (
                <text x={x + barW / 2} y={H - pad.bottom + 10} text-anchor="middle" fill="var(--vscode-descriptionForeground,#888)" font-size="8">
                  {labelEveryNDaily >= 14
                    ? new Date(r.day).toLocaleString('en', { month: 'short' })
                    : r.day.slice(5)}
                </text>
              )}
            </g>
          )
        })}

        {/* Output tokens line (left scale, always visible) */}
        {rows.some(r => r.outputTokens > 0) && rows.length > 1 && (
          <polyline points={outputPoints.join(' ')} fill="none" stroke="var(--vscode-charts-red,#e57373)" stroke-width="1.5" stroke-dasharray="4 2" opacity="0.85" />
        )}
        {rows.map((r, i) => {
          if (r.outputTokens === 0) return null
          const cy = pad.top + chartH * (1 - r.outputTokens / maxBar)
          return <circle key={i} cx={cx(i)} cy={cy} r="1.5" fill="var(--vscode-charts-red,#e57373)" />
        })}

        {/* Cost line overlay */}
        {rows.length > 1 && (
          <polyline points={costPoints.join(' ')} fill="none" stroke="var(--vscode-charts-green,#81c784)" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.9" />
        )}
        {rows.map((r, i) => {
          if (r.costUsd === 0) return null
          const cy = pad.top + chartH * (1 - r.costUsd / maxCost)
          return <circle key={i} cx={cx(i)} cy={cy} r="1.5" fill="var(--vscode-charts-green,#81c784)" />
        })}
      </svg>

      {/* Legend */}
      <div style="display:flex;gap:12px;font-size:10px;color:var(--muted);margin-top:2px;flex-wrap:wrap">
        {([
          ['var(--vscode-charts-blue,#4fc3f7)',   'Input tokens', false],
          ['var(--vscode-charts-green,#81c784)',  'Cache read',   false],
          ['var(--vscode-charts-yellow,#ffb74d)', 'Cache write',  false],
          ['var(--vscode-charts-red,#e57373)',    'Output tokens', true],
          ['var(--vscode-charts-green,#81c784)', 'Cost',          true],
        ] as const).map(([color, label, isDashed]) => (
          <span key={label} style="display:flex;align-items:center;gap:4px">
            {isDashed
              ? <svg width="12" height="8" viewBox="0 0 12 8"><line x1="0" y1="4" x2="12" y2="4" stroke={color} stroke-width="1.5" stroke-dasharray="4 2" /></svg>
              : <span style={`display:inline-block;width:8px;height:8px;border-radius:2px;background:${color}`} />
            }
            {label}
          </span>
        ))}
      </div>

      {/* Hover tooltip */}
      {hovRow && (
        <div style="position:absolute;top:4px;right:4px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-panel-border,#333);border-radius:4px;padding:8px 10px;font-size:11px;line-height:1.8;pointer-events:none;z-index:10;min-width:155px">
          <div style="font-weight:600;margin-bottom:2px">{isHourly ? hovRow.day.slice(0, 10) + ' ' + hovRow.day.slice(11) + ':00' : hovRow.day}</div>
          <div style="color:var(--muted)">{hovRow.sessionCount} session{hovRow.sessionCount !== 1 ? 's' : ''}</div>
          <div>Input tokens: <strong>{formatCompact(hovRow.totalTokens)}</strong></div>
          <div>Cache read: {formatCompact(hovRow.cacheReadTokens)}</div>
          <div>Cache write: {formatCompact(hovRow.cacheCreateTokens)}</div>
          <div>Output tokens: {formatCompact(hovRow.outputTokens)}</div>
          <div style="margin-top:4px;color:var(--vscode-charts-green,#81c784)">Cost: <strong>{'$' + (hovRow.costUsd).toFixed(3)}</strong></div>
        </div>
      )}
    </div>
  )
}

// ── Per-session cost bar chart ─────────────────────────────────────────────────

export function CostBarChart({ sessions, mode }: { sessions: SessionSummaryCard[]; mode: PricingMode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const barDataRef = useRef<Array<{ sessionId: string; slotX: number; slotW: number }>>([])

  // Compute outside the effect so excludedCount is available for JSX rendering.
  const allData = sessions.slice().reverse().map(sess => {  // oldest → newest left → right
    const cost = calcSessionCost(sess, sessionCostMode(sess, mode))
    return { sessionId: sess.sessionId, cost: cost.totalUsd, unknown: cost.modelUnknown, startTime: sess.startTime, source: sess.source }
  })
  const excludedCount = allData.filter(d => d.unknown).length
  const data = allData.filter(d => !d.unknown)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Daily totals for the step-function line overlay
    const dayTotals = new Map<string, number>()
    data.forEach(d => { const dk = dayKeyUtc(d.startTime); dayTotals.set(dk, (dayTotals.get(dk) ?? 0) + d.cost) })
    const maxDailyTotal = Math.max(...Array.from(dayTotals.values()), 0.0001)
    const maxCost = Math.max(...data.map(d => d.cost), 0.0001)

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const w = rect.width, h = rect.height
    ctx.clearRect(0, 0, w, h)

    const pad = { top: 8, right: 58, bottom: 14, left: 64 }
    const chartW = w - pad.left - pad.right
    const chartH = h - pad.top - pad.bottom

    const cs = getComputedStyle(document.body)
    const gridColor = cs.getPropertyValue('--vscode-panel-border').trim() || '#333'
    const textColor = cs.getPropertyValue('--vscode-descriptionForeground').trim() || '#888'
    const fontStr = '9px ' + (cs.getPropertyValue('--vscode-font-family').trim() || 'sans-serif')

    // Grid
    ctx.strokeStyle = gridColor; ctx.lineWidth = 0.5
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + chartH * i / 4
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + chartW, y); ctx.stroke()
    }
    // Left Y axis — per-session cost
    ctx.fillStyle = textColor; ctx.font = fontStr; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    for (let i = 0; i <= 4; i++) {
      const val = maxCost * (4 - i) / 4
      ctx.fillText('$' + val.toFixed(val < 0.01 ? 3 : 2), pad.left - 4, pad.top + chartH * i / 4)
    }
    // Right Y axis — daily total
    ctx.fillStyle = 'rgba(129,199,132,0.85)'; ctx.textAlign = 'left'
    for (let i = 0; i <= 4; i++) {
      const val = maxDailyTotal * (4 - i) / 4
      ctx.fillText('$' + val.toFixed(val < 0.1 ? 3 : 2), pad.left + chartW + 4, pad.top + chartH * i / 4)
    }

    const n = data.length
    // Slot-based sizing: each session gets an equal share of the full chart width
    const slotW = chartW / Math.max(n, 1)
    const barPad = n > 100 ? 0 : n > 50 ? 0.3 : n > 20 ? 0.7 : 1.2
    const barW = Math.max(0.5, slotW - barPad * 2)
    const offsetX = pad.left

    barDataRef.current = data.map((d, i) => ({ sessionId: d.sessionId, slotX: offsetX + i * slotW, slotW }))

    // Draw bars
    data.forEach((d, i) => {
      const x = offsetX + i * slotW + barPad
      const barH = (d.cost / maxCost) * chartH
      const y = pad.top + chartH - barH
      const color = getAgentColor(d.source)
      if (barH < 1) {
        ctx.strokeStyle = color; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x, pad.top + chartH); ctx.lineTo(x + barW, pad.top + chartH); ctx.stroke()
      } else {
        ctx.fillStyle = color; ctx.fillRect(x, y, barW, barH)
      }
    })

    // Build day groups once — used by both the label pass and the line pass
    const dayGroups = new Map<string, { start: number; end: number }>()
    data.forEach((d, i) => {
      const dk = dayKeyUtc(d.startTime)
      if (!dayGroups.has(dk)) dayGroups.set(dk, { start: i, end: i })
      dayGroups.get(dk)!.end = i
    })

    // Day boundary lines + date labels
    if (n > 0) {
      const labelFont = '8px ' + (cs.getPropertyValue('--vscode-font-family').trim() || 'sans-serif')
      const MIN_LABEL_GAP = 30  // minimum pixels between label centres before skipping

      let isFirst = true
      let lastLabelX = -Infinity
      for (const [dk, { start, end }] of dayGroups) {
        const x1  = offsetX + start * slotW + barPad
        const midX = (offsetX + start * slotW + barPad + offsetX + end * slotW + barPad + barW) / 2

        // Dotted boundary line at day start (skip first)
        if (!isFirst) {
          ctx.strokeStyle = gridColor
          ctx.lineWidth = 0.8
          ctx.setLineDash([3, 3])
          ctx.beginPath(); ctx.moveTo(x1, pad.top); ctx.lineTo(x1, pad.top + chartH); ctx.stroke()
          ctx.setLineDash([])
        }
        isFirst = false

        // Label only when far enough from the previous one. Anchor the gap check and the
        // rendered text at the same point (midX) — anchoring render at x1 while checking
        // gaps against midX let labels drift into each other for wide (multi-session) days.
        if (midX - lastLabelX >= MIN_LABEL_GAP) {
          const label = dk.length >= 10 ? dk.slice(5, 10) : dk
          ctx.font = labelFont
          ctx.fillStyle = textColor
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillText(label, midX, pad.top + 1)
          lastLabelX = midX
        }
      }
    }

    // Daily aggregate point-to-point line — each point at the horizontal midpoint of that day's bars
    if (n > 0 && dayGroups.size > 0) {
      const pts: Array<{ x: number; y: number }> = []
      for (const [dk, { start, end }] of dayGroups) {
        const x1 = offsetX + start * slotW + barPad
        const x2 = offsetX + end * slotW + barPad + barW
        const midX = (x1 + x2) / 2
        const daily = dayTotals.get(dk) ?? 0
        const lineY = pad.top + chartH * (1 - daily / maxDailyTotal)
        pts.push({ x: midX, y: lineY })
      }

      ctx.strokeStyle = 'rgba(129,199,132,0.9)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([])
      ctx.beginPath()
      pts.forEach((p, i) => { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y) })
      ctx.stroke()

      // Dot at each day midpoint
      ctx.fillStyle = 'rgba(129,199,132,0.95)'
      pts.forEach(p => {
        ctx.beginPath()
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2)
        ctx.fill()
      })
    }

  })

  function handleClick(e: MouseEvent) {
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const hit = barDataRef.current.find(b => mx >= b.slotX && mx < b.slotX + b.slotW)
    if (hit) { focusedSessionId.value = hit.sessionId; activeTab.value = 'sessions' }
  }

  return (
    <div style="margin-bottom:16px">
      <canvas ref={canvasRef} style="width:100%;height:230px;display:block;cursor:pointer"
        onClick={handleClick} title="Click a bar to open that trace" />
      {excludedCount > 0 && (
        <div style="font-size:10px;color:var(--muted);text-align:right;margin-top:2px">
          {excludedCount} trace{excludedCount === 1 ? '' : 's'} excluded — model unrecognized
        </div>
      )}
    </div>
  )
}



// ── Main tab ──────────────────────────────────────────────────────────────────

export function Cost() {
  const sessions = filteredSessions.value
  const hasAny = (sessionSummary.value?.sessions?.length ?? 0) > 0
  const [mode, setMode] = useState<PricingMode>('token')

  const copilotSessions = sessions.filter(s => s.source === 'copilot')
  const codexSessions = sessions.filter(s => s.source === 'codex')
  const claudeSessions = sessions.filter(s => s.source === 'claude_code')
  const pricedSessions = sessions.filter(s => s.source === 'copilot' || s.source === 'codex' || s.source === 'claude_code')

  const disclaimer = (
    <div style="font-size:11px;background:var(--hover);border:1px solid var(--border);border-left:3px solid var(--warning,#ffb74d);border-radius:4px;padding:8px 10px;margin-bottom:16px;line-height:1.6;color:var(--muted);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <span><strong style="color:var(--foreground)">Estimates only</strong> — not your actual bill. <a href="#cost-known-gaps" style="color:inherit;text-decoration:underline;text-underline-offset:2px">See known gaps.</a></span>
      <span style="white-space:nowrap">Rates last updated: {PRICING_LAST_UPDATED}</span>
    </div>
  )

  if (pricedSessions.length === 0) {
    return (
      <div id="cost-content">
        {disclaimer}
        <div class="empty-state">{hasAny ? 'No traces match the active filters.' : 'No traces recorded yet.'}</div>
      </div>
    )
  }

  const copilotCosts = copilotSessions.map(s => ({ session: s, cost: calcSessionCost(s, mode) }))
  const codexCosts = codexSessions.map(s => ({ session: s, cost: calcSessionCost(s, 'token') }))
  const claudeCosts = claudeSessions.map(s => ({ session: s, cost: calcSessionCost(s, 'token') }))
  const allCosts = pricedSessions.map(s => ({ session: s, cost: calcSessionCost(s, sessionCostMode(s, mode)) }))

  const copilotTotalUsd = copilotCosts.reduce((sum, c) => sum + c.cost.totalUsd, 0)
  const copilotTotalCredits = copilotTotalUsd / 0.01
  const copilotAnyUnknown = copilotCosts.some(c => c.cost.modelUnknown)
  const codexTotalUsd = codexCosts.reduce((sum, c) => sum + c.cost.totalUsd, 0)
  const codexAnyUnknown = codexCosts.some(c => c.cost.modelUnknown)
  const claudeTotalUsd = claudeCosts.reduce((sum, c) => sum + c.cost.totalUsd, 0)
  const claudeAnyUnknown = claudeCosts.some(c => c.cost.modelUnknown)

  // Sort newest first
  const sessionRows = allCosts.slice().sort((a, b) =>
    Date.parse(b.session.startTime || '0') - Date.parse(a.session.startTime || '0')
  )

  const showCreditsCol = mode === 'token'

  return (
    <div id="cost-content">
      {disclaimer}
      {/* Pricing model section — one block per agent type */}
      <div style="margin-bottom:16px;display:flex;flex-direction:column;gap:10px">
        {copilotSessions.length > 0 && (
          <div>
            <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);margin-bottom:5px">
              <span style={'display:inline-block;width:7px;height:7px;border-radius:50%;background:' + getAgentColor('copilot')} />
              Copilot — Select pricing model
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              <button
                class={'tab-mini' + (mode === 'token' ? ' active' : '')}
                onClick={() => setMode('token')}
                title="Token-based AI Credits billing, effective Jun 1, 2026"
              >Token-based</button>
              <button
                class={'tab-mini' + (mode === 'request-annual' ? ' active' : '')}
                onClick={() => setMode('request-annual')}
                title="Annual plan holders staying on request-based billing after Jun 1, 2026 — higher multipliers apply"
              >Annual plan (request)</button>
            </div>
            <div style="margin-top:5px;font-size:10px;color:var(--muted);line-height:1.5">
              Sessions before Jun 1, 2026 were billed per request — use Annual plan (request) for those.
              Copilot Chat log traces with no token data will show $0 in token mode regardless of billing period.
            </div>
          </div>
        )}
        {codexSessions.length > 0 && (
          <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)">
            <span style={'display:inline-block;width:7px;height:7px;border-radius:50%;background:' + getAgentColor('codex')} />
            Codex — Always uses token-based pricing
          </div>
        )}
        {claudeSessions.length > 0 && (
          <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)">
            <span style={'display:inline-block;width:7px;height:7px;border-radius:50%;background:' + getAgentColor('claude_code')} />
            Claude — Always uses token-based pricing
          </div>
        )}
      </div>

      {/* 30-day history */}
      {(() => {
        const stats = dailyStats.value
        const lifetime = lifetimeStats.value
        const agentFilter = selectedAgentFilter.value
        const filteredStats = agentFilter !== 'all'
          ? stats
          : stats
        return (
          <div style="margin-bottom:24px">
            <h3 style="margin:0 0 8px;font-size:13px;color:var(--muted)">30-DAY TOKEN &amp; COST HISTORY</h3>
            <HistoryChart rows={filteredStats} />
            <div style="font-size:10px;color:var(--muted);margin-top:4px">Click a bar to filter the trace table to that day. Click again to clear.</div>
            {lifetime && lifetime.totalSessions > 0 && (
              <div style="display:flex;gap:20px;font-size:11px;color:var(--muted);flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid var(--vscode-panel-border)">
                <span>{lifetime.totalSessions} total traces</span>
                <span>{formatCompact(lifetime.totalTokens)} total tokens</span>
                <span style="color:var(--foreground)">~{'$' + lifetime.totalCostUsd.toFixed(2)} estimated lifetime cost</span>
                {lifetime.oldestSessionMs > 0 && (
                  <span>{new Date(lifetime.oldestSessionMs).toISOString().slice(0, 10)} → {new Date(lifetime.newestSessionMs).toISOString().slice(0, 10)}</span>
                )}
              </div>
            )}
          </div>
        )
      })()}

      {/* Per-session cost bar chart */}
      <h3 style="margin:0 0 8px;font-size:13px;color:var(--muted)">ESTIMATED COST PER SESSION</h3>
      <CostBarChart sessions={pricedSessions} mode={mode} />

      {/* Session cost table */}
      <h3 style="margin:24px 0 8px;font-size:13px;color:var(--muted)">SESSION COST TABLE</h3>
      <div class="h-scroll-hint">
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead>
            <tr style="border-bottom:1px solid var(--vscode-panel-border);color:var(--muted);text-align:left">
              <th style="padding:4px 8px;min-width:130px">Trace</th>
              <th style="padding:4px 8px">Model</th>
              <th style="padding:4px 8px;text-align:right">Turns</th>
              <th style="padding:4px 8px;text-align:right">Input tok</th>
              <th style="padding:4px 8px;text-align:right">Output tok</th>
              <th style="padding:4px 8px;text-align:right">Cache read</th>
              <th style="padding:4px 8px;text-align:right">Est. cost</th>
              {showCreditsCol && <th style="padding:4px 8px;text-align:right" data-tip="Copilot AI Credits (1 credit = $0.01); not applicable to Codex">AI Credits</th>}
            </tr>
          </thead>
          <tbody>
            {sessionRows.map(({ session: s, cost }) => {
              const rawInput = Math.max(0, s.inputTokens - s.cacheReadTokens - s.cacheCreateTokens)
              const isCopilot = s.source === 'copilot'
              return (
                <tr key={s.sessionId} style="border-bottom:1px solid var(--vscode-panel-border)">
                  <td style="padding:4px 8px">
                    <div style="display:flex;align-items:flex-start;gap:4px">
                      <span style={'display:inline-block;width:6px;height:6px;border-radius:50%;flex-shrink:0;margin-top:2px;background:' + getAgentColor(s.source)} />
                      <div>
                        <div style="font-size:10px;color:var(--foreground);white-space:nowrap">{formatSessionTime(s)}</div>
                        {(s.userRequest ?? '').length > 0 && (
                          <div style="font-size:9px;color:var(--muted);margin-top:1px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic" title={s.userRequest}>
                            {(s.userRequest ?? '').slice(0, 55)}{(s.userRequest ?? '').length > 55 ? '…' : ''}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style="padding:4px 8px;color:var(--muted);font-size:10px">{s.model || '—'}</td>
                  <td style="padding:4px 8px;text-align:right">{s.turns}</td>
                  <td style="padding:4px 8px;text-align:right">{formatCompact(rawInput)}</td>
                  <td style="padding:4px 8px;text-align:right">{formatCompact(s.outputTokens)}</td>
                  <td style="padding:4px 8px;text-align:right">{s.cacheReadTokens > 0 ? formatCompact(s.cacheReadTokens) : '—'}</td>
                  <td style="padding:4px 8px;text-align:right;font-weight:600">
                    {cost.modelUnknown
                      ? <span style="color:var(--muted)" data-tip={'Model "' + s.model + '" not in rate table — add rates in pricing.ts'}>~$?</span>
                      : fmtUsd(cost.totalUsd)}
                  </td>
                  {showCreditsCol && (
                    <td style="padding:4px 8px;text-align:right;color:var(--muted)">
                      {!isCopilot ? '—' : cost.modelUnknown ? '?' : fmtCredits(cost.aiCredits)}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            {copilotSessions.length > 0 && (
              <tr style="border-top:1px solid var(--vscode-panel-border)">
                <td colSpan={6} style="padding:5px 8px;text-align:right;color:var(--muted);font-size:10px">
                  Copilot ({copilotSessions.length} session{copilotSessions.length !== 1 ? 's' : ''})
                </td>
                <td style="padding:5px 8px;text-align:right;font-weight:600">{copilotAnyUnknown ? '~' : ''}{fmtUsd(copilotTotalUsd)}</td>
                {showCreditsCol && <td style="padding:5px 8px;text-align:right;color:var(--muted)">{copilotAnyUnknown ? '~' : ''}{fmtCredits(copilotTotalCredits)}</td>}
              </tr>
            )}
            {codexSessions.length > 0 && (
              <tr style="border-top:1px solid var(--vscode-panel-border)">
                <td colSpan={6} style="padding:5px 8px;text-align:right;color:var(--muted);font-size:10px">
                  Codex ({codexSessions.length} session{codexSessions.length !== 1 ? 's' : ''})
                </td>
                <td style="padding:5px 8px;text-align:right;font-weight:600">{codexAnyUnknown ? '~' : ''}{fmtUsd(codexTotalUsd)}</td>
                {showCreditsCol && <td style="padding:5px 8px;text-align:right;color:var(--muted)">—</td>}
              </tr>
            )}
            {claudeSessions.length > 0 && (
              <tr style="border-top:1px solid var(--vscode-panel-border)">
                <td colSpan={6} style="padding:5px 8px;text-align:right;color:var(--muted);font-size:10px">
                  Claude ({claudeSessions.length} session{claudeSessions.length !== 1 ? 's' : ''})
                </td>
                <td style="padding:5px 8px;text-align:right;font-weight:600">{claudeAnyUnknown ? '~' : ''}{fmtUsd(claudeTotalUsd)}</td>
                {showCreditsCol && <td style="padding:5px 8px;text-align:right;color:var(--muted)">—</td>}
              </tr>
            )}
            {[copilotSessions, codexSessions, claudeSessions].filter(s => s.length > 0).length > 1 && (
              <tr style="border-top:2px solid var(--vscode-panel-border);font-weight:600">
                <td colSpan={6} style="padding:6px 8px;text-align:right;color:var(--muted)">
                  Total ({pricedSessions.length} session{pricedSessions.length !== 1 ? 's' : ''})
                </td>
                <td style="padding:6px 8px;text-align:right">{(copilotAnyUnknown || codexAnyUnknown || claudeAnyUnknown) ? '~' : ''}{fmtUsd(copilotTotalUsd + codexTotalUsd + claudeTotalUsd)}</td>
                {showCreditsCol && <td style="padding:6px 8px;text-align:right;color:var(--muted)">—</td>}
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      {/* Footer note */}
      <div style="margin-top:16px;font-size:10px;color:var(--muted);line-height:1.6">
        {mode === 'token'
          ? 'Token-based AI Credits: effective Jun 1, 2026. Per-turn chart uses input+output only; trace totals include cache tokens.'
          : 'Annual plan request-based: for annual-plan holders staying on request billing after Jun 1, 2026. Multipliers are significantly higher on this plan post-June.'}
        {codexSessions.length > 0 && ' Codex sessions use token-based pricing regardless of the Copilot billing model selected above.'}
        {claudeSessions.length > 0 && ' Claude sessions use Anthropic API token-based pricing regardless of the Copilot billing model selected above.'}
      </div>

      {/* Known gaps */}
      <div id="cost-known-gaps" style="margin-top:24px;padding-top:16px;border-top:1px solid var(--vscode-panel-border);font-size:11px;color:var(--muted);line-height:1.7">
        <strong style="color:var(--foreground);font-size:12px">Known gaps</strong>
        <div style="margin-top:8px">
          <span style="font-size:10px;text-transform:uppercase;letter-spacing:.4px">
            <span style={'display:inline-block;width:6px;height:6px;border-radius:50%;background:' + getAgentColor('copilot') + ';vertical-align:middle;margin-right:4px'} />
            Copilot
          </span>
          <ul style="margin:4px 0 0;padding-left:18px">
            <li>Long-context surcharges are not applied — GPT-5.4 (prompts &gt;272K tokens) and Gemini 2.5 Pro / 3.1 Pro (prompts &gt;200K tokens) have higher rates above those thresholds, which require per-prompt token counts not available in trace telemetry.</li>
            <li>Models not in the rate table are shown as <strong>~$?</strong> — this can happen when GitHub releases a new model after the last rate update, or when the model ID in telemetry doesn't match the published name.</li>
            <li>Request-based cost uses trace turn count as a proxy for billable prompts, which may not match exactly for all trace shapes.</li>
          </ul>
        </div>
        <div style="margin-top:12px">
          <span style="font-size:10px;text-transform:uppercase;letter-spacing:.4px">
            <span style={'display:inline-block;width:6px;height:6px;border-radius:50%;background:' + getAgentColor('codex') + ';vertical-align:middle;margin-right:4px'} />
            Codex
          </span>
          <ul style="margin:4px 0 0;padding-left:18px">
            <li>Long-context surcharges are not applied — GPT-5.5 has a higher-rate tier above an unconfirmed token threshold.</li>
            <li>Reasoning tokens (<code>codex.usage.reasoning_output_tokens</code>) are included in output token counts and billed at the standard output rate. A separate reasoning rate has not been confirmed from official sources.</li>
            <li>Models not in the rate table are shown as <strong>~$?</strong>. The official Codex rate card (<code>help.openai.com</code>) may list additional model aliases not yet captured here.</li>
          </ul>
        </div>
        <div style="margin-top:12px">
          <span style="font-size:10px;text-transform:uppercase;letter-spacing:.4px">
            <span style={'display:inline-block;width:6px;height:6px;border-radius:50%;background:' + getAgentColor('claude_code') + ';vertical-align:middle;margin-right:4px'} />
            Claude
          </span>
          <ul style="margin:4px 0 0;padding-left:18px">
            <li>Cache write TTL cannot be determined from telemetry. Claude Code uses 5-minute prompt caches by default (1.25× input rate); if 1-hour caches are active (2× input rate), cost will be underestimated by ~37%.</li>
            <li>Fast mode (<code>/fast</code>): Opus fast-mode requests are billed at $30 input / $150 output per MTok — 6× the standard Opus rate. The model ID in telemetry does not indicate fast mode, so fast-mode traces are costed at the standard Opus rate and will be significantly underestimated.</li>
            <li>Opus 4.7 tokenizer change (from Apr 16, 2026) generates up to 35% more tokens for the same text. Per-token prices are unchanged; traces before and after this date are not directly cost-comparable.</li>
            <li>Models not in the rate table are shown as <strong>~$?</strong>. Older Claude models (claude-3-5-sonnet, claude-3-opus, etc.) may appear in imported historical traces.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
