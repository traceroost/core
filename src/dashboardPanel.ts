import * as vscode from 'vscode'
import * as path from 'path'
import { SidebarPanel } from './sidebarPanel'
import { SessionRepository } from './sessionRepository'
import { InstructionRepository } from './database/instructionRepository'
import { detectInstructionFiles, appendSuggestion, removeSuggestion } from './instructionFiles'
import { computeBaseline } from './instructionEffectiveness'
import { autoConfigureCopilot, autoConfigureClaudeCode, autoConfigureCodex } from './autoConfig'
import { serializeExport, exportFileExtension, type ExportFormat } from './exportFormats'
import { classifySessionOutcome, resolveOutcomeCacheKey, type GitOutcome } from './gitOutcome'
import { GitOutcomeRepository } from './database/gitOutcomeRepository'
import { detectSessionRiskSignals } from './sessionRiskSignals'
import { temperLoopSignalSeverity } from './loopDetector'
import { handleTeamMessage, type TeamPanelDeps } from './cloud/team/panelController'
import { buildPayloadPreviewText } from './cloud/team/payloadPreview'
import { loadCredentials } from './cloud/team/credentials'
import { deriveRepoKey, repoHash } from './cloud/forward/repoKey'
import { resolveGithubUrl } from './repoRemote'
import { teamEndpoint } from './cloud/team/config'
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
  // On-demand — see gitOutcome.ts for why this isn't computed eagerly for every loaded session.
  // Two layers: this in-memory map is just to de-dupe concurrent/repeat requests within a single
  // panel lifetime (also holds in-flight promises, so two clicks for the same not-yet-cached
  // session don't both shell out to git); the durable cache is GitOutcomeRepository (git_outcome
  // table), which is what actually survives a panel/window restart.
  private gitOutcomeCache = new Map<string, Promise<GitOutcome | null>>()
  // Same cutoff update() uses to decide a session is still "live" for burn-rate purposes — see
  // sendGitOutcome.
  private static readonly GIT_OUTCOME_ACTIVE_GRACE_MS = 2 * 60_000
  // Keyed by workspace path rather than session — there are only ever a handful of distinct
  // workspaces open at once, unlike sessions, so this is cheap to compute for every one of them.
  // `name` is the git repo root's own basename, not the (possibly-a-subfolder) workspace path —
  // see sendRepoHash for why.
  private repoInfoCache = new Map<string, { name: string; hash: string; githubUrl: string | null } | null>()

  static show(context: vscode.ExtensionContext, repo: SessionRepository, sidebarProvider?: SidebarPanel, instructionRepo?: InstructionRepository, rawDb?: TurnoverDb) {
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

  /** Pushes a fresh team status to the open panel, if any — call after anything that can change
   *  what it shows without the user having triggered it directly (a background forward-queue
   *  drain, in particular; see `forwardScheduler`'s `onDrainComplete` in extension.ts). A no-op,
   *  cheaply, when no panel is open. */
  static pushTeamStatus() {
    const panel = DashboardPanel.currentPanel
    if (!panel) return
    void handleTeamMessage({ type: 'getTeamStatus' }, panel.teamDeps())
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
      if (typeof msg.type === 'string' && (msg.type === 'getTeamStatus' || msg.type.startsWith('team'))) {
        await handleTeamMessage(msg, this.teamDeps())
        return
      }
      if (msg.type === 'loadSessionDetail' && msg.sessionId) {
        const timeline = this.repo.loadSessionTimeline(msg.sessionId as string)
        this.panel.webview.postMessage({ type: 'sessionDetail', sessionId: msg.sessionId, timeline })
      } else if (msg.type === 'getGitOutcome' && msg.sessionId) {
        this.sendGitOutcome(
          msg.sessionId as string,
          (msg.workspace as string) || '',
          Array.isArray(msg.filesChanged) ? msg.filesChanged as string[] : [],
          (msg.endTime as string) || '',
        ).catch(err => console.error('[TraceRoost] sendGitOutcome failed:', err))
      } else if (msg.type === 'getRepoHash' && msg.workspace) {
        void this.sendRepoHash(msg.workspace as string)
      } else if (msg.type === 'loadBlob' && msg.spanId && msg.field) {
        const content = await this.repo.loadBlob(
          msg.spanId as string,
          msg.field as 'response' | 'thinking' | 'tool-input' | 'full-result' | 'edit-old' | 'edit-new',
          msg.editIndex as number | undefined,
        )
        this.panel.webview.postMessage({ type: 'blobContent', spanId: msg.spanId, field: msg.field, content })
      } else if (msg.type === 'askAI' && msg.prompt) {
        const prompt = `The following efficiency issue was detected in my AI coding trace. Help me fix it:\n\n${msg.prompt}`
        openAIChat(prompt, msg.agent)
      } else if (msg.type === 'alert' && msg.label) {
        handleAlertNotification(msg as { label: string; detail?: string; severity: string }, context, repo, sidebarProvider, rawDb)
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
    const recentCutoff = Date.now() - DashboardPanel.GIT_OUTCOME_ACTIVE_GRACE_MS
    const activeSession = sessions.find(s => Date.parse(s.startTime) > recentCutoff)
    const burnRateResult = activeSession
      ? this.repo.queryBurnRate(activeSession.sessionId)
      : null

    const cfg = vscode.workspace.getConfiguration('traceRoost')
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
      // The one real folder Apply/getInstructionFiles below actually act on
      // (vscode.workspace.workspaceFolders[0], same source those handlers already use) — the
      // webview has no other way to know it, and it is not the same thing as the Repo toolbar's
      // freeform search box (workspaceFilter), which can match any historical repo's sessions.
      currentWorkspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
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

  private async sendGitOutcome(sessionId: string, workspace: string, filesChanged: string[], endTime: string): Promise<void> {
    // classifySessionOutcome has no "still in progress" state — a changed-but-not-yet-committed
    // file reads as 'abandoned' whether the session ended five minutes ago or five seconds ago
    // (see gitOutcome.ts). Sessions.tsx now requests an outcome for every visible session (not
    // just ones a user opens), so a brand-new session with an uncommitted edit would otherwise be
    // classified and durably cached as 'abandoned' before the agent has had a chance to commit.
    // Skip (without caching) while the session's last known activity is still within the same
    // "live" window update() uses for the active-session burn rate — it'll be requested again on
    // the next sessions refresh once that window passes.
    if (endTime && Date.now() - Date.parse(endTime) < DashboardPanel.GIT_OUTCOME_ACTIVE_GRACE_MS) {
      return
    }
    let outcome: GitOutcome | null
    try {
      let pending = this.gitOutcomeCache.get(sessionId)
      if (!pending) {
        pending = this.loadOrComputeGitOutcome(sessionId, workspace, filesChanged)
        this.gitOutcomeCache.set(sessionId, pending)
      }
      outcome = await pending
    } catch (err) {
      // Never leave a rejected classification cached — that would permanently poison this
      // session's slot (every future call re-rejects immediately, forever) and, since nothing
      // downstream of a throw here ever posts a `gitOutcome` reply, permanently strand the
      // Outcome filter's "resolving N outcomes" spinner above zero. Evict so it's retried next
      // time, and still reply now (as "not applicable") so the spinner can count this one down.
      this.gitOutcomeCache.delete(sessionId)
      console.error(`[TraceRoost] git-outcome classification failed for session ${sessionId}:`, err)
      outcome = null
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

  // Checks the durable git_outcome cache (keyed by session + resolveOutcomeCacheKey's doc comment)
  // before shelling out to git — classifySessionOutcome's actual scan is the expensive part (see
  // gitOutcome.ts), so this is what makes reopening the panel/window not rescan every session
  // again. A row is reused as long as nothing relevant has moved since it was computed; once it
  // has, the file's outcome (e.g. abandoned -> committed -> merged) may genuinely have changed, so
  // it's recomputed rather than trusted forever.
  private async loadOrComputeGitOutcome(sessionId: string, workspace: string, filesChanged: string[]): Promise<GitOutcome | null> {
    if (this.rawDb && workspace && filesChanged.length > 0) {
      const key = await resolveOutcomeCacheKey(workspace, filesChanged)
      if (key) {
        const repo = new GitOutcomeRepository(this.rawDb)
        const cached = repo.get(sessionId, key.cacheKey)
        if (cached !== undefined) return cached
        const outcome = await classifySessionOutcome(workspace, filesChanged)
        if (outcome) repo.put(sessionId, key.root, key.cacheKey, outcome)
        return outcome
      }
    }
    return classifySessionOutcome(workspace, filesChanged)
  }

  // `hash` is the same one traceroost-cloud shows in its own Repo column (repoKey.ts's repoHash,
  // HMAC-derived from the repo's root commit and the linked org id) — so a local repo can be
  // matched up with its row in the cloud dashboard on sight. Unlinked installs get the same
  // 'unlinked-preview' salt buildPayloadForCard's own preview path already uses, so the value is
  // still stable and distinguishes repos from each other locally, it just won't match cloud until
  // the team links.
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
    let info: { name: string; hash: string; githubUrl: string | null } | null
    if (this.repoInfoCache.has(workspace)) {
      info = this.repoInfoCache.get(workspace) ?? null
    } else {
      const creds = loadCredentials()
      const orgId = creds?.orgId ?? 'unlinked-preview'
      const [rk, githubUrl] = await Promise.all([deriveRepoKey(workspace, orgId), resolveGithubUrl(workspace)])
      if (rk.ok) {
        const rootName = path.basename(rk.ctx.root) || 'repository'
        const parentName = path.basename(path.dirname(rk.ctx.root))
        const name = parentName ? `${parentName}/${rootName}` : rootName
        info = { name, hash: repoHash(rk.ctx), githubUrl }
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

  /** One source of truth for the Team panel's host dependencies — used both by the real webview
   *  message handler and by `pushTeamStatus()`'s unprompted push, so they can never drift. */
  private teamDeps(): TeamPanelDeps {
    return {
      post: (m) => { void this.panel.webview.postMessage(m) },
      openExternal: (url) => { void vscode.env.openExternal(vscode.Uri.parse(url)) },
      recentSessions: () => this.repo.listSessions({ limit: 25 }),
      allLocalSessions: () => this.repo.listSessions(),
      buildPayloadPreview: (session) => buildPayloadPreviewText(session),
      onOpenTeamView: () => { void vscode.env.openExternal(vscode.Uri.parse(loadCredentials()?.endpoint ?? teamEndpoint())) },
      log: (m) => console.warn(m),
    }
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
    const nonce = getNonce()

    const sessions = this.repo.listSessions()
    const sessionSummary = sessions.length > 0
      ? { sessions, backgroundSpans: [], efficiency: buildEfficiency(sessions) }
      : null

    const mcpEnabled = vscode.workspace.getConfiguration('traceRoost').get<boolean>('enableMcpServer', true)
    const mcpPort    = vscode.workspace.getConfiguration('traceRoost').get<number>('mcpPort', 4316)

    const initialData = `<script nonce="${nonce}">
        window.__INITIAL_TOOL_CALLS__ = ${safeJsonForScript(summary.toolCalls)};
        window.__INITIAL_SESSION_SUMMARY__ = ${safeJsonForScript(sessionSummary)};
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
      DashboardPanel.show(context, repo, sidebarProvider, undefined, rawDb)
      DashboardPanel.switchToTab('alerts')
    } else if (action === 'Copy Prompt') {
      vscode.env.clipboard.writeText(clipboardPrompt).then(() => {
        vscode.window.showInformationMessage('TraceRoost: Alert prompt copied — paste into your AI chat.')
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
  vscode.window.showInformationMessage(`TraceRoost: Prompt copied — paste into your ${label} session.`)
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
