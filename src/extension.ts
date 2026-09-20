import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { OtlpCollector } from './otlpCollector'
import { detectPortOwner } from './portResolver'
import { SessionStore } from './sessionStore'
import { SidebarPanel } from './sidebarPanel'
import { DashboardPanel } from './dashboardPanel'
import { autoConfigureCopilot, autoConfigureClaudeCode, autoConfigureCodex } from './autoConfig'
import { exportSpans, exportSpansRedacted } from './exportData'
import { openDatabase, TraceRoostDb } from './database/db'
import { DatabaseReader, openReadonlySnapshot } from './database/reader'
import { DatabaseWriter } from './database/writer'
import { migrateGlobalStateToSqlite } from './database/migration'
import { runRetention } from './database/retention'
import { SessionRepository } from './sessionRepository'
import { summarizeSpans } from './spanSummarizer'
import { LogReader, type FileState } from './logReader'
import { detectLoopSignals } from './loopDetector'
import { computeOneShotStats } from './oneShotRate'
import { startMcpHttpServer } from './mcpServer'
import { InstructionRepository } from './database/instructionRepository'
import { linkInteractive, leave } from './cloud/team/link'
import { getTeamStatus } from './cloud/team/status'
import { SENT, NEVER_SENT } from './cloud/team/privacy'
import { getQueueStats } from './cloud/forward/currentQueueStats'
import { maybeEnqueueSession } from './cloud/team/enqueueSession'
import { maybeEnqueueInstructionTelemetry, EMPTY_LEDGER } from './cloud/team/instructionTelemetry'
import { startForwardScheduler, type ForwardScheduler } from './cloud/forward/scheduler'
import { startPricingSync } from './cloud/team/pricingSync'
import { resolveRepoHash } from './cloud/team/resolveRepoHash'

let collector: OtlpCollector | undefined
let store: SessionStore | undefined
let outputChannel: vscode.OutputChannel | undefined
let traceRoostDb: TraceRoostDb | undefined
let writer: DatabaseWriter | undefined
let repository: SessionRepository | undefined
let logReaderTimer: ReturnType<typeof setInterval> | undefined
let runLogScanFn: (() => void) | undefined
let forwardScheduler: ForwardScheduler | undefined

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

// ── Log-reader file-state persistence ────────────────────────────────────────
//
// Without this, every extension activation re-parses every historical source-tool log file from
// scratch — LogReader.fileState is an in-memory Map that starts empty on every process start. This
// is pure waste today, at current scale, for anyone with more than a few weeks of log history, so
// it's fixed unconditionally rather than gated behind the stress-test in scalability.md. See
// .staged-issues/scalability.md, risk #1.

const LOG_FILE_STATE_FILENAME = 'log-file-state.json'

function readLogFileState(storageUri: vscode.Uri): Record<string, FileState> {
  try {
    const filePath = path.join(storageUri.fsPath, LOG_FILE_STATE_FILENAME)
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as Record<string, FileState>
  } catch {
    return {}
  }
}

function writeLogFileState(storageUri: vscode.Uri, state: Record<string, FileState>): void {
  try {
    const filePath = path.join(storageUri.fsPath, LOG_FILE_STATE_FILENAME)
    fs.writeFileSync(filePath, JSON.stringify(state))
  } catch { /* non-fatal — worst case, the next activation re-parses from scratch */ }
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

  // ── Database ────────────────────────────────────────────────────────────────
  try {
    traceRoostDb = await openDatabase(
      context.globalStorageUri.fsPath,
      context.extensionUri.fsPath,
    )
    context.subscriptions.push(traceRoostDb)
    outputChannel.appendLine('TraceRoost database initialized.')
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

  // ── Writer + reader + repository ─────────────────────────────────────────────
  if (traceRoostDb) {
    const log = (msg: string) => outputChannel!.appendLine(msg)
    writer = new DatabaseWriter(traceRoostDb.raw, context.globalStorageUri, log)
    const reader = new DatabaseReader(traceRoostDb.raw, context.globalStorageUri)
    repository = new SessionRepository(reader, writer, store, log)

    // Run one-time migration before registering the onUpdate subscriber.
    await migrateGlobalStateToSqlite(context, writer, log)

    // Initial retention run on activation.
    const retentionDays = vscode.workspace.getConfiguration('traceRoost').get<number>('sessionRetentionDays', 90)
    await runRetention(traceRoostDb.raw, retentionDays, traceRoostDb.blobsDir, log)

    // Periodic retention: once per 24 hours while the extension is active.
    const retentionTimer = setInterval(() => {
      const days = vscode.workspace.getConfiguration('traceRoost').get<number>('sessionRetentionDays', 90)
      void runRetention(traceRoostDb!.raw, days, traceRoostDb!.blobsDir, log)
    }, 24 * 60 * 60 * 1000)
    context.subscriptions.push({ dispose: () => clearInterval(retentionTimer) })

    context.subscriptions.push(
      store.onUpdate((traceId) => {
        if (!traceId || !writer || !repository) return
        const { sessions } = summarizeSpans(store!.getSpans())
        const card = sessions.find(s => s.traceId === traceId)
        if (card && !card.sessionId.startsWith('synth-')) {
          const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
          writer.deleteSynthSession(card.traceId)
          writer.enqueue(card, workspace)
          // After drain, save DB to disk and write the cross-window signal.
          void writer.drain().then(() => {
            traceRoostDb?.save()
            writeLastWriteSignal(context.globalStorageUri)
          }).catch(err => console.error('[TraceRoost] writer.drain error:', err))
          // Pro: build a rollup for this session and append it to the forwarding queue. A hard
          // no-op unless a team is linked. The actual network send happens later, on a timer.
          void maybeEnqueueSession({ ...card, workspace: card.workspace || workspace }, m => outputChannel?.appendLine(m))
            .then(r => { if (r.enqueued) forwardScheduler?.drainSoon() })
          if (workspace) {
            void maybeEnqueueInstructionTelemetry(workspace, repository!.listSessions(), EMPTY_LEDGER)
              .then(enq => { if (enq) forwardScheduler?.drainSoon() })
              .catch(() => { /* best-effort */ })
          }
        }
      })
    )

  }

  // ── Collector ────────────────────────────────────────────────────────────────
  const traceRoostCfg = vscode.workspace.getConfiguration('traceRoost')
  const port = traceRoostCfg.get<number>('otlpPort', 4318)
  collector = new OtlpCollector(port, store, outputChannel)
  let collectorFailed = false
  try {
    await collector.start()
    collector.setIngestionEnabled(traceRoostCfg.get<boolean>('enableOtelIngestion', true))
  } catch (err) {
    collectorFailed = true
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const owner = await detectPortOwner(port)
      if (owner === 'standalone') {
        outputChannel.appendLine(`Port ${port} is in use by the TraceRoost standalone server — change traceRoost.otlpPort`)
        vscode.window.showErrorMessage(
          `TraceRoost: Port ${port} is already in use by the TraceRoost standalone server. Change the traceRoost.otlpPort setting to use a different port.`
        )
      } else if (owner === 'foreign') {
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

  // ── Log ingestion ─────────────────────────────────────────────────────────
  const enableLogIngestion = vscode.workspace.getConfiguration('traceRoost').get<boolean>('enableLogIngestion', true)
  let logReader: LogReader | undefined
  let startBatchedLoad: ((onAllDone?: () => void) => void) | undefined
  if (enableLogIngestion && writer) {
    logReader = new LogReader({ log: (msg) => outputChannel!.appendLine(msg), sqlFactory: traceRoostDb?.sqlFactory })
    logReader.importFileState(readLogFileState(context.globalStorageUri))
    const lr = logReader  // non-null alias for use inside closures
    const persistFileState = () => writeLogFileState(context.globalStorageUri, lr.exportFileState())
    const fallbackWorkspace = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''

    // Periodic incremental scan: only picks up files that have changed since last run.
    const runLogScan = runLogScanFn = () => {
      const results = lr.scan()
      if (results.length === 0) return
      const ws = fallbackWorkspace()
      for (const { card, workspace } of results) {
        card.loopSignals = detectLoopSignals(card)
        card.oneShotStats = computeOneShotStats(card)
        writer!.enqueue(card, workspace || ws)
      }
      void writer!.drain().then(() => {
        traceRoostDb?.save()
        provider.refresh()
        DashboardPanel.currentPanel?.update()
        writeLastWriteSignal(context.globalStorageUri)
        persistFileState()
      }).catch(err => outputChannel!.appendLine(`[TraceRoost] log ingestion drain error: ${err}`))
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
        outputChannel!.appendLine(`[TraceRoost] log ingestion collect error: ${err}`)
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
            try {
              // Usually one result; a Claude Code transcript split by a large gap between
              // prompts (see splitClaudeLinesOnPromptGaps) can yield more than one.
              const results = lr.parseFile(files[i].filePath, files[i].agentKey)
              for (const result of results) {
                result.card.loopSignals = detectLoopSignals(result.card)
                result.card.oneShotStats = computeOneShotStats(result.card)
                writer!.enqueue(result.card, result.workspace || ws)
                const dk = files[i].agentKey === 'copilot_vscode_json' ? 'copilot_vscode' : files[i].agentKey
                countByKey.set(dk, (countByKey.get(dk) ?? 0) + 1)
                written++
                // Pro: enqueue this session for forwarding. Hard no-op unless a team is
                // linked. Has to happen in this one-time historical load, not only wherever
                // a live session close triggers it — lr.parseFile() above records this
                // file's mtime/size into the same LogReader's fileState that a later
                // incremental scan checks for "has this changed", so a historical file read
                // here first makes it permanently invisible to that scan as "new" (see the
                // matching fix and its longer note in standalone/server.ts).
                void maybeEnqueueSession(
                  { ...result.card, workspace: result.workspace || ws },
                  m => outputChannel?.appendLine(m),
                )
              }
            } catch { /* skip bad file */ }
          }
          if (written > 0) {
            void writer!.drain().then(() => {
              traceRoostDb?.save()
              provider.refresh()
            }).catch(err => outputChannel!.appendLine(`[TraceRoost] log ingestion drain error: ${err}`))
          }
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
          void maybeEnqueueSession(
            { ...card, workspace: workspace || ws },
            m => outputChannel?.appendLine(m),
          )
        }
        countByKey.set('opencode', (countByKey.get('opencode') ?? 0) + ocResults.length)
      }

      const fastFiles = allFiles.filter(f => f.agentKey !== 'copilot_vscode_json' && f.agentKey !== 'opencode')
      const slowFiles = allFiles.filter(f => f.agentKey === 'copilot_vscode_json')

      processGroup(fastFiles, 10, 0, () => {
        writeLastWriteSignal(context.globalStorageUri)
        // Slow-pass: legacy .json snapshots loaded at low priority after fast pass completes.
        processGroup(slowFiles, 2, 50, () => {
          writeLastWriteSignal(context.globalStorageUri)
          const total = [...countByKey.values()].reduce((s, n) => s + n, 0)
          if (total > 0) {
            const breakdown = [...countByKey.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => `${AGENT_KEY_LABEL[k] ?? k}: ${n}`)
              .join(', ')
            outputChannel!.appendLine(`[TraceRoost] Loaded ${total} sessions from local logs (${breakdown})`)
          }
          persistFileState()
          onAllDone?.()
        })
      })
    }

    // Defer off the activation stack so activation itself completes instantly.
    setImmediate(() => startBatchedLoad!())
    logReaderTimer = setInterval(runLogScan, 30_000)
    context.subscriptions.push({ dispose: () => clearInterval(logReaderTimer) })
    outputChannel.appendLine('TraceRoost: log ingestion enabled — scanning local trace logs')
  }

  if (collectorFailed) {
    // Non-collector window: poll the last-write signal; refresh from DB snapshot when it changes.
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
      DashboardPanel.show(context, repo, provider, instructionRepo, traceRoostDb?.raw)
    })
  )

  registerTeamCommands(context)
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
        logReader.clearFileState()
        // 5 s delay so the cleared state is visible before log sessions flow back in.
        // When all files are loaded, do a final refresh so the dashboard reflects
        // the fully re-ingested state.
        setTimeout(() => startBatchedLoad!(() => {
          provider.refresh()
          if (repository) DashboardPanel.setRepository(repository)
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
      outputChannel.appendLine(`TraceRoost MCP server → http://127.0.0.1:${boundMcpPort}/mcp`)
    } catch (err) {
      outputChannel.appendLine(`Failed to start MCP server on port ${mcpPort}: ${err}`)
      vscode.window.showErrorMessage(`TraceRoost: Could not start the MCP server (port ${mcpPort} and nearby ports are all in use). Set traceRoost.mcpPort to a free port.`)
    }
  }

  // ── Pro: forwarding scheduler ───────────────────────────────────────────────
  // No timer runs unless a team is linked; `syncToLinkState` starts/stops it after link/leave.
  forwardScheduler = startForwardScheduler({
    notify: (message, kind) => {
      if (kind === 'warning') vscode.window.showWarningMessage(message)
      else vscode.window.showInformationMessage(message)
    },
    log: (msg) => outputChannel?.appendLine(msg),
    onDrainComplete: () => DashboardPanel.pushTeamStatus(),
    recordSent: (count, at) => {
      repository?.recordTraceSent(count, at)
      traceRoostDb?.save()
    },
  })
  context.subscriptions.push({ dispose: () => forwardScheduler?.dispose() })

  // ── Pro: pricing sync ────────────────────────────────────────────────────────
  // Same "no timer unless linked" invariant as the forwarding scheduler above, on its own
  // (longer) interval — see pricingSync.ts for why it isn't just piggybacked on the drain cadence.
  const pricingSync = startPricingSync({ onSync: () => DashboardPanel.pushTeamStatus() })
  context.subscriptions.push({ dispose: () => pricingSync.dispose() })

  // ── Status bar ───────────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = 'traceRoost.openDashboard'
  statusBar.tooltip = 'Open TraceRoost Dashboard'
  context.subscriptions.push(statusBar)

  function updateStatusBar() {
    if (collectorFailed) {
      statusBar.text = '$(graph) TraceRoost — syncing'
    } else {
      statusBar.text = '$(graph) TraceRoost'
    }
    statusBar.color = undefined
    statusBar.backgroundColor = undefined
    statusBar.show()
  }

  updateStatusBar()
  context.subscriptions.push(store.onUpdate(updateStatusBar))

  if (collectorFailed) {
    outputChannel.appendLine('TraceRoost syncing — collector already running in another window')
  } else {
    vscode.window.showInformationMessage(`TraceRoost active — listening on port ${port}`)
    outputChannel.appendLine(`TraceRoost active — OTLP collector listening on port ${port}`)
  }
  outputChannel.show(true)

  notifySetupRequired(context, copilotResult.changed, claudeResult.changed, codexResult.changed)
}

// ── Team (TraceRoost Pro) commands ───────────────────────────────────────────
//
// Every capability here is inert until a team is explicitly linked. Registering the commands
// does nothing on its own — `getTeamStatus()` and `loadCredentials()` touch only local disk.

function registerTeamCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('traceRoost.teamLink', async () => {
      if (getTeamStatus().linked) {
        vscode.window.showInformationMessage('TraceRoost: this machine is already linked. Run "TraceRoost: Leave Team" first to re-link.')
        return
      }
      const proceed = await vscode.window.showInformationMessage(
        'Link this machine to a TraceRoost Cloud team?\n\nSent: ' + SENT.join('; ') + '.\n\nNever sent: ' + NEVER_SENT.join('; ') + '.',
        { modal: true },
        'Open browser to link',
      )
      if (proceed !== 'Open browser to link') return
      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'TraceRoost: waiting for browser approval…' },
          () => linkInteractive({ openUrl: (url: string) => { void vscode.env.openExternal(vscode.Uri.parse(url)) } }),
        )
        vscode.window.showInformationMessage(`TraceRoost: linked to ${result.orgName} as ${result.role}.`)
        forwardScheduler?.syncToLinkState()
        DashboardPanel.currentPanel?.update()
      } catch (err) {
        vscode.window.showErrorMessage(`TraceRoost: link failed — ${(err as Error).message}. Nothing was changed.`)
      }
    }),
    vscode.commands.registerCommand('traceRoost.teamStatus', () => {
      const s = getTeamStatus(getQueueStats())
      vscode.window.showInformationMessage(
        s.linked
          ? `TraceRoost Cloud: linked to ${s.orgName} as ${s.role}. Queue depth ${s.queueDepth ?? 0}, last trace ${s.lastRollupAt ?? 'none yet'}.`
          : 'TraceRoost Cloud: not linked. TraceRoost is working locally and sending nothing anywhere.',
      )
    }),
    vscode.commands.registerCommand('traceRoost.teamLeave', async () => {
      if (!getTeamStatus().linked) {
        vscode.window.showInformationMessage('TraceRoost: this machine is not linked.')
        return
      }
      const confirm = await vscode.window.showWarningMessage(
        'Leave the TraceRoost Cloud team? The local credential is deleted and this machine stops forwarding immediately.',
        { modal: true },
        'Leave team',
      )
      if (confirm !== 'Leave team') return
      const res = await leave()
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
            const root = await resolveRepoHash(repoHash, workspaces)
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
