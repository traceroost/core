import * as vscode from 'vscode'
import { SessionRepository } from './sessionRepository'
import { nanoToMs } from './summarizers/helpers'
import { Span } from './types'
import { calcTokenCostUsd } from './pricing'
import { SessionSummaryCard } from './summarizers/summarizerTypes'

// Only the most recent N sessions feed the average — averaging over full history let one
// unusually long session skew the bar-scaling average for everyone after it, especially
// early on when the total session count is small.
const AVG_WINDOW = 5

export function tokenAverages(all: SessionSummaryCard[]): { avgInputTokens: number; avgOutputTokens: number } {
  const recent = all.slice(0, AVG_WINDOW)
  return {
    avgInputTokens: recent.length > 0 ? recent.reduce((s, x) => s + x.inputTokens, 0) / recent.length : 1,
    avgOutputTokens: recent.length > 0 ? recent.reduce((s, x) => s + x.outputTokens, 0) / recent.length : 1,
  }
}

export class SidebarPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView
  private collectorError: string | null = null

  // Timeline cache — only reload when session changes or turn count grows
  private cachedTimelineSessionId: string | null = null
  private cachedTimelineTurns = 0
  private cachedTurnInputTokens: number[] = []

  constructor(
    private repo: SessionRepository,
    private extensionUri: vscode.Uri,
  ) {}

  setRepository(repo: SessionRepository) {
    this.repo = repo
    this.refresh()
  }

  setCollectorError(msg: string | null) {
    this.collectorError = msg
    if (this.view) this.view.webview.html = this.getHtml(this.view.webview)
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    }
    webviewView.webview.html = this.getHtml(webviewView.webview)

    vscode.commands.executeCommand('traceRoost.openDashboard')

    const msgDisposable = webviewView.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'openDashboardTab') {
        vscode.commands.executeCommand('traceRoost.openDashboard')
        setTimeout(() => {
          const { DashboardPanel } = require('./dashboardPanel')
          DashboardPanel.switchToTab(msg.tab ?? 'sessions')
        }, 300)
      } else if (msg.type === 'confirmClear') {
        const answer = await vscode.window.showWarningMessage(
          'Clear all TraceRoost data? OTEL session data is deleted permanently. TraceRoost log cache is cleared and will be rebuilt from your local agent log files (the log files themselves are not deleted).',
          { modal: true },
          'Clear All'
        )
        if (answer === 'Clear All') {
          this.cachedTimelineSessionId = null
          this.cachedTimelineTurns = 0
          this.cachedTurnInputTokens = []
          vscode.commands.executeCommand('traceRoost.clearSessions')
        }
      }
    })

    let pendingRefresh: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      if (pendingRefresh) return
      pendingRefresh = setTimeout(() => { pendingRefresh = undefined; this.refresh() }, 300)
    }
    const updateDisposable = this.repo.onUpdate(scheduleRefresh)
    const interval = setInterval(() => this.refresh(), 5000)
    webviewView.onDidDispose(() => {
      clearInterval(interval)
      if (pendingRefresh) clearTimeout(pendingRefresh)
      updateDisposable.dispose()
      msgDisposable.dispose()
    })
  }

  setAgentFilter(_value: string) { /* no-op */ }
  setSessionLimit(_value: number) { /* no-op */ }

  refresh() {
    if (!this.view) return
    const all = this.repo.listSessions()
    const sessionCount = all.length
    const activity = this.getLastActivity()

    const AGENT_ORDER = ['copilot', 'claude_code', 'codex']
    const agentSources = [...new Set(all.map(s => s.source).filter(s => AGENT_ORDER.includes(s as string)))]
      .sort((a, b) => AGENT_ORDER.indexOf(a) - AGENT_ORDER.indexOf(b))

    const latest = all.length > 0 ? all[0] : null

    // Per-type averages for independent bar scaling
    const { avgInputTokens, avgOutputTokens } = tokenAverages(all)

    // Burn rate for the current session — use latest if the session is active
    const burnRateResult = activity.isActive && latest
      ? this.repo.queryBurnRate(latest.sessionId)
      : null

    // Timeline cache — reload only when session changes or turn count grows
    let turnInputTokens = this.cachedTurnInputTokens
    if (latest) {
      const llmTurns = latest.totalLlmCalls
      if (latest.sessionId !== this.cachedTimelineSessionId || llmTurns > this.cachedTimelineTurns) {
        try {
          const entries = this.repo.loadSessionTimeline(latest.sessionId)
          turnInputTokens = entries
            .filter(e => e.type === 'llm' && (e.inputTokens ?? 0) > 0)
            .map(e => e.inputTokens ?? 0)
          this.cachedTimelineSessionId = latest.sessionId
          this.cachedTimelineTurns = llmTurns
          this.cachedTurnInputTokens = turnInputTokens
        } catch {
          turnInputTokens = this.cachedTurnInputTokens
        }
      }
    }

    const currentSession = latest ? {
      source: latest.source,
      model: latest.model || '',
      userRequest: latest.userRequest || '',
      totalLlmCalls: latest.totalLlmCalls,
      totalToolCalls: latest.totalToolCalls,
      errors: latest.errors,
      cacheHitRate: latest.cacheHitRate,
      durationMs: latest.durationMs,
      startTime: latest.startTime,
      turnInputTokens,
      inputTokens: latest.inputTokens,
      outputTokens: latest.outputTokens,
      cacheReadTokens: latest.cacheReadTokens,
      cacheCreateTokens: latest.cacheCreateTokens,
      costUsd: calcTokenCostUsd(Math.max(0, latest.inputTokens - latest.cacheReadTokens - latest.cacheCreateTokens), latest.cacheReadTokens, latest.cacheCreateTokens, latest.outputTokens, latest.model),
    } : null

    this.view.webview.postMessage({
      type: 'update',
      isActive: activity.isActive,
      lastActivityMs: activity.lastMs,
      sessionCount,
      agentSources,
      currentSession,
      avgInputTokens,
      avgOutputTokens,
      burnRate: burnRateResult ? {
        tokensPerMinute: Math.round(burnRateResult.burnRate.tokensPerMinute),
        costPerHour: burnRateResult.burnRate.costPerHour,
      } : null,
    })
  }

  private getLastActivity(): { isActive: boolean; lastMs: number } {
    const spans: Span[] = this.repo.store_.getSpans()
    let lastMs = 0
    for (const span of spans) {
      const name = span.name || ''
      // Only count spans that belong to actual agent sessions — ignore background
      // noise like copilotLanguageModelWrapper calls and other orphan spans.
      const isAgentSpan =
        name === 'claude_code.interaction' ||
        name === 'claude_code.llm_request' ||
        name === 'claude_code.tool' ||
        name.startsWith('invoke_agent') ||
        name.startsWith('codex.turn') ||
        name.startsWith('codex.session')
      if (!isAgentSpan) continue
      const ms = span.receivedAt ?? nanoToMs(span.endTime)
      if (ms > lastMs) lastMs = ms
    }
    // 45s window: long enough to cover slow LLM responses without flickering off
    // mid-session, short enough to clear once a session actually ends.
    const isActive = lastMs > 0 && (Date.now() - lastMs) < 45_000
    return { isActive, lastMs }
  }

  private getHtml(webview: vscode.Webview): string {
    const activity = this.getLastActivity()
    const all = this.repo.listSessions()
    const latest = all.length > 0 ? all[0] : null

    const AGENT_ORDER = ['copilot', 'claude_code', 'codex']
    const agentSources = [...new Set(all.map(s => s.source).filter(s => AGENT_ORDER.includes(s as string)))]
      .sort((a, b) => AGENT_ORDER.indexOf(a) - AGENT_ORDER.indexOf(b))

    const recentCutoff = Date.now() - 2 * 60_000
    const activeSession = all.find(s => Date.parse(s.startTime) > recentCutoff)
    const burnRateResult = activeSession ? this.repo.queryBurnRate(activeSession.sessionId) : null

    let turnInputTokens: number[] = []
    if (latest) {
      try {
        const entries = this.repo.loadSessionTimeline(latest.sessionId)
        turnInputTokens = entries
          .filter(e => e.type === 'llm' && (e.inputTokens ?? 0) > 0)
          .map(e => e.inputTokens ?? 0)
        this.cachedTimelineSessionId = latest.sessionId
        this.cachedTimelineTurns = latest.totalLlmCalls
        this.cachedTurnInputTokens = turnInputTokens
      } catch { /* empty timeline */ }
    }

    const currentSession = latest ? {
      source: latest.source,
      model: latest.model || '',
      userRequest: latest.userRequest || '',
      totalLlmCalls: latest.totalLlmCalls,
      totalToolCalls: latest.totalToolCalls,
      errors: latest.errors,
      cacheHitRate: latest.cacheHitRate,
      durationMs: latest.durationMs,
      startTime: latest.startTime,
      turnInputTokens,
      inputTokens: latest.inputTokens,
      outputTokens: latest.outputTokens,
      cacheReadTokens: latest.cacheReadTokens,
      cacheCreateTokens: latest.cacheCreateTokens,
      costUsd: calcTokenCostUsd(Math.max(0, latest.inputTokens - latest.cacheReadTokens - latest.cacheCreateTokens), latest.cacheReadTokens, latest.cacheCreateTokens, latest.outputTokens, latest.model),
    } : null

    const burnRate = burnRateResult ? {
      tokensPerMinute: Math.round(burnRateResult.burnRate.tokensPerMinute),
      costPerHour: burnRateResult.burnRate.costPerHour,
    } : null

    const { avgInputTokens, avgOutputTokens } = tokenAverages(all)

    const initData = JSON.stringify({
      lastActivityMs: activity.lastMs,
      agentSources,
      sessionCount: all.length,
      isActive: activity.isActive,
      currentSession,
      burnRate,
      avgInputTokens,
      avgOutputTokens,
    })

    const sidebarJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.js')
    )

    return `<!DOCTYPE html>
<html>
<head>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    padding: 8px 8px 0;
    margin: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .sb-body { flex: 1 1 auto; overflow-y: auto; }
  .sb-card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 8px 10px;
    margin-bottom: 6px;
  }
  .sb-section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
  }
  .sb-row { display: flex; align-items: center; gap: 6px; }
  .sb-dot {
    display: inline-block; width: 8px; height: 8px;
    border-radius: 50%; flex-shrink: 0;
  }
  .sb-dot.active { background: #56D364; animation: pulse 1.5s ease-in-out infinite; }
  .sb-dot.idle { background: var(--vscode-descriptionForeground); opacity: 0.5; }
  @keyframes pulse { 0%,100% { opacity:1;transform:scale(1); } 50% { opacity:0.5;transform:scale(1.4); } }
  .sb-status { font-size: 12px; font-weight: 600; }
  .sb-muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .sb-prompt {
    font-size: 10px;
    color: var(--vscode-foreground);
    opacity: 0.8;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin: 3px 0 2px;
    font-style: italic;
  }
  .sb-model { font-size: 10px; color: var(--vscode-textLink-foreground); margin-bottom: 4px; }
  canvas { display: block; width: 100%; height: 80px; }
  .sb-turn-label { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
  .sb-burn { font-size: 12px; font-weight: 600; color: var(--vscode-charts-green, #81c784); }
  .sb-counters {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 4px; text-align: center;
  }
  .sb-counter-val { font-size: 16px; font-weight: 700; color: var(--vscode-textLink-foreground); }
  .sb-counter-key { font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.3px; }
  .sb-open-btn {
    display: block; width: 100%; padding: 7px 10px;
    font-size: 12px; font-weight: 600; text-align: center; cursor: pointer;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none; border-radius: 4px; margin-bottom: 6px;
  }
  .sb-open-btn:hover { background: var(--vscode-button-hoverBackground); }
  .sb-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 0 8px; font-size: 11px;
    color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--vscode-panel-border);
    margin-top: 4px;
  }
  .sb-error-banner {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    color: var(--vscode-inputValidation-errorForeground, #f48771);
    padding: 8px 10px; margin-bottom: 8px; border-radius: 4px;
    font-size: 11px; line-height: 1.4;
  }
  .sb-live-header {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground); font-weight: 600;
    padding-bottom: 6px; margin-bottom: 2px;
  }
</style>
</head>
<body>
  ${this.collectorError ? `
  <div class="sb-error-banner" id="sb-err-banner">
    <div style="font-weight:600;margin-bottom:3px">&#9888; Collector not running</div>
    <div>${this.collectorError}</div>
    <button onclick="document.getElementById('sb-err-banner').remove()"
      style="margin-top:6px;font-size:10px;padding:2px 8px;cursor:pointer;background:transparent;border:1px solid currentColor;border-radius:3px;color:inherit">Dismiss</button>
  </div>` : ''}

  <div class="sb-body">

    <div class="sb-live-header" title="Updates live as the current agent session progresses">Live &middot; Current Session Activity</div>

    <!-- Status row -->
    <div class="sb-card" style="margin-bottom:6px">
      <div class="sb-row" style="margin-bottom:2px">
        <span class="sb-dot ${activity.isActive ? 'active' : 'idle'}" id="sb-dot"></span>
        <span class="sb-status" id="sb-status-text">${activity.isActive ? 'Active' : 'Idle'}</span>

        <span style="flex:1"></span>
        <span id="sb-agent" class="sb-muted" style="display:flex;align-items:center"></span>
        <span id="sb-dur" class="sb-muted"></span>
      </div>
      <div id="sb-prompt" class="sb-prompt"></div>
      <div id="sb-model" class="sb-model"></div>
      <span id="sb-ago" class="sb-muted" style="font-size:10px"></span>
    </div>

    <!-- Session block (hidden when no sessions) -->
    <div id="sb-session-block" style="display:none">

      <!-- Key counters (shown first) -->
      <div class="sb-card">
        <div class="sb-counters">
          <div>
            <div class="sb-counter-val" id="sb-turns">—</div>
            <div class="sb-counter-key">Turns</div>
          </div>
          <div>
            <div class="sb-counter-val" id="sb-tools">—</div>
            <div class="sb-counter-key">Tools</div>
          </div>
          <div>
            <div class="sb-counter-val" id="sb-errors">—</div>
            <div class="sb-counter-key">Errors</div>
          </div>
          <div>
            <div class="sb-counter-val" id="sb-cache">—</div>
            <div class="sb-counter-key">Cache</div>
          </div>
        </div>
      </div>

      <!-- Context growth sparkline -->
      <div class="sb-card">
        <div class="sb-section-label">Context Growth</div>
        <canvas id="sb-sparkline"></canvas>
        <div id="sb-turn-label" class="sb-turn-label"></div>
        <div id="sb-sparkline-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic;padding:2px 0">Waiting for data…</div>
      </div>

      <!-- Token breakdown (input / output) -->
      <div class="sb-card" id="sb-tokens-card">
        <div class="sb-section-label">Tokens</div>
        <div id="sb-token-bars" style="margin-top:4px"></div>
        <div id="sb-token-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic;padding:2px 0">Waiting for data…</div>
      </div>

      <!-- Estimated cost -->
      <div class="sb-card" id="sb-cost-card">
        <div class="sb-section-label">Estimated Cost</div>
        <div id="sb-cost-val" style="font-size:16px;font-weight:700;color:var(--vscode-charts-green,#81c784)">—</div>
      </div>

      <!-- Burn rate -->
      <div class="sb-card" id="sb-burn-row">
        <div class="sb-section-label">Burn Rate</div>
        <div id="sb-burn" class="sb-burn"></div>
        <div id="sb-burn-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic">Waiting for data…</div>
      </div>

    </div>

    <!-- Empty state (shown by render() when currentSession is null) -->
    <div id="sb-empty" class="sb-muted" style="text-align:center;padding:24px 0;font-size:11px;display:none">
      No sessions recorded yet
    </div>

    <!-- Open dashboard -->
    <button class="sb-open-btn" id="sb-open-btn">Open Dashboard</button>

  </div>

  <!-- Footer -->
  <div class="sb-footer">
    <span><span id="sb-session-count">0</span> sessions stored</span>
  </div>

  <script>var __SIDEBAR_INIT__ = ${initData};</script>
  <script src="${sidebarJsUri}"></script>
</body>
</html>`
  }
}
