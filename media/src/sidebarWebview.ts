// Sidebar live session monitor
// Works in both VS Code webview and standalone (SSE events are normalised to
// window.message in standalone/server.ts, so the same listener handles both).
// acquireVsCodeApi is guarded so the module loads without it.

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void }

interface CurrentSession {
  source: string
  model: string
  userRequest: string
  totalLlmCalls: number
  totalToolCalls: number
  errors: number
  cacheHitRate: number
  durationMs: number
  startTime: string
  turnInputTokens: number[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  costUsd: number
}

interface BurnRate {
  tokensPerMinute: number
  costPerHour: number
}

interface SidebarInit {
  lastActivityMs: number
  agentSources: string[]
  sessionCount: number
  isActive: boolean
  currentSession: CurrentSession | null
  burnRate: BurnRate | null
  avgInputTokens: number
  avgOutputTokens: number
}

declare const __SIDEBAR_INIT__: SidebarInit

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

function fmtDur(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function fmtAgo(ms: number): string {
  if (!ms) return 'No activity yet'
  const secs = Math.floor((Date.now() - ms) / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

function agentColor(source: string): string {
  if (source === 'claude_code') return '#FFB085'
  if (source === 'codex') return '#F0FF42'
  if (source === 'copilot') return '#00EAFF'
  if (source === 'opencode') return '#FFFFFF'
  if (source === 'cursor') return '#B39DDB'
  return '#90a4ae'
}

function agentLabel(source: string): string {
  if (source === 'claude_code') return 'Claude'
  if (source === 'codex') return 'Codex'
  if (source === 'opencode') return 'OpenCode'
  if (source === 'cursor') return 'Cursor'
  return 'Copilot'
}

// ── Sparkline canvas ──────────────────────────────────────────────────────────

function drawSparkline(canvas: HTMLCanvasElement, tokens: number[], color: string, isActive: boolean) {
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  const w = rect.width, h = rect.height
  ctx.clearRect(0, 0, w, h)

  const cs = getComputedStyle(document.body)
  const mutedColor = cs.getPropertyValue('--vscode-descriptionForeground').trim() || '#888'
  const fontStr = '9px ' + (cs.getPropertyValue('--vscode-font-family').trim() || 'sans-serif')

  if (tokens.length < 2) {
    if (tokens.length === 1) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(w / 2, h / 2, 3, 0, Math.PI * 2)
      ctx.fill()
    }
    return
  }

  // Padding leaves room for y-axis labels (left) and x-axis labels (bottom)
  const pad = { top: 10, right: 6, bottom: 14, left: 34 }
  const cw = w - pad.left - pad.right
  const ch = h - pad.top - pad.bottom

  // Fit y-axis tightly to the data range so small changes show as movement
  const rawMin = Math.min(...tokens), rawMax = Math.max(...tokens)
  const spread = rawMax - rawMin || rawMax * 0.1 || 1
  const yMin = Math.max(0, rawMin - spread * 0.15)
  const yMax = rawMax + spread * 0.15

  const xPos = (i: number) => pad.left + (i / (tokens.length - 1)) * cw
  const yPos = (v: number) => pad.top + ch - ((v - yMin) / (yMax - yMin)) * ch

  // Y-axis labels: max at top, min at bottom
  ctx.fillStyle = mutedColor
  ctx.font = fontStr
  ctx.textAlign = 'right'
  ctx.textBaseline = 'top'
  ctx.fillText(fmt(yMax), pad.left - 3, pad.top)
  ctx.textBaseline = 'bottom'
  ctx.fillText(fmt(yMin), pad.left - 3, pad.top + ch)

  // X-axis labels: T1 at left, T{n} at right
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText('T1', pad.left, pad.top + ch + 3)
  ctx.textAlign = 'right'
  ctx.fillText('T' + tokens.length, pad.left + cw, pad.top + ch + 3)

  // Filled area (bottom is the yMin gridline, not the absolute canvas bottom)
  const chartBottom = yPos(yMin)
  ctx.beginPath()
  ctx.moveTo(xPos(0), chartBottom)
  tokens.forEach((v, i) => ctx.lineTo(xPos(i), yPos(v)))
  ctx.lineTo(xPos(tokens.length - 1), chartBottom)
  ctx.closePath()
  const hex = color.startsWith('#') ? color : '#90a4ae'
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  ctx.fillStyle = `rgba(${r},${g},${b},0.15)`
  ctx.fill()

  // Line
  ctx.beginPath()
  tokens.forEach((v, i) => { i === 0 ? ctx.moveTo(xPos(i), yPos(v)) : ctx.lineTo(xPos(i), yPos(v)) })
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Last point dot
  const lx = xPos(tokens.length - 1), ly = yPos(tokens[tokens.length - 1])
  ctx.beginPath()
  ctx.arc(lx, ly, isActive ? 4 : 3, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  isActive: __SIDEBAR_INIT__.isActive,
  lastActivityMs: __SIDEBAR_INIT__.lastActivityMs,
  sessionCount: __SIDEBAR_INIT__.sessionCount,
  agentSources: __SIDEBAR_INIT__.agentSources,
  currentSession: __SIDEBAR_INIT__.currentSession,
  burnRate: __SIDEBAR_INIT__.burnRate,
  avgInputTokens: __SIDEBAR_INIT__.avgInputTokens ?? 1,
  avgOutputTokens: __SIDEBAR_INIT__.avgOutputTokens ?? 1,
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  const { isActive, lastActivityMs, currentSession, burnRate, avgInputTokens, avgOutputTokens } = state

  // Status row
  const dot = document.getElementById('sb-dot')
  const statusText = document.getElementById('sb-status-text')
  const agoEl = document.getElementById('sb-ago')
  if (dot) dot.className = 'sb-dot ' + (isActive ? 'active' : 'idle')
  if (statusText) {
    statusText.textContent = isActive ? 'Active' : 'Idle'
    statusText.style.color = isActive ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)'
  }
  const sessionLabel = document.getElementById('sb-session-label')
  if (sessionLabel) sessionLabel.textContent = isActive ? 'current session' : ''
  if (agoEl) agoEl.textContent = isActive ? '' : (lastActivityMs ? fmtAgo(lastActivityMs) : '')

  // Current session block
  const block = document.getElementById('sb-session-block') as HTMLElement | null
  const empty = document.getElementById('sb-empty') as HTMLElement | null
  if (!currentSession) {
    if (block) block.style.display = 'none'
    if (empty) empty.style.display = 'block'
    const agentEl = document.getElementById('sb-agent')
    if (agentEl) agentEl.innerHTML = ''
    const durEl = document.getElementById('sb-dur')
    if (durEl) durEl.textContent = ''
    const promptEl = document.getElementById('sb-prompt') as HTMLElement | null
    if (promptEl) { promptEl.textContent = ''; promptEl.style.display = 'none' }
    const modelEl = document.getElementById('sb-model')
    if (modelEl) modelEl.textContent = ''
    renderFooter()
    return
  }
  if (block) block.style.display = 'block'
  if (empty) empty.style.display = 'none'

  const color = agentColor(currentSession.source)

  // Agent dot + label + duration
  const agentEl = document.getElementById('sb-agent')
  if (agentEl) {
    agentEl.innerHTML =
      `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0;margin-right:4px"></span>` +
      `<span>${agentLabel(currentSession.source)}</span>`
  }
  const durEl = document.getElementById('sb-dur')
  if (durEl) durEl.textContent = fmtDur(currentSession.durationMs)

  // Prompt snippet
  const promptEl = document.getElementById('sb-prompt')
  if (promptEl) {
    const req = currentSession.userRequest
    promptEl.textContent = req ? (req.length > 60 ? '"' + req.slice(0, 60) + '…"' : '"' + req + '"') : ''
    promptEl.style.display = req ? '' : 'none'
  }

  // Model
  const modelEl = document.getElementById('sb-model')
  if (modelEl) modelEl.textContent = currentSession.model || '—'

  // Sparkline
  const canvas = document.getElementById('sb-sparkline') as HTMLCanvasElement | null
  const sparklineWaiting = document.getElementById('sb-sparkline-waiting')
  const hasSparklineData = currentSession.turnInputTokens.length > 0
  if (canvas) {
    if (hasSparklineData) {
      canvas.style.display = 'block'
      drawSparkline(canvas, currentSession.turnInputTokens, color, isActive)
    } else {
      canvas.style.display = 'none'
    }
  }
  if (sparklineWaiting) sparklineWaiting.style.display = hasSparklineData ? 'none' : ''

  // Turn label
  const turnLabel = document.getElementById('sb-turn-label')
  if (turnLabel) {
    const n = currentSession.turnInputTokens.length
    const last = currentSession.turnInputTokens[n - 1] ?? 0
    turnLabel.textContent = n > 0 ? `Turn ${n} · ${fmt(last)} tokens` : ''
  }

  // Token bars (input / output) — each bar scales independently against its session average
  const tokenBars = document.getElementById('sb-token-bars')
  const tokenWaiting = document.getElementById('sb-token-waiting')
  const inp = currentSession.inputTokens ?? 0
  const out = currentSession.outputTokens ?? 0
  if (inp > 0 || out > 0) {
    if (tokenWaiting) tokenWaiting.style.display = 'none'
    if (tokenBars) {
      const inScale = Math.max(avgInputTokens, inp, 1)
      const outScale = Math.max(avgOutputTokens, out, 1)
      const inPct = Math.min(100, Math.round(inp / inScale * 100))
      const outPct = Math.min(100, Math.round(out / outScale * 100))
      tokenBars.innerHTML =
        `<div style="display:flex;flex-direction:column;gap:3px">` +
        `<div style="display:flex;align-items:center;gap:5px;font-size:10px">` +
        `<span style="width:36px;color:#FFB74D;text-align:right;font-variant-numeric:tabular-nums">${fmt(inp)}</span>` +
        `<div style="flex:1;height:5px;background:var(--vscode-panel-border);border-radius:2px">` +
        `<div style="width:${inPct}%;height:100%;background:#FFB74D;border-radius:2px"></div></div>` +
        `<span style="color:var(--muted);font-size:9px">in</span>` +
        `<span style="color:var(--muted);font-size:9px;opacity:0.6">avg ${fmt(Math.round(avgInputTokens))}</span></div>` +
        `<div style="display:flex;align-items:center;gap:5px;font-size:10px">` +
        `<span style="width:36px;color:#81C784;text-align:right;font-variant-numeric:tabular-nums">${fmt(out)}</span>` +
        `<div style="flex:1;height:5px;background:var(--vscode-panel-border);border-radius:2px">` +
        `<div style="width:${outPct}%;height:100%;background:#81C784;border-radius:2px"></div></div>` +
        `<span style="color:var(--muted);font-size:9px">out</span>` +
        `<span style="color:var(--muted);font-size:9px;opacity:0.6">avg ${fmt(Math.round(avgOutputTokens))}</span></div></div>`
    }
  } else {
    if (tokenBars) tokenBars.innerHTML = ''
    if (tokenWaiting) tokenWaiting.style.display = ''
  }

  // Estimated cost
  const costVal = document.getElementById('sb-cost-val')
  const cost = currentSession.costUsd ?? 0
  if (costVal) costVal.textContent = cost > 0 ? (cost < 0.01 ? '<$0.01' : '$' + cost.toFixed(2)) : '—'

  // Burn rate — show last known value if available, otherwise "Waiting for data…"
  const burnEl = document.getElementById('sb-burn')
  const burnWaiting = document.getElementById('sb-burn-waiting')
  if (burnRate) {
    const tpm = fmt(Math.round(burnRate.tokensPerMinute))
    const cph = burnRate.costPerHour > 0.001 ? ` · $${burnRate.costPerHour.toFixed(2)}/hr` : ''
    if (burnEl) { burnEl.textContent = `${tpm} tokens/min${cph}`; burnEl.style.display = '' }
    if (burnWaiting) burnWaiting.style.display = 'none'
  } else {
    if (burnEl) burnEl.style.display = 'none'
    if (burnWaiting) burnWaiting.style.display = ''
  }

  // Counters
  const turnsEl = document.getElementById('sb-turns')
  const toolsEl = document.getElementById('sb-tools')
  const errEl = document.getElementById('sb-errors')
  const cacheEl = document.getElementById('sb-cache')
  if (turnsEl) turnsEl.textContent = String(currentSession.totalLlmCalls)
  if (toolsEl) toolsEl.textContent = String(currentSession.totalToolCalls)
  if (errEl) {
    errEl.textContent = String(currentSession.errors)
    errEl.style.color = currentSession.errors > 0 ? 'var(--vscode-testing-iconFailed,#f44)' : ''
  }
  if (cacheEl) cacheEl.textContent = `${Math.round(currentSession.cacheHitRate * 100)}%`

  renderFooter()
}

function renderFooter() {
  const countEl = document.getElementById('sb-session-count')
  if (countEl) countEl.textContent = String(state.sessionCount)
}

// ── Init + message handler ────────────────────────────────────────────────────
render()

// Keep idle timer ticking
setInterval(() => {
  if (!state.isActive && state.lastActivityMs) {
    const agoEl = document.getElementById('sb-ago')
    if (agoEl) agoEl.textContent = fmtAgo(state.lastActivityMs)
  }
}, 10_000)

interface UpdateMsg {
  type: 'update'
  isActive?: boolean
  lastActivityMs?: number
  sessionCount?: number
  agentSources?: string[]
  currentSession?: CurrentSession | null
  burnRate?: BurnRate | null
  avgInputTokens?: number
  avgOutputTokens?: number
}

window.addEventListener('message', (e: MessageEvent<UpdateMsg>) => {
  const msg = e.data
  if (msg.type !== 'update') return
  if (msg.isActive !== undefined) state.isActive = msg.isActive
  if (msg.lastActivityMs !== undefined) state.lastActivityMs = msg.lastActivityMs
  if (msg.sessionCount !== undefined) state.sessionCount = msg.sessionCount
  if (msg.agentSources) { state.agentSources = msg.agentSources }
  if ('currentSession' in msg) {
    const incoming = msg.currentSession ?? null
    // Reset retained burn rate when switching to a different session
    if (incoming?.startTime !== state.currentSession?.startTime) state.burnRate = null
    state.currentSession = incoming
  }
  if ('burnRate' in msg && msg.burnRate != null) state.burnRate = msg.burnRate
  if (msg.avgInputTokens != null) state.avgInputTokens = msg.avgInputTokens
  if (msg.avgOutputTokens != null) state.avgOutputTokens = msg.avgOutputTokens
  render()
})

// ── Actions ───────────────────────────────────────────────────────────────────

const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null

document.getElementById('sb-open-btn')?.addEventListener('click', () => {
  if (vscode) vscode.postMessage({ type: 'openDashboardTab', tab: 'sessions' })
})

