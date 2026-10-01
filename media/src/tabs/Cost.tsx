import { useEffect, useRef } from 'preact/hooks'
import { focusedSessionId, activeTab } from '../state'
import { getAgentColor } from '../utils'
import { calcSessionCost, dayKeyUtc, fmtUsd } from '../sessionMetrics'
import type { SessionSummaryCard } from '../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

// One definition (sessionMetrics.ts) so every tab formats costs the same way; re-exported here
// for the tabs that already import it from Cost.
export { fmtUsd }

// ── Per-session cost bar chart ─────────────────────────────────────────────────

export function CostBarChart({ sessions }: { sessions: SessionSummaryCard[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const barDataRef = useRef<Array<{ sessionId: string; slotX: number; slotW: number }>>([])

  // Compute outside the effect so excludedCount is available for JSX rendering.
  const allData = sessions.slice().reverse().map(sess => {  // oldest → newest left → right
    const cost = calcSessionCost(sess)
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
