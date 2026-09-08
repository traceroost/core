import { useEffect, useRef, useState } from 'preact/hooks'
import { rangedSessions, sessionSummary, sessionTimelines, focusedSessionId, vscode } from '../state'
import { getAgentSourceLabel, getAgentColor, formatMs, formatSessionTime } from '../utils'
import { calcEntryCost, fmtUsd } from '../sessionMetrics'
import { LogIngestionNote } from './IngestionNote'
import type { SessionSummaryCard, TimelineEntry } from '../types'

type FlowCanvasEl = HTMLCanvasElement & { __flowDraw?: () => void; __flowCenter?: () => void }

// ── Semantic graph types ───────────────────────────────────────────────────────

interface SemNode {
  id: string
  x: number
  y: number
  color: string
  type: 'llm' | 'tool'
  label: string
  fullLabel?: string
  subLabel: string
  turnNum?: number
  totalTurns?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  model?: string
  durationMs?: number
  action?: string
  note?: string
  toolsUsed?: string[]
  isError?: boolean
  callCount?: number
  totalDurationMs?: number
  avgDurationMs?: number
  errorCount?: number
  usedInTurns?: number[]
}

interface SemEdge {
  from: number
  to: number
  count: number
  kind: 'seq' | 'use'
}

interface TurnGroup {
  entry: TimelineEntry
  tools: TimelineEntry[]
}

const LLM_COLOR  = '#3794FF'
const TOOL_COLOR = '#B8E986'
const ERR_COLOR  = '#f44747'

const TURN_X = 130
const TOOL_X = 380
const LLM_R  = 26
const TOOL_R = 22

function createInferredTurnEntry(sess: SessionSummaryCard, tools: TimelineEntry[], index: number): TimelineEntry {
  const sourceLabel = getAgentSourceLabel(sess.source)
  return {
    type: 'llm',
    spanId: 'flow-inferred-turn-' + index,
    label: sourceLabel + ' tool phase',
    model: sess.model || sourceLabel,
    durationMs: 0,
    action: 'Inferred turn for tool events emitted before a response',
    isError: tools.some(t => t.isError),
    timestamp: tools[0]?.timestamp || sess.startTime,
  }
}

function buildTurnGroups(sess: SessionSummaryCard, timeline: TimelineEntry[]): TurnGroup[] {
  const turns: TurnGroup[] = []
  let pendingTools: TimelineEntry[] = []

  const pushInferredTurn = () => {
    if (pendingTools.length === 0) { return }
    turns.push({
      entry: createInferredTurnEntry(sess, pendingTools, turns.length),
      tools: pendingTools,
    })
    pendingTools = []
  }

  for (const entry of timeline) {
    if (entry.type === 'llm') {
      if (turns.length === 0) {
        pushInferredTurn()
      } else {
        turns[turns.length - 1].tools = pendingTools
        pendingTools = []
      }
      turns.push({ entry, tools: [] })
    } else if (entry.type === 'tool') {
      pendingTools.push(entry)
    }
  }

  if (pendingTools.length > 0) {
    if (turns.length > 0) {
      turns[turns.length - 1].tools = pendingTools
    } else {
      pushInferredTurn()
    }
  }

  return turns
}

function isInferredTurn(entry: TimelineEntry): boolean {
  return entry.spanId.startsWith('flow-inferred-turn-')
}

// ── Shared canvas component ────────────────────────────────────────────────────

export function FlowCanvas({ sess, height = 520 }: { sess: SessionSummaryCard; height?: number }) {
  const [isPlaying, setIsPlaying] = useState(false)
  const speedRef = useRef(800)
  const setIsPlayingRef = useRef(setIsPlaying)
  setIsPlayingRef.current = setIsPlaying
  const progressId = 'flow-prog-' + sess.sessionId

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef({
    zoom: 1, panX: 0, panY: 0,
    dragging: false, didDrag: false, lastMX: 0, lastMY: 0,
    hoverNodeId: null as string | null,
    clickedNodeId: null as string | null,
    nodes: [] as SemNode[],
    edges: [] as SemEdge[],
    playbackTurns: [] as number[],
    playbackIdx: 0,
    playbackPlaying: false,
    playbackTimer: null as ReturnType<typeof setInterval> | null,
  })

  // Request timeline load if needed
  if (!sessionTimelines.value[sess.sessionId] && vscode) {
    vscode.postMessage({ type: 'loadSessionDetail', sessionId: sess.sessionId })
  }

  const hasTimelineData = ((sessionTimelines.value[sess.sessionId] ?? sess.timeline) ?? [])
    .some(e => e.type === 'llm' || e.type === 'tool')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const st = stateRef.current
    if (st.playbackTimer) { clearInterval(st.playbackTimer); st.playbackTimer = null }
    st.playbackPlaying = false; st.playbackIdx = 0; st.clickedNodeId = null
    setIsPlayingRef.current(false)

    const loadedTimeline = sessionTimelines.value[sess.sessionId] ?? sess.timeline
    const timeline = (loadedTimeline ?? []).filter(e => e.type !== 'background')
    const turns = buildTurnGroups(sess, timeline)

    // ── Unique tool map ────────────────────────────────────────────────────────

    const toolData = new Map<string, { count: number; totalMs: number; errors: number; turns: number[] }>()
    turns.forEach((turn, ti) => {
      const seenThisTurn = new Set<string>()
      turn.tools.forEach(t => {
        const name = t.label || 'tool'
        if (!toolData.has(name)) toolData.set(name, { count: 0, totalMs: 0, errors: 0, turns: [] })
        const d = toolData.get(name)!
        d.count++
        d.totalMs += t.durationMs || 0
        if (t.isError) d.errors++
        if (!seenThisTurn.has(name)) { d.turns.push(ti); seenThisTurn.add(name) }
      })
    })

    // ── Layout ─────────────────────────────────────────────────────────────────

    const N = turns.length
    const TURN_SPACING = N <= 1 ? 100 : Math.max(65, Math.min(100, Math.floor(480 / Math.max(N - 1, 1))))
    const TOOL_MIN_GAP = 68
    const START_Y = 70

    const nodes: SemNode[] = []
    const edges: SemEdge[] = []
    const nodeIdxMap: Record<string, number> = {}

    turns.forEach((turn, i) => {
      const inferred = isInferredTurn(turn.entry)
      const node: SemNode = {
        id: 'llm-' + i,
        x: TURN_X,
        y: START_Y + i * TURN_SPACING,
        color: turn.entry.isError ? ERR_COLOR : LLM_COLOR,
        type: 'llm',
        label: 'T' + (i + 1),
        subLabel: inferred
          ? turn.tools.length + '×'
          : ((turn.entry.inputTokens ?? 0) > 0 ? Math.round((turn.entry.inputTokens ?? 0) / 1000) + 'K' : ''),
        turnNum: i + 1,
        totalTurns: turns.length,
        inputTokens: turn.entry.inputTokens ?? 0,
        outputTokens: turn.entry.outputTokens ?? 0,
        costUsd: inferred ? undefined : calcEntryCost(turn.entry, sess.model ?? '') || undefined,
        model: turn.entry.model ?? turn.entry.label ?? '',
        durationMs: turn.entry.durationMs ?? 0,
        action: turn.entry.action ?? '',
        note: inferred ? 'Tool events arrived before a response event, so Flow anchors them to this inferred turn.' : undefined,
        toolsUsed: [...new Set(turn.tools.map(t => t.label || 'tool'))],
        isError: turn.entry.isError,
      }
      nodeIdxMap[node.id] = nodes.length
      nodes.push(node)
    })

    for (let i = 0; i < turns.length - 1; i++) {
      edges.push({ from: nodeIdxMap['llm-' + i], to: nodeIdxMap['llm-' + (i + 1)], count: 1, kind: 'seq' })
    }

    const toolNames = Array.from(toolData.keys())
    const toolTargetY = (name: string) => {
      const d = toolData.get(name)!
      const avg = d.turns.reduce((a, b) => a + b, 0) / d.turns.length
      return START_Y + avg * TURN_SPACING
    }
    const sortedTools = [...toolNames].sort((a, b) => toolTargetY(a) - toolTargetY(b))

    let prevY = -Infinity
    const toolY: Record<string, number> = {}
    for (const name of sortedTools) {
      const ty = Math.max(toolTargetY(name), prevY + TOOL_MIN_GAP)
      toolY[name] = ty
      prevY = ty
    }

    if (sortedTools.length > 0) {
      const turnsCenter = START_Y + ((N - 1) * TURN_SPACING) / 2
      const toolsFirst = toolY[sortedTools[0]]
      const toolsLast  = toolY[sortedTools[sortedTools.length - 1]]
      const toolsCenter = (toolsFirst + toolsLast) / 2
      const shift = turnsCenter - toolsCenter
      sortedTools.forEach(name => { toolY[name] += shift })
    }

    sortedTools.forEach(name => {
      const d = toolData.get(name)!
      const node: SemNode = {
        id: 'tool-' + name,
        x: TOOL_X,
        y: toolY[name],
        color: d.errors > 0 ? ERR_COLOR : TOOL_COLOR,
        type: 'tool',
        label: name.length > 14 ? name.slice(0, 13) + '…' : name,
        fullLabel: name,
        subLabel: d.count + '×',
        callCount: d.count,
        totalDurationMs: d.totalMs,
        avgDurationMs: d.count > 0 ? Math.round(d.totalMs / d.count) : 0,
        errorCount: d.errors,
        usedInTurns: d.turns,
      }
      nodeIdxMap[node.id] = nodes.length
      nodes.push(node)
    })

    turns.forEach((turn, ti) => {
      const perTool: Record<string, number> = {}
      turn.tools.forEach(t => { const n = t.label || 'tool'; perTool[n] = (perTool[n] || 0) + 1 })
      Object.entries(perTool).forEach(([name, count]) => {
        const from = nodeIdxMap['llm-' + ti]
        const to   = nodeIdxMap['tool-' + name]
        if (from !== undefined && to !== undefined) {
          edges.push({ from, to, count, kind: 'use' })
        }
      })
    })

    st.nodes = nodes
    st.edges = edges
    st.playbackTurns = turns.map((_, i) => nodeIdxMap['llm-' + i]).filter(i => i !== undefined)

    // ── Drawing ────────────────────────────────────────────────────────────────

    function nR(n: SemNode) { return n.type === 'llm' ? LLM_R : TOOL_R }

    function centerGraph() {
      if (!canvas || nodes.length === 0) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      nodes.forEach(n => {
        const pad = nR(n) + 34
        if (n.x - pad < minX) minX = n.x - pad
        if (n.y - pad < minY) minY = n.y - pad
        if (n.x + pad > maxX) maxX = n.x + pad
        if (n.y + pad > maxY) maxY = n.y + pad
      })
      const gW = maxX - minX + 40, gH = maxY - minY + 40
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      // Cap at 2.2x so small/sparse graphs still fill most of the canvas instead of
      // leaving it mostly empty, while avoiding comically oversized nodes.
      st.zoom = Math.max(0.15, Math.min(rect.width / gW, rect.height / gH, 2.2))
      st.panX = rect.width  / 2 - (minX + maxX) / 2 * st.zoom
      st.panY = rect.height / 2 - (minY + maxY) / 2 * st.zoom
    }

    function draw() {
      if (!canvas) return
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      canvas.width = rect.width * dpr; canvas.height = rect.height * dpr
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, rect.width, rect.height)
      ctx.save()
      ctx.translate(st.panX, st.panY)
      ctx.scale(st.zoom, st.zoom)

      const cs = getComputedStyle(document.body)
      const fg    = cs.getPropertyValue('--fg').trim()    || '#ccc'
      const muted = cs.getPropertyValue('--muted').trim() || '#666'

      if (turns.length === 0) {
        ctx.restore()
        ctx.font = '13px sans-serif'
        ctx.fillStyle = muted
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('No timeline data for this trace', rect.width / 2, rect.height / 2)
        return
      }

      const activeId = st.clickedNodeId || st.hoverNodeId
      const hlNodes = new Set<string>()
      const hlEdges = new Set<number>()
      if (activeId) {
        hlNodes.add(activeId)
        edges.forEach((e, ei) => {
          const fn = nodes[e.from], tn = nodes[e.to]
          if (fn.id === activeId || tn.id === activeId) {
            hlEdges.add(ei); hlNodes.add(fn.id); hlNodes.add(tn.id)
          }
        })
      }

      const llmNodes = nodes.filter(n => n.type === 'llm')
      if (llmNodes.length >= 2) {
        const spineX = TURN_X - 44
        ctx.save()
        ctx.setLineDash([4, 5])
        ctx.strokeStyle = LLM_COLOR + '40'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(spineX, llmNodes[0].y)
        ctx.lineTo(spineX, llmNodes[llmNodes.length - 1].y)
        ctx.stroke()
        ctx.setLineDash([])
        llmNodes.forEach(n => {
          ctx.strokeStyle = LLM_COLOR + '38'
          ctx.lineWidth = 1
          ctx.beginPath(); ctx.moveTo(spineX, n.y); ctx.lineTo(n.x - LLM_R, n.y); ctx.stroke()
        })
        ctx.restore()
      }

      edges.forEach((e, ei) => {
        const a = nodes[e.from], b = nodes[e.to]
        const isHl  = activeId ? hlEdges.has(ei) : false
        const dimmed = activeId && !isHl

        if (e.kind === 'seq') {
          const ax = a.x + 8, ay = a.y + LLM_R
          const bx = b.x + 8, by = b.y - LLM_R
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
          ctx.strokeStyle = dimmed ? LLM_COLOR + '18' : (isHl ? LLM_COLOR : LLM_COLOR + '50')
          ctx.lineWidth = isHl ? 2.5 : 1.5; ctx.stroke()
          const ang = Math.atan2(by - ay, bx - ax), aLen = 7
          ctx.beginPath(); ctx.moveTo(bx, by)
          ctx.lineTo(bx - aLen * Math.cos(ang - 0.4), by - aLen * Math.sin(ang - 0.4))
          ctx.lineTo(bx - aLen * Math.cos(ang + 0.4), by - aLen * Math.sin(ang + 0.4))
          ctx.closePath()
          ctx.fillStyle = dimmed ? LLM_COLOR + '18' : (isHl ? LLM_COLOR : LLM_COLOR + '60')
          ctx.fill()
        } else {
          const sx = a.x + LLM_R, sy = a.y
          const ex = b.x - TOOL_R, ey = b.y
          const span = TOOL_X - TURN_X
          const cp1x = sx + span * 0.45, cp1y = sy
          const cp2x = ex - span * 0.45, cp2y = ey
          const alpha = dimmed ? 0.08 : (isHl ? 1 : Math.min(0.75, 0.28 + e.count * 0.1))
          const lw    = isHl ? 2.5 : Math.min(4, 1 + e.count * 0.5)
          const hexA  = Math.round(alpha * 255).toString(16).padStart(2, '0')
          ctx.beginPath()
          ctx.moveTo(sx, sy); ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey)
          ctx.strokeStyle = a.color + hexA; ctx.lineWidth = lw; ctx.stroke()
          const ang = Math.atan2(ey - cp2y, ex - cp2x), aLen = 7
          ctx.beginPath(); ctx.moveTo(ex, ey)
          ctx.lineTo(ex - aLen * Math.cos(ang - 0.4), ey - aLen * Math.sin(ang - 0.4))
          ctx.lineTo(ex - aLen * Math.cos(ang + 0.4), ey - aLen * Math.sin(ang + 0.4))
          ctx.closePath(); ctx.fillStyle = a.color + hexA; ctx.fill()
          if (e.count > 1 && !dimmed) {
            const mx = (sx + ex) / 2, my = (sy + ey) / 2 - 9
            ctx.font = 'bold 9px sans-serif'; ctx.fillStyle = a.color + 'cc'
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
            ctx.fillText(e.count + '×', mx, my)
          }
        }
      })

      nodes.forEach(n => {
        const r = nR(n)
        const isActive = n.id === activeId
        const inHL    = activeId ? hlNodes.has(n.id) : false
        const dimmed  = activeId && !inHL

        if (isActive) {
          ctx.save(); ctx.shadowColor = n.color; ctx.shadowBlur = 20
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2)
          ctx.strokeStyle = n.color; ctx.lineWidth = 2; ctx.stroke(); ctx.restore()
        }

        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = isActive ? n.color + 'aa' : (dimmed ? n.color + '10' : n.color + '28'); ctx.fill()
        ctx.strokeStyle = dimmed ? n.color + '30' : n.color
        ctx.lineWidth = isActive ? 3 : (inHL ? 2.5 : 2); ctx.stroke()

        ctx.font = (isActive ? 'bold ' : '') + '10px sans-serif'
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillStyle = dimmed ? muted + '40' : fg
        ctx.fillText(n.label, n.x, n.y - (n.subLabel ? 4 : 0))

        if (n.subLabel) {
          ctx.font = '8px sans-serif'
          ctx.fillStyle = dimmed ? muted + '30'
            : (n.type === 'llm' ? '#7bb3ff' : n.color === ERR_COLOR ? '#f99' : '#8ec96b')
          ctx.fillText(n.subLabel, n.x, n.y + 7)
        }

        ctx.font = '9px sans-serif'; ctx.fillStyle = dimmed ? muted + '30' : muted
        ctx.fillText(n.type === 'llm' ? 'Turn ' + n.turnNum : '', n.x, n.y + r + 11)
      })

      // Tooltip
      const tipId = st.clickedNodeId || st.hoverNodeId
      if (tipId) {
        const hn = nodes.find(n => n.id === tipId)
        if (hn) {
          const trunc = (s: string, max: number) => s && s.length > max ? s.slice(0, max) + '…' : (s || '')
          const lines: Array<{ label?: string; value: string; bold?: boolean; color?: string }> = []

          if (hn.type === 'llm') {
            lines.push({ value: 'Turn ' + hn.turnNum + ' of ' + hn.totalTurns, bold: true, color: hn.color })
            if (hn.model) lines.push({ label: 'Model', value: trunc(hn.model, 42) })
            if (hn.note) lines.push({ label: 'Note', value: hn.note })
            if ((hn.inputTokens ?? 0) > 0 || (hn.outputTokens ?? 0) > 0)
              lines.push({ label: 'Tokens', value: (hn.inputTokens ?? 0).toLocaleString() + ' in → ' + (hn.outputTokens ?? 0).toLocaleString() + ' out' })
            if ((hn.costUsd ?? 0) > 0)
              lines.push({ label: 'Cost', value: fmtUsd(hn.costUsd!) })
            if (hn.durationMs) lines.push({ label: 'Duration', value: formatMs(hn.durationMs) })
            if (hn.action) lines.push({ label: 'Outcome', value: hn.action })
            if (hn.toolsUsed?.length) lines.push({ label: 'Tools used', value: hn.toolsUsed.slice(0, 5).join(', ') + (hn.toolsUsed.length > 5 ? ' +' + (hn.toolsUsed.length - 5) + ' more' : '') })
            if (hn.isError) lines.push({ label: 'Error', value: 'This LLM call failed', color: ERR_COLOR })
          } else {
            lines.push({ value: hn.fullLabel || hn.label, bold: true, color: hn.color })
            lines.push({ label: 'Total calls', value: String(hn.callCount) })
            if ((hn.usedInTurns?.length ?? 0) > 0)
              lines.push({ label: 'Used in turns', value: 'T' + (hn.usedInTurns ?? []).map(t => t + 1).join(', T') })
            if (hn.avgDurationMs) lines.push({ label: 'Avg duration', value: formatMs(hn.avgDurationMs) })
            if (hn.totalDurationMs) lines.push({ label: 'Total time', value: formatMs(hn.totalDurationMs) })
            if (hn.errorCount) lines.push({ label: 'Errors', value: hn.errorCount + ' failed call(s)', color: ERR_COLOR })
          }

          ctx.font = '11px sans-serif'
          const lineH = 19, padX = 12, padY = 10
          let labelW = 0, valueW = 0
          lines.forEach(line => {
            if (line.label) { ctx.font = 'bold 10px sans-serif'; const lw = ctx.measureText(line.label + ':').width; if (lw > labelW) labelW = lw }
            ctx.font = line.bold ? 'bold 12px sans-serif' : '11px sans-serif'
            const vw = ctx.measureText(line.value).width; if (vw > valueW) valueW = vw
          })
          const gapW = 10, contentW = Math.max(labelW + gapW + valueW, valueW)
          const boxW = Math.min(contentW + padX * 2, 390)
          const boxH = lines.length * lineH + padY * 2 + 4
          let boxX = hn.x + nR(hn) + 14
          const boxY = hn.y - boxH / 2
          if ((hn.x + nR(hn) + 14 + boxW) > (rect.width / st.zoom - st.panX / st.zoom - 20)) {
            boxX = hn.x - nR(hn) - 14 - boxW
          }
          const br = 7

          ctx.fillStyle = 'rgba(22,22,26,0.97)'; ctx.strokeStyle = hn.color; ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.moveTo(boxX + br, boxY); ctx.lineTo(boxX + boxW - br, boxY)
          ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + br)
          ctx.lineTo(boxX + boxW, boxY + boxH - br)
          ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - br, boxY + boxH)
          ctx.lineTo(boxX + br, boxY + boxH)
          ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - br)
          ctx.lineTo(boxX, boxY + br)
          ctx.quadraticCurveTo(boxX, boxY, boxX + br, boxY)
          ctx.closePath(); ctx.fill(); ctx.stroke()
          ctx.fillStyle = hn.color + 'cc'; ctx.fillRect(boxX, boxY + br, 3, boxH - br * 2)

          ctx.textAlign = 'left'; ctx.textBaseline = 'top'
          let dividerDrawn = false
          lines.forEach((line, li) => {
            const ly = boxY + padY + li * lineH + 2
            if (line.label) {
              if (!dividerDrawn) {
                dividerDrawn = true
                ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 0.5
                ctx.beginPath(); ctx.moveTo(boxX + 10, ly - 4); ctx.lineTo(boxX + boxW - 10, ly - 4); ctx.stroke()
              }
              ctx.font = 'bold 10px sans-serif'; ctx.fillStyle = '#777'
              ctx.fillText(line.label + ':', boxX + padX + 4, ly + 1)
              ctx.font = '11px sans-serif'; ctx.fillStyle = line.color || '#ddd'
              ctx.fillText(line.value, boxX + padX + 4 + labelW + gapW, ly)
            } else {
              ctx.font = line.bold ? 'bold 12px sans-serif' : '11px sans-serif'
              ctx.fillStyle = line.color || '#fff'
              ctx.fillText(line.value, boxX + padX + 4, ly)
            }
          })
        }
      }

      ctx.restore()
    }

    requestAnimationFrame(() => { centerGraph(); draw() })

    // ── Event handlers ─────────────────────────────────────────────────────────

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const f = e.deltaY < 0 ? 1.1 : 0.9
      const wx = (e.offsetX - st.panX) / st.zoom, wy = (e.offsetY - st.panY) / st.zoom
      st.zoom = Math.max(0.1, Math.min(5, st.zoom * f))
      st.panX = e.offsetX - wx * st.zoom; st.panY = e.offsetY - wy * st.zoom; draw()
    }
    const onMouseDown = (e: MouseEvent) => {
      st.dragging = true; st.didDrag = false; st.lastMX = e.offsetX; st.lastMY = e.offsetY
      canvas.style.cursor = 'grabbing'
    }
    const onMouseMove = (e: MouseEvent) => {
      if (st.dragging) {
        st.didDrag = true
        st.panX += e.offsetX - st.lastMX; st.panY += e.offsetY - st.lastMY
        st.lastMX = e.offsetX; st.lastMY = e.offsetY; draw(); return
      }
      if (!st.playbackPlaying) {
        const rect = canvas.getBoundingClientRect()
        const mx = (e.clientX - rect.left - st.panX) / st.zoom
        const my = (e.clientY - rect.top  - st.panY) / st.zoom
        let found: string | null = null
        for (const n of nodes) {
          const r = nR(n), dx = mx - n.x, dy = my - n.y
          if (dx * dx + dy * dy <= r * r) { found = n.id; break }
        }
        if (found !== st.hoverNodeId) {
          st.hoverNodeId = found; canvas.style.cursor = found ? 'pointer' : 'grab'; draw()
        }
      }
    }
    const onMouseUp    = () => { st.dragging = false; canvas.style.cursor = 'grab' }
    const onMouseLeave = () => { st.dragging = false; st.hoverNodeId = null; canvas.style.cursor = 'grab'; draw() }
    const onClick = (e: MouseEvent) => {
      if (st.didDrag) return
      const rect = canvas.getBoundingClientRect()
      const mx = (e.clientX - rect.left - st.panX) / st.zoom
      const my = (e.clientY - rect.top  - st.panY) / st.zoom
      for (const n of nodes) {
        const r = nR(n), dx = mx - n.x, dy = my - n.y
        if (dx * dx + dy * dy <= r * r) {
          st.clickedNodeId = st.clickedNodeId === n.id ? null : n.id; draw(); return
        }
      }
      st.clickedNodeId = null; draw()
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('mouseleave', onMouseLeave)
    canvas.addEventListener('click', onClick)

    ;(canvas as FlowCanvasEl).__flowDraw   = draw
    ;(canvas as FlowCanvasEl).__flowCenter = centerGraph

    return () => {
      if (st.playbackTimer) clearInterval(st.playbackTimer)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('mouseleave', onMouseLeave)
      canvas.removeEventListener('click', onClick)
    }
  }, [sess.sessionId, sessionTimelines.value[sess.sessionId]])

  // ── Controls ──────────────────────────────────────────────────────────────────

  function handleZoomIn()  { const c = canvasRef.current; if (!c) return; stateRef.current.zoom = Math.min(5, stateRef.current.zoom * 1.3); (c as FlowCanvasEl).__flowDraw?.() }
  function handleZoomOut() { const c = canvasRef.current; if (!c) return; stateRef.current.zoom = Math.max(0.1, stateRef.current.zoom / 1.3); (c as FlowCanvasEl).__flowDraw?.() }
  function handleReset()   { const c = canvasRef.current; if (!c) return; (c as FlowCanvasEl).__flowCenter?.(); (c as FlowCanvasEl).__flowDraw?.() }

  function handlePlayPause() {
    const canvas = canvasRef.current; if (!canvas) return
    const st = stateRef.current
    const draw = (canvas as FlowCanvasEl).__flowDraw; if (!draw) return
    const prog = document.getElementById(progressId)

    if (st.playbackPlaying) {
      if (st.playbackTimer) clearInterval(st.playbackTimer); st.playbackTimer = null
      st.playbackPlaying = false; st.clickedNodeId = null
      setIsPlaying(false); if (prog) prog.textContent = ''; draw()
      return
    }

    if (st.playbackTurns.length === 0) return
    st.playbackPlaying = true; setIsPlaying(true)
    st.playbackIdx = 0
    st.clickedNodeId = st.nodes[st.playbackTurns[0]]?.id ?? null
    if (prog) prog.textContent = '1 / ' + st.playbackTurns.length
    draw()

    st.playbackTimer = setInterval(() => {
      if (st.playbackIdx >= st.playbackTurns.length - 1) {
        clearInterval(st.playbackTimer!); st.playbackTimer = null
        st.playbackPlaying = false; st.clickedNodeId = null
        setIsPlayingRef.current(false); if (prog) prog.textContent = ''; draw(); return
      }
      st.playbackIdx++
      st.clickedNodeId = st.nodes[st.playbackTurns[st.playbackIdx]]?.id ?? null
      if (prog) prog.textContent = (st.playbackIdx + 1) + ' / ' + st.playbackTurns.length
      draw()
    }, speedRef.current)
  }

  if (!hasTimelineData) {
    return (
      <div class="empty-state" style={`min-height:${Math.min(height, 160)}px;display:flex;flex-direction:column;align-items:center;justify-content:center`}>
        No flow data for this session
        {sess.dataSource === 'log' && <LogIngestionNote feature="flow" />}
      </div>
    )
  }

  return (
    <div>
      <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
        <button class="flow-btn" onClick={handleZoomIn}>+</button>
        <button class="flow-btn" onClick={handleZoomOut}>−</button>
        <button class="flow-btn" onClick={handleReset}>Reset</button>
        <span style="width:1px;height:16px;background:var(--border);margin:0 2px" />
        <button class="flow-btn" title="Animate turn sequence" onClick={handlePlayPause}>{isPlaying ? '⏸' : '▶'}</button>
        <select
          class="toolbar-select"
          onChange={e => { speedRef.current = parseInt((e.target as HTMLSelectElement).value) || 800 }}
        >
          <option value="2000">Slow</option>
          <option value="800" selected>Normal</option>
          <option value="300">Fast</option>
        </select>
        <span id={progressId} style="font-size:10px;color:var(--muted)" />
      </div>
      <div style="display:flex;gap:12px;margin-bottom:6px;font-size:10px;color:var(--muted);flex-wrap:wrap;align-items:center">
        {([
          { color: LLM_COLOR, label: 'LLM turn' },
          { color: TOOL_COLOR, label: 'Tool' },
          { color: ERR_COLOR,  label: 'Error' },
        ] as const).map(({ color, label }) => (
          <span key={label} style="display:flex;align-items:center;gap:4px">
            <span style={'display:inline-block;width:9px;height:9px;border-radius:50%;background:' + color + '30;border:1.5px solid ' + color} />
            {label}
          </span>
        ))}
        <span style="color:var(--muted)">Edge thickness = call freq</span>
      </div>
      <canvas
        ref={canvasRef}
        style={`width:100%;height:${height}px;display:block;border:1px solid var(--border);border-radius:4px;cursor:grab`}
      />
    </div>
  )
}

// ── Full Flow tab (with session picker) ───────────────────────────────────────

export function Flow() {
  const sessions = sessionSummary.value?.sessions ?? rangedSessions.value
  const [searchText, setSearchText] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!searchOpen) return
    const close = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [searchOpen])

  const focusedId = focusedSessionId.value
  const focusedIdx = focusedId ? sessions.findIndex(s => s.sessionId === focusedId) : -1
  const [manualIdx, setManualIdx] = useState(-1)
  const selectedIdx = focusedIdx >= 0 ? focusedIdx : manualIdx

  if (sessions.length === 0) {
    return <div id="flow-content"><div class="empty-state">No agent traces recorded — start a Copilot, Claude, or Codex run</div></div>
  }

  const allSessions = sessions.map(sess => {
    const time = formatSessionTime(sess)
    const src = getAgentSourceLabel(sess.source)
    const turns = sess.totalLlmCalls ?? 0
    const snippet = sess.userRequest ? (sess.userRequest.length > 40 ? sess.userRequest.slice(0, 40) + '…' : sess.userRequest) : ''
    return {
      label: snippet ? `${time} · ${src} · "${snippet}"` : `${time} · ${src} · ${turns} turns`,
      time, snippet,
      color: getAgentColor(sess.source),
      sess,
    }
  })

  const searchLower = searchText.toLowerCase()
  const filteredForSearch = searchText
    ? allSessions.filter(s => s.label.toLowerCase().includes(searchLower))
    : allSessions

  const clampedIdx = Math.max(0, Math.min(
    selectedIdx < 0 ? allSessions.length - 1 : selectedIdx,
    allSessions.length - 1
  ))

  const currentSession = allSessions[clampedIdx]

  return (
    <div id="flow-content">
      <div style="margin-bottom:5px">
        <div ref={searchRef} style="position:relative">
          <input
            type="text"
            placeholder={`Search ${allSessions.length} sessions…`}
            value={searchText}
            onInput={e => { setSearchText((e.target as HTMLInputElement).value); setSearchOpen(true) }}
            onFocus={() => setSearchOpen(true)}
            style="width:100%;padding:4px 8px;font-size:11px;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,#555);border-radius:3px;outline:none;box-sizing:border-box"
          />
          {searchOpen && filteredForSearch.length > 0 && (
            <div style="position:absolute;top:100%;left:0;right:0;z-index:200;margin-top:2px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-panel-border,#3e3e42);border-radius:4px;max-height:220px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.35)">
              {filteredForSearch.slice(0, 30).map(s => {
                const origIdx = allSessions.indexOf(s)
                const isSelected = origIdx === clampedIdx
                return (
                  <div
                    key={s.sess.sessionId}
                    style={`display:flex;align-items:flex-start;gap:6px;padding:5px 8px;cursor:pointer;font-size:11px;${isSelected ? 'background:var(--vscode-list-activeSelectionBackground,#094771)' : ''}`}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--vscode-list-hoverBackground,#2a2d2e)' }}
                    onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '' }}
                    onMouseDown={e => {
                      e.preventDefault()
                      setManualIdx(origIdx)
                      setSearchText('')
                      setSearchOpen(false)
                    }}
                  >
                    <span style={'display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:2px;background:' + s.color} />
                    <div style="min-width:0">
                      <div style="white-space:nowrap;color:var(--vscode-foreground,#ccc)">{s.time}</div>
                      {s.snippet && <div style="font-size:9px;color:var(--vscode-descriptionForeground,#888);font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{s.snippet}</div>}
                    </div>
                  </div>
                )
              })}
              {filteredForSearch.length > 30 && (
                <div style="padding:4px 8px;font-size:10px;color:var(--vscode-descriptionForeground,#888)">
                  {filteredForSearch.length - 30} more — refine search
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        {currentSession && (
          <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted);white-space:nowrap">
            <span style={'display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0;background:' + currentSession.color} />
            <span>{currentSession.time}</span>
            {currentSession.snippet && <span style="color:var(--muted);font-style:italic;overflow:hidden;text-overflow:ellipsis;max-width:200px">"{currentSession.snippet}"</span>}
          </div>
        )}
        <div style="display:flex;gap:4px;align-items:center;flex-shrink:0">
          <button
            class="flow-btn"
            disabled={clampedIdx <= 0}
            onClick={() => { setManualIdx(Math.max(0, clampedIdx - 1)); setSearchText(''); setSearchOpen(false) }}
            title="Previous trace"
          >‹</button>
          <button
            class="flow-btn"
            disabled={clampedIdx >= allSessions.length - 1}
            onClick={() => { setManualIdx(Math.min(allSessions.length - 1, clampedIdx + 1)); setSearchText(''); setSearchOpen(false) }}
            title="Next trace"
          >›</button>
        </div>
      </div>

      {currentSession && <FlowCanvas sess={currentSession.sess} height={520} />}
    </div>
  )
}
