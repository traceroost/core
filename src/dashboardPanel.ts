import * as vscode from 'vscode'
import { SidebarPanel } from './sidebarPanel'
import { SessionRepository } from './sessionRepository'
import { InstructionRepository } from './database/instructionRepository'
import { detectInstructionFiles, appendSuggestion, removeSuggestion } from './instructionFiles'
import { computeBaseline } from './instructionEffectiveness'
import { autoConfigureCopilot, autoConfigureClaudeCode, autoConfigureCodex } from './autoConfig'
import { serializeExport, exportFileExtension, type ExportFormat } from './exportFormats'
import { classifySessionOutcome, type GitOutcome } from './gitOutcome'
import { detectSessionRiskSignals } from './sessionRiskSignals'
import { temperLoopSignalSeverity } from './loopDetector'
import { handleTeamMessage } from './cloud/team/panelController'
import { buildPayloadPreviewText } from './cloud/team/payloadPreview'
import { buildLocalTurnoverReport } from './cloud/turnover/localReport'
import { maybeEnqueueInstructionTelemetry, type SuggestionLedger } from './cloud/team/instructionTelemetry'
import { drainForwardQueueSoon } from './cloud/forward/scheduler'

/** The sql.js surface the turnover report needs for its caches. */
export interface TurnoverDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'json' || value === 'csv' || value === 'markdown'
}

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined
  private readonly panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []
  private pendingUpdate: ReturnType<typeof setTimeout> | undefined
  // On-demand, computed once per session per panel lifetime — see gitOutcome.ts for why this
  // isn't computed eagerly for every loaded session.
  private gitOutcomeCache = new Map<string, GitOutcome | null>()

  static show(context: vscode.ExtensionContext, repo: SessionRepository, sidebarProvider?: SidebarPanel, instructionRepo?: InstructionRepository, rawDb?: TurnoverDb) {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal()
      DashboardPanel.currentPanel.update()
      return
    }
    const panel = vscode.window.createWebviewPanel(
      'agentLens.fullDashboard',
      'AgentLens Dashboard',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    )
    DashboardPanel.currentPanel = new DashboardPanel(panel, context, repo, sidebarProvider, instructionRepo, rawDb)
  }

  static setRepository(repo: SessionRepository) {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.repo = repo
      DashboardPanel.currentPanel.update()
    }
  }

  static switchToTab(tab: string) {
    DashboardPanel.currentPanel?.panel.webview.postMessage({ type: 'switchTab', tab })
  }

  /** Post an arbitrary message to this panel's webview (deep-link handlers). */
  postToWebview(message: Record<string, unknown>) {
    void this.panel.webview.postMessage(message)
  }

  static sendFilter(agentFilter?: string, sessionLimit?: number) {
    DashboardPanel.currentPanel?.panel.webview.postMessage({ type: 'setFilter', agentFilter, sessionLimit })
  }

  static disposePanel() {
    DashboardPanel.currentPanel?.dispose()
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private repo: SessionRepository,
    private sidebarProvider?: SidebarPanel,
    private instructionRepo?: InstructionRepository,
    private rawDb?: TurnoverDb,
  ) {
    this.panel = panel
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.html = this.getHtml()

    this.panel.webview.onDidReceiveMessage(async msg => {
      if (typeof msg.type === 'string' && msg.type.startsWith('team')) {
        await handleTeamMessage(msg, {
          post: (m) => { void this.panel.webview.postMessage(m) },
          openExternal: (url) => { void vscode.env.openExternal(vscode.Uri.parse(url)) },
          recentSessions: () => this.repo.listSessions({ limit: 25 }),
          buildPayloadPreview: (session) => buildPayloadPreviewText(session),
          onOpenTeamView: () => { void vscode.env.openExternal(vscode.Uri.parse('https://app.agentlens.dev')) },
        })
        return
      }
      if (msg.type === 'getOutcomes') {
        try {
          const report = await buildLocalTurnoverReport(this.repo.listSessions(), { db: this.rawDb })
          this.panel.webview.postMessage({ type: 'outcomesReport', report })
        } catch (err) {
          this.panel.webview.postMessage({ type: 'outcomesReport', report: { repos: [], hasMeasurableCohort: false, generatedAt: new Date().toISOString(), error: String(err) } })
        }
        return
      }
      if (msg.type === 'loadSessionDetail' && msg.sessionId) {
        const timeline = this.repo.loadSessionTimeline(msg.sessionId as string)
        this.panel.webview.postMessage({ type: 'sessionDetail', sessionId: msg.sessionId, timeline })
      } else if (msg.type === 'getGitOutcome' && msg.sessionId) {
        void this.sendGitOutcome(
          msg.sessionId as string,
          (msg.workspace as string) || '',
          Array.isArray(msg.filesChanged) ? msg.filesChanged as string[] : [],
          (msg.startTime as string) || '',
          (msg.endTime as string) || '',
        )
      } else if (msg.type === 'loadBlob' && msg.spanId && msg.field) {
        const content = await this.repo.loadBlob(
          msg.spanId as string,
          msg.field as 'response' | 'thinking' | 'tool-input' | 'full-result' | 'edit-old' | 'edit-new',
          msg.editIndex as number | undefined,
        )
        this.panel.webview.postMessage({ type: 'blobContent', spanId: msg.spanId, field: msg.field, content })
      } else if (msg.type === 'askAI' && msg.prompt) {
        const prompt = `The following efficiency issue was detected in my AI coding session. Help me fix it:\n\n${msg.prompt}`
        openAIChat(prompt, msg.agent)
      } else if (msg.type === 'alert' && msg.label) {
        handleAlertNotification(msg as { label: string; detail?: string; severity: string }, context, repo, sidebarProvider)
      } else if (msg.type === 'automation' && msg.prompt) {
        handleAutomation(msg as { label: string; writePromptsFile: boolean; agent: string; sessionTitle: string; prompt: string })
      } else if (msg.type === 'openFile' && msg.filePath) {
        const uri = vscode.Uri.file(msg.filePath)
        vscode.window.showTextDocument(uri, { preview: true }).then(undefined, () => {
          vscode.window.showWarningMessage(`Could not open file: ${msg.filePath}`)
        })
      } else if (msg.type === 'agentFilterChanged' && this.sidebarProvider) {
        this.sidebarProvider.setAgentFilter(msg.value || 'all')
      } else if (msg.type === 'searchSessions' && msg.query) {
        const result = this.repo.searchSessions(msg.query as import('./sessionRepository').SearchQuery)
        this.panel.webview.postMessage({
          type: 'searchResults',
          sessions: result.sessions,
          totalCount: result.totalCount,
          offset: (msg.query as { offset?: number }).offset ?? 0,
          context: (msg as { context?: string }).context ?? 'search',
        })
      } else if (msg.type === 'importSessionData' && Array.isArray(msg.sessions)) {
        void this.importSessions(msg.sessions as Record<string, unknown>[])
      } else if (msg.type === 'exportSessionData' || msg.type === 'exportSessionDataRedacted') {
        const redact = msg.type === 'exportSessionDataRedacted'
        const ids = Array.isArray(msg.sessionIds) ? new Set(msg.sessionIds as string[]) : null
        const format = isExportFormat(msg.format) ? msg.format : 'json'
        void this.exportSessions(redact, ids, format)
      } else if (msg.type === 'openSidebar') {
        vscode.commands.executeCommand('workbench.view.extension.agent-lens')
      } else if (msg.type === 'closeSidebar') {
        vscode.commands.executeCommand('workbench.action.closeSidebar')
      } else if (msg.type === 'confirmClear') {
        const answer = await vscode.window.showWarningMessage(
          'Clear all AgentLens data? OTEL session data is deleted permanently. AgentLens log cache is cleared and will be rebuilt from your local agent log files (the log files themselves are not deleted).',
          { modal: true },
          'Clear All'
        )
        if (answer === 'Clear All') {
          vscode.commands.executeCommand('agentLens.clearSessions')
        }
      } else if (msg.type === 'setVsCodeConfig' && typeof msg.key === 'string') {
        void vscode.workspace.getConfiguration('agentLens').update(msg.key as string, msg.value, vscode.ConfigurationTarget.Global)
      } else if (msg.type === 'reconfigureOtel') {
        const port = vscode.workspace.getConfiguration('agentLens').get<number>('otlpPort', 4318)
        const [copilot, claudeCode, codex] = await Promise.all([
          autoConfigureCopilot(port),
          autoConfigureClaudeCode(port),
          autoConfigureCodex(port),
        ])
        this.panel.webview.postMessage({ type: 'reconfigureOtelResult', results: { copilot, claudeCode, codex } })
      } else if (msg.type === 'getInstructionFiles' && msg.workspace) {
        const wsFolders = vscode.workspace.workspaceFolders
        const wsRoot = (wsFolders?.[0]?.uri.fsPath) ?? (msg.workspace as string)
        const files = detectInstructionFiles(wsRoot)
        this.panel.webview.postMessage({ type: 'instructionFiles', files })
      } else if (msg.type === 'getAppliedSuggestions' && msg.workspace && this.instructionRepo) {
        const records = this.instructionRepo.getApplied(msg.workspace as string)
        this.panel.webview.postMessage({ type: 'appliedSuggestions', records })
      } else if (msg.type === 'getDismissedSuggestions' && msg.workspace && this.instructionRepo) {
        const ids = this.instructionRepo.getDismissedIds(msg.workspace as string)
        this.panel.webview.postMessage({ type: 'dismissedSuggestions', ids })
      } else if (msg.type === 'applyInstructionSuggestion' && msg.id && msg.workspace && this.instructionRepo) {
        const { id, workspace, targetFile, appliedText, category, title, suggestedText } = msg as {
          id: string; workspace: string; targetFile: string; appliedText: string
          category: string; title: string; suggestedText: string
        }
        const wsFolders = vscode.workspace.workspaceFolders
        const wsRoot = wsFolders?.[0]?.uri.fsPath ?? workspace
        const absPath = require('path').join(wsRoot, targetFile)
        try {
          appendSuggestion(absPath, appliedText, id)
          const sessions = this.repo.listSessions().filter(s => (s.workspace ?? '') === workspace)
          const baseline = computeBaseline(sessions, Date.now())
          this.instructionRepo.recordApplied({
            id, workspace, category, title, suggestedText,
            appliedTo: targetFile, appliedText,
            baselineCostAvg: baseline.costAvg,
            baselineTurnsAvg: baseline.turnsAvg,
            baselineErrorRate: baseline.errorRate,
            baselineLoopRate: baseline.loopRate,
            baselineInsufficient: baseline.insufficient,
          })
          const records = this.instructionRepo.getApplied(workspace)
          this.panel.webview.postMessage({ type: 'appliedSuggestions', records })
          this.panel.webview.postMessage({ type: 'instructionApplied', id })
          this.emitInstructionTelemetry(workspace)
        } catch (err) {
          vscode.window.showErrorMessage(`AgentLens: Failed to apply suggestion — ${err}`)
        }
      } else if (msg.type === 'dismissInstructionSuggestion' && msg.id && msg.workspace && this.instructionRepo) {
        this.instructionRepo.recordDismissed(msg.id as string, msg.workspace as string)
        this.emitInstructionTelemetry(msg.workspace as string)
      } else if (msg.type === 'removeInstructionSuggestion' && msg.id && msg.workspace && this.instructionRepo) {
        const { id, workspace } = msg as { id: string; workspace: string }
        const applied = this.instructionRepo.getApplied(workspace).find(a => a.id === id)
        if (applied) {
          const wsFolders = vscode.workspace.workspaceFolders
          const wsRoot = wsFolders?.[0]?.uri.fsPath ?? workspace
          const absPath = require('path').join(wsRoot, applied.appliedTo)
          removeSuggestion(absPath, id)
          this.instructionRepo.removeApplied(id)
          const records = this.instructionRepo.getApplied(workspace)
          this.panel.webview.postMessage({ type: 'appliedSuggestions', records })
          this.emitInstructionTelemetry(workspace)
        }
      }
    }, null, this.disposables)

    const pushDisposable = repo.onUpdate(() => this.scheduleUpdate())
    this.disposables.push(pushDisposable)
    const interval = setInterval(() => this.update(), 10000)
    this.disposables.push({ dispose: () => clearInterval(interval) })

    // First-run routing (AL 07): if a turnover cohort is measurable and Outcomes has never been
    // shown, open on it — it is the free tier's activation event. Computed off the activation
    // path so it never blocks the panel.
    void this.maybeRouteToOutcomes()
  }

  /** Builds an instruction-telemetry rollup for `workspace` and queues it — a hard no-op unless
   *  a team is linked. Called after any apply / dismiss / revert so the pooled evidence stays
   *  current (AL 08). */
  private emitInstructionTelemetry(workspace: string): void {
    if (!this.instructionRepo) return
    const applied = this.instructionRepo.getApplied(workspace)
    const dismissedIds = this.instructionRepo.getDismissedIds(workspace)
    const ledger: SuggestionLedger = {
      applied: applied.map(a => ({
        id: a.id,
        atIso: a.appliedAt || new Date().toISOString(),
        card: { id: a.id, category: a.category as 'context' | 'behavior' | 'prompting' },
      })),
      dismissed: dismissedIds.map(id => ({ id, atIso: new Date().toISOString() })),
      reverted: [],
    }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? workspace
    void maybeEnqueueInstructionTelemetry(wsRoot, this.repo.listSessions(), ledger)
      .then(enqueued => { if (enqueued) drainForwardQueueSoon() })
      .catch(() => { /* telemetry is best-effort */ })
  }

  private async maybeRouteToOutcomes(): Promise<void> {
    const SHOWN_KEY = 'agentLens.outcomesFirstRunShown'
    if (this.context.globalState.get<boolean>(SHOWN_KEY)) return
    try {
      const report = await buildLocalTurnoverReport(this.repo.listSessions(), { db: this.rawDb })
      if (report.hasMeasurableCohort) {
        await this.context.globalState.update(SHOWN_KEY, true)
        this.panel.webview.postMessage({ type: 'outcomesReport', report })
        this.panel.webview.postMessage({ type: 'switchTab', tab: 'outcomes' })
      }
    } catch { /* first-run nicety only */ }
  }

  private scheduleUpdate() {
    if (this.pendingUpdate) { return }
    this.pendingUpdate = setTimeout(() => {
      this.pendingUpdate = undefined
      this.update()
    }, 300)
  }

  update() {
    const sessions = this.repo.listSessions()
    const summary = this.repo.store_.getSummary()
    const sessionSummary = sessions.length > 0
      ? { sessions, backgroundSpans: [], efficiency: buildEfficiency(sessions) }
      : null

    // Analytics data: 7-day hourly stats + lifetime totals.
    const since7d = Date.now() - 7 * 86_400_000
    const dailyStats = this.repo.queryHourlyStats({ since: since7d })
    const lifetimeStats = this.repo.queryLifetimeStats()

    // Burn rate for the most recently updated live session (< 2 min old).
    const recentCutoff = Date.now() - 2 * 60_000
    const activeSession = sessions.find(s => Date.parse(s.startTime) > recentCutoff)
    const burnRateResult = activeSession
      ? this.repo.queryBurnRate(activeSession.sessionId)
      : null

    const cfg = vscode.workspace.getConfiguration('agentLens')
    this.panel.webview.postMessage({
      type: 'update',
      summary,
      sessionSummary,
      analyticsData: { dailyStats, lifetimeStats },
      burnRate: burnRateResult
        ? { sessionId: activeSession!.sessionId, ...burnRateResult }
        : null,
      enableOtelIngestion: cfg.get<boolean>('enableOtelIngestion', true),
      enableLogIngestion: cfg.get<boolean>('enableLogIngestion', true),
      otlpPort: cfg.get<number>('otlpPort', 4318),
    })
  }

  private async importSessions(rawSessions: Record<string, unknown>[]): Promise<void> {
    try {
      const existing = new Set(this.repo.listSessions().map(s => s.sessionId))
      const BATCH = 50
      let imported = 0
      let skipped = 0
      const total = rawSessions.length

      for (let i = 0; i < rawSessions.length; i += BATCH) {
        const batch = rawSessions.slice(i, i + BATCH)
        const cards: SessionSummaryCard[] = []
        for (const raw of batch) {
          const id = raw['sessionId'] as string
          if (existing.has(id)) { skipped++; continue }
          existing.add(id)
          cards.push(buildImportCard(raw))
          imported++
        }
        if (cards.length > 0) {
          this.repo.importCards(cards)
        }
        this.panel.webview.postMessage({ type: 'importProgress', imported, total, skipped })
        // Yield between batches so the webview can render progress and other
        // tasks (log reader, OTEL) can run without starving the event loop.
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }

      this.panel.webview.postMessage({ type: 'importDone', imported, skipped, failed: 0, total })
      this.update()
      this.sidebarProvider?.refresh()
    } catch (err) {
      this.panel.webview.postMessage({ type: 'importError', message: String(err) })
    }
  }

  private async sendGitOutcome(sessionId: string, workspace: string, filesChanged: string[], startTime: string, endTime: string): Promise<void> {
    let outcome: GitOutcome | null
    if (this.gitOutcomeCache.has(sessionId)) {
      outcome = this.gitOutcomeCache.get(sessionId) ?? null
    } else {
      outcome = await classifySessionOutcome(workspace, filesChanged, startTime, endTime)
      this.gitOutcomeCache.set(sessionId, outcome)
    }
    // Post-hoc risk signals (hallucinated import, submitted-despite-a-failing-check) and
    // re-tempered loop-signal severity are both only knowable once the session's outcome is
    // known, same lifecycle as git-outcome classification — computed here rather than eagerly
    // for every session. See sessionRiskSignals.ts and temperLoopSignalSeverity's docstring.
    const card = this.repo.listSessions().find(s => s.sessionId === sessionId) ?? null
    const riskSignals = card ? detectSessionRiskSignals(card, workspace) : []
    const temperedLoopSignals = card ? temperLoopSignalSeverity(card.loopSignals ?? [], outcome) : null
    this.panel.webview.postMessage({ type: 'gitOutcome', sessionId, outcome, riskSignals, temperedLoopSignals })
  }

  private async exportSessions(redact: boolean, ids: Set<string> | null = null, format: ExportFormat = 'json'): Promise<void> {
    const all = this.repo.listSessions()
    const sessions = ids ? all.filter(s => ids.has(s.sessionId)) : all
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('AgentLens: No session data to export')
      return
    }

    const exportable = sessions.map(s => {
      const base = {
        sessionId:        s.sessionId,
        traceId:          s.traceId,
        source:           s.source,
        dataSource:       s.dataSource ?? 'otel',
        model:            s.model,
        models:           s.models ?? [s.model],
        startTime:        s.startTime,
        durationMs:       s.durationMs,
        turns:            s.totalLlmCalls,
        totalToolCalls:   s.totalToolCalls,
        inputTokens:      s.inputTokens,
        outputTokens:     s.outputTokens,
        cacheReadTokens:  s.cacheReadTokens,
        cacheCreateTokens: s.cacheCreateTokens,
        cacheHitRate:     s.cacheHitRate,
        errors:           s.errors,
        outcome:          s.outcome,
        toolCounts:       s.toolCounts,
        filesRead:        s.filesRead,
        filesChanged:     s.filesChanged,
        loopSignals:      s.loopSignals,
      }
      if (redact) return {
        ...base,
        userRequest:  '[redacted]',
        filesRead:    (s.filesRead    ?? []).map(() => '[redacted]'),
        filesChanged: (s.filesChanged ?? []).map(() => '[redacted]'),
      }
      return { ...base, userRequest: s.userRequest }
    })

    const now = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const prefix = redact ? 'export_redacted' : 'export'
    const filename = `${prefix}_sessions_${ts}.${exportFileExtension(format)}`

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    const baseUri = workspaceFolder ? workspaceFolder.uri : this.context.globalStorageUri
    const fileUri = vscode.Uri.joinPath(baseUri, filename)

    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(serializeExport(exportable, format)))
    vscode.window.showInformationMessage(`AgentLens: Exported ${sessions.length} sessions to ${filename}`)
    const doc = await vscode.workspace.openTextDocument(fileUri)
    vscode.window.showTextDocument(doc, { preview: false })
  }

  private dispose() {
    DashboardPanel.currentPanel = undefined
    if (this.pendingUpdate) { clearTimeout(this.pendingUpdate); this.pendingUpdate = undefined }
    this.panel.dispose()
    this.disposables.forEach(d => d.dispose())
  }

  private getWebviewUri(filename: string): vscode.Uri {
    return this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', filename)
    )
  }

  private getHtml(): string {
    const summary = this.repo.store_.getSummary()
    const cssUri = this.getWebviewUri('dashboard.css')
    const jsUri = this.getWebviewUri('dashboard.js')
    const mascotUri = this.getWebviewUri('help-mascot.png')
    const nonce = getNonce()

    const sessions = this.repo.listSessions()
    const sessionSummary = sessions.length > 0
      ? { sessions, backgroundSpans: [], efficiency: buildEfficiency(sessions) }
      : null

    const mcpEnabled = vscode.workspace.getConfiguration('agentLens').get<boolean>('enableMcpServer', true)
    const mcpPort    = vscode.workspace.getConfiguration('agentLens').get<number>('mcpPort', 4316)

    const initialData = `<script nonce="${nonce}">
        window.__INITIAL_TOOL_CALLS__ = ${safeJsonForScript(summary.toolCalls)};
        window.__INITIAL_SESSION_SUMMARY__ = ${safeJsonForScript(sessionSummary)};
        window.__MASCOT_URI__ = ${safeJsonForScript(mascotUri.toString())};
        window.__VERSION__ = ${safeJsonForScript(this.context.extension.packageJSON.version)};
        window.__MCP_ENABLED__ = ${mcpEnabled};
        window.__MCP_PORT__ = ${mcpPort};
      </script>`

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${this.panel.webview.cspSource}; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${this.panel.webview.cspSource};">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  ${initialData}
  <div id="app"></div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`
  }
}

// ── Import helper ─────────────────────────────────────────────────────────────

import type { SessionSummaryCard } from './summarizers/summarizerTypes'

function buildImportCard(raw: Record<string, unknown>): SessionSummaryCard {
  const num = (v: unknown, def = 0): number => (typeof v === 'number' ? v : def)
  const str = (v: unknown, def = ''): string => (typeof v === 'string' ? v : def)
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') as string[] : [])
  return {
    sessionId:       str(raw['sessionId']),
    traceId:         str(raw['traceId']),
    source:          (raw['source'] as SessionSummaryCard['source']) ?? 'claude_code',
    dataSource:      'log',
    workspace:       str(raw['workspace']),
    userRequest:     str(raw['userRequest']),
    model:           str(raw['model']),
    turns:           num(raw['turns']),
    totalLlmCalls:   num(raw['turns']),
    totalToolCalls:  num(raw['totalToolCalls']),
    inputTokens:     num(raw['inputTokens']),
    outputTokens:    num(raw['outputTokens']),
    cacheReadTokens: num(raw['cacheReadTokens']),
    cacheCreateTokens: num(raw['cacheCreateTokens']),
    cacheHitRate:    num(raw['cacheHitRate']),
    durationMs:      num(raw['durationMs']),
    startTime:       str(raw['startTime'], new Date().toISOString()),
    filesRead:       arr(raw['filesRead']),
    filesChanged:    arr(raw['filesChanged']),
    filesSearched:   [],
    filesWritten:    [],
    toolCounts:      (typeof raw['toolCounts'] === 'object' && raw['toolCounts'] !== null ? raw['toolCounts'] : {}) as Record<string, number>,
    errors:          num(raw['errors']),
    outcome:         (raw['outcome'] as SessionSummaryCard['outcome']) ?? 'unknown',
    timeline:        [],
    backgroundSpans: [],
    loopSignals:     Array.isArray(raw['loopSignals']) ? raw['loopSignals'] as SessionSummaryCard['loopSignals'] : [],
  }
}

// ── Efficiency stub ───────────────────────────────────────────────────────────

function buildEfficiency(sessions: SessionSummaryCard[]) {
  const totalInput = sessions.reduce((a, s) => a + s.inputTokens, 0)
  const totalOutput = sessions.reduce((a, s) => a + s.outputTokens, 0)
  const totalLlm = sessions.reduce((a, s) => a + s.totalLlmCalls, 0)
  return {
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalLlmCalls: totalLlm,
    avgInputPerCall: totalLlm > 0 ? Math.round(totalInput / totalLlm) : 0,
    avgTtft: 0,
    cacheHitRate: sessions.length > 0
      ? sessions.reduce((a, s) => a + s.cacheHitRate, 0) / sessions.length : 0,
    toolDefWaste: 0,
    sysInstructionWaste: 0,
    topTokenConsumers: [],
  }
}

// ── Alert / automation helpers (unchanged) ────────────────────────────────────

async function handleAlertNotification(
  msg: { label: string; detail?: string; severity: string },
  context: vscode.ExtensionContext,
  repo: SessionRepository,
  sidebarProvider?: SidebarPanel
): Promise<void> {
  const text = `Alert: ${msg.label}${msg.detail ? ' — ' + msg.detail : ''}`
  const clipboardPrompt = [
    "An alert was triggered in my AI coding session. Please explain what's happening and how I should respond.",
    '',
    `Alert: ${msg.label}`,
    ...(msg.detail ? [`Detail: ${msg.detail}`] : []),
  ].join('\n')

  let promise: Thenable<string | undefined>
  if (msg.severity === 'error') {
    promise = vscode.window.showErrorMessage(text, 'View Alerts', 'Copy Prompt')
  } else if (msg.severity === 'info') {
    promise = vscode.window.showInformationMessage(text, 'View Alerts', 'Copy Prompt')
  } else {
    promise = vscode.window.showWarningMessage(text, 'View Alerts', 'Copy Prompt')
  }
  promise.then(action => {
    if (action === 'View Alerts') {
      DashboardPanel.show(context, repo, sidebarProvider)
      DashboardPanel.switchToTab('alerts')
    } else if (action === 'Copy Prompt') {
      vscode.env.clipboard.writeText(clipboardPrompt).then(() => {
        vscode.window.showInformationMessage('AgentLens: Alert prompt copied — paste into your AI chat.')
      })
    }
  })
}

async function openAIChat(prompt: string, agent?: string): Promise<void> {
  const commands = await vscode.commands.getCommands(true)
  if (agent === 'copilot') {
    const cmd = ['github.copilot.chat.open', 'workbench.action.chat.open'].find(c => commands.includes(c))
    if (cmd) { vscode.commands.executeCommand(cmd, { query: prompt }); return }
  }
  await vscode.env.clipboard.writeText(prompt)
  const label = agent === 'claude_code' ? 'Claude' : agent === 'codex' ? 'Codex' : 'AI'
  vscode.window.showInformationMessage(`AgentLens: Prompt copied — paste into your ${label} session.`)
}

async function writeAutomationPrompt(agent: string, label: string, fullPrompt: string): Promise<string | undefined> {
  const agentSlug = agent === 'claude_code' ? 'claude' : agent === 'codex' ? 'codex' : 'copilot'
  const agentName = agent === 'claude_code' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Copilot'
  const filename = `agentlens-prompts-${agentSlug}.md`
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
  if (!workspaceFolder) {
    vscode.window.showWarningMessage('AgentLens: No workspace folder open — cannot write prompts file.')
    return undefined
  }
  const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filename)
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const entry = `## ${timestamp} — ${label}\n\n${fullPrompt}\n\n---\n\n`
  let existing = ''
  try {
    const data = await vscode.workspace.fs.readFile(fileUri)
    existing = Buffer.from(data).toString('utf8')
  } catch { /* file doesn't exist yet */ }
  const content = existing ? existing + entry : `# Automation Prompts — ${agentName}\n\n${entry}`
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'))
  return filename
}

async function handleAutomation(msg: { label: string; writePromptsFile: boolean; agent: string; sessionTitle: string; sessionId?: string; prompt: string }): Promise<void> {
  const agentLabel = msg.agent === 'claude_code' ? 'Claude' : msg.agent === 'copilot' ? 'Copilot' : msg.agent === 'codex' ? 'Codex' : 'AI'
  const sessionLine = msg.sessionId ? `Session ID: ${msg.sessionId}\n` : ''
  const fullPrompt = `[${msg.label}]\n\n${sessionLine}${msg.prompt}`
  if (msg.writePromptsFile) {
    const filename = await writeAutomationPrompt(msg.agent, msg.label, fullPrompt)
    if (filename) {
      vscode.window.showInformationMessage(`Automation: ${msg.label} — prompt written to ${filename}`, 'Dismiss')
    }
    return
  }

  const action = await vscode.window.showWarningMessage(
    `Automation: ${msg.label}`,
    { modal: false },
    'Copy Prompt',
    'Dismiss',
  )
  if (action === 'Copy Prompt') {
    await vscode.env.clipboard.writeText(fullPrompt)
    vscode.window.showInformationMessage(`AgentLens: Prompt copied — paste into your ${agentLabel} session.`)
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let nonce = ''
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return nonce
}

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--')
    .replace(/\$\{/g, '\\${')
}
