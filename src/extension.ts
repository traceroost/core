import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as vscode from 'vscode'
import { OtlpCollector } from './otlpCollector'
import { SessionStore } from './sessionStore'
import { SidebarPanel } from './sidebarPanel'
import { DashboardPanel } from './dashboardPanel'
import { autoConfigureCopilot, autoConfigureClaudeCode, autoConfigureCodex } from './autoConfig'
import { exportSpans, exportSpansRedacted } from './exportData'
import { openDatabase, AgentLensDb } from './database/db'
import { DatabaseReader, openReadonlySnapshot } from './database/reader'
import { DatabaseWriter } from './database/writer'
import { migrateGlobalStateToSqlite } from './database/migration'
import { runRetention } from './database/retention'
import { SessionRepository } from './sessionRepository'
import { summarizeSpans } from './spanSummarizer'
import { LogReader } from './logReader'
import { detectLoopSignals } from './loopDetector'
import { computeOneShotStats } from './oneShotRate'
import { startMcpHttpServer } from './mcpServer'
import { InstructionRepository } from './database/instructionRepository'
import { linkInteractive, leave } from './team/link'
import { getTeamStatus } from './team/status'
import { SENT, NEVER_SENT } from './team/privacy'
import { getQueueStats } from './forward/currentQueueStats'
import { maybeEnqueueSession } from './team/enqueueSession'
import { startForwardScheduler, type ForwardScheduler } from './forward/scheduler'

let collector: OtlpCollector | undefined
let store: SessionStore | undefined
let outputChannel: vscode.OutputChannel | undefined
let agentLensDb: AgentLensDb | undefined
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

// ── Port detection ────────────────────────────────────────────────────────────

function probePort(port: number, probePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}${probePath}`, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
          resolve(json.agentlens === true)
        } catch {
          resolve(false)
        }
      })
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => { req.destroy(); resolve(false) })
  })
}

async function detectPortOwner(port: number): Promise<'plugin' | 'standalone' | 'foreign'> {
  const [isPlugin, isStandalone] = await Promise.all([
    probePort(port, '/agentlens/plugin'),
    probePort(port, '/agentlens/standalone'),
  ])
  if (isPlugin) return 'plugin'
  if (isStandalone) return 'standalone'
  return 'foreign'
}

// ── Activate ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('AgentLens')
  context.subscriptions.push(outputChannel)
  outputChannel.appendLine(`AgentLens activating… (v${context.extension.packageJSON.version})`)

  // ── Database ────────────────────────────────────────────────────────────────
  try {
    agentLensDb = await openDatabase(
      context.globalStorageUri.fsPath,
      context.extensionUri.fsPath,
    )
    context.subscriptions.push(agentLensDb)
    outputChannel.appendLine('AgentLens database initialized.')
  } catch (err) {
    outputChannel.appendLine(`Failed to initialize database: ${err}`)
  }

  // ── Session store ────────────────────────────────────────────────────────────
  try {
    store = new SessionStore(context)
  } catch (err) {
    outputChannel.appendLine(`Failed to initialize session store: ${err}`)
    vscode.window.showErrorMessage('AgentLens: Failed to initialize session store.')
    return
  }

  // ── Writer + reader + repository ─────────────────────────────────────────────
  if (agentLensDb) {
    const log = (msg: string) => outputChannel!.appendLine(msg)
    writer = new DatabaseWriter(agentLensDb.raw, context.globalStorageUri, log)
    const reader = new DatabaseReader(agentLensDb.raw, context.globalStorageUri)
    repository = new SessionRepository(reader, writer, store)

    // Run one-time migration before registering the onUpdate subscriber.
    await migrateGlobalStateToSqlite(context, writer, log)

    // Initial retention run on activation.
    const retentionDays = vscode.workspace.getConfiguration('agentLens').get<number>('sessionRetentionDays', 90)
    await runRetention(agentLensDb.raw, retentionDays, agentLensDb.blobsDir, log)

    // Periodic retention: once per 24 hours while the extension is active.
    const retentionTimer = setInterval(() => {
      const days = vscode.workspace.getConfiguration('agentLens').get<number>('sessionRetentionDays', 90)
      void runRetention(agentLensDb!.raw, days, agentLensDb!.blobsDir, log)
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
            agentLensDb?.save()
            writeLastWriteSignal(context.globalStorageUri)
          }).catch(err => console.error('[AgentLens] writer.drain error:', err))
          // Pro: build a rollup for this session and append it to the forwarding queue. A hard
          // no-op unless a team is linked. The actual network send happens later, on a timer.
          void maybeEnqueueSession({ ...card, workspace: card.workspace || workspace }, m => outputChannel?.appendLine(m))
            .then(r => { if (r.enqueued) forwardScheduler?.drainSoon() })
        }
      })
    )

  }

  // ── Collector ────────────────────────────────────────────────────────────────
  const agentLensCfg = vscode.workspace.getConfiguration('agentLens')
  const port = agentLensCfg.get<number>('otlpPort', 4318)
  collector = new OtlpCollector(port, store, outputChannel)
  let collectorFailed = false
  try {
    await collector.start()
    collector.setIngestionEnabled(agentLensCfg.get<boolean>('enableOtelIngestion', true))
  } catch (err) {
    collectorFailed = true
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const owner = await detectPortOwner(port)
      if (owner === 'standalone') {
        outputChannel.appendLine(`Port ${port} is in use by the AgentLens standalone server — change agentLens.otlpPort`)
        vscode.window.showErrorMessage(
          `AgentLens: Port ${port} is already in use by the AgentLens standalone server. Change the agentLens.otlpPort setting to use a different port.`
        )
      } else if (owner === 'foreign') {
        outputChannel.appendLine(`Port ${port} is in use by an unknown process — change agentLens.otlpPort`)
        vscode.window.showErrorMessage(
          `AgentLens: Port ${port} is already in use by another application. Change the agentLens.otlpPort setting to use a different port.`
        )
      }
    } else {
      outputChannel.appendLine(`Failed to start OTLP collector on port ${port}: ${err}`)
    }
    collector = undefined
  }

  // ── Auto-configure agents ────────────────────────────────────────────────────
  const autoConfigureAgents = agentLensCfg.get<boolean>('autoConfigureAgents', true)
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
      `AgentLens: Could not auto-configure Copilot OTel. Manually set github.copilot.chat.otel.enabled=true and otlpEndpoint to http://localhost:${port}`
    )
  }
  if (claudeResult.error) {
    outputChannel.appendLine(`Auto-configure Claude Code failed: ${claudeResult.error}`)
    vscode.window.showWarningMessage(
      `AgentLens: Could not auto-configure Claude Code. Manually add CLAUDE_CODE_ENABLE_TELEMETRY=1 and OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${port} to ~/.claude/settings.json env block.`
    )
  }
  if (codexResult.error) {
    outputChannel.appendLine(`Auto-configure Codex failed: ${codexResult.error}`)
    vscode.window.showWarningMessage(
      `AgentLens: Could not auto-configure Codex. Manually add [otel] exporter = { otlp-http = { endpoint = "http://localhost:${port}" } } to ~/.codex/config.toml`
    )
  }

  const configuredAgents: string[] = []
  if (copilotResult.changed) configuredAgents.push('Copilot')
  if (claudeResult.changed) configuredAgents.push('Claude Code')
  if (codexResult.changed) configuredAgents.push('Codex')
  if (configuredAgents.length > 0) {
    outputChannel.appendLine(`Auto-configured OTEL telemetry for: ${configuredAgents.join(', ')}`)
    vscode.window.showInformationMessage(
      `AgentLens configured OTEL telemetry for ${configuredAgents.join(', ')} — restart the agent(s) to start streaming traces. Disable via the agentLens.autoConfigureAgents setting.`
    )
  }

  // ── Panels ───────────────────────────────────────────────────────────────────
  const repo = repository ?? fallbackRepository(store)
  const provider = new SidebarPanel(repo, context.extensionUri)

  // ── Log ingestion ─────────────────────────────────────────────────────────
  const enableLogIngestion = vscode.workspace.getConfiguration('agentLens').get<boolean>('enableLogIngestion', true)
  let logReader: LogReader | undefined
  let startBatchedLoad: ((onAllDone?: () => void) => void) | undefined
  if (enableLogIngestion && writer) {
    logReader = new LogReader({ log: (msg) => outputChannel!.appendLine(msg), sqlFactory: agentLensDb?.sqlFactory })
    const lr = logReader  // non-null alias for use inside closures
    const fallbackWorkspace = () => vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? ''

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
        agentLensDb?.save()
        provider.refresh()
        DashboardPanel.currentPanel?.update()
        writeLastWriteSignal(context.globalStorageUri)
      }).catch(err => outputChannel!.appendLine(`[AgentLens] log ingestion drain error: ${err}`))
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
        outputChannel!.appendLine(`[AgentLens] log ingestion collect error: ${err}`)
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
              }
            } catch { /* skip bad file */ }
          }
          if (written > 0) {
            void writer!.drain().then(() => {
              agentLensDb?.save()
              provider.refresh()
            }).catch(err => outputChannel!.appendLine(`[AgentLens] log ingestion drain error: ${err}`))
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
            outputChannel!.appendLine(`[AgentLens] Loaded ${total} sessions from local logs (${breakdown})`)
          }
          onAllDone?.()
        })
      })
    }

    // Defer off the activation stack so activation itself completes instantly.
    setImmediate(() => startBatchedLoad!())
    logReaderTimer = setInterval(runLogScan, 30_000)
    context.subscriptions.push({ dispose: () => clearInterval(logReaderTimer) })
    outputChannel.appendLine('AgentLens: log ingestion enabled — scanning local session logs')
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
          const snapshotWriter = writer ?? new DatabaseWriter(agentLensDb!.raw, context.globalStorageUri, () => {})
          repository = new SessionRepository(snapshotReader, snapshotWriter, store)
          provider.setRepository(repository)
          DashboardPanel.setRepository(repository)
          provider.refresh()
        }
      }
    }, 2000)
    context.subscriptions.push({ dispose: () => clearInterval(pollTimer) })
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentLens.dashboard', provider)
  )

  // ── Commands ─────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('agentLens.showStorageStats', () => {
      if (!agentLensDb || !repository) {
        vscode.window.showInformationMessage('AgentLens: database not available')
        return
      }
      const dbPath = path.join(context.globalStorageUri.fsPath, 'agentlens.db')
      const { dbBytes, blobBytes, blobCount } = repository.getStorageStats(dbPath, agentLensDb.blobsDir)
      const lifetime = repository.queryLifetimeStats()
      const toMb = (b: number) => (b / 1_048_576).toFixed(1)
      const dateRange = lifetime.totalSessions > 0
        ? `${new Date(lifetime.oldestSessionMs).toISOString().slice(0, 10)} → ${new Date(lifetime.newestSessionMs).toISOString().slice(0, 10)}`
        : 'no sessions'
      const retentionDays = vscode.workspace.getConfiguration('agentLens').get<number>('sessionRetentionDays', 90)
      const msg = [
        `Database:  ${toMb(dbBytes)} MB  (${lifetime.totalSessions} sessions, ${dateRange})`,
        `Blobs:     ${toMb(blobBytes)} MB  (${blobCount} files)`,
        `Total:     ${toMb(dbBytes + blobBytes)} MB`,
        `Retention: ${retentionDays} days`,
      ].join('\n')
      outputChannel!.appendLine('\nAgentLens storage stats:\n' + msg)
      outputChannel!.show(true)
      vscode.window.showInformationMessage(`AgentLens storage: ${toMb(dbBytes + blobBytes)} MB total — see Output panel for details.`)
    })
  )

  const instructionRepo = agentLensDb ? new InstructionRepository(agentLensDb.raw) : undefined

  context.subscriptions.push(
    vscode.commands.registerCommand('agentLens.openDashboard', () => {
      vscode.commands.executeCommand('workbench.view.extension.agent-lens')
      DashboardPanel.show(context, repo, provider, instructionRepo)
    })
  )

  registerTeamCommands(context)

  context.subscriptions.push(
    vscode.commands.registerCommand('agentLens.dumpSpanAttrs', () => {
      const spans = store!.getSpans()
      outputChannel!.clear()
      outputChannel!.appendLine('=== AgentLens span attribute dump ===')
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
      vscode.window.showInformationMessage(`AgentLens: dumped ${codexByType.size} Codex span types + ${claudeSpans.length} Claude spans`)
    })
  )

  async function runExport(exporter: typeof exportSpans) {
    const spans = store!.getSpans()
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    const baseUri = workspaceFolder ? workspaceFolder.uri : context.globalStorageUri
    const writtenFiles = await exporter(spans, baseUri)
    if (writtenFiles.length === 0) {
      vscode.window.showInformationMessage('AgentLens: No session data to export')
      return
    }
    vscode.window.showInformationMessage(`AgentLens: Exported to: ${writtenFiles.join(', ')}`)
    for (const fname of writtenFiles) {
      const uri = vscode.Uri.joinPath(baseUri, fname)
      const doc = await vscode.workspace.openTextDocument(uri)
      vscode.window.showTextDocument(doc, { preview: false })
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('agentLens.exportData', () => runExport(exportSpans))
  )
  context.subscriptions.push(
    vscode.commands.registerCommand('agentLens.exportDataRedacted', () => runExport(exportSpansRedacted))
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentLens.clearSessions', () => {
      if (!repository || !writer) return
      // Clear DB and live span window
      repository.clearAll()
      store?.clear()
      agentLensDb?.save()
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
      const cfg = vscode.workspace.getConfiguration('agentLens')
      if (e.affectsConfiguration('agentLens.enableOtelIngestion') && collector) {
        collector.setIngestionEnabled(cfg.get<boolean>('enableOtelIngestion', true))
      }
      if (e.affectsConfiguration('agentLens.enableLogIngestion')) {
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
        e.affectsConfiguration('agentLens.enableOtelIngestion') ||
        e.affectsConfiguration('agentLens.enableLogIngestion')
      ) {
        DashboardPanel.currentPanel?.update()
      }
    })
  )

  // ── MCP server ───────────────────────────────────────────────────────────────
  const enableMcp = vscode.workspace.getConfiguration('agentLens').get<boolean>('enableMcpServer', true)
  if (enableMcp) {
    const mcpPort = vscode.workspace.getConfiguration('agentLens').get<number>('mcpPort', 4316)
    const mcpServer = startMcpHttpServer(
      { getSessions: () => repository?.listSessions() ?? [],
        getTimeline: (id) => repository?.loadSessionTimeline(id) ?? [] },
      mcpPort,
    )
    context.subscriptions.push({ dispose: () => mcpServer.close() })
    outputChannel.appendLine(`AgentLens MCP server → http://127.0.0.1:${mcpPort}/mcp`)
  }

  // ── Pro: forwarding scheduler ───────────────────────────────────────────────
  // No timer runs unless a team is linked; `syncToLinkState` starts/stops it after link/leave.
  forwardScheduler = startForwardScheduler({
    notify: (message, kind) => {
      if (kind === 'warning') vscode.window.showWarningMessage(message)
      else vscode.window.showInformationMessage(message)
    },
    log: (msg) => outputChannel?.appendLine(msg),
  })
  context.subscriptions.push({ dispose: () => forwardScheduler?.dispose() })

  // ── Status bar ───────────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = 'agentLens.openDashboard'
  statusBar.tooltip = 'Open AgentLens Dashboard'
  context.subscriptions.push(statusBar)

  function updateStatusBar() {
    if (collectorFailed) {
      statusBar.text = '$(graph) AgentLens — syncing'
    } else {
      statusBar.text = '$(graph) AgentLens'
    }
    statusBar.color = undefined
    statusBar.backgroundColor = undefined
    statusBar.show()
  }

  updateStatusBar()
  context.subscriptions.push(store.onUpdate(updateStatusBar))

  if (collectorFailed) {
    outputChannel.appendLine('AgentLens syncing — collector already running in another window')
  } else {
    vscode.window.showInformationMessage(`AgentLens active — listening on port ${port}`)
    outputChannel.appendLine(`AgentLens active — OTLP collector listening on port ${port}`)
  }
  outputChannel.show(true)

  notifySetupRequired(context, copilotResult.changed, claudeResult.changed, codexResult.changed)
}

// ── Team (AgentLens Pro) commands ────────────────────────────────────────────
//
// Every capability here is inert until a team is explicitly linked. Registering the commands
// does nothing on its own — `getTeamStatus()` and `loadCredentials()` touch only local disk.

function registerTeamCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentLens.teamLink', async () => {
      if (getTeamStatus().linked) {
        vscode.window.showInformationMessage('AgentLens: this machine is already linked. Run "AgentLens: Leave Team" first to re-link.')
        return
      }
      const proceed = await vscode.window.showInformationMessage(
        'Link this machine to an AgentLens Pro team?\n\nSent: ' + SENT.join('; ') + '.\n\nNever sent: ' + NEVER_SENT.join('; ') + '.',
        { modal: true },
        'Open browser to link',
      )
      if (proceed !== 'Open browser to link') return
      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'AgentLens: waiting for browser approval…' },
          () => linkInteractive({ openUrl: (url: string) => { void vscode.env.openExternal(vscode.Uri.parse(url)) } }),
        )
        vscode.window.showInformationMessage(`AgentLens: linked to ${result.orgName} as ${result.role}.`)
        forwardScheduler?.syncToLinkState()
        DashboardPanel.currentPanel?.update()
      } catch (err) {
        vscode.window.showErrorMessage(`AgentLens: link failed — ${(err as Error).message}. Nothing was changed.`)
      }
    }),
    vscode.commands.registerCommand('agentLens.teamStatus', () => {
      const s = getTeamStatus(getQueueStats())
      vscode.window.showInformationMessage(
        s.linked
          ? `AgentLens Pro: linked to ${s.orgName} as ${s.role}. Queue depth ${s.queueDepth ?? 0}, last rollup ${s.lastRollupAt ?? 'none yet'}.`
          : 'AgentLens Pro: not linked. AgentLens is working locally and sending nothing anywhere.',
      )
    }),
    vscode.commands.registerCommand('agentLens.teamLeave', async () => {
      if (!getTeamStatus().linked) {
        vscode.window.showInformationMessage('AgentLens: this machine is not linked.')
        return
      }
      const confirm = await vscode.window.showWarningMessage(
        'Leave the AgentLens Pro team? The local credential is deleted and this machine stops forwarding immediately.',
        { modal: true },
        'Leave team',
      )
      if (confirm !== 'Leave team') return
      const res = await leave()
      vscode.window.showInformationMessage(
        res.serverRevoked
          ? 'AgentLens: unlinked. This machine has stopped forwarding.'
          : 'AgentLens: unlinked locally. Could not reach the server to revoke the token — it will be revoked on next contact, or by a lead from the roster.',
      )
      forwardScheduler?.syncToLinkState()
      DashboardPanel.currentPanel?.update()
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

  const isFirstInstall = !context.globalState.get<string>('agentLens.installedVersion')
  if (isFirstInstall) {
    context.globalState.update('agentLens.installedVersion', context.extension.packageJSON.version)
  }

  const parts: string[] = []
  if (copilotChanged) { parts.push('Reload VS Code to activate Copilot tracing.') }
  const cliAgents = [claudeChanged && 'Claude', codexChanged && 'Codex'].filter(Boolean).join(' and ')
  if (cliAgents) { parts.push(`Restart ${cliAgents} in your terminal to activate CLI tracing.`) }

  const message = `AgentLens: Telemetry configured. ${parts.join(' ')}`
  const actions = copilotChanged ? ['Reload VS Code'] : []

  const action = await vscode.window.showInformationMessage(message, ...actions)
  if (action === 'Reload VS Code') {
    vscode.commands.executeCommand('workbench.action.reloadWindow')
  }
}

// ── Deactivate ────────────────────────────────────────────────────────────────

export async function deactivate() {
  DashboardPanel.disposePanel()
  if (collector) { await collector.stop() }
  if (writer) { await writer.drain() }
}
