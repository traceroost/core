import * as preact from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { sessionSummary, displaySessions, rangedSessions, agentFilteredSessions, filteredSessions, sessionTimelines, burnRateData, focusedSessionId, activeTab, CHART_MAX, COLORS, vscode, goToHelp, timeRange } from '../state'
import {
  getSessionGlobalNumber,
  formatMs, formatCompact, getAgentColor, getAgentSourceLabel, formatSessionTime, formatSessionTimeShort,
} from '../utils'
import type { SessionSummaryCard } from '../types'

type HeatReason = { text: string; linkPhrase?: string; helpId?: string }

export function TurnsLink() {
  return (
    <span
      onClick={() => goToHelp('gl-turn')}
      style="cursor:pointer;border-bottom:1px dotted currentColor"
      title="View 'Turn' definition in glossary"
    >Turns</span>
  )
}

// ── Context growth — each session is a line, x-axis = LLM turn number ─────────
// One line per session shows how input tokens accumulate turn by turn.
// Easier to compare growth profiles across sessions than a wall-clock view.

type GrowthSeries = {
  sessionId: string; label: string; color: string
  points: Array<{ turn: number; tokens: number }>
}

// Shared drawing state for click-detection
interface GrowthState { series: GrowthSeries[]; xPos: (t: number) => number; yPos: (tok: number) => number; chartH: number; pad: { top: number; left: number } }
const growthStateRef: { current: GrowthState | null } = { current: null }

function formatGrowthLabel(sess: { startTime?: string }): string {
  if (!sess?.startTime) return '—'
  const d = new Date(sess.startTime)
  if (isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const BASE_MS = 900 // ms per session at 1× speed

export function ContextGrowthChart({ sessions, timelines }: { sessions: SessionSummaryCard[]; timelines: Record<string, import('../types').TimelineEntry[]> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const focusedId = focusedSessionId.value
  const focusedIdRef = useRef<string | null>(null)
  focusedIdRef.current = focusedId

  const [paused, setPaused] = useState(false)
  const [hasData, setHasData] = useState(false)
  const [loading, setLoading] = useState(false)
  const [seriesCount, setSeriesCount] = useState(0)
  const [speed, setSpeed] = useState(1)
  const pausedRef = useRef(false)
  const speedRef = useRef(1)
  const activeIdxRef = useRef(0)
  const seriesCountRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const drawFnRef = useRef<((idx: number) => void) | null>(null)

  function clearTimer() {
    if (timerRef.current !== null) { clearInterval(timerRef.current); timerRef.current = null }
  }

  function startTimer() {
    clearTimer()
    if (pausedRef.current || !drawFnRef.current || seriesCountRef.current === 0) return
    timerRef.current = setInterval(() => {
      const next = (activeIdxRef.current + 1) % seriesCountRef.current
      activeIdxRef.current = next
      drawFnRef.current!(next)
    }, Math.round(BASE_MS / speedRef.current))
  }

  function changeSpeed(s: number) {
    speedRef.current = s
    setSpeed(s)
    if (!pausedRef.current) startTimer()
  }

  // Rebuild series + draw function when data changes; reset + restart animation
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const seriesData: GrowthSeries[] = []
    sessions.forEach(sess => {
      // Accept 'tool' entries with inputTokens too: log-sourced sessions classify
      // tool-using turns as type:'tool' even though they represent LLM calls with tokens.
      // OTel 'tool' entries never have inputTokens, so this doesn't double-count.
      const llmEntries = (timelines[sess.sessionId] ?? sess.timeline ?? [])
        .filter(e => (e.type === 'llm' || e.type === 'tool') && (e.inputTokens ?? 0) > 0)
      if (llmEntries.length < 1) return
      seriesData.push({
        sessionId: sess.sessionId,
        label: formatGrowthLabel(sess),
        color: getAgentColor(sess.source) || COLORS[seriesData.length % COLORS.length],
        points: llmEntries.map((e, i) => ({ turn: i + 1, tokens: e.inputTokens ?? 0 })),
      })
    })

    if (seriesData.length === 0) {
      canvas.style.display = 'none'
      growthStateRef.current = null
      drawFnRef.current = null
      clearTimer()
      setHasData(false)
      // A session with no timeline entry yet (fetch still in flight — see the
      // loadSessionDetail postMessage loop in Analytics.tsx) is "not loaded", not
      // "no data" — only call it empty once every session has actually reported in.
      const stillLoading = sessions.some(sess => timelines[sess.sessionId] === undefined && (sess.timeline?.length ?? 0) === 0)
      setLoading(stillLoading)
      return
    }
    canvas.style.display = 'block'
    setHasData(true)
    setLoading(false)
    setSeriesCount(seriesData.length)
    seriesCountRef.current = seriesData.length

    const maxTurns = Math.max(...seriesData.map(s => s.points.length), 2)
    const allTokens = seriesData.flatMap(s => s.points.map(p => p.tokens))
    const rawMin = Math.min(...allTokens), rawMax = Math.max(...allTokens)
    const spread = rawMax - rawMin || rawMax * 0.1 || 1
    const yMin = Math.max(0, rawMin - spread * 0.1)
    const yMax = rawMax + spread * 0.1

    const cs = getComputedStyle(document.body)
    const gridColor = cs.getPropertyValue('--vscode-panel-border').trim() || '#333'
    const textColor = cs.getPropertyValue('--vscode-descriptionForeground').trim() || '#888'
    const fontStr = '9px ' + (cs.getPropertyValue('--vscode-font-family').trim() || 'sans-serif')
    const smallFont = '8px ' + (cs.getPropertyValue('--vscode-font-family').trim() || 'sans-serif')

    // Draw all lines; highlight the one at activeIdx, dim the rest
    function draw(activeIdx: number) {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas!.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      canvas!.width = rect.width * dpr; canvas!.height = rect.height * dpr
      const ctx = canvas!.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const w = rect.width, h = rect.height
      ctx.clearRect(0, 0, w, h)

      const pad = { top: 8, right: 80, bottom: 22, left: 56 }
      const chartW = w - pad.left - pad.right, chartH = h - pad.top - pad.bottom

      const xPos = (turn: number) => pad.left + ((turn - 1) / Math.max(maxTurns - 1, 1)) * chartW
      const yPos = (tok: number)  => pad.top + chartH - ((tok - yMin) / (yMax - yMin)) * chartH

      const fId = focusedIdRef.current
      growthStateRef.current = { series: seriesData, xPos, yPos, chartH, pad }

      // Grid + Y labels
      ctx.strokeStyle = gridColor; ctx.lineWidth = 0.5
      for (let i = 0; i <= 4; i++) {
        const y = pad.top + chartH * i / 4
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + chartW, y); ctx.stroke()
      }
      ctx.fillStyle = textColor; ctx.font = fontStr; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
      for (let i = 0; i <= 4; i++) {
        const val = yMax - (yMax - yMin) * i / 4
        if (val > 0) ctx.fillText(formatCompact(val), pad.left - 4, pad.top + chartH * i / 4)
      }

      // X axis ticks — step chosen so labels stay at least 32 px apart
      const minLabelPx = 32
      const maxLabels = Math.max(2, Math.floor(chartW / minLabelPx))
      let xStep: number
      if (maxTurns <= maxLabels) {
        xStep = 1
      } else {
        const raw = maxTurns / maxLabels
        if (raw <= 2) xStep = 2
        else if (raw <= 5) xStep = 5
        else if (raw <= 10) xStep = 10
        else if (raw <= 20) xStep = 20
        else if (raw <= 25) xStep = 25
        else if (raw <= 50) xStep = 50
        else xStep = Math.ceil(raw / 50) * 50
      }
      ctx.fillStyle = textColor; ctx.font = fontStr; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
      for (let t = 1; t <= maxTurns; t += xStep) {
        const x = xPos(t)
        ctx.strokeStyle = gridColor; ctx.lineWidth = 0.5
        ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + chartH); ctx.stroke()
        ctx.fillText('T' + t, x, pad.top + chartH + 4)
      }
      if (maxTurns > 1 && (maxTurns - 1) % xStep !== 0) {
        const lastRegularX = xPos(Math.floor((maxTurns - 1) / xStep) * xStep + 1)
        const lastX = xPos(maxTurns)
        if (lastX - lastRegularX >= minLabelPx) {
          ctx.fillText('T' + maxTurns, lastX, pad.top + chartH + 4)
        }
      }

      // Draw dim lines first, then the highlighted one on top.
      // Only use focusedSessionId when paused — while cycling, activeIdx drives the highlight.
      const highlighted = (fId && pausedRef.current) ? seriesData.findIndex(s => s.sessionId === fId) : activeIdx
      const order = [...seriesData.keys()].sort((a, b) => (a === highlighted ? 1 : 0) - (b === highlighted ? 1 : 0))

      order.forEach(i => {
        const series = seriesData[i]
        const isHighlighted = i === highlighted
        ctx.strokeStyle = isHighlighted ? series.color : series.color + '28'
        ctx.lineWidth = isHighlighted ? 2.5 : 1

        ctx.beginPath()
        series.points.forEach(({ turn, tokens }, j) => {
          const x = xPos(turn), y = yPos(tokens)
          j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        })
        ctx.stroke()

        if (isHighlighted) {
          ctx.fillStyle = series.color
          ctx.font = smallFont; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
          ctx.fillText(series.label, pad.left + chartW + 4, pad.top)
        }
      })
    }

    drawFnRef.current = draw
    clearTimer()

    // Only reset index + unpause when the session list itself changes.
    // sessions prop is a new array reference on every parent render, so without
    // this guard the animation resets to session 0 on every SSE update.
    const prevIds = growthStateRef.current?.series.map(s => s.sessionId).join(',') ?? ''
    const newIds = seriesData.map(s => s.sessionId).join(',')
    if (prevIds !== newIds) {
      activeIdxRef.current = 0
      pausedRef.current = false
      setPaused(false)
    }

    draw(activeIdxRef.current)
    startTimer()

    return () => clearTimer()
  }, [sessions, timelines])

  // Redraw when focus changes (no animation reset)
  useEffect(() => {
    drawFnRef.current?.(activeIdxRef.current)
  }, [focusedId])

  function togglePause() {
    const next = !pausedRef.current
    pausedRef.current = next
    setPaused(next)
    if (!next) startTimer()
    else clearTimer()
  }

  function stepPrev() {
    clearTimer(); pausedRef.current = true; setPaused(true)
    focusedSessionId.value = null
    activeIdxRef.current = Math.max(0, activeIdxRef.current - 1)
    drawFnRef.current?.(activeIdxRef.current)
  }

  function stepNext() {
    clearTimer(); pausedRef.current = true; setPaused(true)
    focusedSessionId.value = null
    activeIdxRef.current = Math.min(seriesCountRef.current - 1, activeIdxRef.current + 1)
    drawFnRef.current?.(activeIdxRef.current)
  }

  function handleCanvasClick(e: MouseEvent) {
    const canvas = canvasRef.current; if (!canvas) return
    const state = growthStateRef.current; if (!state || !state.series.length) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    let bestDist = 20, bestId = ''
    state.series.forEach(s => {
      s.points.forEach(({ turn, tokens }) => {
        const dx = mx - state.xPos(turn), dy = my - state.yPos(tokens)
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < bestDist) { bestDist = dist; bestId = s.sessionId }
      })
    })
    if (bestId) {
      focusedSessionId.value = focusedSessionId.peek() === bestId ? null : bestId
      if (focusedSessionId.value) activeTab.value = 'sessions'
    }
  }

  const btnStyle = 'padding:2px 8px;font-size:11px;cursor:pointer;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);line-height:1.4'

  return (
    <>
      <canvas
        ref={canvasRef}
        id="context-growth-chart"
        style="width:100%;height:200px;cursor:pointer"
        onClick={handleCanvasClick}
        title="Click a line to select that trace"
      />
      {!hasData && loading && <div class="empty-state" style="font-size:11px">Loading per-turn token data…</div>}
      {!hasData && !loading && <div class="empty-state" style="font-size:11px">No per-turn token data for these traces. Context Growth requires traces with per-turn input token counts — available for OTel-sourced traces and Claude Code log traces.</div>}
      {hasData && (
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:5px">
          <div style="display:flex;align-items:center;gap:6px">
            <button style={btnStyle} onClick={togglePause} title={paused ? 'Play' : 'Pause'}>
              {paused ? '▶' : '⏸'}
            </button>
            {([0.5, 1, 2] as const).map(s => (
              <button
                key={s}
                style={btnStyle + (speed === s ? ';border-color:var(--accent);color:var(--accent)' : '')}
                onClick={() => changeSpeed(s)}
                title={`${s}× speed`}
              >{s === 0.5 ? '½×' : `${s}×`}</button>
            ))}
            <button style={btnStyle} onClick={stepPrev} title="Previous trace">◀</button>
            <button style={btnStyle} onClick={stepNext} title="Next trace">▶</button>
          </div>
          <span style="font-size:10px;color:var(--muted)">most recent {seriesCount} of {sessions.length} trace{sessions.length !== 1 ? 's' : ''}</span>
        </div>
      )}
      <div style="text-align:center;font-size:9px;color:var(--muted);margin-top:4px">
        <TurnsLink />
      </div>
    </>
  )
}

const HELP_TOOLTIPS: Record<string, string> = {
  'help-tool-failures':        'Failures come from guessed file paths or unavailable commands. Provide exact paths and tell the agent which tools and runtimes are available.',
  'help-high-turns':           'Prompt describes the goal but not the location. Add explicit file paths, stopping conditions, and break multi-step tasks into separate prompts.',
  'help-cache-rate':           'Cache breaks when the prompt prefix changes between calls. Keep static instructions identical at the top; avoid timestamps in instruction files.',
  'help-large-context':        'Large instruction files make every session start expensive. Audit and trim instruction files; move reference docs out of instruction files.',
  'help-context-bloat':        'Tool results and instruction files expand context each turn. Keep instruction files under 4 KB; use line-ranged reads instead of full file reads.',
}

function renderHeatReason(r: HeatReason): preact.JSX.Element {
  if (!r.linkPhrase || !r.helpId) return <span style="color:var(--fg)">{r.text}</span>
  const idx = r.text.indexOf(r.linkPhrase)
  if (idx === -1) return <span style="color:var(--fg)">{r.text}</span>
  const before = r.text.slice(0, idx)
  const after  = r.text.slice(idx + r.linkPhrase.length)
  const tip = HELP_TOOLTIPS[r.helpId] || ''
  return (
    <span style="color:var(--fg)">
      {before}<span data-tip={tip} style="border-bottom:1px dotted currentColor;cursor:help">{r.linkPhrase}</span>{after}
    </span>
  )
}

function SessionDiagRow({ reasons }: { reasons: HeatReason[] }) {
  return (
    <tr>
      <td colSpan={10} style="padding:0">
        <div style="padding:8px 16px 12px 32px;background:var(--vscode-editorWidget-background,var(--bg));border-top:1px solid var(--border);font-size:11px">
          <div style="font-weight:600;color:var(--muted);margin-bottom:4px;font-size:10px;text-transform:uppercase">What needs attention</div>
          {reasons.map((r, i) => (
            <div key={i} style="display:flex;align-items:baseline;gap:6px;margin-bottom:3px">
              <span style="color:var(--error);flex-shrink:0">•</span>
              {renderHeatReason(r)}
            </div>
          ))}
        </div>
      </td>
    </tr>
  )
}

function SessionRow({ sess, idx, heat, expanded, onToggle }: {
  sess: SessionSummaryCard; idx: number;
  heat: { score: number; reasons: HeatReason[] }; expanded: boolean; onToggle: () => void
}) {
  const timeLabel = formatSessionTime(sess)
  const cacheRate = sess.inputTokens > 0 ? ((sess.cacheReadTokens / sess.inputTokens) * 100).toFixed(0) : '—'
  const agentDotColor = getAgentColor(sess.source)
  const isFocused = focusedSessionId.value === sess.sessionId

  let rowBg = ''
  if (isFocused) rowBg = 'rgba(55,148,255,0.12)'
  else if (heat.score > 60) rowBg = 'rgba(255,50,50,' + (0.15 + Math.min(heat.score - 60, 40) / 40 * 0.25) + ')'
  else if (heat.score > 30) rowBg = 'rgba(255,140,0,' + (0.12 + (heat.score - 30) / 30 * 0.18) + ')'
  else if (heat.score > 10) rowBg = 'rgba(255,180,50,' + (0.10 + (heat.score - 10) / 20 * 0.15) + ')'

  function handleRowClick() {
    focusedSessionId.value = isFocused ? null : sess.sessionId
    onToggle()
  }

  return (
    <>
      <tr style={'background:' + (rowBg || 'transparent') + ';cursor:pointer' + (isFocused ? ';outline:1px solid var(--vscode-focusBorder,#007fd4)' : '')} onClick={handleRowClick}>
        <td style="text-align:left;min-width:130px;padding:4px 8px">
          <div style="display:flex;align-items:flex-start;gap:4px">
            <span style="font-size:9px;color:var(--muted);flex-shrink:0;margin-top:2px">{expanded ? '▼' : '▶'}</span>
            <span style={'display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:2px;background:' + agentDotColor} />
            <div>
              <div style="font-size:10px;color:var(--foreground);white-space:nowrap">{timeLabel}</div>
              {(sess.userRequest ?? '').length > 0 && (
                <div style="font-size:9px;color:var(--muted);margin-top:1px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic" title={sess.userRequest}>
                  {(sess.userRequest ?? '').slice(0, 55)}{(sess.userRequest ?? '').length > 55 ? '…' : ''}
                </div>
              )}
              {(() => {
                const br = burnRateData.value
                if (!br || br.sessionId !== sess.sessionId) return null
                const tpm = br.burnRate.tokensPerMinute
                const cph = br.burnRate.costPerHour
                const label = formatCompact(Math.round(tpm)) + ' tok/min' + (cph > 0.001 ? ' · $' + cph.toFixed(2) + '/hr' : '')
                return <span style="padding:1px 5px;background:var(--vscode-charts-green,#81c784);color:#000;border-radius:3px;font-size:9px;font-weight:600" data-tip={'Active session burn rate: ' + label}>{label}</span>
              })()}
            </div>
          </div>
        </td>
        <td style="text-align:left;white-space:nowrap;color:var(--muted);font-size:10px" title={sess.model}>{sess.model ? sess.model.split('/').pop() : '—'}</td>
        <td style="text-align:left;white-space:nowrap;font-size:10px;font-family:monospace;color:var(--muted)" title={sess.conversationId || ''}>
          {sess.conversationId ? sess.conversationId.slice(0, 8) : '—'}
        </td>
        <td class="right">{sess.totalLlmCalls}</td>
        <td class="right">{sess.totalToolCalls}</td>
        <td class="right">{sess.inputTokens.toLocaleString()}</td>
        <td class="right">{sess.outputTokens.toLocaleString()}</td>
        <td class="right">{cacheRate}%</td>
        <td class="right">{formatMs(sess.durationMs)}</td>
        <td style={'text-align:right' + (sess.errors > 0 ? ';color:var(--error)' : '')}>{sess.errors}</td>
      </tr>
      {expanded && heat.reasons.length > 0 && <SessionDiagRow reasons={heat.reasons} />}
    </>
  )
}

// ── Token usage per session — evenly-spaced bars, x-axis labeled with timestamps

export function SessionTokenChart({ sessions }: { sessions: SessionSummaryCard[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionDataRef = useRef<Array<{ sessionId: string; startTime: string; input: number; output: number; source: string; slotX: number; slotW: number }>>([])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    // Oldest → newest left → right
    const sessionData = [...sessions].reverse()
      .map(sess => {
        const input = sess.inputTokens ?? 0, output = sess.outputTokens ?? 0
        return input + output > 0
          ? { sessionId: sess.sessionId, startTime: sess.startTime, input, output, source: sess.source }
          : null
      })
      .filter(Boolean) as Array<{ sessionId: string; startTime: string; input: number; output: number; source: string }>

    if (sessionData.length === 0) { canvas.style.display = 'none'; return }
    canvas.style.display = 'block'

    const dpr = window.devicePixelRatio || 1
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    const w = rect.width, h = rect.height
    ctx.clearRect(0, 0, w, h)

    // No X-axis time labels — just slim bars + agent color dot beneath each
    const pad = { top: 8, right: 44, bottom: 14, left: 44 }
    const chartW = w - pad.left - pad.right, chartH = h - pad.top - pad.bottom

    const maxIn  = Math.max(...sessionData.map(s => s.input))  || 1
    const maxOut = Math.max(...sessionData.map(s => s.output)) || 1

    const cs = getComputedStyle(document.body)
    const gridColor = cs.getPropertyValue('--vscode-panel-border').trim() || '#333'
    const fontStr = '9px ' + (cs.getPropertyValue('--vscode-font-family').trim() || 'sans-serif')

    ctx.strokeStyle = gridColor; ctx.lineWidth = 0.5
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + chartH * i / 4
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + chartW, y); ctx.stroke()
    }
    ctx.fillStyle = '#FFB74D'; ctx.font = fontStr; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    for (let i = 0; i <= 4; i++) {
      const val = maxIn * (4 - i) / 4
      if (val > 0) ctx.fillText(formatCompact(val), pad.left - 4, pad.top + chartH * i / 4)
    }
    ctx.fillStyle = '#81C784'; ctx.textAlign = 'left'
    for (let i = 0; i <= 4; i++) {
      const val = maxOut * (4 - i) / 4
      if (val > 0) ctx.fillText(formatCompact(val), pad.left + chartW + 4, pad.top + chartH * i / 4)
    }

    const sl = sessionData.length
    // Slot-based sizing: fill full chart width regardless of session count
    const slotW = chartW / Math.max(sl, 1)
    const barPad = sl > 100 ? 0 : sl > 50 ? 0.2 : sl > 20 ? 0.5 : 1
    const halfSlot = slotW / 2
    const halfBar = Math.max(0.5, halfSlot - barPad)

    const dayKey = (t: string) => t ? new Date(t).toISOString().slice(0, 10) : 'none'
    const textColor = cs.getPropertyValue('--vscode-descriptionForeground').trim() || '#888'
    let lastDayLabelX = -Infinity
    const MIN_DAY_LABEL_GAP = 30

    sessionDataRef.current = sessionData.map((s, i) => ({ ...s, slotX: pad.left + i * slotW, slotW }))

    sessionData.forEach((s, i) => {
      const slotX = pad.left + i * slotW
      const inH = (s.input / maxIn) * chartH
      ctx.fillStyle = '#FFB74D'; ctx.fillRect(slotX + barPad, pad.top + chartH - inH, halfBar, inH)
      const outH = (s.output / maxOut) * chartH
      ctx.fillStyle = '#81C784'; ctx.fillRect(slotX + halfSlot, pad.top + chartH - outH, halfBar, outH)
      // Agent color dot below bar
      ctx.beginPath()
      ctx.arc(slotX + slotW / 2, pad.top + chartH + 7, 1.5, 0, Math.PI * 2)
      ctx.fillStyle = getAgentColor(s.source); ctx.fill()
      // Day boundary: vertical line + MM-DD label (skipped when too close to the previous label)
      if (i > 0 && dayKey(s.startTime) !== dayKey(sessionData[i - 1].startTime)) {
        ctx.strokeStyle = gridColor; ctx.lineWidth = 0.8
        ctx.beginPath(); ctx.moveTo(slotX, pad.top); ctx.lineTo(slotX, pad.top + chartH); ctx.stroke()
        const label = s.startTime ? new Date(s.startTime).toISOString().slice(5, 10) : ''
        if (label && slotX - lastDayLabelX >= MIN_DAY_LABEL_GAP) {
          ctx.fillStyle = textColor
          ctx.font = '8px ' + (cs.getPropertyValue('--vscode-font-family').trim() || 'sans-serif')
          ctx.textAlign = 'left'; ctx.textBaseline = 'top'
          ctx.fillText(label, slotX + 2, pad.top + 1)
          lastDayLabelX = slotX
        }
      }
    })
  })

  function handleTokenChartClick(e: MouseEvent) {
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const hit = sessionDataRef.current.find(s => mx >= s.slotX && mx < s.slotX + s.slotW)
    if (hit) { focusedSessionId.value = hit.sessionId; activeTab.value = 'sessions' }
  }

  const presentSources = new Set(sessions.map(s => s.source).filter(Boolean))
  const agentSources = (['copilot', 'claude_code', 'codex'] as const).filter(src => presentSources.has(src))

  return (
    <>
      <canvas ref={canvasRef} style="width:100%;height:160px;display:block;cursor:pointer"
        onClick={handleTokenChartClick} title="Click a bar to open that trace" />
      {agentSources.length > 0 && (
        <div style="display:flex;gap:10px;justify-content:center;margin-top:4px;flex-wrap:wrap">
          {agentSources.map(src => (
            <span key={src} style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)">
              <span style={`display:inline-block;width:7px;height:7px;border-radius:50%;background:${getAgentColor(src)}`} />
              {getAgentSourceLabel(src)}
            </span>
          ))}
        </div>
      )}
    </>
  )
}

