import * as vscode from 'vscode'
import * as path from 'path'
import { SidebarPanel } from './sidebarPanel'
import { SessionRepository } from './sessionRepository'
import { InstructionRepository } from './database/instructionRepository'
import { detectInstructionFiles, appendSuggestion, removeSuggestion } from './instructionFiles'
import { computeBaseline } from './instructionEffectiveness'
import { autoConfigureCopilot, autoConfigureClaudeCode, autoConfigureCodex } from './autoConfig'
import { serializeExport, exportFileExtension, type ExportFormat } from './exportFormats'
import { classifySessionOutcome, onRunningGitCommandsChanged, type GitOutcome } from './gitOutcome'
import { onActionLogChanged, getActionLogHistory } from './actionLog'
import { ReconciliationService, type ReconcileInput, type ReconcileResult } from './reconcile/reconciliationService'
import { detectSessionRiskSignals } from './sessionRiskSignals'
import { temperLoopSignalSeverity } from './loopDetector'
import { resolveGithubUrl } from './repoRemote'
// TraceRoost Cloud (org panel, upload) — only ever through this seam; see cloudBridge.ts.
import { cloud, type OrgPanelDeps, type SuggestionLedger } from './cloudBridge'
import { getNonce, safeJsonForScript } from './webviewHtml'
import { WebviewSessionSync } from './webviewSessionSync'
import { getPlanUsageService } from './planUsage/planUsageService'

/** The sql.js surface the turnover report needs for its caches. */
export interface TurnoverDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'json' || value === 'csv' || value === 'markdown'
}

// ── Webview message guards ───────────────────────────────────────────────────
// Messages come from a webview that renders span data (prompts, tool output) — treat their
// fields as untrusted input, not as commands the extension host obeys verbatim.

/** True when `key` (unprefixed, e.g. `enableMcpServer`) is a `traceRoost.*` setting this extension
 *  declares in package.json, and `value` has that setting's declared JSON type. */
function isDeclaredSettingUpdate(packageJSON: unknown, key: string, value: unknown): boolean {
  const contributes = (packageJSON as { contributes?: { configuration?: unknown } } | undefined)?.contributes
  const sections = Array.isArray(contributes?.configuration) ? contributes.configuration : [contributes?.configuration]
  for (const section of sections) {
    const props = (section as { properties?: Record<string, { type?: string | string[] }> } | undefined)?.properties
    const decl = props && Object.prototype.hasOwnProperty.call(props, `traceRoost.${key}`) ? props[`traceRoost.${key}`] : undefined
    if (!decl) { continue }
    const types = Array.isArray(decl.type) ? decl.type : decl.type ? [decl.type] : []
    if (types.length === 0) { return true }
    return types.some(t =>
      t === 'integer' ? Number.isInteger(value)
        : t === 'array' ? Array.isArray(value)
        : t === 'null' ? value === null
        : t === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
        : typeof value === t)
  }
  return false
}

/** `child` resolves to `parent` itself or somewhere beneath it. */
function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined
  /** The port the MCP server actually bound (set by extension.ts) — it can differ from the
   *  configured traceRoost.mcpPort when that port was busy and listenWithFallback moved on. */
  public static boundMcpPort: number | undefined
  /** Set by extension.ts when this window's own OTLP collector lost the port to the TraceRoost
   *  background service or an unrelated app — never for another VS Code window running this same
   *  extension, which shares one database by design and isn't a conflict. Read on every 'update'
   *  postMessage below so the webview shows a persistent warning banner for as long as this
   *  window isn't actually receiving OTel, rather than a one-time toast that's easy to miss or
   *  dismiss and forget about. */
  public static collectorConflict: { owner: 'standalone' | 'foreign'; port: number } | undefined
  /** Progress of extension.ts's batched log load (startBatchedLoad); null when none is running.
   *  Inlined into a panel opened mid-load and posted to an open one as it advances, so the
   *  webview shows a progress banner rather than an empty dashboard. */
  private static logIngestProgress: { done: number; total: number } | null = null
  private static lastLogIngestPostAt = 0
  private static refreshTimer: ReturnType<typeof setTimeout> | undefined
  private readonly panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []
  private pendingUpdate: ReturnType<typeof setTimeout> | undefined
  private pendingGitOutcomeResults = new Map<string, ReconcileResult>()
  private pendingGitOutcomeFlush: ReturnType<typeof setTimeout> | undefined
  // On-demand — see gitOutcome.ts for why this isn't computed eagerly for every loaded session.
  // Host-independent, and deliberately *injected* rather than constructed here: extension.ts owns
  // one instance for the whole extension-host lifetime and hands it to both this panel and the
  // background watcher, so a watcher-detected change while this panel is open reaches this
  // panel's subscription (see the constructor) instead of landing on a separate, panel-scoped
  // instance no watcher publishes to. Undefined only when the SQLite database itself failed to
  // open; sendGitOutcome falls back to an uncached, non-durable classification in that case.
  // In-flight-only dedup for the no-database fallback path — mirrors ReconciliationService's own
  // eviction discipline (deleted in `finally`, never a permanent success cache).
  private fallbackInFlight = new Map<string, Promise<GitOutcome | null>>()
  // Keyed by workspace path rather than session — there are only ever a handful of distinct
  // workspaces open at once, unlike sessions, so this is cheap to compute for every one of them.
  // `name` is the git repo root's own basename, not the (possibly-a-subfolder) workspace path —
  // see sendRepoHash for why.
  private repoInfoCache = new Map<string, { name: string; hash: string | null; githubUrl: string | null } | null>()
  // Cutoff for "still live" in update()'s burn-rate calculation — kept here rather than only in
  // reconciliationService.ts (which has its own copy for the same window, ACTIVE_GRACE_MS) since
  // this one has nothing to do with git-outcome reconciliation.
  private static readonly GIT_OUTCOME_ACTIVE_GRACE_MS = 2 * 60_000
  // What the webview already holds, so update() posts only what changed.
  private readonly sessionSync = new WebviewSessionSync()

  static show(context: vscode.ExtensionContext, repo: SessionRepository, sidebarProvider?: SidebarPanel, instructionRepo?: InstructionRepository, rawDb?: TurnoverDb, reconciliation?: ReconciliationService) {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal()
      DashboardPanel.currentPanel.update()
      return
    }
    const panel = vscode.window.createWebviewPanel(
      'traceRoost.fullDashboard',
      'TraceRoost Dashboard',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    )
    DashboardPanel.currentPanel = new DashboardPanel(panel, context, repo, sidebarProvider, instructionRepo, rawDb, reconciliation)
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

  static sendFilter(agentFilter?: string, sessionLimit?: number, workspaceFilter?: string, textFilter?: string) {
    DashboardPanel.currentPanel?.panel.webview.postMessage({ type: 'setFilter', agentFilter, sessionLimit, workspaceFilter, textFilter })
  }

  static disposePanel() {
    DashboardPanel.currentPanel?.dispose()
  }

  /** Pushes a fresh org status to the open panel, if any — call after anything that can change
   *  what it shows without the user having triggered it directly (a background forward-queue
   *  drain, in particular; see `forwardScheduler`'s `onDrainComplete` in extension.ts). A no-op,
   *  cheaply, when no panel is open. */
  static pushOrgStatus() {
    const panel = DashboardPanel.currentPanel
    if (!panel) return
    void cloud.handleOrgMessage({ type: 'getOrgStatus' }, panel.orgDeps())
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private repo: SessionRepository,
    private sidebarProvider?: SidebarPanel,
    private instructionRepo?: InstructionRepository,
    rawDb?: TurnoverDb,
    private reconciliation?: ReconciliationService,
  ) {
    this.panel = panel
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.html = this.getHtml()

    this.panel.webview.onDidReceiveMessage(async msg => {
      if (typeof msg.type === 'string' && (msg.type === 'getOrgStatus' || msg.type.startsWith('org'))) {
        try {
          await cloud.handleOrgMessage(msg, this.orgDeps())
        } catch (err) {
          // Belt-and-suspenders: individual org* cases reply on both success and failure, but if
          // one doesn't, this is what stops the webview's busy/loading state from hanging forever
          // with no error shown (see App.tsx's `orgError` handler).
          console.error('[TraceRoost] org message handler failed:', err)
          this.panel.webview.postMessage({ type: 'orgError', error: (err as Error).message })
        }
        return
      }
      if (msg.type === 'requestFullUpdate') {
        // The webview's copy no longer matches what this panel last posted (reloaded, or a post
        // was missed) — start over from a full post.
        this.sessionSync.reset()
        this.update()
      } else if (msg.type === 'loadSessionDetail' && msg.sessionId) {
        const timeline = this.repo.loadSessionTimeline(msg.sessionId as string)
        this.panel.webview.postMessage({ type: 'sessionDetail', sessionId: msg.sessionId, timeline })
      } else if (msg.type === 'getGitOutcome' && msg.sessionId) {
        this.sendGitOutcome(
          msg.sessionId as string,
          (msg.workspace as string) || '',
          Array.isArray(msg.filesChanged) ? msg.filesChanged as string[] : [],
          (msg.endTime as string) || '',
        ).catch(err => console.error('[TraceRoost] sendGitOutcome failed:', err))
      } else if (msg.type === 'getGitOutcomes' && Array.isArray(msg.sessionIds)) {
        const sessionIds = msg.sessionIds.filter((id: unknown): id is string => typeof id === 'string')
        void this.sendGitOutcomes(sessionIds)
      } else if (msg.type === 'getRepoHash' && msg.workspace) {
        void this.sendRepoHash(msg.workspace as string)
      } else if (msg.type === 'alert' && msg.label) {
        handleAlertNotification(msg as { label: string; detail?: string; severity: string; sessionId?: string }, context, repo, sidebarProvider, rawDb)
      } else if (msg.type === 'automation' && msg.prompt) {
        handleAutomation(msg as { label: string; writePromptsFile: boolean; agent: string; sessionTitle: string; prompt: string })
      } else if (msg.type === 'openFile' && typeof msg.filePath === 'string' && msg.filePath) {
        // Only files in an open workspace folder, in a workspace some recorded session ran in, or
        // in an agent's own config/log directory — never an arbitrary path the webview names.
        const home = require('os').homedir() as string
        const roots = [
          ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
          ...this.repo.listSessions().map(s => s.workspace).filter((w): w is string => typeof w === 'string' && path.isAbsolute(w)),
          path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.traceroost'),
        ]
        if (!path.isAbsolute(msg.filePath) || !roots.some(r => isPathInside(r, msg.filePath))) {
          vscode.window.showWarningMessage(`TraceRoost: Not opening ${msg.filePath} — it is outside your workspace.`)
          return
        }
        const uri = vscode.Uri.file(msg.filePath)
        vscode.window.showTextDocument(uri, { preview: true }).then(undefined, () => {
          vscode.window.showWarningMessage(`Could not open file: ${msg.filePath}`)
        })
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
        vscode.commands.executeCommand('workbench.view.extension.traceroost')
      } else if (msg.type === 'closeSidebar') {
        vscode.commands.executeCommand('workbench.action.closeSidebar')
      } else if (msg.type === 'confirmClear') {
        const answer = await vscode.window.showWarningMessage(
          'Clear all TraceRoost data? OTEL trace data is deleted permanently. TraceRoost log cache is cleared and will be rebuilt from your local agent log files (the log files themselves are not deleted).',
          { modal: true },
          'Clear All'
        )
        if (answer === 'Clear All') {
          vscode.commands.executeCommand('traceRoost.clearSessions')
        }
      } else if (msg.type === 'setVsCodeConfig' && typeof msg.key === 'string') {
        if (!isDeclaredSettingUpdate(this.context.extension.packageJSON, msg.key, msg.value)) { return }
        void vscode.workspace.getConfiguration('traceRoost').update(msg.key as string, msg.value, vscode.ConfigurationTarget.Global)
      } else if (msg.type === 'reconfigureOtel') {
        const port = vscode.workspace.getConfiguration('traceRoost').get<number>('otlpPort', 4318)
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
        const absPath = path.resolve(wsRoot, String(targetFile ?? ''))
        // targetFile names an instruction file in the workspace (CLAUDE.md, AGENTS.md, …);
        // `../../.bashrc` or an absolute path elsewhere must not become a write target.
        if (!targetFile || typeof targetFile !== 'string' || absPath === path.resolve(wsRoot) || !isPathInside(wsRoot, absPath)) {
          vscode.window.showErrorMessage(`TraceRoost: Refusing to apply suggestion — ${targetFile} is outside the workspace.`)
          return
        }
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
          vscode.window.showErrorMessage(`TraceRoost: Failed to apply suggestion — ${err}`)
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
          removeSuggestion(absPath, id, applied.appliedText)
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

    // Unsolicited pushes (staged feature 10, Stage 2): the background watcher (registered by
    // extension.ts, outside this panel's lifetime) calls reconciliation.reconcileMany() for
    // retained sessions whether or not this panel is even open. When it is, this is what makes a
    // commit/merge/edit while Traces stays open show up without navigating away and back.
    if (this.reconciliation) {
      const unsubscribe = this.reconciliation.subscribe(r => this.pushGitOutcomeResult(r))
      this.disposables.push({ dispose: unsubscribe })
    }

    // Independent of `reconciliation` — the uncached fallback path (fallbackInFlight, used when
    // the database failed to open) runs git subprocesses too, and should still surface them.
    const unsubscribeRunningCommands = onRunningGitCommandsChanged(commands => {
      this.panel.webview.postMessage({ type: 'runningGitCommands', commands })
    })
    this.disposables.push({ dispose: unsubscribeRunningCommands })

    // action-log.md: the persistent Log panel's history, pushed on every change plus once up
    // front so a freshly opened panel doesn't start blank waiting for the next action to run.
    this.panel.webview.postMessage({ type: 'actionLog', entries: getActionLogHistory() })
    const unsubscribeActionLog = onActionLogChanged(entries => {
      this.panel.webview.postMessage({ type: 'actionLog', entries })
    })
    this.disposables.push({ dispose: unsubscribeActionLog })
  }

  /** Coalesces reconciliation pushes so a large pass indexes the session list once per flush. */
  private pushGitOutcomeResult(r: ReconcileResult): void {
    this.pendingGitOutcomeResults.set(r.sessionId, r)
    if (this.pendingGitOutcomeFlush) return
    this.pendingGitOutcomeFlush = setTimeout(() => {
      this.pendingGitOutcomeFlush = undefined
      const pending = this.pendingGitOutcomeResults
      this.pendingGitOutcomeResults = new Map()
      const cards = new Map(this.repo.listSessions({ limit: Infinity }).map(card => [card.sessionId, card]))
      for (const result of pending.values()) {
        const card = cards.get(result.sessionId)
        if (!card) continue
        const riskSignals = detectSessionRiskSignals(card, card.workspace, result.outcome)
        const temperedLoopSignals = temperLoopSignalSeverity(card.loopSignals ?? [], result.outcome)
        this.panel.webview.postMessage({
          type: 'gitOutcome', sessionId: result.sessionId, outcome: result.outcome, riskSignals, temperedLoopSignals,
          revision: result.revision,
        })
      }
    }, 50)
  }

  /** Builds an instruction-telemetry rollup for `workspace` and queues it — a hard no-op unless
   *  an org is linked. Called after any apply / dismiss / revert so the pooled evidence stays
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
    void cloud.enqueueInstructionTelemetry(wsRoot, this.repo.listSessions(), ledger)
      .then(enqueued => { if (enqueued) cloud.drainUploadsSoon() })
      .catch(() => { /* telemetry is best-effort */ })
  }

  private scheduleUpdate() {
    if (this.pendingUpdate) { return }
    this.pendingUpdate = setTimeout(() => {
      this.pendingUpdate = undefined
      this.update()
    }, 300)
  }

  /** Records the batched log load's progress and forwards it to the open panel, if any —
   *  throttled, since the load advances every few milliseconds. The final null always goes out. */
  static setLogIngestProgress(progress: { done: number; total: number } | null): void {
    DashboardPanel.logIngestProgress = progress
    const current = DashboardPanel.currentPanel
    if (!current) return
    const now = Date.now()
    if (progress && now - DashboardPanel.lastLogIngestPostAt < 150) return
    DashboardPanel.lastLogIngestPostAt = now
    current.panel.webview.postMessage({ type: 'logIngest', logIngest: progress })
  }

  /** Coalesced refresh of the open panel, for writes that don't go through the span store's
   *  onUpdate — log-ingested sessions go straight to the database. */
  static refreshSoon(): void {
    if (DashboardPanel.refreshTimer) return
    // Longer than scheduleUpdate's 300 ms: each update() re-reads every session from the
    // database, and a first-run load on a large history lands a batch every few milliseconds.
    DashboardPanel.refreshTimer = setTimeout(() => {
      DashboardPanel.refreshTimer = undefined
      DashboardPanel.currentPanel?.update()
    }, 1000)
  }

  update() {
    const sessions = this.repo.listSessions()
    const summary = this.repo.store_.getSummary()

    // Analytics data: 7-day hourly stats + lifetime totals.
    const since7d = Date.now() - 7 * 86_400_000
    const dailyStats = this.repo.queryHourlyStats({ since: since7d })
    const lifetimeStats = this.repo.queryLifetimeStats()

    // Burn rate for the most recently updated live session (< 2 min old).
    const recentCutoff = Date.now() - DashboardPanel.GIT_OUTCOME_ACTIVE_GRACE_MS
    const activeSession = sessions.find(s => Date.parse(s.startTime) > recentCutoff)
    const burnRateResult = activeSession
      ? this.repo.queryBurnRate(activeSession.sessionId)
      : null

    // Only what changed since the last post — see webviewSessionSync.ts.
    const sync = this.sessionSync.next(
      sessions,
      () => buildEfficiency(sessions),
      { dailyStats, lifetimeStats },
      burnRateResult
        ? { sessionId: activeSession!.sessionId, ...burnRateResult }
        : null,
    )

    const cfg = vscode.workspace.getConfiguration('traceRoost')
    this.panel.webview.postMessage({
      type: 'update',
      summary,
      ...sync,
      enableOtelIngestion: cfg.get<boolean>('enableOtelIngestion', true),
      enableLogIngestion: cfg.get<boolean>('enableLogIngestion', true),
      otlpPort: cfg.get<number>('otlpPort', 4318),
      collectorConflict: DashboardPanel.collectorConflict ?? null,
      // The one real folder Apply/getInstructionFiles below actually act on
      // (vscode.workspace.workspaceFolders[0], same source those handlers already use) — the
      // webview has no other way to know it, and it is not the same thing as the Repo toolbar's
      // freeform search box (workspaceFilter), which can match any historical repo's sessions.
      currentWorkspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    })
    this.postPlanUsage(sessions)
  }

  /** Subscription plan limits (src/planUsage/) — its own message, sent only when it changed. */
  private lastPlanUsageJson: string | null = null
  private postPlanUsage(sessions: SessionSummaryCard[]): void {
    const svc = getPlanUsageService()
    if (!svc) return
    try {
      const snapshot = svc.snapshot(sessions)
      const json = JSON.stringify({ ...snapshot, generatedAt: 0 })
      if (json === this.lastPlanUsageJson) return
      this.lastPlanUsageJson = json
      this.panel.webview.postMessage({ type: 'planUsage', snapshot })
    } catch { /* plan limits stay hidden; the rest of the dashboard is unaffected */ }
  }

  private async importSessions(rawSessions: Record<string, unknown>[]): Promise<void> {
    try {
      // Every stored id, not the webview list's most-recent-20k cap — an older session past the
      // cap would otherwise read as new and be overwritten by the imported copy.
      const existing = new Set(this.repo.listSessions({ limit: Infinity }).map(s => s.sessionId))
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

  private async sendGitOutcome(sessionId: string, workspace: string, filesChanged: string[], endTime: string): Promise<void> {
    let outcome: GitOutcome | null
    let revision: number | null = null
    const cachedOutcome = this.reconciliation?.getCachedOutcome(sessionId)
    if (cachedOutcome) {
      // Paint the durable value while the normal path checks whether git has changed since it was stored.
      this.panel.webview.postMessage({ type: 'gitOutcomeCache', sessionId, outcome: cachedOutcome })
    }
    try {
      if (this.reconciliation) {
        const result = await this.reconciliation.reconcile({ sessionId, workspace, filesChanged, endTime })
        // A deferred (in-grace) result: no git classification ran, so don't cache/show it as an
        // outcome (e.g. 'abandoned') before the agent has had a chance to commit. Tell the webview
        // it's deferred (rather than staying silent) so the Outcome filter's pending-count spinner
        // can stop counting it — see media/src/state.ts's deferredGitOutcomeSessionIds. It'll be
        // requested again on the next sessions refresh, or pushed proactively once the grace timer
        // revisits it (see reconciliationService.ts's scheduleGraceRevisit).
        if (result.deferred) {
          this.panel.webview.postMessage({ type: 'gitOutcomeDeferred', sessionId })
          return
        }
        outcome = result.outcome
        revision = result.revision
      } else {
        let pending = this.fallbackInFlight.get(sessionId)
        if (!pending) {
          pending = classifySessionOutcome(workspace, filesChanged)
          this.fallbackInFlight.set(sessionId, pending)
        }
        try { outcome = await pending } finally { this.fallbackInFlight.delete(sessionId) }
      }
    } catch (err) {
      // Never leave a rejected classification cached — since nothing downstream of a throw here
      // ever posts a `gitOutcome` reply, that would permanently strand the Outcome filter's
      // "resolving N outcomes" spinner above zero. Reply now (as "not applicable") so the spinner
      // can count this one down; it will be retried on the next request for this session.
      console.error(`[TraceRoost] git-outcome classification failed for session ${sessionId}:`, err)
      outcome = null
    }
    // Post-hoc risk signals (hallucinated import, submitted-despite-a-failing-check) and
    // re-tempered loop-signal severity are both only knowable once the session's outcome is
    // known, same lifecycle as git-outcome classification — computed here rather than eagerly
    // for every session. See sessionRiskSignals.ts and temperLoopSignalSeverity's docstring.
    const card = this.repo.listSessions().find(s => s.sessionId === sessionId) ?? null
    const riskSignals = card ? detectSessionRiskSignals(card, workspace, outcome) : []
    const temperedLoopSignals = card ? temperLoopSignalSeverity(card.loopSignals ?? [], outcome) : null
    this.panel.webview.postMessage({ type: 'gitOutcome', sessionId, outcome, riskSignals, temperedLoopSignals, revision })
  }

  private async sendGitOutcomes(sessionIds: string[]): Promise<void> {
    const requested = new Set(sessionIds.slice(0, 20_000))
    if (requested.size === 0) return
    const cards = this.repo.listSessions({ limit: Infinity }).filter(card => requested.has(card.sessionId))
    const foundIds = new Set(cards.map(card => card.sessionId))
    for (const id of requested) {
      if (!foundIds.has(id)) this.panel.webview.postMessage({ type: 'gitOutcome', sessionId: id, outcome: null })
    }
    const inputs: ReconcileInput[] = cards.map(card => ({
      sessionId: card.sessionId,
      workspace: card.workspace,
      filesChanged: card.filesChanged,
      endTime: card.startTime && card.durationMs
        ? new Date(Date.parse(card.startTime) + card.durationMs).toISOString()
        : card.startTime,
    }))

    if (this.reconciliation) {
      const cachedOutcomes = this.reconciliation.getCachedOutcomes(inputs.map(input => input.sessionId))
      if (Object.keys(cachedOutcomes).length > 0) {
        this.panel.webview.postMessage({ type: 'gitOutcomeCacheBatch', outcomes: cachedOutcomes })
      }
      try {
        const results = await this.reconciliation.reconcileMany(inputs)
        for (const result of results) {
          if (result.deferred) this.panel.webview.postMessage({ type: 'gitOutcomeDeferred', sessionId: result.sessionId })
        }
      } catch (err) {
        console.error('[TraceRoost] batched git-outcome reconciliation failed:', err)
        await Promise.all(inputs.map(input => this.sendGitOutcome(
          input.sessionId, input.workspace, input.filesChanged, input.endTime,
        )))
      }
      return
    }

    await Promise.all(inputs.map(input => this.sendGitOutcome(
      input.sessionId, input.workspace, input.filesChanged, input.endTime,
    )))
  }

  // `hash` is the same one traceroost-cloud shows in its own Repo column (repoKey.ts's repoHash,
  // HMAC-derived from the repo's root commit and the linked org id) — so a local repo can be
  // matched up with its row in the cloud dashboard on sight. Unlinked installs get the same
  // 'unlinked-preview' salt buildPayloadForCard's own preview path already uses, so the value is
  // still stable and distinguishes repos from each other locally, it just won't match cloud until
  // the org links. The core edition always uses that unlinked salt — see cloudBridge.ts's
  // describeRepo.
  //
  // `name` is the git-resolved repo root's own basename (`rk.ctx.root`), prefixed with its parent
  // folder's name where one exists (e.g. "traceroost/core") — not the workspace path itself:
  // `workspace` is whatever folder the session happened to be recorded from, which can be a
  // subdirectory of the repo (or, with multiple worktrees/clones, a differently-named checkout of
  // it). Two sessions from different subfolders of the same repo must show the same name, so this
  // always resolves through git rather than reading it off the given path. The parent segment
  // keeps this consistent with shortWorkspaceName's own "last two path segments" fallback shown
  // in the UI before this async result arrives — swapping to a bare basename once it lands would
  // otherwise make the displayed name shrink out from under the user.
  private async sendRepoHash(workspace: string): Promise<void> {
    let info: { name: string; hash: string | null; githubUrl: string | null } | null
    if (this.repoInfoCache.has(workspace)) {
      info = this.repoInfoCache.get(workspace) ?? null
    } else {
      const [repo, githubUrl] = await Promise.all([cloud.describeRepo(workspace), resolveGithubUrl(workspace)])
      if (repo) {
        const rootName = path.basename(repo.root) || 'repository'
        const parentName = path.basename(path.dirname(repo.root))
        const name = parentName ? `${parentName}/${rootName}` : rootName
        info = { name, hash: repo.hash, githubUrl }
      } else {
        info = null
      }
      this.repoInfoCache.set(workspace, info)
    }
    this.panel.webview.postMessage({ type: 'repoHash', workspace, name: info?.name ?? null, hash: info?.hash ?? null, githubUrl: info?.githubUrl ?? null })
  }

  private async exportSessions(redact: boolean, ids: Set<string> | null = null, format: ExportFormat = 'json'): Promise<void> {
    const all = this.repo.listSessions()
    const sessions = ids ? all.filter(s => ids.has(s.sessionId)) : all
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('TraceRoost: No session data to export')
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
    vscode.window.showInformationMessage(`TraceRoost: Exported ${sessions.length} sessions to ${filename}`)
    const doc = await vscode.workspace.openTextDocument(fileUri)
    vscode.window.showTextDocument(doc, { preview: false })
  }

  /** One source of truth for the Org panel's host dependencies — used both by the real webview
   *  message handler and by `pushOrgStatus()`'s unprompted push, so they can never drift. */
  private orgDeps(): OrgPanelDeps {
    return {
      post: (m) => { void this.panel.webview.postMessage(m) },
      openExternal: (url) => { void vscode.env.openExternal(vscode.Uri.parse(url)) },
      recentSessions: () => this.repo.listSessions({ limit: 25 }),
      // Explicitly unbounded — reconcile must see every local session, not just the most recent
      // MAX_SESSIONS_TO_WEBVIEW. That cap exists to bound the webview postMessage payload; an
      // install with a history past it would otherwise silently strand its oldest sessions,
      // permanently unreachable by "Check for unsent traces". See sessionRepository.ts's
      // MAX_SESSIONS_TO_WEBVIEW doc comment and .staged-issues/reconcile-gap-and-latency.md.
      allLocalSessions: () => this.repo.listSessions({ limit: Infinity }),
      traceSendStats: () => this.repo.queryTraceSendStats(Date.now()),
      buildPayloadPreview: (sessions) => cloud.buildPayloadPreview(sessions),
      onOpenOrgView: () => {
        // Deep-links straight into the org's own dashboard — see cloud/bridge.ts's orgViewUrl.
        const url = cloud.orgViewUrl()
        void vscode.env.openExternal(vscode.Uri.parse(url)).then(
          (opened) => { if (!opened) void vscode.window.showErrorMessage(`TraceRoost: could not open ${url} in your browser.`) },
          (err) => { void vscode.window.showErrorMessage(`TraceRoost: could not open ${url}: ${err instanceof Error ? err.message : err}`) },
        )
      },
      log: (m) => console.warn(m),
    }
  }

  private dispose() {
    DashboardPanel.currentPanel = undefined
    if (this.pendingUpdate) { clearTimeout(this.pendingUpdate); this.pendingUpdate = undefined }
    if (this.pendingGitOutcomeFlush) { clearTimeout(this.pendingGitOutcomeFlush); this.pendingGitOutcomeFlush = undefined }
    this.pendingGitOutcomeResults.clear()
    this.panel.dispose()
    // Unsubscribes this panel's pushGitOutcomeResult listener (registered in the constructor) via
    // the disposable pushed there — the ReconciliationService instance itself is owned and
    // disposed by extension.ts, not this panel, since the background watcher keeps using it after
    // this panel closes.
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
    const nonce = getNonce()

    const sessions = this.repo.listSessions()
    const sessionSummary = sessions.length > 0
      ? { sessions, backgroundSpans: [], efficiency: buildEfficiency(sessions) }
      : null
    const sessionRev = this.sessionSync.seed(sessions)

    const mcpEnabled = vscode.workspace.getConfiguration('traceRoost').get<boolean>('enableMcpServer', true)
    const mcpPort    = DashboardPanel.boundMcpPort ?? vscode.workspace.getConfiguration('traceRoost').get<number>('mcpPort', 4316)

    const initialData = `<script nonce="${nonce}">
        window.__INITIAL_TOOL_CALLS__ = ${safeJsonForScript(summary.toolCalls)};
        window.__INITIAL_SESSION_SUMMARY__ = ${safeJsonForScript(sessionSummary)};
        window.__INITIAL_SESSION_REV__ = ${sessionRev};
        window.__INITIAL_LOG_INGEST__ = ${safeJsonForScript(DashboardPanel.logIngestProgress)};
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
  msg: { label: string; detail?: string; severity: string; sessionId?: string },
  context: vscode.ExtensionContext,
  repo: SessionRepository,
  sidebarProvider?: SidebarPanel,
  rawDb?: TurnoverDb
): Promise<void> {
  const text = `Alert: ${msg.label}${msg.detail ? ' — ' + msg.detail : ''}`
  const clipboardPrompt = [
    "An alert was triggered in my AI coding session. Please explain what's happening and how I should respond.",
    '',
    `Alert: ${msg.label}`,
    ...(msg.detail ? [`Detail: ${msg.detail}`] : []),
  ].join('\n')

  // Most alerts point at one offending trace (evaluateAlert's `worst` session) — jump straight to
  // it in the Sessions tab instead of the generic Alerts tab. Aggregate alerts (e.g. daily_cost)
  // have no single trace responsible, so those still fall back to the Alerts tab.
  const viewLabel = msg.sessionId ? 'View Trace' : 'View Alerts'

  let promise: Thenable<string | undefined>
  if (msg.severity === 'error') {
    promise = vscode.window.showErrorMessage(text, viewLabel, 'Copy Prompt')
  } else if (msg.severity === 'info') {
    promise = vscode.window.showInformationMessage(text, viewLabel, 'Copy Prompt')
  } else {
    promise = vscode.window.showWarningMessage(text, viewLabel, 'Copy Prompt')
  }
  promise.then(action => {
    if (action === viewLabel) {
      DashboardPanel.show(context, repo, sidebarProvider, undefined, rawDb)
      setTimeout(() => {
        if (msg.sessionId) {
          DashboardPanel.switchToTab('sessions')
          DashboardPanel.sendFilter(undefined, undefined, undefined, msg.sessionId)
        } else {
          DashboardPanel.switchToTab('alerts')
        }
      }, 250)
    } else if (action === 'Copy Prompt') {
      vscode.env.clipboard.writeText(clipboardPrompt).then(() => {
        vscode.window.showInformationMessage('TraceRoost: Alert prompt copied — paste into your AI chat.')
      })
    }
  })
}

async function writeAutomationPrompt(agent: string, label: string, fullPrompt: string): Promise<string | undefined> {
  const agentSlug = agent === 'claude_code' ? 'claude' : agent === 'codex' ? 'codex' : 'copilot'
  const agentName = agent === 'claude_code' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Copilot'
  const filename = `traceroost-prompts-${agentSlug}.md`
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
  if (!workspaceFolder) {
    vscode.window.showWarningMessage('TraceRoost: No workspace folder open — cannot write prompts file.')
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
  const sessionLine = msg.sessionId ? `Trace ID: ${msg.sessionId}\n` : ''
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
    vscode.window.showInformationMessage(`TraceRoost: Prompt copied — paste into your ${agentLabel} session.`)
  }
}

