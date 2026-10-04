import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { OtlpCollector } from './otlpCollector'
import { detectPortOwner } from './portResolver'
import { SessionStore } from './sessionStore'
import { SidebarPanel } from './sidebarPanel'
import { DashboardPanel } from './dashboardPanel'
import { autoConfigureCopilot, autoConfigureClaudeCode, autoConfigureCodex, type ConfigResult } from './autoConfig'
import { exportSpans, exportSpansRedacted } from './exportData'
import { openDatabase, TraceRoostDb } from './database/db'
import { DatabaseReader, openReadonlySnapshot } from './database/reader'
import { DatabaseWriter } from './database/writer'
import { migrateGlobalStateToSqlite } from './database/migration'
import { runRetention } from './database/retention'
import { PlanUsageService, getPlanUsageService, setPlanUsageService } from './planUsage/planUsageService'
import { SessionRepository } from './sessionRepository'
import { summarizeSpans, summarizeTraces } from './spanSummarizer'
import { LogReader, findClaudeTranscripts } from './logReader'
import { ClaudeTurnJoiner, setClaudeTurnJoiner, joinHoldMsFromEnv } from './claudeTurnJoin'
import { restoreLogFileState, writeLogFileState } from './logFileState'
import { detectLoopSignals } from './loopDetector'
import { computeOneShotStats } from './oneShotRate'
import { startMcpHttpServer } from './mcpServer'
import { InstructionRepository } from './database/instructionRepository'
// TraceRoost Cloud (org link + upload) — only ever through this seam; see cloudBridge.ts.
import { cloud, type ForwardSchedulerHandle } from './cloudBridge'
import { ReconciliationService } from './reconcile/reconciliationService'
import { startBackgroundReconciliation, type BackgroundWatcher } from './reconcile/backgroundWatcher'
import { KeyedDebouncer } from './reconcile/keyedDebouncer'
import { createSessionForwarder } from './sessionForwarder'
import { matchesTraceId } from './traceIdentity'

let collector: OtlpCollector | undefined
let store: SessionStore | undefined
let outputChannel: vscode.OutputChannel | undefined
let traceRoostDb: TraceRoostDb | undefined
let writer: DatabaseWriter | undefined
let repository: SessionRepository | undefined
let reconciliationService: ReconciliationService | undefined
let backgroundWatcher: BackgroundWatcher | undefined
// Coalesces bursty live onUpdate ticks for the same session before checking whether its rollup
// content changed (staged feature 10) -- see keyedDebouncer.ts's doc comment for why: each check
// rebuilds the payload via real `git` subprocesses.
const contentChangeDebouncer = new KeyedDebouncer(3_000, 30_000)
// How long reconciliation revision changes are collected before being forwarded as one batch.
const REVISION_FORWARD_BATCH_MS = 1_000
let logReaderTimer: ReturnType<typeof setInterval> | undefined
let runLogScanFn: (() => void) | undefined
let forwardScheduler: ForwardSchedulerHandle | undefined
// Forwards a session whose content changed — a live OTLP update or a log-scan result — to the
// cloud; see sessionForwarder.ts. A hard no-op unless an org is linked.
const forwardChangedSession = createSessionForwarder({
  cloud,
  reconciliation: () => reconciliationService,
  debouncer: contentChangeDebouncer,
  drainSoon: () => forwardScheduler?.drainSoon(),
  log: m => outputChannel?.appendLine(m),
})
// The trace manifest (stable trace identity) lists what the database holds, so it must not go
// out while the database is still filling: false until the startup log load has been written,
// and again while "clear all data" re-ingests.
let traceStoreReady = false

// ── Cross-window sync ────────────────────────────────────────────────────────

const LAST_WRITE_FILENAME = 'last-write.json'

function writeLastWriteSignal(storageUri: vscode.Uri): void {
  try {
    const filePath = path.join(storageUri.fsPath, LAST_WRITE_FILENAME)
    fs.writeFileSync(filePath, JSON.stringify({ lastWriteMs: Date.now() }))
  } catch { /* non-fatal — cross-window signal only */ }
}

function readLastWriteMs(storageUri: vscode.Uri): number {
  try {
    const filePath = path.join(storageUri.fsPath, LAST_WRITE_FILENAME)
    const raw = fs.readFileSync(filePath, 'utf8')
    return (JSON.parse(raw) as { lastWriteMs: number }).lastWriteMs ?? 0
  } catch {
    return 0
  }
}

// ── Activate ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('TraceRoost')
  context.subscriptions.push(outputChannel)
  outputChannel.appendLine(`TraceRoost activating… (v${context.extension.packageJSON.version})`)

  // ── Duplicate-install guard ─────────────────────────────────────────────────
  // During the AgentLens → TraceRoost transition the same build ships under two
  // marketplace ids: `traceroost.traceroost` (the new listing) and
  // `agentlens.agentlens-dashboard` (the old listing, so existing users keep
  // updating). If both are installed they'd register the same commands, the same
  // `traceroost` view container, and two collectors fighting over the OTLP/MCP
  // ports. The old copy stands down; the new one keeps running and asks the user
  // to remove the duplicate.
  if (await handleDuplicateInstall(context)) { return }

  // This host's trace store — its cloud host id lives beside the database, so the extension and
  // the standalone server (one shared link) each reconcile only their own traces.
  cloud.setHostStore(context.globalStorageUri.fsPath)

  // ── Database ────────────────────────────────────────────────────────────────
  try {
    traceRoostDb = await openDatabase(
      context.globalStorageUri.fsPath,
      context.extensionUri.fsPath,
      (msg) => outputChannel!.appendLine(msg),
    )
    context.subscriptions.push(traceRoostDb)
    outputChannel.appendLine('TraceRoost database initialized.')
    if (traceRoostDb.loadError) {
      vscode.window.showErrorMessage(
        `TraceRoost: Could not read the existing trace database (${traceRoostDb.loadError}). History is unavailable in this window and nothing will be saved over it — see the TraceRoost output channel.`
      )
    } else if (!traceRoostDb.isOwner) {
      // Another window owns writes to the shared database file (see TraceRoostDb) — this window
      // only reads it, so it can never overwrite that window's newer history with a stale copy.
      outputChannel.appendLine('TraceRoost database is owned by another window — this window is read-only on disk.')
    }
  } catch (err) {
    outputChannel.appendLine(`Failed to initialize database: ${err}`)
  }

  // ── Session store ────────────────────────────────────────────────────────────
  try {
    store = new SessionStore(context)
  } catch (err) {
    outputChannel.appendLine(`Failed to initialize session store: ${err}`)
    vscode.window.showErrorMessage('TraceRoost: Failed to initialize trace store.')
    return
  }

  // A Claude OTEL interaction takes its transcript turn's key through this join (stable trace
  // identity — see claudeTurnJoin.ts); every summarizeSpans() reads it.
  const claudeJoiner = new ClaudeTurnJoiner({ findTranscripts: findClaudeTranscripts, holdMs: joinHoldMsFromEnv() })
  setClaudeTurnJoiner(claudeJoiner)

  // ── Writer + reader + repository ─────────────────────────────────────────────
  if (traceRoostDb) {
    const log = (msg: string) => outputChannel!.appendLine(msg)
    writer = new DatabaseWriter(traceRoostDb.raw, context.globalStorageUri, log)
    const reader = new DatabaseReader(traceRoostDb.raw, context.globalStorageUri)
    repository = new SessionRepository(reader, writer, store, log)
    setPlanUsageService(new PlanUsageService(traceRoostDb.raw, { log }))

    // Run one-time migration before registering the onUpdate subscriber. Only the window that
    // owns the database file can persist it — anywhere else it would mark globalState migrated
    // while the migrated rows stay in an in-memory copy that is never saved.
    if (traceRoostDb.isOwner) await migrateGlobalStateToSqlite(context, writer, log)
    // A rebuilt trace store (traceStore.ts) re-queues its history under the new keys; what was
    // queued or recorded delivered under the old ones goes. Owner only, for the same reason.
    if (traceRoostDb.isOwner && traceRoostDb.rebuiltTraceStore) cloud.dropQueuedTraces()

    // Initial retention run on activation. Its session deletes run synchronously inside this call;
    // only the orphaned-blob sweep (a full timeline scan) is left to finish after activation.
    const retentionDays = vscode.workspace.getConfiguration('traceRoost').get<number>('sessionRetentionDays', 90)
    void runRetention(traceRoostDb.raw, retentionDays, traceRoostDb.blobsDir, log)
    getPlanUsageService()?.runRetention(retentionDays)

    // Periodic retention: once per 24 hours while the extension is active.
    const retentionTimer = setInterval(() => {
      const days = vscode.workspace.getConfiguration('traceRoost').get<number>('sessionRetentionDays', 90)
      void runRetention(traceRoostDb!.raw, days, traceRoostDb!.blobsDir, log)
      getPlanUsageService()?.runRetention(days)
    }, 24 * 60 * 60 * 1000)
    context.subscriptions.push({ dispose: () => clearInterval(retentionTimer) })

    // The collector adds a payload's spans one at a time and each addSpan notifies; summarizing
    // the whole window on every one of those was O(n²) per payload. Collect the touched traceIds
    // and summarize once, after the synchronous ingest of the payload finishes.
    const pendingTraceIds = new Set<string>()
    const persistLiveTraces = () => {
      const traceIds = [...pendingTraceIds]
      pendingTraceIds.clear()
      if (!writer || !repository || traceIds.length === 0) return
      const sessions = summarizeTraces(store!.getSpans(), traceIds)
      let wrote = false
      for (const traceId of traceIds) {
        const card = sessions.find(s => s.traceId === traceId)
        if (card && persistLiveCard(card)) wrote = true
      }
      if (!wrote) return
      // After drain, save DB to disk and write the cross-window signal. Coalesced: agents export
      // a payload every few seconds each, and every save rewrites the whole database file.
      void writer.drain().then(() => {
        traceRoostDb?.saveSoon(saved => { if (saved) writeLastWriteSignal(context.globalStorageUri) })
      }).catch(err => console.error('[TraceRoost] writer.drain error:', err))
    }
    // Traces whose Claude transcript join is on hold (keyPending) get one more pass once the hold
    // runs out, even if no further span arrives for them.
    const joinRetries = new Set<string>()
    const persistLiveCard = (card: ReturnType<typeof summarizeSpans>['sessions'][number]): boolean => {
      if (!writer || !repository || card.sessionId.startsWith('synth-')) return false
      if (card.keyPending) {
        if (!joinRetries.has(card.traceId)) {
          joinRetries.add(card.traceId)
          setTimeout(() => {
            joinRetries.delete(card.traceId)
            if (pendingTraceIds.size === 0) queueMicrotask(persistLiveTraces)
            pendingTraceIds.add(card.traceId)
          }, claudeJoiner.holdMs + 50)
        }
        return false
      }
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
      writer.deleteSynthSession(card.traceId)
      writer.enqueue(card, workspace)
      // Cloud: re-forward the session when its rollup content changed (sessionForwarder.ts). A
      // hard no-op unless an org is linked; the network send happens later, on a timer.
      forwardChangedSession({ ...card, workspace: card.workspace || workspace })
      // isLinked() first: enqueueInstructionTelemetry is a no-op without an org, but its
      // listSessions() argument (every stored session, plus a re-summarize of the live window —
      // hundreds of ms on a large history) was built for it on every live OTLP payload anyway.
      if (workspace && cloud.isLinked()) {
        void cloud.enqueueInstructionTelemetry(workspace, repository!.listSessions())
          .then(enq => { if (enq) forwardScheduler?.drainSoon() })
          .catch(() => { /* best-effort */ })
      }
      return true
    }
    context.subscriptions.push(
      store.onUpdate((traceId) => {
        if (!traceId) return
        if (pendingTraceIds.size === 0) queueMicrotask(persistLiveTraces)
        pendingTraceIds.add(traceId)
      })
    )

  }

  // ── Collector ────────────────────────────────────────────────────────────────
  const traceRoostCfg = vscode.workspace.getConfiguration('traceRoost')
  const port = traceRoostCfg.get<number>('otlpPort', 4318)
  collector = new OtlpCollector(port, store, outputChannel)
  let collectorFailed = false
  // Set only when another TraceRoost-owned process (the standalone/background service, most
  // often) or an unrelated app holds the port — never for the benign case of another VS Code
  // window already running this same extension (owner 'plugin'), which shares one database by
  // design. Surfaced persistently in the dashboard UI via DashboardPanel.collectorConflict,
  // not just as a one-time toast, since the wrong data source can otherwise go unnoticed for a
  // whole session.
  let collectorConflict: { owner: 'standalone' | 'foreign'; port: number } | undefined
  try {
    await collector.start()
    collector.setIngestionEnabled(traceRoostCfg.get<boolean>('enableOtelIngestion', true))
  } catch (err) {
    collectorFailed = true
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const owner = await detectPortOwner(port)
      if (owner === 'standalone') {
        collectorConflict = { owner, port }
        outputChannel.appendLine(
          `Not receiving OTel — the background service already holds port ${port}.\n` +
          `  - New sessions here come from log files only (no prompt/tool content).\n` +
          `  - Run TraceRoost one way per machine — background service, VS Code extension, or Docker. ` +
          `Recommended: the background service — it starts at login and keeps capturing OTel even when ` +
          `VS Code is closed, so nothing gets missed. Install with \`npx traceroost@latest service install\` ` +
          `(macOS/Linux/Windows all use the same command).\n` +
          `  - The service already holds this port, so: keep it and uninstall this extension ` +
          `(\`code --uninstall-extension traceroost.traceroost\`), then reload — or, to use VS Code instead, ` +
          `stop the service with \`traceroost service stop\`.`
        )
        vscode.window.showErrorMessage(
          `TraceRoost: the background service is already receiving OTel data on port ${port}. This window won't ` +
          `see live OTel sessions until you stop the service (\`traceroost service stop\`) and reload, or view its ` +
          `dashboard instead. Run TraceRoost one way per machine — extension, background service, local run, or ` +
          `Docker, not several at once — and stick to the default ports.`
        )
      } else if (owner === 'foreign') {
        collectorConflict = { owner, port }
        outputChannel.appendLine(`Port ${port} is in use by an unknown process — change traceRoost.otlpPort`)
        vscode.window.showErrorMessage(
          `TraceRoost: Port ${port} is already in use by another application. Change the traceRoost.otlpPort setting to use a different port.`
        )
      }
    } else {
      outputChannel.appendLine(`Failed to start OTLP collector on port ${port}: ${err}`)
    }
    collector = undefined
  }
  DashboardPanel.collectorConflict = collectorConflict

  // ── Auto-configure agents ────────────────────────────────────────────────────
  const autoConfigureAgents = traceRoostCfg.get<boolean>('autoConfigureAgents', true)
  const [copilotResult, claudeResult, codexResult] = autoConfigureAgents
    ? await Promise.all([
        autoConfigureCopilot(port),
        autoConfigureClaudeCode(port),
        autoConfigureCodex(port),
      ])
    : [{ changed: false }, { changed: false }, { changed: false }]

  if (copilotResult.error) {
    outputChannel.appendLine(`Auto-configure Copilot failed: ${copilotResult.error}`)
    vscode.window.showWarningMessage(
      `TraceRoost: Could not auto-configure Copilot OTel. Manually set github.copilot.chat.otel.enabled=true and otlpEndpoint to http://localhost:${port}`
    )
  }
  if (claudeResult.error) {
    outputChannel.appendLine(`Auto-configure Claude Code failed: ${claudeResult.error}`)
    vscode.window.showWarningMessage(
      `TraceRoost: Could not auto-configure Claude Code. Manually add CLAUDE_CODE_ENABLE_TELEMETRY=1 and OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${port} to ~/.claude/settings.json env block.`
    )
  }
  if (codexResult.error) {
    outputChannel.appendLine(`Auto-configure Codex failed: ${codexResult.error}`)
    vscode.window.showWarningMessage(
      `TraceRoost: Could not auto-configure Codex. Manually add [otel] exporter = { otlp-http = { endpoint = "http://localhost:${port}" } } to ~/.codex/config.toml`
    )
  }

  // A user endpoint left alone on purpose (it points at their own collector) — log why.
  for (const r of [copilotResult, claudeResult, codexResult] as ConfigResult[]) {
    if (r.warning) outputChannel.appendLine(`Auto-configure: ${r.warning}`)
  }

  const configuredAgents: string[] = []
  if (copilotResult.changed) configuredAgents.push('Copilot')
  if (claudeResult.changed) configuredAgents.push('Claude Code')
  if (codexResult.changed) configuredAgents.push('Codex')
  if (configuredAgents.length > 0) {
    outputChannel.appendLine(`Auto-configured OTEL telemetry for: ${configuredAgents.join(', ')}`)
    vscode.window.showInformationMessage(
      `TraceRoost configured OTEL telemetry for ${configuredAgents.join(', ')} — restart the agent(s) to start streaming traces. Disable via the traceRoost.autoConfigureAgents setting.`
    )
  }

  // ── Panels ───────────────────────────────────────────────────────────────────
  const repo = repository ?? fallbackRepository(store)
  const provider = new SidebarPanel(repo, context.extensionUri)

  // ── Live trace reconciliation (staged feature 10) ────────────────────────────
  // One instance for the whole extension-host lifetime, independent of whether a Traces panel is
  // open — see reconciliationService.ts and backgroundWatcher.ts. Requires the SQLite database
  // (traceRoostDb); without it there's nothing durable to revision, so both stay undefined and
  // DashboardPanel falls back to its uncached per-request path, same as before this feature.
  if (traceRoostDb) {
    reconciliationService = new ReconciliationService(traceRoostDb.raw)
    // A revision change detected in the background (a commit, merge, edit, etc. while nothing was
    // watching) must reach the forwarding queue, not just the UI — otherwise a corrected outcome
    // sits correct locally but stale in Cloud until something else happens to re-enqueue this
    // session. See enqueueSession.ts's `revision` param and queue.ts's replace-on-newer-revision.
    //
    // Changes arrive one reconciled session at a time — thousands of them from the startup pass over
    // a long history, where every session's first check counts as a change. Each used to list every
    // stored session to find its card (hundreds of ms apiece); they're now collected briefly and
    // looked up against one listing per burst, and skipped outright when no org is linked
    // (maybeEnqueueSession is a no-op then).
    const pendingRevisions = new Map<string, number>()
    let revisionFlushTimer: ReturnType<typeof setTimeout> | undefined
    const flushRevisions = () => {
      revisionFlushTimer = undefined
      const batch = [...pendingRevisions]
      pendingRevisions.clear()
      const cards = new Map<string, ReturnType<typeof repo.listSessions>[number]>()
      for (const s of repo.listSessions()) if (!cards.has(s.sessionId)) cards.set(s.sessionId, s)
      for (const [sessionId, revision] of batch) {
        const card = cards.get(sessionId)
        if (!card) continue
        void cloud.enqueueSession(card, m => outputChannel?.appendLine(m), revision)
          .then(res => { if (res.enqueued) forwardScheduler?.drainSoon() })
      }
    }
    const unsubscribeForwarding = reconciliationService.subscribe((r) => {
      if (!r.changed || r.revision === null || !cloud.isLinked()) return
      pendingRevisions.set(r.sessionId, Math.max(r.revision, pendingRevisions.get(r.sessionId) ?? 0))
      revisionFlushTimer ??= setTimeout(flushRevisions, REVISION_FORWARD_BATCH_MS)
    })
    backgroundWatcher = startBackgroundReconciliation({
      service: reconciliationService,
      listSessions: () => repo.listSessions({ limit: Infinity }).map(s => ({
        sessionId: s.sessionId,
        workspace: s.workspace,
        filesChanged: s.filesChanged,
        endTime: s.startTime && s.durationMs && !Number.isNaN(Date.parse(s.startTime)) ? new Date(Date.parse(s.startTime) + s.durationMs).toISOString() : s.startTime,
      })),
      log: (msg) => outputChannel!.appendLine(msg),
    })
    context.subscriptions.push({ dispose: () => { unsubscribeForwarding(); if (revisionFlushTimer) clearTimeout(revisionFlushTimer); backgroundWatcher?.dispose(); reconciliationService?.dispose(); contentChangeDebouncer.dispose() } })
  }

  // ── Log ingestion ─────────────────────────────────────────────────────────
  const enableLogIngestion = vscode.workspace.getConfiguration('traceRoost').get<boolean>('enableLogIngestion', true)
  let logReader: LogReader | undefined
  let startBatchedLoad: ((onAllDone?: () => void) => void) | undefined
  if (enableLogIngestion && writer) {
    logReader = new LogReader({ log: (msg) => outputChannel!.appendLine(msg), sqlFactory: traceRoostDb?.sqlFactory })
    // Also re-derives what a parser change needs re-read (see LOG_FILE_STATE_VERSION) — e.g.
    // every file once, into a store rebuilt for stable trace identity.
    restoreLogFileState(logReader, context.globalStorageUri.fsPath,
      vscode.workspace.getConfiguration('traceRoost').get<number>('sessionRetentionDays', 90))
    const lr = logReader  // non-null alias for use inside closures
    // Only once the parsed sessions are actually on disk: a read-only window (see TraceRoostDb)
    // recording files as processed would make the owning window skip them on its next activation.
    const persistFileState = () => {
      if (traceRoostDb?.isOwner) writeLogFileState(context.globalStorageUri.fsPath, lr.exportFileState())
    }
    const fallbackWorkspace = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''

    // Periodic incremental scan: only picks up files that have changed since last run.
    // Every 30 s. Parses changed files in small batches across event-loop turns rather than one
    // synchronous lr.scan() over every log directory, so a large or fast-growing transcript
    // doesn't stall the extension host; LogReader itself reads only the bytes appended since the
    // last scan (see _readNewLines). A tick that fires while the previous scan is still in
    // progress is skipped.
    let logScanInFlight = false
    const LOG_SCAN_BATCH = 10
    // Claude Code caches its plan-usage reading in ~/.claude.json; a new fetch there is a new
    // reading even when no session log changed.
    const pollClaudePlanUsage = () => {
      if (!traceRoostDb?.isOwner || !getPlanUsageService()?.pollClaudeCache()) return
      traceRoostDb.saveSoon()
      provider.refresh()
      DashboardPanel.refreshSoon()
    }
    const runLogScan = runLogScanFn = () => {
      pollClaudePlanUsage()
      if (logScanInFlight) return
      let files: ReturnType<typeof lr.collectFileMeta>
      let results: ReturnType<typeof lr.scan>
      try {
        // OpenCode is one DB holding many sessions — scanned whole, as in the initial load.
        files = lr.collectFileMeta().filter(f => f.agentKey !== 'opencode')
        results = lr.scanOpenCode()
      } catch (err) {
        outputChannel!.appendLine(`[TraceRoost] Log ingestion collect error: ${err}`)
        return
      }
      logScanInFlight = true
      const step = (idx: number) => {
        for (let i = idx; i < Math.min(idx + LOG_SCAN_BATCH, files.length); i++) {
          try { results.push(...lr.parseFile(files[i].filePath, files[i].agentKey)) } catch { /* skip bad file */ }
        }
        const next = idx + LOG_SCAN_BATCH
        if (next < files.length) { setTimeout(() => step(next), 0); return }
        logScanInFlight = false
        writeScanResults(results)
      }
      step(0)
    }
    const writeScanResults = (results: ReturnType<typeof lr.scan>) => {
      if (results.length === 0) return
      getPlanUsageService()?.ingest(results)
      const ws = fallbackWorkspace()
      for (const { card, workspace } of results) {
        card.loopSignals = detectLoopSignals(card)
        card.oneShotStats = computeOneShotStats(card)
        writer!.enqueue(card, workspace || ws)
        // Cloud: scan() returns only sessions whose log file changed, so forward each (the content
        // gate skips one whose rollup didn't actually change). Without this, a log-only session —
        // a Q&A turn, a non-git directory — and every later change to one already delivered
        // reached the cloud only on the next activation's load, and meanwhile held its day's trace
        // manifest at missing_keys. The standalone server's runLogScan does the same.
        forwardChangedSession({ ...card, workspace: workspace || ws })
      }
      void writer!.drain().then(() => {
        provider.refresh()
        DashboardPanel.currentPanel?.update()
        traceRoostDb?.saveSoon(saved => {
          if (saved) writeLastWriteSignal(context.globalStorageUri)
          persistFileState()
        })
      }).catch(err => outputChannel!.appendLine(`[TraceRoost] Log ingestion drain error: ${err}`))
    }

    // Initial load: collect file metadata sorted newest-first, then process in two
    // priority groups so the extension host stays responsive throughout.
    //
    // Fast group  (.jsonl and other small files): batch=10, no artificial delay.
    // Slow group  (copilot_vscode_json — legacy .json snapshots that average 1.8 MB):
    //             batch=2 with a 50 ms gap between batches.  This keeps each event-loop
    //             tick under ~100 ms so VS Code can process incoming messages.
    //
    // Both groups use setTimeout(fn, 0) rather than setImmediate so the host can
    // drain its own message queue between batches.
    startBatchedLoad = (onAllDone?: () => void) => {
      let allFiles: ReturnType<typeof lr.collectFileMeta>
      try {
        allFiles = lr.collectFileMeta()
      } catch (err) {
        outputChannel!.appendLine(`[TraceRoost] Log ingestion collect error: ${err}`)
        onAllDone?.()
        return
      }
      if (allFiles.length === 0) { onAllDone?.(); return }

      const AGENT_KEY_LABEL: Record<string, string> = {
        claude:              'Claude Code',
        codex:               'Codex',
        copilot:             'Copilot CLI',
        copilot_vscode:      'Copilot (VS Code)',
        copilot_vscode_json: 'Copilot (VS Code)',
        opencode:            'OpenCode',
        cursor:              'Cursor CLI',
      }
      const countByKey = new Map<string, number>()

      const processGroup = (
        files: typeof allFiles,
        batchSize: number,
        delayMs: number,
        onDone: () => void,
      ) => {
        const step = (idx: number) => {
          const ws = fallbackWorkspace()
          let written = 0
          for (let i = idx; i < Math.min(idx + batchSize, files.length); i++) {
            progress.done++
            try {
              // Usually one result; a Claude Code transcript split by a large gap between
              // prompts (see splitClaudeLinesOnPromptGaps) can yield more than one.
              const results = lr.parseFile(files[i].filePath, files[i].agentKey)
              getPlanUsageService()?.ingest(results)
              for (const result of results) {
                result.card.loopSignals = detectLoopSignals(result.card)
                result.card.oneShotStats = computeOneShotStats(result.card)
                writer!.enqueue(result.card, result.workspace || ws)
                const dk = files[i].agentKey === 'copilot_vscode_json' ? 'copilot_vscode' : files[i].agentKey
                countByKey.set(dk, (countByKey.get(dk) ?? 0) + 1)
                written++
                // Cloud: enqueue this session for forwarding. Hard no-op unless an org is
                // linked. Has to happen in this one-time historical load, not only wherever
                // a live session close triggers it — lr.parseFile() above records this
                // file's mtime/size into the same LogReader's fileState that a later
                // incremental scan checks for "has this changed", so a historical file read
                // here first makes it permanently invisible to that scan as "new" (see the
                // matching fix and its longer note in standalone/server.ts).
                void cloud.enqueueSession(
                  { ...result.card, workspace: result.workspace || ws },
                  m => outputChannel?.appendLine(m),
                )
              }
            } catch { /* skip bad file */ }
          }
          if (written > 0) {
            void writer!.drain().then(() => {
              // Coalesced — this runs every 10 files of the initial load, and each save rewrites
              // the whole database file.
              traceRoostDb?.saveSoon()
              provider.refresh()
              DashboardPanel.refreshSoon()
            }).catch(err => outputChannel!.appendLine(`[TraceRoost] Log ingestion drain error: ${err}`))
          }
          DashboardPanel.setLogIngestProgress(progress)
          const next = idx + batchSize
          if (next < files.length) {
            setTimeout(() => step(next), delayMs)
          } else {
            onDone()
          }
        }
        if (files.length > 0) setTimeout(() => step(0), delayMs)
        else onDone()
      }

      // OpenCode: DB file returns multiple sessions — process separately before batched files.
      const ocResults = lr.scanOpenCode()
      if (ocResults.length > 0) {
        const ws = fallbackWorkspace()
        for (const { card, workspace } of ocResults) {
          card.loopSignals = detectLoopSignals(card)
          card.oneShotStats = computeOneShotStats(card)
          writer!.enqueue(card, workspace || ws)
          void cloud.enqueueSession(
            { ...card, workspace: workspace || ws },
            m => outputChannel?.appendLine(m),
          )
        }
        countByKey.set('opencode', (countByKey.get('opencode') ?? 0) + ocResults.length)
      }

      const fastFiles = allFiles.filter(f => f.agentKey !== 'copilot_vscode_json' && f.agentKey !== 'opencode')
      const slowFiles = allFiles.filter(f => f.agentKey === 'copilot_vscode_json')
      // Drives the dashboard's progress banner (see DashboardPanel.setLogIngestProgress).
      const progress = { done: 0, total: fastFiles.length + slowFiles.length }
      DashboardPanel.setLogIngestProgress(progress)

      // Saves are coalesced (saveSoon), so the cross-window signal and the processed-files record
      // wait for the save that actually covers everything enqueued so far.
      const afterSaved = (after: (saved: boolean) => void) => {
        void writer!.drain().then(() => traceRoostDb!.saveSoon(after))
          .catch(err => outputChannel!.appendLine(`[TraceRoost] Log ingestion drain error: ${err}`))
      }

      processGroup(fastFiles, 10, 0, () => {
        afterSaved(saved => { if (saved) writeLastWriteSignal(context.globalStorageUri) })
        // Slow-pass: legacy .json snapshots loaded at low priority after fast pass completes.
        processGroup(slowFiles, 2, 50, () => {
          DashboardPanel.setLogIngestProgress(null)
          afterSaved(saved => {
            if (saved) writeLastWriteSignal(context.globalStorageUri)
            persistFileState()
          })
          DashboardPanel.refreshSoon()
          const total = [...countByKey.values()].reduce((s, n) => s + n, 0)
          if (total > 0) {
            const breakdown = [...countByKey.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => `${AGENT_KEY_LABEL[k] ?? k}: ${n}`)
              .join(', ')
            outputChannel!.appendLine(`[TraceRoost] Loaded ${total} sessions from local logs (${breakdown})`)
          }
          onAllDone?.()
        })
      })
    }

    // Defer off the activation stack so activation itself completes instantly.
    setImmediate(() => {
      startBatchedLoad!(() => { void writer!.drain().then(() => { traceStoreReady = true }) })
      pollClaudePlanUsage()
    })
    logReaderTimer = setInterval(runLogScan, 30_000)
    context.subscriptions.push({ dispose: () => clearInterval(logReaderTimer) })
    outputChannel.appendLine('TraceRoost: log ingestion enabled — scanning local trace logs')
  }

  if (!logReader) traceStoreReady = true // nothing to load from logs

  if (collectorFailed || (traceRoostDb && !traceRoostDb.isOwner)) {
    // Non-collector (or read-only database) window: poll the last-write signal; refresh from a
    // DB snapshot when it changes.
    let lastKnownWriteMs = readLastWriteMs(context.globalStorageUri)
    const pollTimer = setInterval(() => {
      const latest = readLastWriteMs(context.globalStorageUri)
      if (latest > lastKnownWriteMs) {
        lastKnownWriteMs = latest
        // Re-open a fresh snapshot of the DB written by the collector window.
        const snapshotReader = openReadonlySnapshot(
          context.globalStorageUri.fsPath,
          context.globalStorageUri,
          context.extensionUri.fsPath,
          traceRoostDb?.sqlFactory,
        )
        if (snapshotReader && store) {
          const snapshotWriter = writer ?? new DatabaseWriter(traceRoostDb!.raw, context.globalStorageUri, () => {})
          repository = new SessionRepository(snapshotReader, snapshotWriter, store, (msg) => outputChannel!.appendLine(msg))
          provider.setRepository(repository)
          DashboardPanel.setRepository(repository)
          provider.refresh()
        }
      }
    }, 2000)
    context.subscriptions.push({ dispose: () => clearInterval(pollTimer) })
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('traceRoost.dashboard', provider)
  )

  // ── Commands ─────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('traceRoost.showStorageStats', () => {
      if (!traceRoostDb || !repository) {
        vscode.window.showInformationMessage('TraceRoost: database not available')
        return
      }
      const dbPath = path.join(context.globalStorageUri.fsPath, 'traceroost.db')
      const { dbBytes, blobBytes, blobCount } = repository.getStorageStats(dbPath, traceRoostDb.blobsDir)
      const lifetime = repository.queryLifetimeStats()
      const toMb = (b: number) => (b / 1_048_576).toFixed(1)
      const dateRange = lifetime.totalSessions > 0
        ? `${new Date(lifetime.oldestSessionMs).toISOString().slice(0, 10)} → ${new Date(lifetime.newestSessionMs).toISOString().slice(0, 10)}`
        : 'no traces'
      const retentionDays = vscode.workspace.getConfiguration('traceRoost').get<number>('sessionRetentionDays', 90)
      const msg = [
        `Database:  ${toMb(dbBytes)} MB  (${lifetime.totalSessions} sessions, ${dateRange})`,
        `Blobs:     ${toMb(blobBytes)} MB  (${blobCount} files)`,
        `Total:     ${toMb(dbBytes + blobBytes)} MB`,
        `Retention: ${retentionDays} days`,
      ].join('\n')
      outputChannel!.appendLine('\nTraceRoost storage stats:\n' + msg)
      outputChannel!.show(true)
      vscode.window.showInformationMessage(`TraceRoost storage: ${toMb(dbBytes + blobBytes)} MB total — see Output panel for details.`)
    })
  )

  const instructionRepo = traceRoostDb ? new InstructionRepository(traceRoostDb.raw) : undefined

  context.subscriptions.push(
    vscode.commands.registerCommand('traceRoost.openDashboard', () => {
      vscode.commands.executeCommand('workbench.view.extension.traceroost')
      DashboardPanel.show(context, repo, provider, instructionRepo, traceRoostDb?.raw, reconciliationService)
    })
  )

  // A literal `process.env.TRACEROOST_EDITION` check (esbuild.js defines it) rather than
  // `cloud.edition`, so the core build drops registerOrgCommands and its strings entirely.
  if (process.env.TRACEROOST_EDITION !== 'core') registerOrgCommands(context)
  registerUriHandler(context, repo)

  context.subscriptions.push(
    vscode.commands.registerCommand('traceRoost.dumpSpanAttrs', () => {
      const spans = store!.getSpans()
      outputChannel!.clear()
      outputChannel!.appendLine('=== TraceRoost span attribute dump ===')
      outputChannel!.appendLine(`Total spans in window: ${spans.length}`)
      outputChannel!.appendLine('')

      const names = [...new Set(spans.map(s => s.name))].sort()
      outputChannel!.appendLine(`Span names seen: ${names.join(', ')}`)
      outputChannel!.appendLine('')

      function dumpSpan(span: { name: string; attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number; boolValue?: boolean } }> }) {
        outputChannel!.appendLine(`[${span.name}]`)
        for (const attr of span.attributes ?? []) {
          const val = attr.value?.stringValue ?? attr.value?.intValue ?? attr.value?.doubleValue ?? attr.value?.boolValue
          if (val === undefined || val === null) { continue }
          const strVal = String(val)
          outputChannel!.appendLine(`  ${attr.key} = ${strVal.length > 300 ? strVal.slice(0, 300) + '…' : strVal}`)
        }
        outputChannel!.appendLine('')
      }

      const codexByType = new Map<string, typeof spans[0]>()
      for (const s of spans) {
        if (s.name.startsWith('codex.') && !codexByType.has(s.name)) codexByType.set(s.name, s)
      }
      outputChannel!.appendLine('--- Codex span types (one example each) ---')
      for (const s of codexByType.values()) dumpSpan(s)

      const claudeSpans = spans.filter(s =>
        s.name === 'claude_code.llm_request' || s.name === 'claude_code.tool' || s.name === 'claude_code.tool_result'
      ).slice(-5)
      outputChannel!.appendLine('--- Claude LLM + tool spans (last 5 each) ---')
      for (const s of claudeSpans) dumpSpan(s)

      outputChannel!.show(true)
      vscode.window.showInformationMessage(`TraceRoost: dumped ${codexByType.size} Codex span types + ${claudeSpans.length} Claude spans`)
    })
  )

  async function runExport(exporter: typeof exportSpans) {
    const spans = store!.getSpans()
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    const baseUri = workspaceFolder ? workspaceFolder.uri : context.globalStorageUri
    const writtenFiles = await exporter(spans, baseUri)
    if (writtenFiles.length === 0) {
      vscode.window.showInformationMessage('TraceRoost: No trace data to export')
      return
    }
    vscode.window.showInformationMessage(`TraceRoost: Exported to: ${writtenFiles.join(', ')}`)
    for (const fname of writtenFiles) {
      const uri = vscode.Uri.joinPath(baseUri, fname)
      const doc = await vscode.workspace.openTextDocument(uri)
      vscode.window.showTextDocument(doc, { preview: false })
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('traceRoost.exportData', () => runExport(exportSpans))
  )
  context.subscriptions.push(
    vscode.commands.registerCommand('traceRoost.exportDataRedacted', () => runExport(exportSpansRedacted))
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('traceRoost.clearSessions', () => {
      if (!repository || !writer) return
      // Clear DB and live span window
      repository.clearAll()
      store?.clear()
      traceRoostDb?.save()
      // Re-ingest from local log files so log-sourced sessions reappear immediately
      // Refresh both panels to show the cleared state before re-ingestion starts.
      provider.refresh()
      if (repository) DashboardPanel.setRepository(repository)
      if (logReader && startBatchedLoad) {
        traceStoreReady = false
        logReader.clearFileState()
        // 5 s delay so the cleared state is visible before log sessions flow back in.
        // When all files are loaded, do a final refresh so the dashboard reflects
        // the fully re-ingested state.
        setTimeout(() => startBatchedLoad!(() => {
          provider.refresh()
          if (repository) DashboardPanel.setRepository(repository)
          void writer?.drain().then(() => { traceStoreReady = true })
        }), 5000)
      }
      writeLastWriteSignal(context.globalStorageUri)
    })
  )

  // ── Reactive configuration changes ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      const cfg = vscode.workspace.getConfiguration('traceRoost')
      if (e.affectsConfiguration('traceRoost.enableOtelIngestion') && collector) {
        collector.setIngestionEnabled(cfg.get<boolean>('enableOtelIngestion', true))
      }
      if (e.affectsConfiguration('traceRoost.enableLogIngestion')) {
        const enabled = cfg.get<boolean>('enableLogIngestion', true)
        if (!enabled) {
          clearInterval(logReaderTimer)
          logReaderTimer = undefined
        } else if (!logReaderTimer && runLogScanFn) {
          logReaderTimer = setInterval(runLogScanFn, 30_000)
          runLogScanFn()
        }
      }
      if (
        e.affectsConfiguration('traceRoost.enableOtelIngestion') ||
        e.affectsConfiguration('traceRoost.enableLogIngestion')
      ) {
        DashboardPanel.currentPanel?.update()
      }
    })
  )

  // ── MCP server ───────────────────────────────────────────────────────────────
  const enableMcp = vscode.workspace.getConfiguration('traceRoost').get<boolean>('enableMcpServer', true)
  if (enableMcp) {
    const mcpPort = vscode.workspace.getConfiguration('traceRoost').get<number>('mcpPort', 4316)
    try {
      const mcpServer = await startMcpHttpServer(
        { getSessions: () => repository?.listSessions() ?? [],
          getTimeline: (id) => repository?.loadSessionTimeline(id) ?? [] },
        mcpPort,
        '127.0.0.1',
        '',
        (requested, bound) => outputChannel!.appendLine(`[TraceRoost] Port ${requested} (MCP) was in use — using ${bound} instead.`),
      )
      context.subscriptions.push({ dispose: () => mcpServer.close() })
      const boundMcpPort = (mcpServer.address() as { port: number }).port
      DashboardPanel.boundMcpPort = boundMcpPort
      outputChannel.appendLine(`TraceRoost MCP server → http://127.0.0.1:${boundMcpPort}/mcp`)
    } catch (err) {
      outputChannel.appendLine(`Failed to start MCP server on port ${mcpPort}: ${err}`)
      vscode.window.showErrorMessage(`TraceRoost: Could not start the MCP server (port ${mcpPort} and nearby ports are all in use). Set traceRoost.mcpPort to a free port.`)
    }
  }

  // ── Cloud: forwarding scheduler ───────────────────────────────────────────────
  // No timer runs unless an org is linked; `syncToLinkState` starts/stops it after link/leave.
  forwardScheduler = cloud.startForwardScheduler({
    notify: (message, kind) => {
      if (kind === 'warning') vscode.window.showWarningMessage(message)
      else vscode.window.showInformationMessage(message)
    },
    log: (msg) => outputChannel?.appendLine(msg),
    onDrainStart: () => DashboardPanel.pushOrgStatus(),
    onDrainComplete: () => DashboardPanel.pushOrgStatus(),
    recordSent: (count, at) => {
      repository?.recordTraceSent(count, at)
      traceRoostDb?.saveSoon()
    },
    // Only the window that owns the database sends it (see TraceRoostDb), once it is loaded.
    traceManifest: {
      isWriter: () => !!traceRoostDb && traceRoostDb.isOwner && !traceRoostDb.loadError,
      isReady: () => traceStoreReady && !!repository,
      localHorizonMs: () => repository?.localHorizonMs() ?? null,
      listTraceKeys: (fromMs, toMs) => repository?.listTraceKeys(fromMs, toMs) ?? [],
      countTraces: (fromMs, toMs) => repository?.countTraces(fromMs, toMs) ?? 1,
    },
  })
  context.subscriptions.push({ dispose: () => forwardScheduler?.dispose() })

  // A link made outside this window (`traceroost org link`, another window or server sharing
  // ~/.traceroost) would otherwise go unnoticed until a reload: no forwarding timer, and no
  // history queued. Same owner/readiness gate as the trace manifest above.
  const linkWatcher = cloud.startLinkWatcher({
    allLocalSessions: () => repository?.listSessions({ limit: Infinity }) ?? [],
    isWriter: () => !!traceRoostDb && traceRoostDb.isOwner && !traceRoostDb.loadError,
    isReady: () => traceStoreReady && !!repository,
    log: (msg) => outputChannel?.appendLine(msg),
    onLinkStateChange: () => DashboardPanel.pushOrgStatus(),
  })
  context.subscriptions.push(linkWatcher)

  // ── Cloud: pricing sync ────────────────────────────────────────────────────────
  // Same "no timer unless linked" invariant as the forwarding scheduler above, on its own
  // (longer) interval — see pricingSync.ts for why it isn't just piggybacked on the drain cadence.
  const pricingSync = cloud.startPricingSync({ onSync: () => DashboardPanel.pushOrgStatus() })
  context.subscriptions.push({ dispose: () => pricingSync.dispose() })

  // ── Status bar ───────────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = 'traceRoost.openDashboard'
  statusBar.tooltip = 'Open TraceRoost Dashboard'
  context.subscriptions.push(statusBar)

  function updateStatusBar() {
    if (collectorConflict) {
      statusBar.text = '$(warning) TraceRoost — not receiving OTel'
      statusBar.color = new vscode.ThemeColor('statusBarItem.warningForeground')
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
    } else {
      // collectorFailed alone means another VS Code window already runs the collector and this
      // window reads the shared database — normal operation, so no suffix, just a tooltip hint.
      statusBar.text = '$(graph) TraceRoost'
      statusBar.tooltip = collectorFailed
        ? 'Open TraceRoost Dashboard (collector running in another VS Code window)'
        : 'Open TraceRoost Dashboard'
      statusBar.color = undefined
      statusBar.backgroundColor = undefined
    }
    statusBar.show()
  }

  updateStatusBar()
  context.subscriptions.push(store.onUpdate(updateStatusBar))

  if (collectorConflict) {
    // Already logged/shown in detail where collectorConflict was set, above.
  } else if (collectorFailed) {
    outputChannel.appendLine('TraceRoost active — collector already running in another VS Code window; sharing its database')
  } else {
    vscode.window.showInformationMessage(`TraceRoost active — listening on port ${port}`)
    outputChannel.appendLine(`TraceRoost active — OTLP collector listening on port ${port}`)
  }
  outputChannel.show(true)

  notifySetupRequired(context, copilotResult.changed, claudeResult.changed, codexResult.changed)
}

// ── Org (TraceRoost Cloud) commands ───────────────────────────────────────────
//
// Every capability here is inert until an org is explicitly linked. Registering the commands
// does nothing on its own — `getOrgStatus()` and `loadCredentials()` touch only local disk.

function registerOrgCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('traceRoost.orgLink', async () => {
      if (cloud.orgStatus().linked) {
        vscode.window.showInformationMessage('TraceRoost: this machine is already linked. Run "TraceRoost: Unlink" first to re-link.')
        return
      }
      const proceed = await vscode.window.showInformationMessage(
        'Link this machine to a TraceRoost Cloud org?\n\nSent: ' + cloud.privacy.sent.join('; ') + '.\n\nNever sent: ' + cloud.privacy.neverSent.join('; ') + '.',
        { modal: true },
        'Open browser to link',
      )
      if (proceed !== 'Open browser to link') return
      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'TraceRoost: waiting for browser approval…' },
          () => cloud.link({ openUrl: (url: string) => { void vscode.env.openExternal(vscode.Uri.parse(url)) } }),
        )
        vscode.window.showInformationMessage(`TraceRoost: linked to ${result.orgName} as ${result.role}.`)
        forwardScheduler?.syncToLinkState()
        DashboardPanel.currentPanel?.update()
      } catch (err) {
        vscode.window.showErrorMessage(`TraceRoost: link failed — ${(err as Error).message}. Nothing was changed.`)
      }
    }),
    vscode.commands.registerCommand('traceRoost.orgStatus', () => {
      const s = cloud.orgStatus(true)
      vscode.window.showInformationMessage(
        s.linked
          ? `TraceRoost Cloud: linked to ${s.orgName} as ${s.role}. Queue depth ${s.queueDepth ?? 0}, last trace ${s.lastRollupAt ?? 'none yet'}.`
          : 'TraceRoost Cloud: not linked. TraceRoost is working locally and sending nothing anywhere.',
      )
    }),
    vscode.commands.registerCommand('traceRoost.orgLeave', async () => {
      if (!cloud.orgStatus().linked) {
        vscode.window.showInformationMessage('TraceRoost: this machine is not linked.')
        return
      }
      const confirm = await vscode.window.showWarningMessage(
        'Unlink this machine from TraceRoost Cloud? The local credential is deleted and this machine stops forwarding immediately. This does not remove you from the org — a lead can still see you on the roster until they remove you there.',
        { modal: true },
        'Unlink',
      )
      if (confirm !== 'Unlink') return
      const res = await cloud.leave()
      vscode.window.showInformationMessage(
        res.serverRevoked
          ? 'TraceRoost: unlinked. This machine has stopped forwarding.'
          : 'TraceRoost: unlinked locally. Could not reach the server to revoke the token — it will be revoked on next contact, or by a lead from the roster.',
      )
      forwardScheduler?.syncToLinkState()
      DashboardPanel.currentPanel?.update()
    }),
  )
}

// ── Deep links (AL 08 / AL 09) ──────────────────────────────────────────────
//
// Routed through VS Code's own `vscode://<publisher>.<extension-id>/<path>?<query>` scheme —
// there is no separately-registered custom `traceroost://` or `agentlens://` protocol anywhere,
// only what `registerUriHandler` below catches. The extension's marketplace identity is frozen at
// `agentlens.agentlens-dashboard` (see RELEASING.md), so the real, working links are:
// `vscode://agentlens.agentlens-dashboard/advise?id=<hashed-or-raw-suggestion-id>` and
// `vscode://agentlens.agentlens-dashboard/cohort?repo=<hash>&merged=<YYYY-MM>&window=<30|90>`
// (built by `traceroost/cloud`'s `vscodeDeepLink()`, `src/lib/deepLink.ts` — cloud previously
// generated a bare `traceroost://...` link here that nothing registered and silently did nothing
// when clicked; fixed 2026-09-16). A link from an untrusted source can only cause a local view
// change — never a network call, never a write. Every parameter is validated for shape before
// use, and the cohort hand-off resolves hashes only for repositories on this machine (it is not
// an oracle for testing hashes against).

const HASH_RE = /^[a-f0-9]{64}$/
const MONTH_RE = /^\d{4}-\d{2}$/

function registerUriHandler(context: vscode.ExtensionContext, repo: SessionRepository): void {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        const params = new URLSearchParams(uri.query)
        const kind = uri.path.replace(/^\//, '') || uri.authority

        if (kind === 'advise') {
          const id = (params.get('id') ?? '').trim()
          if (!HASH_RE.test(id) && !/^[a-z0-9:_]{1,120}$/i.test(id)) {
            vscode.window.showWarningMessage('TraceRoost: that advise link is malformed.')
            return
          }
          vscode.commands.executeCommand('traceRoost.openDashboard')
          setTimeout(() => {
            DashboardPanel.switchToTab('patterns')
            DashboardPanel.currentPanel?.postToWebview({ type: 'focusSuggestion', id })
          }, 250)
          return
        }

        if (kind === 'patterns') {
          const repoHash = (params.get('repo') ?? '').trim()
          if (!HASH_RE.test(repoHash)) {
            vscode.window.showWarningMessage('TraceRoost: that patterns link is malformed.')
            return
          }
          void (async () => {
            const workspaces = [
              ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
              ...new Set(repo.listSessions().map(s => s.workspace).filter(Boolean)),
            ]
            const root = await cloud.resolveRepoHash(repoHash, workspaces)
            if (!root) {
              vscode.window.showInformationMessage('TraceRoost: that repository is not on this machine. Nothing was requested.')
              return
            }
            vscode.commands.executeCommand('traceRoost.openDashboard')
            setTimeout(() => {
              DashboardPanel.switchToTab('patterns')
              DashboardPanel.sendFilter(undefined, undefined, root)
            }, 250)
          })()
          return
        }

        if (kind === 'cohort') {
          const repoHash = (params.get('repo') ?? '').trim()
          const merged = (params.get('merged') ?? '').trim()
          const window = (params.get('window') ?? '90').trim()
          if (!HASH_RE.test(repoHash) || !MONTH_RE.test(merged) || (window !== '30' && window !== '90')) {
            vscode.window.showWarningMessage('TraceRoost: that cohort link is malformed.')
            return
          }
          void (async () => {
            const workspaces = [
              ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
              ...new Set(repo.listSessions().map(s => s.workspace).filter(Boolean)),
            ]
            const root = await cloud.resolveRepoHash(repoHash, workspaces)
            if (!root) {
              vscode.window.showInformationMessage('TraceRoost: that cohort is for a repository this machine does not have. Nothing was requested.')
              return
            }
            vscode.commands.executeCommand('traceRoost.openDashboard')
            setTimeout(() => {
              DashboardPanel.switchToTab('outcomes')
              DashboardPanel.currentPanel?.postToWebview({ type: 'focusCohort', repoRoot: root, merged, windowDays: Number(window) })
            }, 250)
          })()
          return
        }

        if (kind === 'find') {
          // One hash, two possible shapes (findCli.ts's own classify()): a session/trace id
          // (an exact match against this machine's recorded sessions) or a repo_hash (resolved
          // the same way 'patterns' above does). `reporter` is optional — cloud embeds the
          // trace's reporting member's email when it has one (traces-table.tsx), purely so a
          // miss here can point at the right machine instead of a bare "not found".
          const hash = (params.get('hash') ?? params.get('repo') ?? params.get('id') ?? '').trim()
          const reporter = (params.get('reporter') ?? '').trim()
          if (!hash) {
            vscode.window.showWarningMessage('TraceRoost: that find link is malformed.')
            return
          }
          const elsewhereHint = reporter
            ? ` It may be on ${reporter}'s linked machine instead of this one.`
            : ' It may be on a different linked machine.'
          void (async () => {
            const session = repo.listSessions().find(s => matchesTraceId(s, hash))
            if (session) {
              vscode.commands.executeCommand('traceRoost.openDashboard')
              setTimeout(() => {
                DashboardPanel.switchToTab('sessions')
                DashboardPanel.sendFilter(undefined, undefined, undefined, hash)
              }, 250)
              return
            }
            if (HASH_RE.test(hash)) {
              const workspaces = [
                ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
                ...new Set(repo.listSessions().map(s => s.workspace).filter(Boolean)),
              ]
              const root = await cloud.resolveRepoHash(hash, workspaces)
              if (root) {
                vscode.commands.executeCommand('traceRoost.openDashboard')
                setTimeout(() => {
                  DashboardPanel.switchToTab('patterns')
                  DashboardPanel.sendFilter(undefined, undefined, root)
                }, 250)
                return
              }
            }
            vscode.window.showInformationMessage(
              `TraceRoost: that hash/id isn't recorded on this machine.${elsewhereHint}`,
            )
          })()
          return
        }

        vscode.window.showWarningMessage(`TraceRoost: unrecognised link ${uri.toString()}`)
      },
    }),
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal repository shim used when the DB is unavailable. */
function fallbackRepository(store: SessionStore): SessionRepository {
  const noop = {
    run: () => {},
    exec: () => [],
    prepare: () => ({ run: () => {}, step: () => false, get: () => [], reset: () => {}, free: () => {} }),
  }
  const noopStorageUri = vscode.Uri.file('/tmp')
  const fakeReader = new DatabaseReader(noop, noopStorageUri)
  const fakeWriter = new DatabaseWriter(noop, noopStorageUri, () => {})
  return new SessionRepository(fakeReader, fakeWriter, store)
}

async function notifySetupRequired(
  context: vscode.ExtensionContext,
  copilotChanged: boolean,
  claudeChanged: boolean,
  codexChanged: boolean
) {
  if (!copilotChanged && !claudeChanged && !codexChanged) { return }

  const isFirstInstall = !context.globalState.get<string>('traceRoost.installedVersion')
  if (isFirstInstall) {
    context.globalState.update('traceRoost.installedVersion', context.extension.packageJSON.version)
  }

  const parts: string[] = []
  if (copilotChanged) { parts.push('Reload VS Code to activate Copilot tracing.') }
  const cliAgents = [claudeChanged && 'Claude', codexChanged && 'Codex'].filter(Boolean).join(' and ')
  if (cliAgents) { parts.push(`Restart ${cliAgents} in your terminal to activate CLI tracing.`) }

  const message = `TraceRoost: Telemetry configured. ${parts.join(' ')}`
  const actions = copilotChanged ? ['Reload VS Code'] : []

  const action = await vscode.window.showInformationMessage(message, ...actions)
  if (action === 'Reload VS Code') {
    vscode.commands.executeCommand('workbench.action.reloadWindow')
  }
}

// ── Duplicate-install guard ───────────────────────────────────────────────────

const SIBLING_ID: Record<string, string> = {
  'traceroost.traceroost': 'agentlens.agentlens-dashboard',
  'agentlens.agentlens-dashboard': 'traceroost.traceroost',
}

/**
 * Returns true when this activation should bail out — i.e. this is the old
 * `agentlens.agentlens-dashboard` copy and the new `traceroost.traceroost` is
 * also installed. When it's the other way round (we're the new one, the old one
 * is also present) we run normally but nudge the user once to uninstall the old
 * listing.
 */
async function handleDuplicateInstall(context: vscode.ExtensionContext): Promise<boolean> {
  const selfId = context.extension.id.toLowerCase()
  const siblingId = SIBLING_ID[selfId]
  if (!siblingId || !vscode.extensions.getExtension(siblingId)) { return false }

  const showOldExtension = () =>
    void vscode.commands.executeCommand(
      'workbench.extensions.search', '@installed agentlens.agentlens-dashboard',
    )

  if (selfId === 'agentlens.agentlens-dashboard') {
    outputChannel?.appendLine(
      'Standing down: traceroost.traceroost is installed and handles everything. ' +
      'This listing (agentlens.agentlens-dashboard) can be uninstalled.',
    )
    const notifiedKey = 'traceRoost.duplicateNotice'
    if (!context.globalState.get<boolean>(notifiedKey)) {
      void context.globalState.update(notifiedKey, true)
      void vscode.window.showInformationMessage(
        'AgentLens and TraceRoost are the same extension. TraceRoost is now active — ' +
        'you can uninstall "AgentLens" (agentlens.agentlens-dashboard).',
        'Show Extension',
      ).then(pick => { if (pick === 'Show Extension') { showOldExtension() } })
    }
    return true
  }

  // We are traceroost.traceroost and the old listing is also installed.
  const notifiedKey = 'traceRoost.duplicateNotice'
  if (!context.globalState.get<boolean>(notifiedKey)) {
    void context.globalState.update(notifiedKey, true)
    void vscode.window.showWarningMessage(
      'Both TraceRoost and the older AgentLens extension are installed — they are the same ' +
      'extension. Uninstall "AgentLens" (agentlens.agentlens-dashboard) to avoid duplicate ' +
      'views and port conflicts.',
      'Show Extension',
    ).then(pick => { if (pick === 'Show Extension') { showOldExtension() } })
  }
  return false
}

// ── Deactivate ────────────────────────────────────────────────────────────────

export async function deactivate() {
  DashboardPanel.disposePanel()
  if (collector) { await collector.stop() }
  if (writer) { await writer.drain() }
}
