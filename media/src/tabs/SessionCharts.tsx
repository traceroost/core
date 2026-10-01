import { useEffect, useRef, useState } from 'preact/hooks'
import { focusedSessionId, activeTab, COLORS, goToHelp } from '../state'
import { getAgentColor, getAgentSourceLabel, formatCompact } from '../utils'
import { dayKeyUtc } from '../sessionMetrics'
import type { SessionSummaryCard, GitOutcome, FileOutcome } from '../types'
import { OUTCOME_META } from './Sessions'
import { TREND_OUTCOMES, TREND_COLOR, niceMax, type TrendBin } from './outcomeTrend'

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

    const dayKey = (t: string) => t ? dayKeyUtc(t) : 'none'
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
        const day = dayKey(s.startTime)
        const label = /^\d{4}-/.test(day) ? day.slice(5, 10) : ''
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
  const agentSources = (['copilot', 'claude_code', 'codex', 'opencode', 'cursor'] as const).filter(src => presentSources.has(src))

  return (
    <>
      <canvas ref={canvasRef} style="width:100%;height:160px;display:block;cursor:pointer"
        onClick={handleTokenChartClick} title="Click a bar to open that trace" />
      {agentSources.length > 0 && (
        <div style="display:flex;gap:10px;justify-content:center;margin-top:4px;flex-wrap:wrap">
          {agentSources.map(src => (
            <span key={src} style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)">
              <span style={`display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--agent-${src === 'claude_code' ? 'claude' : src},${getAgentColor(src)})`} />
              {getAgentSourceLabel(src)}
            </span>
          ))}
        </div>
      )}
    </>
  )
}

// ── Outcome vs. tokens — median tokens per git outcome bucket ─────────────────
// Answers "did the sessions that spent more tokens tend to land?" for the local,
// single-developer view. See .staged-issues/outcome-vs-tokens-chart.md.

// Only the three buckets `gitOutcome.ts` actually classifies locally get a bar — 'ambiguous' has
// no OUTCOME_META entry (nothing meaningful to show, per Sessions.tsx's own comment) and is
// excluded here the same way it's excluded from every other OUTCOME_META consumer.
const OUTCOME_BUCKETS: FileOutcome[] = ['merged', 'committed', 'abandoned']

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export interface OutcomeTokenBucket { outcome: FileOutcome; medianTokens: number; count: number }

/** Buckets `sessions` by resolved git outcome and computes median input+output tokens per bucket.
 *  A session with no entry in `outcomes` yet (not requested, or still resolving) or a `null`/
 *  `'ambiguous'` entry is simply omitted — never counted as zero — so the chart shows what's
 *  resolved so far and grows as `requestGitOutcomesFor` fills in the rest. Exported for the
 *  chart component below and for anything that wants the same bucketing without the SVG. */
export function buildOutcomeTokenBuckets(
  sessions: SessionSummaryCard[],
  outcomes: Record<string, GitOutcome | null | undefined>,
): OutcomeTokenBucket[] {
  const tokensByOutcome: Partial<Record<FileOutcome, number[]>> = {}
  for (const s of sessions) {
    const go = outcomes[s.sessionId]
    if (!go || !OUTCOME_BUCKETS.includes(go.overall)) continue
    const list = tokensByOutcome[go.overall] ?? (tokensByOutcome[go.overall] = [])
    list.push((s.inputTokens ?? 0) + (s.outputTokens ?? 0))
  }
  return OUTCOME_BUCKETS
    .filter(o => (tokensByOutcome[o]?.length ?? 0) > 0)
    .map(o => ({ outcome: o, medianTokens: median(tokensByOutcome[o]!), count: tokensByOutcome[o]!.length }))
}

// ── Outcome & token spend over time ────────────────────────────────────────────
// The cloud-first design (analytics/outcome-trend-chart.tsx in the cloud repo), ported to core's
// local git-outcome model (outcomeTrend.ts) and superseding the single median-bar chart above
// (buildOutcomeTokenBuckets is still used for the per-outcome median in Analytics.tsx's table).
// Used to carry a second "traces per day" panel beneath this one; dropped as not pulling its
// weight once tokens already has the story, and the hover tooltip still surfaces the per-outcome
// trace count for anyone who wants it.

const TREND_W = 600
const TREND_PAD = { top: 14, right: 12, bottom: 16, left: 44 }
const TREND_TOKENS_H = 100

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function shortDate(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`
}
function binLabel(bin: TrendBin, unit: 'day' | 'week'): string {
  return unit === 'day' || bin.start === bin.end ? shortDate(bin.start) : `${shortDate(bin.start)} – ${shortDate(bin.end)}`
}

/** A plan limit hit, marked above the bin it fell in (see media/src/planUsage.ts). */
export interface TrendHitMarker { t: number; label: string }

/** Index of the bin a timestamp falls in (bins are UTC days `start`..`end` inclusive), or -1. */
function binIndexOf(bins: TrendBin[], t: number): number {
  const day = new Date(t).toISOString().slice(0, 10)
  return bins.findIndex(b => b.start <= day && day <= b.end)
}

export function OutcomeTrendChart({ bins, unit, hitMarkers = [] }: { bins: TrendBin[]; unit: 'day' | 'week'; hitMarkers?: TrendHitMarker[] }) {
  const [hover, setHover] = useState<number | null>(null)

  if (bins.length === 0) {
    return <div class="empty-state" style="font-size:11px">No traces with a resolved outcome yet — merged, committed, or uncommitted, per local git.</div>
  }

  const chartW = TREND_W - TREND_PAD.left - TREND_PAD.right
  const slotW = chartW / bins.length
  const barW = Math.max(1, Math.min(20, slotW * 0.7))
  const H = TREND_PAD.top + TREND_TOKENS_H + TREND_PAD.bottom

  const tokenScale = niceMax(Math.max(...bins.map(b => b.total.tokens), 0))

  const labelEvery = Math.max(1, Math.ceil(bins.length / Math.max(1, Math.floor(chartW / 70))))
  const last = bins.length - 1

  function stack(bin: TrendBin, i: number, top: number, h: number, scaleMax: number) {
    const x = TREND_PAD.left + (i + 0.5) * slotW - barW / 2
    let y = top + h
    const present = TREND_OUTCOMES.filter(o => bin.byOutcome[o].tokens > 0)
    return present.map((o, si) => {
      const segH = (bin.byOutcome[o].tokens / scaleMax) * h
      y -= segH
      const drawH = Math.max(1, segH - (si > 0 ? 1 : 0))
      return <rect key={o} x={x} y={y} width={barW} height={drawH} fill={TREND_COLOR[o]} opacity={hover === i ? 1 : 0.85} />
    })
  }

  function axis(top: number, h: number, scale: { max: number; step: number }) {
    const ticks: number[] = []
    for (let v = 0; v <= scale.max + 1e-9; v += scale.step) ticks.push(v)
    return ticks.map(v => {
      const y = top + h - (v / scale.max) * h
      return (
        <g key={v}>
          <line x1={TREND_PAD.left} y1={y} x2={TREND_W - TREND_PAD.right} y2={y} stroke="var(--vscode-panel-border,#333)" stroke-width="0.5" />
          <text x={TREND_PAD.left - 6} y={y} text-anchor="end" dominant-baseline="middle" font-size="9" fill="var(--vscode-descriptionForeground,#888)">{formatCompact(v)}</text>
        </g>
      )
    })
  }

  const hovered = hover !== null ? bins[hover] : null

  return (
    <div style="position:relative">
      <svg viewBox={`0 0 ${TREND_W} ${H}`} style="width:100%;height:auto;display:block"
        role="img" aria-label={`Tokens per ${unit}, stacked by outcome.`}
        onMouseLeave={() => setHover(null)}
      >
        <text x={TREND_PAD.left} y={TREND_PAD.top - 4} font-size="9" fill="var(--vscode-descriptionForeground,#888)">Tokens (in + out) per {unit}</text>
        {axis(TREND_PAD.top, TREND_TOKENS_H, tokenScale)}

        {[...new Set(hitMarkers.map(m => binIndexOf(bins, m.t)).filter(i => i >= 0))].map(i => {
          const cx = TREND_PAD.left + (i + 0.5) * slotW
          return <path key={`hit${i}`} d={`M${cx - 4},${TREND_PAD.top - 10} L${cx + 4},${TREND_PAD.top - 10} L${cx},${TREND_PAD.top - 4} Z`} fill="var(--vscode-charts-red,#f44747)" />
        })}
        {bins.map((b, i) => (
          <g key={b.start}
            onMouseEnter={() => setHover(i)}
            style={hover === i ? 'filter:brightness(1)' : undefined}
          >
            {hover === i && (
              <rect x={TREND_PAD.left + i * slotW} y={TREND_PAD.top} width={slotW}
                height={TREND_TOKENS_H} fill="var(--foreground)" opacity="0.05" />
            )}
            {stack(b, i, TREND_PAD.top, TREND_TOKENS_H, tokenScale.max)}
            <rect x={TREND_PAD.left + i * slotW} y={TREND_PAD.top} width={slotW}
              height={TREND_TOKENS_H} fill="transparent" />
            {(i % labelEvery === 0 || i === last) && (
              <text x={Math.min(TREND_PAD.left + (i + 0.5) * slotW, TREND_W - 20)} y={TREND_PAD.top + TREND_TOKENS_H + 12}
                text-anchor="middle" font-size="9" fill="var(--vscode-descriptionForeground,#888)">{shortDate(b.start)}</text>
            )}
          </g>
        ))}
      </svg>

      {hovered && (
        <div style={`position:absolute;top:${TREND_PAD.top}px;${hover !== null && hover / bins.length > 0.6 ? 'right' : 'left'}:8px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-panel-border,#333);border-radius:4px;padding:8px 10px;font-size:11px;line-height:1.7;pointer-events:none;z-index:10;white-space:nowrap`}>
          <div style="font-weight:600;margin-bottom:2px">{binLabel(hovered, unit)}</div>
          {TREND_OUTCOMES.filter(o => hovered.byOutcome[o].sessions > 0).slice().reverse().map(o => (
            <div key={o}>
              <span style={`display:inline-block;width:8px;height:8px;border-radius:2px;background:${TREND_COLOR[o]};margin-right:6px`} />
              {OUTCOME_META[o]!.label}: <strong>{formatCompact(hovered.byOutcome[o].tokens)}</strong> tokens, {hovered.byOutcome[o].sessions} trace{hovered.byOutcome[o].sessions === 1 ? '' : 's'}
            </div>
          ))}
          <div style="margin-top:4px;padding-top:4px;border-top:1px solid var(--vscode-panel-border,#333);color:var(--muted)">
            Total: <strong style="color:var(--foreground)">{formatCompact(hovered.total.tokens)}</strong> tokens, {hovered.total.sessions} trace{hovered.total.sessions === 1 ? '' : 's'}
          </div>
          {hitMarkers.filter(m => binIndexOf(bins, m.t) === hover).map(m => (
            <div key={m.t} style="color:var(--vscode-charts-red,#f44747)">{m.label}</div>
          ))}
        </div>
      )}
    </div>
  )
}

