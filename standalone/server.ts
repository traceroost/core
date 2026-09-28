/**
 * TraceRoost standalone server — runs the dashboard outside VS Code.
 *
 * Three HTTP servers:
 *   OTLP_PORT (default 4318) — receives OTLP traces/logs from agents
 *   UI_PORT   (default 3000) — serves the dashboard and SSE
 *   MCP_PORT  (default 4316) — MCP endpoint for Claude Code and other agents
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { exec } from 'child_process'
import { config as loadDotenv } from 'dotenv'
import { summarizeSpans } from '../src/spanSummarizer'
import { calcSessionCostUsd } from '../src/pricing'
import { autoConfigureClaudeCode, autoConfigureCodex, autoConfigureCopilotStandalone } from '../src/autoConfigNode'
import { classifyOtlpPayload, objectItems } from '../src/otlpParser'
import { logCardsNotCoveredByOtel } from '../src/claudeConversation'
import { startMcpHttpServer } from '../src/mcpServer'
import { LogReader, type OpenCodeSqlFactory } from '../src/logReader'
import { computeOneShotStats } from '../src/oneShotRate'
import { classifySessionOutcome, onRunningGitCommandsChanged, type GitOutcome } from '../src/gitOutcome'
import { onActionLogChanged, getActionLogHistory } from '../src/actionLog'
import { ReconciliationService, type ReconcileResult } from '../src/reconcile/reconciliationService'
import { startBackgroundReconciliation, type BackgroundWatcher } from '../src/reconcile/backgroundWatcher'
import { detectSessionRiskSignals } from '../src/sessionRiskSignals'
import { temperLoopSignalSeverity } from '../src/loopDetector'
import { generateSuggestions } from '../src/instructionAdvisor'
import { detectInstructionFiles, appendSuggestion } from '../src/instructionFiles'
import type { Span } from '../src/types'
import type { SessionSummaryCard } from '../src/summarizers/summarizerTypes'
import { pruneSpans, DEFAULT_MAX_SPANS } from '../src/spanStore'
import { readServiceConfig, ensureAuthToken, ensureInstallId, isRunningFromNpx, readPackageManifest, writeServiceProcessRecord, clearServiceProcessRecord } from '../src/serviceConfig'
import { startVersionCheckLoop, getCachedVersionCheck } from './versionCheck'
import { listenWithFallback, writeResolvedPorts, PortScanExhaustedError, type ResolvedPorts } from '../src/portResolver'
// TraceRoost Pro (org link + upload) — only ever through this seam; see src/cloudBridge.ts.
import { cloud } from '../src/cloudBridge'
import { resolveGithubUrl } from '../src/repoRemote'
import {
  isAllowedHostHeader, isAllowedOrigin, isAllowedOtlpContentType, isAuthorized, isLoopbackHost,
  extractCookieToken, authCookieHeader,
} from '../src/httpSecurity'
import { SseSessionSync, type SyncSummary } from './sseSessionSync'

// Load `.env` from the current working directory, if one exists — lets `pnpm run local` point at
// a specific org environment (e.g. `TRACEROOST_ORG_ENV=test`) without exporting shell vars.
// `quiet` suppresses dotenv's own startup banner; this is silent no-ops when no `.env` is present.
loadDotenv({ quiet: true })

// `traceroost service install` persists its port/host/data-dir choices to
// ~/.traceroost/config.json (see src/serviceConfig.ts) so a background-service install and an
// ad-hoc `npx`/`node standalone/server.js` run share one config story. Env vars still win when
// set, matching this server's behavior before the config file existed. ensureAuthToken generates
// and persists a bearer token the first time this runs with none set yet.
const fileConfig = ensureInstallId(ensureAuthToken(readServiceConfig()))

const OTLP_PORT  = parseInt(process.env.OTLP_PORT  ?? String(fileConfig.otlpPort))
const UI_PORT    = parseInt(process.env.UI_PORT    ?? String(fileConfig.uiPort))
const MCP_PORT   = parseInt(process.env.MCP_PORT   ?? String(fileConfig.mcpPort))
const BIND_HOST  = process.env.BIND_HOST ?? fileConfig.bindHost
const AUTH_TOKEN = fileConfig.authToken
// Escape hatch for anything that starts this server without wanting it to touch the real
// machine's agent config — demo/test harnesses, CI, a second instance for screenshotting.
// Covers both the unconditional startup call below and the manual "Configure OTEL" button
// (POST /action { type: 'reconfigureOtel' }); unset (the default) changes nothing for a real
// user, since nobody sets this by hand.
const AUTOCONFIG_DISABLED = process.env.TRACEROOST_NO_AUTOCONFIG === '1'

// Turns the "BIND_HOST=0.0.0.0 ships with zero access control" footgun into a startup error:
// once bindHost is exposed beyond loopback, a token must actually be in place (it always will
// be, barring a disk-write failure in ensureAuthToken) before any server is allowed to listen.
if (!isLoopbackHost(BIND_HOST) && !AUTH_TOKEN) {
  console.error(`[TraceRoost] Refusing to start: BIND_HOST=${BIND_HOST} exposes TraceRoost beyond localhost, but no auth token could be generated or persisted (check that the data directory is writable). Fix that, or set BIND_HOST back to 127.0.0.1.`)
  process.exit(1)
}

// ── Resolved-ports record ────────────────────────────────────────────────────
//
// One record, written once all three ports are known — every other reader (the printed dashboard
// URL, the browser auto-open, `service status`, the `reconfigureOtel` action) reads this instead
// of re-deriving "the port" from OTLP_PORT/UI_PORT/MCP_PORT independently. See
// .staged-issues/auto-pick-free-port.md.
const resolvedPorts: Partial<Record<'ui' | 'otlp' | 'mcp', number>> = {}

function recordResolvedPort(kind: 'ui' | 'otlp' | 'mcp', requested: number, bound: number): void {
  resolvedPorts[kind] = bound
  if (bound !== requested) {
    console.log(`[TraceRoost] Port ${requested} (${kind.toUpperCase()}) was in use — using ${bound} instead.`)
  }
  if (resolvedPorts.ui !== undefined && resolvedPorts.otlp !== undefined && resolvedPorts.mcp !== undefined) {
    const record: ResolvedPorts = {
      ui: resolvedPorts.ui, otlp: resolvedPorts.otlp, mcp: resolvedPorts.mcp,
      resolvedAt: new Date().toISOString(), pid: process.pid,
    }
    try { writeResolvedPorts(record) } catch (e) { console.warn('[TraceRoost] Could not persist resolved ports:', e) }
  }
}
// None of the three servers (UI, OTLP, MCP) require the token while bound to loopback — the
// network boundary is the security boundary there: only another process on this machine can
// reach 127.0.0.1 at all, so a bearer token on top of that only ever defended against a
// malicious webpage open in the same browser making same-machine requests, not against another
// machine. Once BIND_HOST is exposed beyond loopback that network boundary is gone, so the token
// becomes load-bearing everywhere, uniformly.
const REQUIRE_TOKEN_EVERYWHERE = !isLoopbackHost(BIND_HOST)
if (REQUIRE_TOKEN_EVERYWHERE) {
  console.log('[TraceRoost] BIND_HOST is not loopback — the dashboard, OTLP and MCP all now require Authorization: Bearer <token> (or ?token=) too. Configure agents accordingly.')
}
const parsedMaxSpans = parseInt(process.env.TRACEROOST_MAX_SPANS ?? '', 10)
const MAX_SPANS  = Number.isNaN(parsedMaxSpans) ? DEFAULT_MAX_SPANS : parsedMaxSpans

const PACKAGE_VERSION: string = readPackageManifest(__dirname).version ?? 'unknown'
if (PACKAGE_VERSION === 'unknown') {
  console.warn('[TraceRoost] Could not read package.json to determine the running version — is package.json missing from this install?')
} else {
  console.log(`[TraceRoost] Version         ${PACKAGE_VERSION}`)
  // The Sessions tab footer shows this version, but a bare `npx traceroost`/long-running
  // service can go stale silently — startVersionCheckLoop compares it against npm in the
  // background so the dashboard can surface an "update available" notice (/api/version-check).
  startVersionCheckLoop(PACKAGE_VERSION)
}
if (isRunningFromNpx(process.env.npm_config_user_agent, process.argv[1] ?? '')) {
  // A bare `npx traceroost` re-runs npx's cached copy without checking npm, so the version
  // above can be an old release even right after a publish. Surface that at the moment it's on screen.
  console.log('[TraceRoost] Launched via npx — if this isn\'t the version you expect, npx served a cached copy. Re-run as `npx traceroost@latest` (or clear it with `rm -rf ~/.npm/_npx`).')
}

const mediaDir  = path.join(__dirname, '..', 'media')
const DATA_DIR  = process.env.DATA_DIR ?? fileConfig.dataDir
const DATA_FILE = path.join(DATA_DIR, 'spans.json')

// Running as the background service: record this process so `traceroost service stop/uninstall`
// can end it on Windows, where ending the Scheduled Task only kills the wrapper cmd.exe and not
// this node child (see standalone/service/windows.ts's endServerProcess).
if (process.env.TRACEROOST_SERVICE === '1') {
  try { writeServiceProcessRecord({ pid: process.pid, image: path.basename(process.execPath) }) } catch (e) { console.warn('[TraceRoost] Could not record the service process:', e) }
  process.on('exit', () => { try { clearServiceProcessRecord(process.pid) } catch { /* best effort */ } })
}

// ── Span store with file persistence ─────────────────────────────────────────
//
// The in-memory/persisted span list is capped at MAX_SPANS (see spanStore.ts)
// to keep spans.json well under V8's max string length — without a cap,
// JSON.stringify(spans) eventually throws RangeError: Invalid string length
// and every save silently fails forever.

let spans: Span[] = []
let sseClients: http.ServerResponse[] = []
// Bumped on every mutation to `spans` or `logSessions` — buildSessionSummary() caches its
// (expensive, ~50k-span) summarizeSpans() pass keyed on this instead of recomputing on every
// call. See buildSessionSummary()'s doc comment for why that recompute was pegging the CPU.
let dataVersion = 0

// Load persisted spans on startup
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (fs.existsSync(DATA_FILE)) {
    const { size } = fs.statSync(DATA_FILE)
    const MAX_LOADABLE_BYTES = 450 * 1024 * 1024 // stay clear of Node's ~512MB string ceiling
    if (size > MAX_LOADABLE_BYTES) {
      const backupFile = `${DATA_FILE}.bak`
      fs.renameSync(DATA_FILE, backupFile)
      console.warn(`[TraceRoost] ${DATA_FILE} was ${(size / 1024 / 1024).toFixed(0)}MB — too large to load safely. Moved it to ${backupFile} and starting fresh.`)
    } else {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8')
      spans = JSON.parse(raw) as Span[]
      const dropped = pruneSpans(spans, MAX_SPANS)
      console.log(`[TraceRoost] Loaded ${spans.length} spans from ${DATA_FILE}${dropped ? ` (dropped ${dropped} oldest to respect the ${MAX_SPANS}-span cap)` : ''}`)
    }
  }
} catch (e) {
  console.warn('[TraceRoost] Could not load persisted data:', e)
}

function saveSpansNow(): boolean {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(spans))
    return true
  } catch (e) {
    if (e instanceof RangeError && spans.length > 1) {
      const keep = Math.floor(spans.length / 2)
      const dropped = spans.length - keep
      spans.splice(0, dropped)
      dataVersion++
      console.warn(`[TraceRoost] Save failed (spans array too large to serialize) — dropped oldest ${dropped} spans and retrying`)
      try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(spans))
        return true
      } catch (e2) {
        console.warn('[TraceRoost] Could not save data after emergency prune:', e2)
        return false
      }
    }
    console.warn('[TraceRoost] Could not save data:', e)
    return false
  }
}

// Debounced save — writes at most once per second under continuous ingestion
let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveSpansNow, 1000)
}

function addSpan(span: Span) {
  if (span.receivedAt === undefined) span.receivedAt = Date.now()
  spans.push(span)
  const dropped = pruneSpans(spans, MAX_SPANS)
  if (dropped > 0) console.warn(`[TraceRoost] Pruned ${dropped} oldest spans to stay under the ${MAX_SPANS}-span cap`)
  dataVersion++
}

// ── Log file sessions ─────────────────────────────────────────────────────────

// Indexed by sessionId; OTEL-derived sessions (from spans) take precedence —
// when the same session ID appears in both, the OTEL version is used.
let logSessions: Map<string, SessionSummaryCard> = new Map()

/** The one way a card enters `logSessions` — bumps `dataVersion` and drops any cached serialized
 *  form of the card (see `strippedCardJson`), in case a producer ever hands back the same object
 *  updated in place rather than a fresh one. */
function setLogSession(card: SessionSummaryCard): void {
  logSessions.set(card.sessionId, card)
  strippedCardJson.delete(card)
  dataVersion++
}

// Host-independent reconciliation (staged feature 10) — created once outcomesDb opens, in
// startLogIngestion() below. Undefined only when sql.js failed to load; getGitOutcome falls back
// to an in-flight-only, non-durable classification in that case, same posture as before this
// feature (a permanent-until-restart Map has been replaced either way — see reconciliationService.ts).
let reconciliationService: ReconciliationService | undefined
let backgroundWatcher: BackgroundWatcher | undefined
const fallbackInFlight = new Map<string, Promise<GitOutcome | null>>()

// Mirrors DashboardPanel's identical subscription — independent of reconciliationService (also
// covers the uncached fallbackInFlight path above), so wire it unconditionally at module load
// rather than inside startLogIngestion's conditional setup.
onRunningGitCommandsChanged(commands => broadcastSse({ type: 'runningGitCommands', commands }))

// action-log.md: pushed to every connected client on every change; a freshly connecting client
// also gets the current backlog once, at SSE connect time (see the `/events` handler below).
onActionLogChanged(entries => broadcastSse({ type: 'actionLog', entries }))

async function loadOrComputeGitOutcome(sessionId: string, workspace: string, filesChanged: string[], endTime: string): Promise<{ outcome: GitOutcome | null; revision: number | null; deferred: boolean }> {
  if (reconciliationService) {
    const result = await reconciliationService.reconcile({ sessionId, workspace, filesChanged, endTime })
    return { outcome: result.outcome, revision: result.revision, deferred: result.deferred }
  }
  let pending = fallbackInFlight.get(sessionId)
  if (!pending) {
    pending = classifySessionOutcome(workspace, filesChanged)
    fallbackInFlight.set(sessionId, pending)
  }
  try {
    return { outcome: await pending, revision: null, deferred: false }
  } finally {
    fallbackInFlight.delete(sessionId)
  }
}

/** Pushes an unsolicited reconciliation result to every open tab, exactly like DashboardPanel's
 *  pushGitOutcomeResult — the background watcher calls this via the service subscription below,
 *  so "leave Traces open through multiple commits and a merge" converges without the tab
 *  re-requesting anything. */
function pushGitOutcomeResult(r: ReconcileResult): void {
  const card = buildSessionSummary()?.sessions.find(s => s.sessionId === r.sessionId) ?? null
  if (!card) return
  const riskSignals = detectSessionRiskSignals(card, card.workspace, r.outcome)
  const temperedLoopSignals = temperLoopSignalSeverity(card.loopSignals ?? [], r.outcome)
  broadcastSse({ type: 'gitOutcome', sessionId: r.sessionId, outcome: r.outcome, riskSignals, temperedLoopSignals, revision: r.revision })
}

// Repo info, keyed by workspace path. `hash` is repoKey.ts's repoHash — the same hash
// traceroost-cloud shows in its own Repo column. `name` is the git repo root's own basename (not
// the workspace path, which may be a subfolder of it). Mirrors DashboardPanel's repoInfoCache.
const repoInfoCache = new Map<string, { name: string; hash: string | null; githubUrl: string | null } | null>()

function buildImportCardStandalone(raw: Record<string, unknown>): SessionSummaryCard {
  const num = (v: unknown, def = 0): number => (typeof v === 'number' ? v : def)
  const str = (v: unknown, def = ''): string => (typeof v === 'string' ? v : def)
  const arrStr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') as string[] : [])
  return {
    sessionId:         str(raw['sessionId']),
    traceId:           str(raw['traceId']),
    source:            (raw['source'] as SessionSummaryCard['source']) ?? 'claude_code',
    dataSource:        'log',
    workspace:         str(raw['workspace']),
    userRequest:       str(raw['userRequest']),
    model:             str(raw['model']),
    turns:             num(raw['turns']),
    totalLlmCalls:     num(raw['turns']),
    totalToolCalls:    num(raw['totalToolCalls']),
    inputTokens:       num(raw['inputTokens']),
    outputTokens:      num(raw['outputTokens']),
    cacheReadTokens:   num(raw['cacheReadTokens']),
    cacheCreateTokens: num(raw['cacheCreateTokens']),
    cacheHitRate:      num(raw['cacheHitRate']),
    durationMs:        num(raw['durationMs']),
    startTime:         str(raw['startTime'], new Date().toISOString()),
    filesRead:         arrStr(raw['filesRead']),
    filesChanged:      arrStr(raw['filesChanged']),
    filesSearched:     [],
    filesWritten:      [],
    toolCounts:        (typeof raw['toolCounts'] === 'object' && raw['toolCounts'] !== null ? raw['toolCounts'] : {}) as Record<string, number>,
    errors:            num(raw['errors']),
    outcome:           (raw['outcome'] as SessionSummaryCard['outcome']) ?? 'unknown',
    timeline:          [],
    backgroundSpans:   [],
    loopSignals:       Array.isArray(raw['loopSignals']) ? raw['loopSignals'] as SessionSummaryCard['loopSignals'] : [],
  }
}

let logReader = new LogReader()
let outcomesDb: import('./db/outcomesDb').OutcomesDb | null = null

// ── MCP server ────────────────────────────────────────────────────────────────

// Dedicated server on MCP_PORT (default 4316) — same port as the VS Code extension. Falls back to
// the next free port on EADDRINUSE rather than exiting; `mcpServerReady` is awaited before the UI
// server prints the MCP endpoint, so the printed URL is always the port actually bound.
const mcpServerReady: Promise<number> = startMcpHttpServer({
  getSessions: () => {
    const summary = buildSessionSummary()
    return summary?.sessions ?? []
  },
}, MCP_PORT, BIND_HOST, AUTH_TOKEN)
  .then(server => {
    const bound = (server.address() as { port: number }).port
    recordResolvedPort('mcp', MCP_PORT, bound)
    return bound
  })
  .catch(err => {
    console.error(`[TraceRoost] Failed to start MCP server: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })

// Sessions whose repository couldn't be *matched to a written transcript file at all* — a
// genuinely different problem from the ungrouped-repo case (0182506): the client, agent, or
// timing meant no ~/.claude/projects/ (etc.) log ever appeared for this session, so it exists
// only as OTEL spans (dataSource 'otel', built by summarizeSpans()) and never reaches
// runLogScan()/logReader at all — that pipeline only ever looks at log files, by construction.
//
// Only forward one once it's been idle a while: an OTEL session is *live* for as long as the
// agent keeps emitting spans for it, and forwarding mid-conversation would send an incomplete,
// wrong rollup — worse, forwarding it more than once as it grows would each time look like a
// *different* session server-side (its payload, hence its content hash inputs, differs), so
// there is no cheap dedup to lean on the way there is for a stable file. If its transcript file
// *does* show up later (the common case — this is a race, not a permanent state, for anything
// still actively writing), runLogScan() reaching it first and enqueuing under the real
// session_id is what should happen; this function backs off the moment that's true so the same
// underlying session is never double-counted under two different ids.
const OTEL_IDLE_MS = 3 * 60_000
const otelLastSeen = new Map<string, { durationMs: number; at: number }>()
const otelAttempted = new Set<string>()

function checkStaleOtelSessions() {
  const summary = buildSessionSummary()
  if (!summary) return
  const now = Date.now()
  for (const card of summary.sessions) {
    if (card.dataSource !== 'otel') continue
    if (otelAttempted.has(card.traceId)) continue
    if (logSessions.has(card.sessionId)) { otelAttempted.add(card.traceId); continue } // now has a real log counterpart — that one wins
    const prev = otelLastSeen.get(card.traceId)
    if (!prev || prev.durationMs !== card.durationMs) {
      otelLastSeen.set(card.traceId, { durationMs: card.durationMs, at: now })
      continue
    }
    if (now - prev.at < OTEL_IDLE_MS) continue
    otelAttempted.add(card.traceId)
    void cloud.enqueueSession(card, m => console.log(m)).then(r => { if (r.enqueued) cloud.drainUploadsSoon() })
  }
}

function runLogScan() {
  const results = logReader.scan()
  let changed = false
  for (const { card } of results) {
    card.oneShotStats = computeOneShotStats(card)
    setLogSession(card)
    changed = true
    // Pro: enqueue this session for forwarding. Hard no-op unless an org is linked.
    //
    // scan() already only returns sessions whose underlying log file actually changed since the
    // last check (see LogReader's fileState), and this whole function is itself only reached on a
    // 5s interval or a 300ms-debounced fs.watch event -- so no extra debounce is needed here, only
    // in extension.ts's per-tick `onUpdate` (see contentChangeForward.ts). Once reconciliation is
    // available, the content-hash gate (staged feature 10) replaces the plain ledger-gated
    // enqueue: it re-forwards under a fresh revision whenever this session's rollup content
    // actually changed (not just on its first send). Falls back to the old first-send-only
    // behavior without a reconciliation service, same as before this feature.
    if (reconciliationService) {
      void cloud.forwardOnContentChange(reconciliationService, card, m => console.log(m))
        .then(r => { if (r.enqueued) cloud.drainUploadsSoon() })
    } else {
      void cloud.enqueueSession(card, m => console.log(m)).then(r => { if (r.enqueued) cloud.drainUploadsSoon() })
    }
  }
  if (changed) schedulePushUpdate()
}

// Debounced scan triggered by fs.watch events — fires 300 ms after the last event.
let watchScanTimer: ReturnType<typeof setTimeout> | null = null
function scheduleWatchScan() {
  if (watchScanTimer) clearTimeout(watchScanTimer)
  watchScanTimer = setTimeout(() => { watchScanTimer = null; runLogScan() }, 300)
}

function setupLogWatcher() {
  for (const dir of logReader.getWatchDirs()) {
    try {
      fs.watch(dir, { recursive: true, persistent: false }, scheduleWatchScan)
    } catch { /* dir may not exist yet — poll will cover it */ }
  }
}

async function startLogIngestion() {
  // Initialize sql.js so we can read the OpenCode SQLite DB.
  try {
    const sqlJsDir = path.dirname(require.resolve('sql.js'))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<OpenCodeSqlFactory>
    const sqlFactory = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
    logReader = new LogReader({ log: (msg) => console.log(msg), sqlFactory })
  } catch { /* no sql.js — OpenCode falls back to JSON */ }

  // Git-outcome caching — a separate small sqlite file, see standalone/db/outcomesDb.ts.
  try {
    const { openOutcomesDb } = require('./db/outcomesDb') as typeof import('./db/outcomesDb')
    outcomesDb = await openOutcomesDb(DATA_DIR)
  } catch { /* falls back to uncached git-outcome classification, same as before this existed */ }

  // Live trace reconciliation (staged feature 10) — runs from server lifecycle, not from any
  // particular browser tab being open, so a commit/merge made while the tab is closed is already
  // reconciled by the time it's reopened. See reconciliationService.ts and backgroundWatcher.ts.
  if (outcomesDb) {
    reconciliationService = new ReconciliationService(outcomesDb.raw)
    const unsubscribe = reconciliationService.subscribe(pushGitOutcomeResult)
    // See extension.ts's identical wiring — a background-detected revision change must reach the
    // forwarding queue, not just the open tab's UI.
    const unsubscribeForwarding = reconciliationService.subscribe((r) => {
      if (!r.changed || r.revision === null) return
      const card = buildSessionSummary()?.sessions.find(s => s.sessionId === r.sessionId)
      if (!card) return
      void cloud.enqueueSession(card, m => console.log(m), r.revision)
        .then(res => { if (res.enqueued) cloud.drainUploadsSoon() })
    })
    backgroundWatcher = startBackgroundReconciliation({
      service: reconciliationService,
      listSessions: () => (buildSessionSummary()?.sessions ?? []).map(s => ({
        sessionId: s.sessionId,
        workspace: s.workspace,
        filesChanged: s.filesChanged,
        endTime: s.startTime && s.durationMs ? new Date(Date.parse(s.startTime) + s.durationMs).toISOString() : s.startTime,
      })),
      log: (msg) => console.log(msg),
    })
    process.once('exit', () => { unsubscribe(); unsubscribeForwarding(); backgroundWatcher?.dispose(); reconciliationService?.dispose() })
  }

  // Register the poll first so it always runs, even if no files exist yet at startup.
  setInterval(runLogScan, 5_000)
  // Pro: catch sessions that never got a matching transcript file at all — see the doc
  // comment on checkStaleOtelSessions for why this needs its own idle-based check rather
  // than firing from the same per-file-change trigger runLogScan uses.
  setInterval(checkStaleOtelSessions, 5_000)
  // Watch log directories for file-system events so updates appear immediately,
  // without waiting for the next poll interval.
  setupLogWatcher()
  console.log('[TraceRoost] Log ingestion enabled — scanning local trace logs')

  const AGENT_KEY_LABEL: Record<string, string> = {
    claude:               'Claude Code',
    codex:                'Codex',
    copilot:              'Copilot CLI',
    copilot_vscode:       'Copilot (VS Code)',
    copilot_vscode_json:  'Copilot (VS Code)',
    opencode:             'OpenCode',
  }
  const AGENT_KEY_DIR: Record<string, string> = {
    claude:               '~/.claude/projects/',
    codex:                '~/.codex/sessions/',
    copilot:              '~/.copilot/session-state/',
    copilot_vscode:       '~/Library/…/workspaceStorage/',
    copilot_vscode_json:  '~/Library/…/workspaceStorage/',
    opencode:             '~/.local/share/opencode/',
  }

  const countByKey = new Map<string, number>()

  // OpenCode: one DB file = many sessions, handled separately.
  const ocResults = logReader.scanOpenCode()
  for (const { card } of ocResults) {
    card.oneShotStats = computeOneShotStats(card)
    setLogSession(card)
    countByKey.set('opencode', (countByKey.get('opencode') ?? 0) + 1)
    // Pro: enqueue this session for forwarding. Hard no-op unless an org is linked. Needed
    // here, not just in runLogScan() — this loop's own file reads update the same LogReader's
    // fileState that scan() checks, so a historical file read here first is invisible to
    // scan() as "new" forever after (see the note above the main loop below).
    void cloud.enqueueSession(card, m => console.log(m)).then(r => { if (r.enqueued) cloud.drainUploadsSoon() })
  }

  // Run the initial batch synchronously so logSessions is populated before the
  // browser's first HTTP request. The setImmediate approach deferred this past
  // the first page load, causing a blank screen on startup.
  let files: ReturnType<typeof logReader.collectFileMeta>
  try { files = logReader.collectFileMeta() } catch { return }

  for (const file of files) {
    if (file.agentKey === 'opencode') continue  // already handled above
    try {
      // Usually one result; a Claude Code transcript split by a large gap between prompts
      // (see splitClaudeLinesOnPromptGaps) can yield more than one.
      const results = logReader.parseFile(file.filePath, file.agentKey)
      for (const result of results) {
        result.card.oneShotStats = computeOneShotStats(result.card)
        setLogSession(result.card)
        countByKey.set(file.agentKey, (countByKey.get(file.agentKey) ?? 0) + 1)
        // Pro: enqueue this session for forwarding. Hard no-op unless an org is linked.
        //
        // This has to happen here, not only in runLogScan(): this loop calls
        // logReader.parseFile() directly on every discovered file to build the dashboard's
        // initial view, and parseFile() records each file's current mtime/size into the same
        // LogReader instance's fileState that scan() (runLogScan()'s own file-change check)
        // reads. Without this call, every session that existed before the app ever started
        // gets marked "already seen" here, on this one-time synchronous pass — before
        // runLogScan() ever runs for the first time — so scan() finds no delta for any of
        // them and never enqueues them, permanently. Only files that change *again* after
        // this point (an actively-growing session) ever reach forwarding. Confirmed directly:
        // of 58 real local sessions, only the handful still being actively written to were
        // ever forwarded; the other ~40+ built valid payloads fine in isolation (repo-grouped
        // or correctly ungrouped) but were never enqueued by the running server at all.
        void cloud.enqueueSession(result.card, m => console.log(m)).then(r => { if (r.enqueued) cloud.drainUploadsSoon() })
      }
    } catch { /* skip bad file */ }
  }

  // Merge copilot_vscode and copilot_vscode_json into one display row
  const displayCounts = new Map<string, { label: string; dir: string; count: number }>()
  for (const [key, count] of countByKey) {
    const displayKey = key === 'copilot_vscode_json' ? 'copilot_vscode' : key
    const existing = displayCounts.get(displayKey)
    if (existing) { existing.count += count } else {
      displayCounts.set(displayKey, { label: AGENT_KEY_LABEL[key] ?? key, dir: AGENT_KEY_DIR[key] ?? key, count })
    }
  }

  const total = [...displayCounts.values()].reduce((s, v) => s + v.count, 0)
  if (total === 0) return
  const lines = [...displayCounts.values()]
    .sort((a, b) => b.count - a.count)
    .map(v => `  ${v.label.padEnd(20)} ${String(v.count).padStart(4)}  (${v.dir})`)
    .join('\n')
  console.log(`[TraceRoost] Loaded ${total} traces from local logs:\n${lines}`)
  // Push loaded sessions to any SSE clients that connected before the scan finished.
  pushUpdate()
}

// ── OTLP parsing ──────────────────────────────────────────────────────────────

type RawAttr = { key: string; value: Record<string, unknown> }

function toAttrs(raw: unknown): RawAttr[] {
  return objectItems(raw).filter((o): o is RawAttr =>
    typeof o.key === 'string' && typeof o.value === 'object' && o.value !== null
  )
}

function attrStr(attrs: RawAttr[], ...keys: string[]): string {
  for (const key of keys) {
    const a = attrs.find(x => x.key === key)
    if (!a) continue
    const v = a.value
    const s = v.stringValue ?? v.intValue ?? v.doubleValue
    if (s != null) return String(s)
  }
  return ''
}

function isCodexWebsocketSpanName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('codex.') && lower.includes('websocket')
}

function isCodexWebsocketTraceSpan(name: string, attrs: RawAttr[]): boolean {
  const lower = name.toLowerCase()
  if (!lower.includes('websocket')) return false
  const eventName = attrStr(attrs, 'event.name', 'event_name', 'name', 'event').toLowerCase()
  const hasCodexAttr = Boolean(attrStr(attrs, 'codex.session.id', 'codex.conversation.id', 'codex.turn.id'))
  return lower.startsWith('codex.') || eventName.startsWith('codex.') || hasCodexAttr
}

function attrsFromBodyKv(body: unknown): RawAttr[] {
  if (typeof body !== 'object' || body === null) return []
  const obj = body as Record<string, unknown>
  const kv = obj.kvlistValue as Record<string, unknown> | undefined
  const values = kv?.values
  if (!Array.isArray(values)) return []
  const attrs: RawAttr[] = []
  for (const entry of objectItems(values)) {
    const key = typeof entry.key === 'string' ? entry.key : ''
    const attrValue = entry.value as Record<string, unknown> | undefined
    if (!key || typeof attrValue !== 'object' || attrValue === null) continue
    attrs.push({ key, value: attrValue })
  }
  return attrs
}

function mergeAttrs(...lists: RawAttr[][]): RawAttr[] {
  const out: RawAttr[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const attr of list) {
      if (seen.has(attr.key)) continue
      seen.add(attr.key)
      out.push(attr)
    }
  }
  return out
}

function agentLabelFromSpanName(name: string): string {
  if (name.startsWith('claude_code.')) return 'Claude Code'
  if (name.startsWith('codex.'))       return 'Codex'
  if (name === 'invoke_agent' || name.startsWith('copilot.')) return 'Copilot'
  return 'unknown'
}

function processTraces(payload: unknown, collectorPath = '/v1/traces'): { count: number; agent: string } {
  const p = payload as { resourceSpans?: Array<{ resource?: { attributes?: unknown }; scopeSpans?: Array<{ spans?: unknown[] }> }> }
  // Resource-level attributes (Claude Code puts `session.id` there) are merged onto every span, the
  // span's own value winning on a key collision — same as the extension's collector
  // (otlpCollector.ts), so the Claude OTEL card carries the session id the transcript dedupe keys on.
  const rawSpans = objectItems<{ resource?: { attributes?: unknown }; scopeSpans?: unknown }>(p?.resourceSpans).flatMap(rs => {
    const resourceAttrs = toAttrs(rs.resource?.attributes)
    return objectItems<{ spans?: unknown }>(rs.scopeSpans).flatMap(ss => objectItems(ss.spans).map(span => ({ span, resourceAttrs })))
  })
  let count = 0
  let agent = 'unknown'
  for (const { span: raw, resourceAttrs } of rawSpans) {
    const s = raw as Record<string, unknown>
    if (typeof s.traceId !== 'string' || typeof s.spanId !== 'string' || typeof s.name !== 'string') continue
    let attrs = toAttrs(s.attributes)
    const own = new Set(attrs.map(a => a.key))
    attrs = [...attrs, ...resourceAttrs.filter(a => !own.has(a.key))]
    if (isCodexWebsocketTraceSpan(s.name, attrs)) continue
    if (agent === 'unknown') agent = agentLabelFromSpanName(s.name)
    attrs = [...attrs, { key: '_traceroost.collector_path', value: { stringValue: collectorPath } }]
    addSpan({
      traceId: s.traceId,
      spanId: s.spanId,
      parentSpanId: (s.parentSpanId as string) || undefined,
      name: s.name,
      startTime: s.startTimeUnixNano as string,
      endTime: s.endTimeUnixNano as string,
      attributes: attrs,
      status: s.status as { code: number; message?: string } | undefined,
    })
    count++
  }
  return { count, agent }
}

function processLogs(payload: unknown, collectorPath = '/v1/logs'): number {
  type SL = { logRecords?: unknown[] }
  type RL = { scopeLogs?: SL[]; resource?: { attributes?: unknown } }
  const p = payload as { resourceLogs?: RL[] }
  const fallback = `codex-${Date.now()}`
  let n = 0
  for (const rl of objectItems<RL>(p?.resourceLogs)) {
    const resourceAttrs = toAttrs(rl.resource?.attributes)
    for (const sl of objectItems<SL>(rl.scopeLogs)) {
      const scopeAttrs = toAttrs((sl as { scope?: { attributes?: unknown } }).scope?.attributes)
      for (const rec of objectItems(sl.logRecords)) {
        const r = rec as Record<string, unknown>
        const attrs = mergeAttrs(toAttrs(r.attributes), attrsFromBodyKv(r.body), scopeAttrs, resourceAttrs)
        const name = attrStr(attrs, 'event.name', 'event_name', 'name', 'event')
        const logToolName = attrStr(attrs, 'tool.name')
        const isCodexEvent = name.startsWith('codex.')
        const isClaudeToolResult = name === 'tool_result' && logToolName !== ''
        if (!isCodexEvent && !isClaudeToolResult) continue
        if (isCodexEvent && isCodexWebsocketSpanName(name)) continue
        let traceId: string
        let spanName: string
        if (isClaudeToolResult) {
          traceId = (typeof r.traceId === 'string' && r.traceId)
            ? r.traceId
            : attrStr(attrs, 'session.id', 'session_id') || fallback
          spanName = 'claude_code.tool_result'
        } else {
          traceId = (typeof r.traceId === 'string' && r.traceId)
            ? r.traceId
            : attrStr(attrs, 'conversation.id', 'conversation_id', 'session.id', 'session_id') || fallback
          spanName = name
        }
        const spanId = (typeof r.spanId === 'string' && r.spanId)
          ? r.spanId
          : attrStr(attrs, 'span_id', 'spanId') || `cl-${Math.random().toString(36).slice(2, 10)}`
        let startTime = String(r.timeUnixNano ?? r.observedTimeUnixNano ?? '0')
        let endTime = startTime
        if (startTime === '0') {
          const timestamp = attrStr(attrs, 'event.timestamp')
          const ms = timestamp ? new Date(timestamp).getTime() : 0
          if (ms > 0) {
            const endNs = String(BigInt(ms) * BigInt(1_000_000))
            const durMs = parseInt(attrStr(attrs, 'duration_ms') || '0') || 0
            endTime = endNs
            startTime = durMs > 0
              ? String(BigInt(endNs) - BigInt(durMs) * BigInt(1_000_000))
              : endNs
          }
        }
        addSpan({ traceId, spanId, name: spanName, startTime, endTime, attributes: [...attrs, { key: '_traceroost.collector_path', value: { stringValue: collectorPath } }], status: undefined })
        n++
      }
    }
  }
  return n
}

// ── SSE push ──────────────────────────────────────────────────────────────────

function safeJson(data: unknown): string {
  return safeJsonText(JSON.stringify(data))
}

function safeJsonText(json: string): string {
  return json
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--')
    .replace(/\$\{/g, '\\${')
}

/** A card's `Date.parse(startTime)` (and, once asked for, its UTC day), kept per card object and
 *  redone only if its startTime string changes. Log cards outlive many dataVersions, and every
 *  update re-sorted and re-bucketed all of them — ~70ms of date parsing/formatting per update at
 *  20k sessions. */
const startTimeCache = new WeakMap<object, { startTime: string; ms: number; day?: string }>()

function cachedStart(card: { startTime: string }): { startTime: string; ms: number; day?: string } {
  let hit = startTimeCache.get(card)
  if (!hit || hit.startTime !== card.startTime) {
    hit = { startTime: card.startTime, ms: Date.parse(card.startTime) }
    startTimeCache.set(card, hit)
  }
  return hit
}

const EMPTY_START_MS = Date.parse('0')

/** Newest-first by startTime — the same order (ties included) as sorting with a
 *  `Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0')` comparator, with each
 *  timestamp parsed once instead of on every comparison (~20× fewer parses at 20k sessions). */
function sortNewestFirst<T extends { startTime: string }>(sessions: T[]): T[] {
  const times = sessions.map(s => s.startTime ? cachedStart(s).ms : EMPTY_START_MS)
  return sessions.map((_, i) => i).sort((a, b) => times[b] - times[a]).map(i => sessions[i])
}

/** The part of computeSidebarPayload that depends only on the data, not the clock or live pricing
 *  — computed once per dataVersion (see derivedViews). */
function sidebarPayloadBase(summary: ReturnType<typeof summarizeSpans>, allSpans: Span[]) {
  const sessions = summary.sessions
  // newest-first (summarizeSpans returns in arbitrary order — sort by startTime)
  const sorted = sortNewestFirst(sessions)
  const latest = sorted[0] ?? null

  const AGENT_ORDER = ['copilot', 'claude_code', 'codex']
  const agentSources = [...new Set(sorted.map(s => s.source).filter(Boolean))]
    .sort((a, b) => {
      const ai = AGENT_ORDER.indexOf(a), bi = AGENT_ORDER.indexOf(b)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })

  // Activity: most recent span received
  let lastMs = 0
  for (const span of allSpans) {
    const ms = span.receivedAt ?? 0
    if (ms > lastMs) lastMs = ms
  }

  // Turn input tokens for sparkline from timeline
  const turnInputTokens = latest
    ? (latest.timeline ?? [])
        .filter(e => e.type === 'llm' && (e.inputTokens ?? 0) > 0)
        .map(e => e.inputTokens ?? 0)
    : []

  const avgInputTokens = sorted.length > 0
    ? sorted.reduce((s, x) => s + x.inputTokens, 0) / sorted.length : 1
  const avgOutputTokens = sorted.length > 0
    ? sorted.reduce((s, x) => s + x.outputTokens, 0) / sorted.length : 1

  return { sessionCount: sessions.length, latest, agentSources, lastMs, turnInputTokens, avgInputTokens, avgOutputTokens }
}

function computeSidebarPayload(base: ReturnType<typeof sidebarPayloadBase>) {
  const { latest, agentSources, lastMs, turnInputTokens, avgInputTokens, avgOutputTokens } = base
  const isActive = lastMs > 0 && (Date.now() - lastMs) < 20_000

  // Simple burn rate estimate for active sessions
  let burnRate: { tokensPerMinute: number; costPerHour: number } | null = null
  if (latest && isActive && latest.durationMs > 10_000) {
    const totalTokens = latest.inputTokens + latest.outputTokens
    const tpm = (totalTokens / latest.durationMs) * 60_000
    burnRate = { tokensPerMinute: Math.round(tpm), costPerHour: 0 }
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
    costUsd: calcSessionCostUsd(latest),
  } : null

  return { isActive, lastActivityMs: lastMs, sessionCount: base.sessionCount, agentSources, currentSession, burnRate, avgInputTokens, avgOutputTokens }
}

// Legacy shape kept for data the Preact dashboard still reads
function computeSidebarData(summary: ReturnType<typeof summarizeSpans>, _allSpans: Span[]) {
  const sessions = summary.sessions

  const filesSet = new Set<string>()
  let errorCount = 0
  for (const sess of sessions) {
    for (const f of sess.filesChanged) filesSet.add(f)
    errorCount += sess.errors
  }
  const cacheHitPct = sessions.length > 0
    ? Math.round(sessions.reduce((a, s) => a + s.cacheHitRate, 0) / sessions.length * 100) : 0
  const avgTurns = sessions.length > 0
    ? Math.round(sessions.reduce((a, s) => a + s.totalLlmCalls, 0) / sessions.length * 10) / 10 : 0

  const AGENT_KEY_ORDER = ['copilot', 'claude_code', 'codex']
  const agentSources = [...new Set(sessions.map(s => s.source).filter(Boolean))].sort((a, b) => {
    const ai = AGENT_KEY_ORDER.indexOf(a), bi = AGENT_KEY_ORDER.indexOf(b)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  const totalToolCalls = sessions.reduce((s, sess) => s + sess.totalToolCalls, 0)
  const latest = sessions.length > 0 ? sessions[sessions.length - 1] : null
  const latestSession = latest ? {
    source: latest.source,
    model: latest.model || '',
    totalLlmCalls: latest.totalLlmCalls,
    totalToolCalls: latest.totalToolCalls,
    durationMs: latest.durationMs,
    errors: latest.errors,
    cacheHitRate: latest.cacheHitRate,
  } : null

  return {
    sessionCount: sessions.length,
    turnCount: sessions.reduce((s, sess) => s + sess.totalLlmCalls, 0),
    totalInputTokens: sessions.reduce((s, sess) => s + sess.inputTokens, 0),
    totalOutputTokens: sessions.reduce((s, sess) => s + sess.outputTokens, 0),
    filesChangedCount: filesSet.size,
    errors: errorCount,
    totalToolCalls,
    cacheHitPct,
    avgTurns,
    agentSources,
    latestSession,
  }
}

function computeAnalyticsData(sessions: ReturnType<typeof summarizeSpans>['sessions']) {
  const dayMap: Record<string, { totalTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; costUsd: number; sessionCount: number }> = {}
  for (const sess of sessions) {
    if (!sess.startTime) continue
    const start = cachedStart(sess)
    if (isNaN(start.ms)) continue
    const day = start.day ??= new Date(start.ms).toISOString().slice(0, 10)
    if (!dayMap[day]) dayMap[day] = { totalTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0, sessionCount: 0 }
    const r = dayMap[day]
    r.totalTokens += sess.inputTokens
    r.outputTokens += sess.outputTokens
    r.cacheReadTokens += sess.cacheReadTokens
    r.cacheCreateTokens += sess.cacheCreateTokens
    r.sessionCount++
  }
  const dailyStats = Object.entries(dayMap).map(([day, r]) => ({ day, ...r })).sort((a, b) => a.day.localeCompare(b.day))
  const totalTokens = sessions.reduce((s, sess) => s + sess.inputTokens + sess.outputTokens, 0)
  const times = sessions.map(s => s.startTime ? cachedStart(s).ms : 0).filter(t => t > 0)
  const lifetimeStats = {
    totalSessions: sessions.length,
    totalTokens,
    totalCostUsd: 0,
    oldestSessionMs: times.length > 0 ? Math.min(...times) : 0,
    newestSessionMs: times.length > 0 ? Math.max(...times) : 0,
  }
  return { dailyStats, lifetimeStats }
}

// Cache for buildSessionSummary() — summarizeSpans() is a real pass over every span (tens of
// thousands once the store fills up) including per-span BigInt timestamp parsing, and
// buildSessionSummary() used to run it fresh on every call: every HTTP request that touches
// session data, plus the background reconciliation watcher's 60s fallback poll and its
// 3s-after-any-git-activity debounce. With nothing invalidating between those, the event loop
// stayed pinned redoing the same work, which is what made the dashboard (including simple
// actions like opening a link) appear to hang. Keyed on dataVersion so a real change (new span,
// updated log session, clear) still recomputes.
let summaryCache: { version: number; summary: ReturnType<typeof summarizeSpans> | null } | null = null

function buildSessionSummary(): ReturnType<typeof summarizeSpans> | null {
  if (summaryCache && summaryCache.version === dataVersion) return summaryCache.summary

  let summary: ReturnType<typeof summarizeSpans> | null = null
  try { summary = summarizeSpans(spans) } catch (e) { console.warn('[TraceRoost] summarizeSpans error:', e) }

  // Merge log-sourced sessions; OTEL wins — on an ID collision, and for a Claude transcript whose
  // conversation an OTEL interaction already covers (same Claude session id, overlapping time; the
  // rule the extension's database writer applies — see claudeConversation.ts), so one Claude
  // session is listed once, not once per ingestion path. OTEL backfills conversationId from the
  // log-sourced sibling when it has none — buildClaudeSessions (the live OTEL path) never does
  // cross-trace/multi-segment linking, only logReader.ts's file parser does.
  if (logSessions.size > 0) {
    const logOnly = logCardsNotCoveredByOtel(summary?.sessions ?? [], logSessions.values())
    if (logOnly.length > 0) {
      const merged = sortNewestFirst([...logOnly, ...(summary?.sessions ?? [])])
      summary = { ...(summary ?? { backgroundSpans: [], efficiency: { totalInputTokens: 0, totalOutputTokens: 0, totalLlmCalls: 0, avgInputPerCall: 0, avgTtft: 0, cacheHitRate: 0, toolDefWaste: 0, sysInstructionWaste: 0, topTokenConsumers: [] } }), sessions: merged }
    }
  }
  summaryCache = { version: dataVersion, summary }
  return summary
}

/** Each log-sourced card's `JSON.stringify({ ...card, timeline: [] })`. Log cards outlive any one
 *  dataVersion (only the few that changed are replaced per scan), so re-serializing all of them
 *  for every update — tens of MB at 20k sessions — was most of what one OTLP post cost. Keyed on
 *  the card object and dropped whenever a card (re-)enters `logSessions` (setLogSession). OTEL
 *  cards are rebuilt by every summarizeSpans() pass, so they're serialized fresh. */
const strippedCardJson = new WeakMap<SessionSummaryCard, string>()

/** Each session's `JSON.stringify({ ...card, timeline: [] })`, reusing strippedCardJson. */
function strippedCardJsons(summary: ReturnType<typeof summarizeSpans>): string[] {
  return summary.sessions.map(s => {
    const reusable = logSessions.get(s.sessionId) === s
    let json = reusable ? strippedCardJson.get(s) : undefined
    if (json === undefined) {
      json = JSON.stringify({ ...s, timeline: [] })
      if (reusable) strippedCardJson.set(s, json)
    }
    return json
  })
}

/** The summary with every session's timeline emptied (`{ ...summary, sessions: sessions.map(s =>
 *  ({ ...s, timeline: [] })) }`), as JSON — byte for byte what stringifying that would give, but
 *  built from strippedCardJsons. Timelines are loaded lazily via /api/timeline/:sessionId instead. */
function strippedSummaryJson(summary: ReturnType<typeof summarizeSpans> | null, cards: string[] | null): string {
  if (!summary || !cards) return 'null'
  // Serialize everything but `sessions` normally (keeping its key position), then splice the
  // cached card array in where a unique placeholder string landed.
  const placeholder = `__traceroost_sessions_${process.pid}_${dataVersion}__`
  const shell = JSON.stringify({ ...summary, sessions: placeholder })
  const at = shell.indexOf(`"${placeholder}"`)
  return shell.slice(0, at) + '[' + cards.join(',') + ']' + shell.slice(at + placeholder.length + 2)
}

/** Everything the dashboard's update payload, the inlined first-paint HTML and /api/summary derive
 *  from the session data — recomputed once per dataVersion instead of once per HTTP request/SSE
 *  push (each of which used to re-sort, re-aggregate and re-serialize every session). Only the
 *  clock/pricing-dependent sidebar bits (computeSidebarPayload) are still computed per use. */
interface DerivedViews {
  version: number
  summary: ReturnType<typeof summarizeSpans> | null
  /** strippedCardJsons(summary) — what both the full payload and SSE deltas are built from. */
  cardJsons: string[] | null
  /** strippedSummaryJson() of the same summary. Built on first use (see strippedJsonOf) — an SSE
   *  delta doesn't need the whole ~23MB (at 20k sessions) string. */
  strippedJson: string | null
  /** safeJson() of the same value, for inlining into a <script>. Built on first use. */
  strippedSafeJson: string | null
  sidebarJson: string
  analyticsJson: string
  sidebarBase: ReturnType<typeof sidebarPayloadBase> | null
}
let derivedCache: DerivedViews | null = null

function derivedViews(): DerivedViews {
  const summary = buildSessionSummary()
  if (derivedCache && derivedCache.version === dataVersion && derivedCache.summary === summary) return derivedCache
  derivedCache = {
    version: dataVersion,
    summary,
    cardJsons: summary ? strippedCardJsons(summary) : null,
    strippedJson: null,
    strippedSafeJson: null,
    sidebarJson: JSON.stringify(summary ? computeSidebarData(summary, spans) : null),
    analyticsJson: JSON.stringify(summary ? computeAnalyticsData(summary.sessions) : null),
    sidebarBase: summary ? sidebarPayloadBase(summary, spans) : null,
  }
  return derivedCache
}

function strippedJsonOf(views: DerivedViews): string {
  return views.strippedJson ??= strippedSummaryJson(views.summary, views.cardJsons)
}

function syncSummaryOf(views: DerivedViews): SyncSummary | null {
  const summary = views.summary
  if (!summary || !views.cardJsons) return null
  return {
    ids: summary.sessions.map(s => s.sessionId),
    cardJsons: views.cardJsons,
    efficiencyJson: JSON.stringify(summary.efficiency),
    backgroundSpansJson: JSON.stringify(summary.backgroundSpans),
    deltaable: Array.isArray(summary.backgroundSpans) &&
      Object.keys(summary).every(k => k === 'sessions' || k === 'efficiency' || k === 'backgroundSpans'),
  }
}

// ── SSE session sync ──────────────────────────────────────────────────────────
// Every open tab is sent the same frames in the same order, so one SseSessionSync tracks what all
// of them hold (see sseSessionSync.ts). A tab that holds something else — a new connection whose
// page was rendered at an older revision, a reconnect, a missed frame — gets a full update.
const sseSync = new SseSessionSync(Date.now())
/** The derivedViews() sseSync was last advanced to. */
let sseSyncedViews: DerivedViews | null = null
/** Open SSE responses by the client id the page connected with — how POST /api/sse-resync finds
 *  the stream to send a requested full update down. */
const sseClientsById = new Map<string, http.ServerResponse>()

/** An `update` frame: `fields` (the session/analytics part, see SyncStep) plus what every frame
 *  carries — the legacy sidebar blob and the live sidebar/burn-rate fields. */
function updateFrame(views: DerivedViews, base: number, rev: number, fields: string): string {
  const sidebarLive = views.sidebarBase ? computeSidebarPayload(views.sidebarBase) : null
  return '{"type":"update","summary":{"toolCalls":{}}' + fields + ',"sidebar":' + views.sidebarJson +
    ',"base":' + base + ',"rev":' + rev +
    (sidebarLive ? ',' + JSON.stringify(sidebarLive).slice(1) : '}')
}

/** Advances sseSync to the current data, sending what changed (if anything) to every open tab.
 *  Returns false when there was nothing to send. */
function syncSseClients(): boolean {
  const views = derivedViews()
  if (views === sseSyncedViews) return false
  sseSyncedViews = views
  const step = sseSync.advance(syncSummaryOf(views), () => strippedJsonOf(views), views.analyticsJson)
  if (!step.fields) return false
  writeSse(updateFrame(views, step.base, step.rev, step.fields))
  return true
}

/** A full update at sseSync's current revision, for one client that doesn't hold it. */
function fullUpdateFrame(): string {
  syncSseClients()
  const views = derivedViews()
  const rev = sseSync.revision
  return updateFrame(views, rev, rev, ',"sessionSummary":' + strippedJsonOf(views) + ',"analyticsData":' + views.analyticsJson)
}

function writeSse(data: string): void {
  sseClients = sseClients.filter(client => {
    try { client.write(`data: ${data}\n\n`); return true } catch { return false }
  })
}

function pushUpdate() {
  if (pushUpdateTimer) { clearTimeout(pushUpdateTimer); pushUpdateTimer = null }
  lastPushUpdateAt = Date.now()
  if (sseClients.length === 0) return // nobody to tell — a tab that connects later gets a fresh payload
  const started = performance.now()
  // Nothing session-shaped changed: still send the live sidebar fields, as every push always has.
  if (!syncSseClients()) writeSse(updateFrame(derivedViews(), sseSync.revision, sseSync.revision, ''))
  lastPushUpdateCostMs = performance.now() - started
}

// Ingest-driven pushes (every OTLP POST, every changed log file) are coalesced: at most one full
// update per PUSH_UPDATE_MIN_INTERVAL_MS — or per 3× what the last one cost, on a history large
// enough that building and writing the payload takes a while — always ending on the latest state.
// Pushing on every POST rebuilt and re-sent the whole summary each time, which on a large history
// kept the event loop busy for as long as an agent kept exporting.
const PUSH_UPDATE_MIN_INTERVAL_MS = 250
let pushUpdateTimer: ReturnType<typeof setTimeout> | null = null
let lastPushUpdateAt = 0
let lastPushUpdateCostMs = 0

function schedulePushUpdate(): void {
  if (pushUpdateTimer) return
  const wait = lastPushUpdateAt + Math.max(PUSH_UPDATE_MIN_INTERVAL_MS, 3 * lastPushUpdateCostMs) - Date.now()
  if (wait <= 0) { pushUpdate(); return }
  pushUpdateTimer = setTimeout(pushUpdate, wait)
}

/** Sends an arbitrary message to every open dashboard tab, exactly as `vscode.postMessage` would
 *  in the extension host — the browser-side shim (`new EventSource('/events')`, see the inline
 *  script below) re-dispatches each SSE payload as a `window` `message` event, so the same
 *  `msg.type` switch in App.tsx handles both hosts unmodified. */
function broadcastSse(payload: Record<string, unknown>): void {
  writeSse(JSON.stringify(payload))
}

/** Pushes a fresh org status to every open dashboard tab — call after anything that can change
 *  what the Org panel shows without a user having triggered it directly (a background
 *  forward-queue drain, in particular; see `forwardScheduler`'s `onDrainComplete` below). A no-op
 *  cheaply when nothing is linked. `openExternal` is a real no-op, not a stub standing in for one
 *  — `getOrgStatus` never opens anything, so nothing here should ever call it. */
function pushOrgStatusToClients(): void {
  void cloud.handleOrgMessage({ type: 'getOrgStatus' }, {
    post: (m) => broadcastSse(m),
    openExternal: () => {},
    recentSessions: () => buildSessionSummary()?.sessions.slice(0, 25) ?? [],
    log: (m) => console.log(m),
  })
}

/** The standalone page's Org-panel transport: the webview posts `org*` messages, this polyfill
 *  turns them into `/api/org` requests. Empty in the core edition — its Org panel is a stub that
 *  never posts one — so no org wiring reaches the page at all. A literal
 *  `process.env.TRACEROOST_EDITION` check (esbuild.js defines it) so the core build drops the
 *  string entirely rather than just never using it. */
let ORG_FETCH_SHIM = ''
if (process.env.TRACEROOST_EDITION !== 'core') {
  ORG_FETCH_SHIM = ` else if (msg.type && (msg.type === 'getOrgStatus' || msg.type.indexOf('org') === 0)) {
            fetch('/api/org', {
              method: msg.type === 'getOrgStatus' ? 'GET' : 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: msg.type === 'getOrgStatus' ? undefined : JSON.stringify(msg),
            }).then(function(r) { return r.json(); }).then(function(data) {
              (data.messages || []).forEach(function(m) {
                if (m.type === 'orgLinkUrl' && m.url) { window.open(m.url, '_blank'); }
                window.dispatchEvent(new MessageEvent('message', { data: m }));
              });
            }).catch(function() {
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'orgActionResult', ok: false, error: 'request failed' } }));
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'orgError', error: 'request failed' } }));
            });
            return;
          }`
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

function getHtml(): string {
  // The inlined sessions are sseSync's current revision — the page's SSE connection passes that
  // revision back, and is spared a second full copy when nothing changed in between.
  syncSseClients()
  const sessionRev = sseSync.revision
  const views = derivedViews()
  // Strip full timeline arrays before inlining — they can be many MB across sessions.
  // Timelines are loaded lazily via /api/timeline/:sessionId after first paint.
  const sessionSummaryJson = views.strippedSafeJson ??= safeJsonText(strippedJsonOf(views))
  const sidebarLive = views.sidebarBase ? computeSidebarPayload(views.sidebarBase) : {
    isActive: false, lastActivityMs: 0, sessionCount: 0, agentSources: [], currentSession: null, burnRate: null,
  }
  const sidebarInitJson = safeJson(sidebarLive)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script>
    // Applies a stored dark/light override before first paint, so the page never flashes the
    // wrong theme for a frame — must run before the <style> block below resolves the CSS custom
    // properties it depends on. No entry (or "system") means no attribute: the prefers-color-scheme
    // media query in that block handles it instead. See media/src/state.ts's setThemePreference,
    // which is the only other writer of this key.
    (function () {
      try {
        var t = localStorage.getItem('traceroost-theme');
        if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
      } catch (e) { /* localStorage unavailable — falls back to system preference below */ }
    })();
  </script>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TraceRoost</title>
  <link rel="icon" href="/mascot.png" type="image/png">
  <link rel="stylesheet" href="/dashboard.css">
  <style>
    /* ── VS Code theme variable shim ─────────────────────────────────────────
       Standalone has no real VS Code host to supply --vscode-* variables, so this
       defines them directly. Three states: System (default — follows
       prefers-color-scheme), Dark, Light (explicit override via the [data-theme]
       attribute the script above sets). Toggle lives in Settings — see
       media/src/tabs/Settings.tsx's ThemeToggle and .staged-issues/theme-toggle.md.
       Not used in the VS Code webview at all — that has its own HTML in
       src/dashboardPanel.ts and always inherits the IDE's real --vscode-* values. ── */

    /* Light palette — the default, before any media query or explicit override applies.
       color-scheme tells the browser which mode *native* form control chrome (dropdowns,
       checkboxes, date pickers) should render in — without it, those follow the OS/browser's own
       dark-mode detection independently of the custom colors above, which is why they kept
       rendering dark even when everything else correctly switched to light. */
    :root {
      color-scheme: light;
      --agent-copilot: #087e96; --agent-claude: #c2410c; --agent-codex: #7c3aed;
      --vscode-editor-background:       #ffffff;
      --vscode-foreground:              #1f2328;
      --vscode-panel-border:            #d0d7de;
      --vscode-textLink-foreground:     #0969da;
      --vscode-descriptionForeground:   #656d76;
      --vscode-list-hoverBackground:    #f3f4f6;
      --vscode-editorWidget-background: #f6f8fa;
      --vscode-testing-iconFailed:      #cf222e;
      --vscode-testing-iconPassed:      #1a7f37;
      --vscode-font-family:             -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --vscode-dropdown-background:     #ffffff;
      --vscode-dropdown-border:         #d0d7de;
      --vscode-dropdown-foreground:     #1f2328;
      --vscode-button-background:       #0969da;
      --vscode-button-foreground:       #ffffff;
      --vscode-button-hoverBackground:  #0860ca;

      /* Aliases for --vscode-* names real VS Code exposes that this shim otherwise never defined —
         components referencing them (input fields, list selection highlight) were silently falling
         back to their hardcoded (dark) fallback value in every theme, since an undefined custom
         property with a var() fallback ignores the current theme entirely. Defined once here rather
         than duplicated into the dark blocks below — custom property resolution follows the cascade
         at use time, so these keep tracking whatever --vscode-dropdown-background (etc.) and
         --vscode-list-hoverBackground currently resolve to in each theme, without needing to be
         redeclared per theme. */
      --vscode-input-background:              var(--vscode-dropdown-background);
      --vscode-input-border:                  var(--vscode-dropdown-border);
      --vscode-input-foreground:              var(--vscode-dropdown-foreground);
      --vscode-list-activeSelectionBackground: var(--vscode-list-hoverBackground);
      --vscode-focusBorder:                   var(--vscode-textLink-foreground);

      /* Status/chart colors — semantic accents that don't need to invert with theme (these stay
         legible against both a white and a dark background at these saturations). Values match the
         one fallback each call site already used consistently, so defining these doesn't also
         change how they've looked in dark mode all along — it only fixes light mode, which
         previously got the same dark-tuned fallback since the variable itself was never defined. */
      --vscode-editorInfo-foreground:    #4fc3f7;
      --vscode-editorWarning-foreground: #cca700;
      --vscode-errorForeground:          #f48771;
      --vscode-charts-blue:              #4fc3f7;
      --vscode-charts-green:             #1a7f37;
      --vscode-charts-red:               #e57373;
      --vscode-charts-yellow:            #ffb74d;
    }

    /* System preference is dark, and the user hasn't explicitly forced Light. */
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
      --vscode-charts-green: #81c784;
      --agent-copilot: #00EAFF; --agent-claude: #FFB085; --agent-codex: #F0FF42;
        --vscode-editor-background:       #1e1e1e;
        --vscode-foreground:              #cccccc;
        --vscode-panel-border:            #3e3e42;
        --vscode-textLink-foreground:     #4fc3f7;
        --vscode-descriptionForeground:   #9d9d9d;
        --vscode-list-hoverBackground:    #2a2d2e;
        --vscode-editorWidget-background: #252526;
        --vscode-testing-iconFailed:      #f44747;
        --vscode-testing-iconPassed:      #4ec994;
        --vscode-dropdown-background:     #3c3c3c;
        --vscode-dropdown-border:         #616161;
        --vscode-dropdown-foreground:     #f0f0f0;
        --vscode-button-background:       #0e639c;
        --vscode-button-foreground:       #ffffff;
        --vscode-button-hoverBackground:  #1177bb;
      }
    }

    /* Explicit Dark override, regardless of system preference. */
    :root[data-theme="dark"] {
      color-scheme: dark;
      --vscode-charts-green: #81c784;
      --agent-copilot: #00EAFF; --agent-claude: #FFB085; --agent-codex: #F0FF42;
      --vscode-editor-background:       #1e1e1e;
      --vscode-foreground:              #cccccc;
      --vscode-panel-border:            #3e3e42;
      --vscode-textLink-foreground:     #4fc3f7;
      --vscode-descriptionForeground:   #9d9d9d;
      --vscode-list-hoverBackground:    #2a2d2e;
      --vscode-editorWidget-background: #252526;
      --vscode-testing-iconFailed:      #f44747;
      --vscode-testing-iconPassed:      #4ec994;
      --vscode-dropdown-background:     #3c3c3c;
      --vscode-dropdown-border:         #616161;
      --vscode-dropdown-foreground:     #f0f0f0;
      --vscode-button-background:       #0e639c;
      --vscode-button-foreground:       #ffffff;
      --vscode-button-hoverBackground:  #1177bb;
    }

    /* ── Standalone layout ───────────────────────────────────────────────── */
    html, body { height: 100%; overflow: hidden; margin: 0; padding: 0; }
    body { padding: 0; }
    #sa-wrap { display: flex; height: 100vh; width: 100vw; overflow: hidden; }

    /* ── Sidebar panel ───────────────────────────────────────────────────── */
    #sa-sidebar {
      width: 260px;
      min-width: 260px;
      background: var(--vscode-editorWidget-background);
      border-right: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
      transition: width 0.15s ease, min-width 0.15s ease;
    }
    #sa-sidebar.sa-collapsed { width: 0; min-width: 0; }

    /* Sidebar content — shared CSS classes with sidebarWebview.ts */
    .sb-card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; }
    .sb-section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .sb-row { display: flex; align-items: center; gap: 6px; }
    .sb-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .sb-dot.active { background: #56D364; animation: sbPulse 1.5s ease-in-out infinite; }
    .sb-dot.idle { background: var(--vscode-descriptionForeground); opacity: 0.5; }
    @keyframes sbPulse { 0%,100% { opacity:1;transform:scale(1); } 50% { opacity:0.5;transform:scale(1.4); } }
    .sb-status { font-size: 12px; font-weight: 600; }
    .sb-muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .sb-prompt { font-size: 10px; color: var(--vscode-foreground); opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 3px 0 2px; font-style: italic; }
    .sb-model { font-size: 10px; color: var(--vscode-textLink-foreground); margin-bottom: 4px; }
    #sa-sidebar canvas { display: block; width: 100%; height: 80px; }
    .sb-turn-label { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
    .sb-burn { font-size: 12px; font-weight: 600; color: var(--vscode-charts-green, #81c784); }
    .sb-counters { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; text-align: center; }
    .sb-counter-val { font-size: 16px; font-weight: 700; color: var(--vscode-textLink-foreground); }
    .sb-counter-key { font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.3px; }
.sb-footer { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
#sa-toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#333; color:#fff; padding:8px 16px; border-radius:4px; font-size:12px; z-index:9999; opacity:0; transition:opacity 0.2s; pointer-events:none; white-space:nowrap; box-shadow:0 2px 8px rgba(0,0,0,0.4); }
    #sa-toast.visible { opacity:1; }

    /* ── Main panel ──────────────────────────────────────────────────────── */
    #sa-main { flex: 1; overflow-y: auto; scrollbar-gutter: stable; min-width: 0; padding: 0 18px 16px; }
    #app { min-height: 100%; }
  </style>
</head>
<body>
  <script>
    console.log('[TraceRoost] HTML received', Date.now());
    window.__INITIAL_TOOL_CALLS__ = {};
    window.__INITIAL_SESSION_SUMMARY__ = ${sessionSummaryJson};
    window.__INITIAL_SESSION_REV__ = ${sessionRev};
    window.__STANDALONE__ = true;
    window.__VERSION__ = ${JSON.stringify(PACKAGE_VERSION)};

    // ── Client-side search support ────────────────────────────────────────────
    var __latestSessions__ = (window.__INITIAL_SESSION_SUMMARY__ && window.__INITIAL_SESSION_SUMMARY__.sessions) || [];
    // Follows the same base/rev protocol as App.tsx's 'update' handler: a frame whose base isn't
    // the revision held here is skipped — the dashboard asks for the full update that fixes both.
    var __latestRev__ = window.__INITIAL_SESSION_REV__;
    window.addEventListener('message', function(e) {
      var d = e.data;
      if (!d || d.type !== 'update') return;
      if (d.sessionSummary !== undefined) {
        if (d.sessionSummary && d.sessionSummary.sessions) __latestSessions__ = d.sessionSummary.sessions;
        __latestRev__ = d.rev;
      } else if (d.base !== undefined && d.base !== __latestRev__) {
        return;
      } else if (d.sessionDelta) {
        var byId = new Map();
        __latestSessions__.forEach(function(s) { byId.set(s.sessionId, s); });
        d.sessionDelta.upserts.forEach(function(s) { byId.set(s.sessionId, s); });
        var order = d.sessionDelta.order || __latestSessions__.map(function(s) { return s.sessionId; });
        var next = [];
        for (var i = 0; i < order.length; i++) {
          if (!byId.has(order[i])) return;
          next.push(byId.get(order[i]));
        }
        __latestSessions__ = next;
        __latestRev__ = d.rev;
      } else if (d.rev !== undefined) {
        __latestRev__ = d.rev;
      }
    });

    var _toastTimer;
    function showToast(msg) {
      var el = document.getElementById('sa-toast');
      if (!el) { el = document.createElement('div'); el.id = 'sa-toast'; document.body.appendChild(el); }
      el.textContent = msg;
      el.classList.add('visible');
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(function() { el.classList.remove('visible'); }, 3000);
    }

    // CSV/Markdown export helpers — mirrors src/exportFormats.ts. Kept as hand-written vanilla JS
    // (not compiled from TS) because this whole block is embedded directly into the served HTML's
    // inline <script>, matching the rest of this file's acquireVsCodeApi polyfill.
    function csvCell(value) {
      return '"' + String(value).replace(/"/g, '""') + '"';
    }
    function joinList(items) {
      return (items || []).join('; ');
    }
    function joinToolCounts(counts) {
      var parts = [];
      for (var tool in (counts || {})) { parts.push(tool + ':' + counts[tool]); }
      return parts.join('; ');
    }
    function joinLoopSignals(signals) {
      return (signals || []).map(function(s) { return s.type + '(' + s.severity + ')'; }).join('; ');
    }
    var CSV_HEADERS = [
      'Session ID', 'Trace ID', 'Source', 'Data Source', 'Model', 'Models', 'Start Time', 'Duration (ms)', 'Turns',
      'Tool Calls', 'Input Tokens', 'Output Tokens', 'Cache Read Tokens', 'Cache Create Tokens',
      'Cache Hit Rate', 'Errors', 'Outcome', 'Tool Counts', 'Files Read', 'Files Changed',
      'Loop Signals', 'User Request'
    ];
    function toCsv(sessions) {
      var rows = sessions.map(function(s) {
        return [
          s.sessionId, s.traceId, s.source, s.dataSource || 'otel', s.model, joinList(s.models), s.startTime,
          String(s.durationMs), String(s.turns), String(s.totalToolCalls), String(s.inputTokens),
          String(s.outputTokens), String(s.cacheReadTokens), String(s.cacheCreateTokens),
          (s.cacheHitRate || 0).toFixed(4), String(s.errors), s.outcome,
          joinToolCounts(s.toolCounts), joinList(s.filesRead), joinList(s.filesChanged),
          joinLoopSignals(s.loopSignals), s.userRequest || ''
        ];
      });
      var allRows = [CSV_HEADERS].concat(rows);
      return allRows.map(function(row) { return row.map(csvCell).join(','); }).join('\\r\\n') + '\\r\\n';
    }
    function mdEscape(text) {
      return String(text).replace(/\\|/g, '\\\\|');
    }
    function toMarkdown(sessions) {
      var parts = ['# TraceRoost Session Export', '', sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + ', exported ' + new Date().toISOString(), ''];
      sessions.forEach(function(s) {
        parts.push('## ' + (s.model || 'unknown model') + ' — ' + (s.startTime || 'unknown time'));
        parts.push('');
        parts.push('- **Session ID:** ' + s.sessionId);
        parts.push('- **Source:** ' + s.source + ' (' + (s.dataSource === 'log' ? 'log file' : 'OTEL') + ')');
        if (s.models && s.models.length > 1) parts.push('- **Models used:** ' + joinList(s.models));
        parts.push('- **Duration:** ' + s.durationMs + 'ms');
        parts.push('- **Turns:** ' + s.turns + ' · **Tool calls:** ' + s.totalToolCalls + ' · **Errors:** ' + s.errors);
        parts.push('- **Tokens:** ' + s.inputTokens.toLocaleString() + ' in / ' + s.outputTokens.toLocaleString() + ' out '
          + '(cache read ' + s.cacheReadTokens.toLocaleString() + ', cache write ' + s.cacheCreateTokens.toLocaleString() + ', '
          + ((s.cacheHitRate || 0) * 100).toFixed(1) + '% hit rate)');
        parts.push('- **Outcome:** ' + s.outcome);
        if (s.toolCounts && Object.keys(s.toolCounts).length > 0) {
          parts.push('- **Tool counts:** ' + joinToolCounts(s.toolCounts));
        }
        if (s.loopSignals && s.loopSignals.length > 0) {
          parts.push('- **Loop signals:** ' + joinLoopSignals(s.loopSignals));
        }
        if (s.filesRead && s.filesRead.length > 0) {
          parts.push('', '**Files read:**', '');
          s.filesRead.forEach(function(f) { parts.push('- \`' + mdEscape(f) + '\`'); });
        }
        if (s.filesChanged && s.filesChanged.length > 0) {
          parts.push('', '**Files changed:**', '');
          s.filesChanged.forEach(function(f) { parts.push('- \`' + mdEscape(f) + '\`'); });
        }
        if (s.userRequest) {
          parts.push('', '**Prompt:**', '', '> ' + mdEscape(s.userRequest).replace(/\\n/g, '\\n> '));
        }
        parts.push('', '---', '');
      });
      return parts.join('\\n');
    }
    function serializeExport(sessions, format) {
      if (format === 'csv') return toCsv(sessions);
      if (format === 'markdown') return toMarkdown(sessions);
      return JSON.stringify(sessions, null, 2);
    }
    function exportMimeType(format) {
      return format === 'csv' ? 'text/csv' : format === 'markdown' ? 'text/markdown' : 'application/json';
    }
    function exportFileExtension(format) {
      return format === 'csv' ? 'csv' : format === 'markdown' ? 'md' : 'json';
    }

    function getNotifContainer() {
      var el = document.getElementById('sa-notif-container');
      if (!el) {
        el = document.createElement('div');
        el.id = 'sa-notif-container';
        el.style.cssText = 'position:fixed;bottom:20px;right:16px;z-index:9998;display:flex;flex-direction:column;gap:8px;max-width:320px;';
        document.body.appendChild(el);
      }
      return el;
    }

    // showActionNotification(label, prompt, color, preview, secondaryAction, dismissMs)
    // secondaryAction: { label: string, onClick: function } | null — rendered before Copy Prompt
    function showActionNotification(label, prompt, color, preview, secondaryAction, dismissMs) {
      color = color || '#f6a623';
      var container = getNotifContainer();
      var notif = document.createElement('div');
      notif.style.cssText = 'background:#252526;border:1px solid #3e3e42;border-left:3px solid ' + color + ';border-radius:4px;padding:10px 12px;font-size:12px;color:#ccc;box-shadow:0 2px 8px rgba(0,0,0,0.4);';

      var header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;';

      var labelEl = document.createElement('span');
      labelEl.style.cssText = 'font-weight:600;color:' + color + ';line-height:1.3;';
      labelEl.textContent = label;

      var closeBtn = document.createElement('button');
      closeBtn.textContent = '×';
      closeBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:16px;padding:0;line-height:1;flex-shrink:0;';
      closeBtn.onclick = function() { notif.remove(); };

      header.appendChild(labelEl);
      header.appendChild(closeBtn);
      notif.appendChild(header);

      if (preview) {
        var previewEl = document.createElement('div');
        previewEl.style.cssText = 'font-size:11px;color:#999;margin-bottom:8px;line-height:1.4;max-height:56px;overflow:hidden;';
        previewEl.textContent = preview;
        notif.appendChild(previewEl);
      }

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

      if (secondaryAction) {
        var secBtn = document.createElement('button');
        secBtn.textContent = secondaryAction.label;
        secBtn.style.cssText = 'background:none;border:1px solid #555;border-radius:3px;color:#ccc;cursor:pointer;font-size:11px;padding:4px 10px;';
        secBtn.onclick = function() { secondaryAction.onClick(); notif.remove(); };
        actions.appendChild(secBtn);
      }

      var copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy Prompt';
      copyBtn.style.cssText = 'background:none;border:1px solid ' + color + ';border-radius:3px;color:' + color + ';cursor:pointer;font-size:11px;padding:4px 10px;';
      copyBtn.onclick = function() {
        navigator.clipboard.writeText(prompt).then(function() {
          copyBtn.textContent = 'Copied!';
          copyBtn.style.borderColor = '#56D364';
          copyBtn.style.color = '#56D364';
          setTimeout(function() { notif.remove(); }, 1500);
        }).catch(function() {
          showToast('Could not copy — check browser clipboard permissions');
        });
      };
      actions.appendChild(copyBtn);

      notif.appendChild(actions);
      container.appendChild(notif);
      setTimeout(function() { notif.remove(); }, dismissMs || 30000);
    }

    window.acquireVsCodeApi = function() {
      return {
        getState: function() { return null; },
        setState: function() {},
        postMessage: function(msg) {
          if (msg.type === 'requestFullUpdate') {
            _requestFullUpdate();
          }${ORG_FETCH_SHIM}
          if (msg.type === 'confirmClear') {
            if (confirm('Clear all TraceRoost data? OTEL trace data is deleted permanently. TraceRoost log cache is cleared and will be rebuilt from your local agent log files (the log files themselves are not deleted).')) {
              fetch('/api/clear', { method: 'POST' });
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'clearAll' } }));
            }
          } else if (msg.type === 'clearAll') {
            fetch('/api/clear', { method: 'POST' });
          } else if (msg.type === 'automation' && msg.prompt) {
            // Build full prompt matching VS Code format: [label] + session ID + body
            var sessionLine = msg.sessionId ? 'Session ID: ' + msg.sessionId + '\\n' : '';
            var autoFull = '[' + (msg.label || 'Automation') + ']\\n\\n' + sessionLine + msg.prompt;
            var autoPreview = msg.prompt.length > 160 ? msg.prompt.slice(0, 160) + '…' : msg.prompt;
            var autoLabel = 'Automation: ' + (msg.label || 'Automation');
            var viewAutomations = {
              label: 'View Automations',
              onClick: function() {
                window.dispatchEvent(new MessageEvent('message', { data: { type: 'switchTab', tab: 'settings-automation' } }));
              }
            };
            if (msg.writePromptsFile) {
              fetch('/api/write-prompts-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agent: msg.agent, label: msg.label, prompt: autoFull })
              }).then(function() {
                var slug = msg.agent === 'claude_code' ? 'claude' : msg.agent === 'codex' ? 'codex' : 'copilot';
                showToast('Prompt written to traceroost-prompts-' + slug + '.md');
              }).catch(function() {
                showActionNotification(autoLabel, autoFull, '#f6a623', autoPreview, viewAutomations, 30000);
              });
            } else {
              showActionNotification(autoLabel, autoFull, '#f6a623', autoPreview, viewAutomations, 30000);
            }
          } else if (msg.type === 'askAI' && msg.prompt) {
            navigator.clipboard.writeText(msg.prompt).then(function() {
              showToast('Prompt copied to clipboard');
            }).catch(function() {
              showToast('Could not copy — check browser clipboard permissions');
            });
          } else if (msg.type === 'exportSessionData' || msg.type === 'exportSessionDataRedacted') {
            var redact = msg.type === 'exportSessionDataRedacted';
            var exportIds = Array.isArray(msg.sessionIds) ? new Set(msg.sessionIds) : null;
            var exportSessions = exportIds
              ? (__latestSessions__ || []).filter(function(s) { return exportIds.has(s.sessionId); })
              : (__latestSessions__ || []);
            var exportable = exportSessions.map(function(s) {
              return {
                sessionId:         s.sessionId,
                traceId:           s.traceId,
                source:            s.source,
                dataSource:        s.dataSource || 'otel',
                model:             s.model,
                models:            s.models || [s.model],
                startTime:         s.startTime,
                durationMs:        s.durationMs,
                turns:             s.totalLlmCalls,
                totalToolCalls:    s.totalToolCalls,
                inputTokens:       s.inputTokens,
                outputTokens:      s.outputTokens,
                cacheReadTokens:   s.cacheReadTokens,
                cacheCreateTokens: s.cacheCreateTokens,
                cacheHitRate:      s.cacheHitRate,
                errors:            s.errors,
                outcome:           s.outcome,
                toolCounts:        s.toolCounts,
                filesRead:    redact ? (s.filesRead    || []).map(function() { return '[redacted]'; }) : s.filesRead,
                filesChanged: redact ? (s.filesChanged || []).map(function() { return '[redacted]'; }) : s.filesChanged,
                loopSignals:  s.loopSignals,
                userRequest:  redact ? '[redacted]' : (s.userRequest || null),
              };
            });
            var format = (msg.format === 'csv' || msg.format === 'markdown') ? msg.format : 'json';
            var now = new Date();
            var pad = function(n) { return String(n).padStart(2, '0'); };
            var ts = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
                     '_' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
            var filename = (redact ? 'export_redacted' : 'export') + '_sessions_' + ts + '.' + exportFileExtension(format);
            var blob = new Blob([serializeExport(exportable, format)], { type: exportMimeType(format) });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
            showToast('Downloaded ' + filename);
          } else if (msg.type === 'openSidebar' || msg.type === 'closeSidebar') {
            window.dispatchEvent(new CustomEvent('traceroost:sidebar', { detail: { open: msg.type === 'openSidebar' } }));
          } else if (msg.type === 'searchSessions' && msg.query) {
            var q = msg.query;
            var filtered = __latestSessions__.filter(function(s) {
              if (q.text) {
                var t = q.text.toLowerCase();
                if (!(s.userRequest || '').toLowerCase().includes(t) && !(s.model || '').toLowerCase().includes(t)) return false;
              }
              if (q.source && s.source !== q.source) return false;
              if (q.since) { var ms = s.startTime ? new Date(s.startTime).getTime() : 0; if (ms < q.since) return false; }
              if (q.until) { var ms2 = s.startTime ? new Date(s.startTime).getTime() : 0; if (ms2 > q.until) return false; }
              return true;
            });
            var dir = q.orderDir === 'ASC' ? 1 : -1;
            filtered.sort(function(a, b) {
              if (q.orderBy === 'start_time') return dir * (new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
              if (q.orderBy === 'total_tokens') return dir * ((a.inputTokens + a.outputTokens) - (b.inputTokens + b.outputTokens));
              if (q.orderBy === 'duration_ms') return dir * (a.durationMs - b.durationMs);
              if (q.orderBy === 'errors') return dir * (a.errors - b.errors);
              if (q.orderBy === 'cost_usd') return 0;
              return 0;
            });
            var offset = q.offset || 0; var limit = q.limit || 50;
            var page = filtered.slice(offset, offset + limit);
            setTimeout(function() {
              window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'searchResults', sessions: page, totalCount: filtered.length, offset: offset, context: msg.context || 'search' }
              }));
            }, 0);
          } else if (msg.type === 'alert' && msg.label) {
            var alertColor = msg.severity === 'error' ? '#f44747' : msg.severity === 'info' ? '#4fc3f7' : '#f6a623';
            var alertPrompt = [
              "An alert was triggered in my AI coding trace. Please explain what's happening and how I should respond.",
              '',
              'Alert: ' + msg.label,
            ].concat(msg.detail ? ['Detail: ' + msg.detail] : []).join('\\n');
            showActionNotification(
              'Alert: ' + msg.label,
              alertPrompt,
              alertColor,
              msg.detail || null,
              {
                label: 'View Alerts',
                onClick: function() {
                  window.dispatchEvent(new MessageEvent('message', { data: { type: 'switchTab', tab: 'alerts' } }));
                }
              },
              30000
            );
          } else if (msg.type === 'loadSessionDetail' && msg.sessionId) {
            fetch('/api/timeline/' + encodeURIComponent(msg.sessionId))
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'sessionDetail', sessionId: msg.sessionId, timeline: data.timeline || [] }
                }));
              })
              .catch(function(e) { console.warn('[TraceRoost] timeline fetch failed', e); });
          } else if (msg.type === 'getGitOutcome' && msg.sessionId) {
            fetch('/api/git-outcome', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: msg.sessionId,
                workspace: msg.workspace || '',
                filesChanged: msg.filesChanged || [],
                endTime: msg.endTime || '',
              }),
            })
              .then(function(r) { return r.json(); })
              .then(function(data) {
                // A deferred reply (session still inside its active-session grace window): no git
                // classification ran, so dispatch a distinct message rather than 'gitOutcome' —
                // App.tsx uses it to keep the Outcome filter's pending-count spinner from counting
                // this session (deferredGitOutcomeSessionIds in state.ts) without caching a
                // premature answer. It'll resolve for real unsolicited over SSE once the grace
                // timer revisits it, or on the next sessions refresh.
                if (data.deferred) {
                  window.dispatchEvent(new MessageEvent('message', {
                    data: { type: 'gitOutcomeDeferred', sessionId: data.sessionId }
                  }));
                  return;
                }
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'gitOutcome', sessionId: data.sessionId, outcome: data.outcome, riskSignals: data.riskSignals, temperedLoopSignals: data.temperedLoopSignals, revision: data.revision }
                }));
              })
              .catch(function(e) {
                console.warn('[TraceRoost] git outcome fetch failed', e);
                // Still dispatch a reply (as "not applicable") — the Outcome filter's pending
                // count only ever counts down on a 'gitOutcome' message, so a request that only
                // logs and never replies leaves that session's spinner stuck forever.
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'gitOutcome', sessionId: msg.sessionId, outcome: null, riskSignals: [], temperedLoopSignals: null }
                }));
              });
          } else if (msg.type === 'getRepoHash' && msg.workspace) {
            fetch('/api/repo-hash', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ workspace: msg.workspace }),
            })
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'repoHash', workspace: data.workspace, name: data.name, hash: data.hash, githubUrl: data.githubUrl }
                }));
              })
              .catch(function(e) { console.warn('[TraceRoost] repo hash fetch failed', e); });
          } else if (msg.type === 'reconfigureOtel') {
            fetch('/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'reconfigureOtel' }) })
              .then(function(r) { return r.json(); })
              .then(function(results) {
                window.dispatchEvent(new MessageEvent('message', { data: { type: 'reconfigureOtelResult', results: results } }));
              })
              .catch(function(e) {
                window.dispatchEvent(new MessageEvent('message', { data: { type: 'reconfigureOtelResult', results: { error: String(e) } } }));
              });
          }
        }
      };
    };

    // SSE → dispatch as window message (picked up by Preact app AND sidebar handler below)
    // Falls back to polling /api/summary every 2s if EventSource fails (e.g. Safari private mode).
    var _sseOk = false;
    var _pollTimer = null;
    function _startPolling() {
      if (_pollTimer) return;
      console.warn('[TraceRoost] SSE unavailable — falling back to polling');
      _pollTimer = setInterval(function() {
        fetch('/api/summary')
          .then(function(r) { return r.json(); })
          .then(function(summary) {
            window.dispatchEvent(new MessageEvent('message', {
              data: { type: 'update', sessionSummary: summary }
            }));
          })
          .catch(function(e) { console.warn('[TraceRoost] poll failed', e); });
      }, 2000);
    }
    // Names this tab's stream so a full update can be requested down it (/api/sse-resync). The
    // rev is what the inlined HTML holds — a (re)connection at any other revision starts with a
    // full update.
    var _sseClientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var _es;
    function _openEvents(rev) {
      _es = new EventSource('/events?client=' + _sseClientId + (rev !== undefined ? '&rev=' + rev : ''));
      _es.onopen = function() {
        console.log('[TraceRoost] SSE connected', Date.now());
        _sseOk = true;
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
      };
      _es.onmessage = function(e) {
        window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(e.data) }));
      };
      _es.onerror = function() {
        if (!_sseOk) {
          // Never connected — start polling immediately
          _startPolling();
        }
        // If it was connected before, browser will auto-reconnect; don't start polling yet
      };
    }
    function _requestFullUpdate() {
      if (!_es) return;
      fetch('/api/sse-resync?client=' + _sseClientId, { method: 'POST' })
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); })
        .catch(function() {
          // Stream not (yet) known to the server — reopen it without a revision, which always
          // starts with a full update.
          _es.close();
          _openEvents(undefined);
        });
    }
    _openEvents(window.__INITIAL_SESSION_REV__);
  </script>

  <div id="sa-wrap">
    <!-- ── Sidebar (live session monitor) ────────────────────────────────── -->
    <div id="sa-sidebar" class="sa-collapsed">
      <div style="flex-shrink:0;padding:7px 10px;border-bottom:1px solid var(--vscode-panel-border)" title="Updates live as the current agent trace progresses">
        <span style="font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:var(--vscode-descriptionForeground);font-weight:600">Live &middot; Current Trace Activity</span>
      </div>
      <div style="flex:1;overflow-y:auto;padding:8px 8px 8px;font-family:var(--vscode-font-family);color:var(--vscode-foreground)">
        <!-- Status row -->
        <div class="sb-card" style="margin-bottom:6px">
          <div class="sb-row" style="margin-bottom:2px">
            <span class="sb-dot idle" id="sb-dot"></span>
            <span class="sb-status" id="sb-status-text">Idle</span>
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
          No traces recorded yet
        </div>


      </div>

      <!-- Footer -->
      <div class="sb-footer">
        <span><span id="sb-session-count">0</span> traces stored</span>
      </div>
    </div>

    <!-- ── Main dashboard ─────────────────────────────────────────────────── -->
    <div id="sa-main">
      <div id="app"></div>
    </div>
  </div>

  <script>
    console.log('[TraceRoost] Inline setup done', Date.now());
    window.onerror = function(msg, src, line, col, err) {
      console.error('[TraceRoost] JS error:', msg, src + ':' + line + ':' + col, err);
      var app = document.getElementById('app');
      if (app) {
        app.style.cssText = 'padding:20px;color:red;font-family:monospace;white-space:pre-wrap';
        app.textContent = 'JS ERROR: ' + msg + ' | At: ' + src + ':' + line + ':' + col + ' | ' + (err ? err.stack : '');
      }
    };
  </script>

  <script src="/dashboard.js" onload="console.log('[TraceRoost] dashboard.js loaded', Date.now())"></script>

  <script>
    // Sidebar collapse driven by dashboard toggle
    var _sidebarEl = document.getElementById('sa-sidebar');
    window.addEventListener('traceroost:sidebar', function(e) {
      _sidebarEl.classList.toggle('sa-collapsed', !e.detail.open);
    });
</script>
  <script>var __SIDEBAR_INIT__ = ${sidebarInitJson};</script>
  <script src="/sidebar.js"></script>
</body>
</html>`
}

// ── Static file serving ───────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.css': 'text/css',
  '.js':  'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

// ── UI server ─────────────────────────────────────────────────────────────────

/** A real page, not a bare `text/plain` dump — this is the one 401 a human actually reads in a
 *  browser (the OTLP server's matching check below stays plain text; nothing browses to that
 *  one). Explains what's missing and exactly where to find it, since "Unauthorized" alone just
 *  looks broken. */
function unauthorizedHtml(port: number): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unauthorized — TraceRoost</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #1e1e1e; color: #cccccc;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    body { background: #ffffff; color: #1f2328; }
    .card { border-color: #d0d7de !important; background: #f6f8fa !important; }
    code { background: #eaeef2 !important; color: #0969da !important; }
  }
  .card {
    max-width: 480px; margin: 16px; padding: 28px 32px; border-radius: 8px;
    border: 1px solid #3e3e42; background: #252526;
  }
  h1 { margin: 0 0 4px; font-size: 18px; }
  p { line-height: 1.6; font-size: 13px; color: #9d9d9d; margin: 12px 0; }
  code {
    display: block; margin: 6px 0; padding: 8px 10px; border-radius: 4px;
    background: #1e1e1e; color: #4fc3f7; font-size: 12px; overflow-wrap: anywhere;
  }
  .hint code { display: inline; padding: 1px 6px; margin: 0; }
  .hint { font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>🔒 Unauthorized</h1>
    <p>This dashboard needs the access token TraceRoost generated for it — the address you used is missing it, or has the wrong one.</p>
    <p>Open the dashboard using the full URL TraceRoost printed when it started, token included:</p>
    <code>http://localhost:${port}/?token=&lt;your-token&gt;</code>
    <p class="hint">Running this as a background service instead? <code>traceroost service status</code> prints that same URL again — no need to dig through old terminal output.</p>
  </div>
</body>
</html>`
}

const SSE_CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/

const uiServer = http.createServer((req, res) => {
  if (!isAllowedHostHeader(req.headers.host, BIND_HOST)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden — invalid Host header'); return
  }
  const url = (req.url ?? '/').split('?')[0]

  // Unauthenticated liveness probe — `traceroost service status` and the Dockerfile HEALTHCHECK
  // both poll this and need a plain 200, not a 401.
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok' })); return
  }

  // Loopback-bound (the default): no token needed, same as OTLP/MCP — see REQUIRE_TOKEN_EVERYWHERE.
  if (REQUIRE_TOKEN_EVERYWHERE) {
    if (!isAuthorized(req, AUTH_TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(unauthorizedHtml(UI_PORT))
      return
    }
    // First request authenticated via ?token= or an Authorization header rather than an existing
    // cookie — hand the browser a cookie so every subsequent asset/API/SSE request just works.
    if (extractCookieToken(req) !== AUTH_TOKEN) {
      res.setHeader('Set-Cookie', authCookieHeader(AUTH_TOKEN))
    }
  }
  // No CORS: the dashboard is same-origin, and on loopback (no token) a wildcard
  // Access-Control-Allow-Origin let any website read every session off /api/*. State-changing
  // requests from a foreign page (e.g. POST /action clearAll) are refused outright.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !isAllowedOrigin(req.headers.origin, req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden — cross-origin request'); return
  }

  if (url === '/events') {
    // `client` names this stream for POST /api/sse-resync; `rev` is the session revision the page
    // already holds (the one inlined into its HTML).
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
    const clientId = query.get('client') ?? ''
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    res.write(':\n\n') // initial ping
    syncSseClients() // tabs already open get any pending change before this one joins
    const rev = sseSync.revision
    res.write(`data: ${query.get('rev') === String(rev) ? updateFrame(derivedViews(), rev, rev, '') : fullUpdateFrame()}\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'actionLog', entries: getActionLogHistory() })}\n\n`)
    sseClients.push(res)
    if (SSE_CLIENT_ID.test(clientId)) sseClientsById.set(clientId, res)
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res)
      if (sseClientsById.get(clientId) === res) sseClientsById.delete(clientId)
    })
    return
  }

  // The dashboard's `requestFullUpdate` (its revision doesn't match a frame's `base`): send a full
  // update down that tab's own stream, so it stays ordered with every other frame.
  if (req.method === 'POST' && url === '/api/sse-resync') {
    const client = sseClientsById.get(new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('client') ?? '')
    if (!client) { res.writeHead(404); res.end(); return }
    try { client.write(`data: ${fullUpdateFrame()}\n\n`) } catch { /* closing — its reconnect gets a full update */ }
    res.writeHead(204); res.end()
    return
  }

  if (req.method === 'POST' && url === '/api/import') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { sessions?: unknown[] }
        if (!Array.isArray(body.sessions)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'sessions array required' }))
          return
        }
        const VALID_SOURCES = new Set(['copilot', 'claude_code', 'codex', 'opencode'])
        let imported = 0
        let skipped = 0
        for (const raw of body.sessions) {
          if (typeof raw !== 'object' || raw === null) continue
          const s = raw as Record<string, unknown>
          const id = typeof s['sessionId'] === 'string' ? s['sessionId'] : ''
          if (!id || !VALID_SOURCES.has(s['source'] as string)) continue
          if (logSessions.has(id)) { skipped++; continue }
          const card = buildImportCardStandalone(s)
          setLogSession(card)
          imported++
        }
        pushUpdate()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ imported, skipped, failed: 0, total: body.sessions.length }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e) }))
      }
    })
    return
  }

  if (req.method === 'POST' && url === '/api/clear') {
    spans = []
    logSessions.clear()
    dataVersion++
    logReader.clearFileState()
    try { fs.writeFileSync(DATA_FILE, '[]') } catch (e) { console.warn('[TraceRoost] Could not clear data file:', e) }
    pushUpdate()          // send cleared state to clients immediately
    res.writeHead(200); res.end()
    // Re-ingest after the response is sent so the client sees the cleared state first.
    setImmediate(() => runLogScan())
    return
  }

  if (req.method === 'POST' && url === '/api/write-prompts-file') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const { agent, label, prompt } = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { agent: string; label: string; prompt: string }
        const agentSlug = agent === 'claude_code' ? 'claude' : agent === 'codex' ? 'codex' : 'copilot'
        const agentName = agent === 'claude_code' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Copilot'
        const filename = `traceroost-prompts-${agentSlug}.md`
        const filePath = path.join(process.cwd(), filename)
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
        const entry = `## ${timestamp} — ${label}\n\n${prompt}\n\n---\n\n`
        let existing = ''
        try { existing = fs.readFileSync(filePath, 'utf-8') } catch { /* new file */ }
        const content = existing ? existing + entry : `# TraceRoost Prompts — ${agentName}\n\n${entry}`
        fs.writeFileSync(filePath, content, 'utf-8')
        console.log(`[TraceRoost] Prompt written to ${filePath}`)
      } catch (e) {
        console.warn('[TraceRoost] write-prompts-file error:', e)
      }
      res.writeHead(200); res.end()
    })
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/instruction-suggestions')) {
    const parsed = new URL(url, 'http://localhost')
    const workspace = parsed.searchParams.get('workspace')?.trim()
    if (!workspace) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'workspace query param is required' }))
      return
    }
    const sessions = (buildSessionSummary()?.sessions ?? [])
      .filter(s => (s.workspace ?? '') === workspace || s.workspace?.startsWith(workspace))
    const { readAllInstructionContent } = require('../src/instructionFiles') as typeof import('../src/instructionFiles')
    const existingText = readAllInstructionContent(workspace)
    const suggestions = generateSuggestions(sessions, existingText)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(suggestions))
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/instruction-files')) {
    const parsed = new URL(url, 'http://localhost')
    const workspace = parsed.searchParams.get('workspace')?.trim()
    if (!workspace) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'workspace query param is required' }))
      return
    }
    const files = detectInstructionFiles(workspace)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(files))
    return
  }

  if (req.method === 'POST' && url === '/api/instructions/apply') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const { workspace, targetFile, appliedText, id } = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          workspace: string; targetFile: string; appliedText: string; id: string
        }
        if (!workspace || !targetFile || !appliedText || !id) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'workspace, targetFile, appliedText, and id are required' }))
          return
        }
        const absPath = path.join(workspace, targetFile)
        appendSuggestion(absPath, appliedText, id)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        console.warn('[TraceRoost] /api/instructions/apply error:', e)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e) }))
      }
    })
    return
  }

  if (req.method === 'POST' && url === '/action') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { type?: string }
        if (body.type === 'clearAll') {
          spans = []
          dataVersion++
          try { fs.writeFileSync(DATA_FILE, '[]') } catch (e) { console.warn('[TraceRoost] Could not clear data file:', e) }
          pushUpdate()
        } else if (body.type === 'reconfigureOtel') {
          if (AUTOCONFIG_DISABLED) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Auto-configure is disabled (TRACEROOST_NO_AUTOCONFIG=1).' }))
            return
          }
          const [claudeCode, codex, copilotResults] = await Promise.all([
            autoConfigureClaudeCode(resolvedPorts.otlp ?? OTLP_PORT),
            autoConfigureCodex(resolvedPorts.otlp ?? OTLP_PORT),
            autoConfigureCopilotStandalone(resolvedPorts.otlp ?? OTLP_PORT),
          ])
          const copilot = {
            changed: copilotResults.some(r => r.changed),
            error: copilotResults.find(r => r.error)?.error,
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ claudeCode, codex, copilot }))
          return
        }
      } catch (e) { console.warn('[TraceRoost] Malformed /action body:', e) }
      res.writeHead(200); res.end()
    })
    return
  }

  if (req.method === 'GET' && url === '/api/summary') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(strippedJsonOf(derivedViews()))
    return
  }

  if (req.method === 'GET' && url === '/api/version-check') {
    const result = getCachedVersionCheck(PACKAGE_VERSION)
    // No signal distinguishes a Docker container from a bare npx run, so both get the same
    // generic recommendation — only an OS-native background service (which sets this env var,
    // see src/serviceConfig.ts's generators) gets the more precise `service update`.
    const isService = process.env.TRACEROOST_SERVICE === '1'
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ...result,
      isService,
      recommendedCommand: isService ? 'traceroost service update' : 'npx traceroost@latest service install',
    }))
    return
  }

  // ── Org (TraceRoost Pro) — AL 01 ──────────────────────────────────────────
  // GET returns the local status (no network). POST runs an action (link/leave/explain).
  // Both reply with an array of webview messages the polyfill re-dispatches.
  // Not served at all in the core edition (literal edition check, so esbuild drops the handler).
  if (process.env.TRACEROOST_EDITION !== 'core' && url === '/api/org' && (req.method === 'GET' || req.method === 'POST')) {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const outbox: Record<string, unknown>[] = []
      const msg = req.method === 'GET'
        ? { type: 'getOrgStatus' }
        : (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { type: string } } catch { return { type: 'getOrgStatus' } } })()
      try {
        await cloud.handleOrgMessage(msg, {
          post: (m) => outbox.push(m),
          openExternal: (u) => {
            const cmd = process.platform === 'darwin' ? `open "${u}"` : process.platform === 'win32' ? `start "" "${u}"` : `xdg-open "${u}"`
            exec(cmd, () => { /* URL is also delivered as an orgLinkUrl message */ })
          },
          recentSessions: () => buildSessionSummary()?.sessions.slice(0, 25) ?? [],
          allLocalSessions: () => buildSessionSummary()?.sessions ?? [],
          buildPayloadPreview: (sessions) => cloud.buildPayloadPreview(sessions),
          onOpenOrgView: () => {
            // Deep-links into the org's own dashboard — see cloud/bridge.ts's orgViewUrl.
            const url = cloud.orgViewUrl()
            const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`
            exec(cmd, (err) => {
              if (err) console.warn(`[TraceRoost] Could not open ${url} in a browser: ${err.message}`)
            })
          },
          log: (m) => console.log(m),
        })
      } catch (e) {
        // `orgActionResult` is only listened for by link/leave — reconcile and the payload
        // preview ignore it, so without `orgError` too, this host also left those buttons
        // stuck on "Checking…"/"Building…" after a clean, caught backend error.
        outbox.push({ type: 'orgActionResult', ok: false, error: String(e) })
        outbox.push({ type: 'orgError', error: String(e) })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ messages: outbox }))
    })
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/timeline/')) {
    const sessionId = decodeURIComponent(url.slice('/api/timeline/'.length))
    const summary = buildSessionSummary()
    const session = summary?.sessions.find(s => s.sessionId === sessionId) ?? null
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ timeline: session?.timeline ?? [] }))
    return
  }

  if (req.method === 'POST' && url === '/api/git-outcome') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          sessionId?: string; workspace?: string; filesChanged?: string[]; endTime?: string
        }
        const sessionId = body.sessionId ?? ''
        if (!sessionId) { res.writeHead(400); res.end(); return }
        let outcome: GitOutcome | null
        let revision: number | null = null
        let deferred = false
        try {
          const result = await loadOrComputeGitOutcome(
            sessionId,
            body.workspace ?? '',
            Array.isArray(body.filesChanged) ? body.filesChanged : [],
            body.endTime ?? '',
          )
          outcome = result.outcome
          revision = result.revision
          deferred = result.deferred
        } catch (err) {
          // See dashboardPanel.ts's sendGitOutcome for why a rejected classification must never
          // go unreported — the browser's Outcome-filter spinner counts down only on receiving a
          // reply. Nothing here is durably cached on a throw either way (see
          // reconciliationService.ts's in-flight-only discipline), so there's nothing to evict.
          console.warn(`[TraceRoost] git-outcome classification failed for session ${sessionId}:`, err)
          outcome = null
        }
        if (deferred) {
          // Same "still in its active-session grace window" case dashboardPanel.ts's
          // sendGitOutcome defers on — reply with a marker the fetch() call site (above)
          // recognizes and turns into a `gitOutcomeDeferred` message, rather than prematurely
          // caching an answer like 'not applicable'.
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ sessionId, deferred: true }))
          return
        }
        // Post-hoc risk signals (hallucinated import, submitted-despite-a-failing-check) and
        // re-tempered loop-signal severity are both only knowable once the session's outcome is
        // known, same lifecycle as git-outcome classification — computed here rather than eagerly
        // for every session. See sessionRiskSignals.ts and temperLoopSignalSeverity's docstring.
        const card = buildSessionSummary()?.sessions.find(s => s.sessionId === sessionId) ?? null
        const riskSignals = card ? detectSessionRiskSignals(card, body.workspace ?? '', outcome) : []
        const temperedLoopSignals = card ? temperLoopSignalSeverity(card.loopSignals ?? [], outcome) : null
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessionId, outcome, riskSignals, temperedLoopSignals, revision }))
      } catch (e) {
        console.warn('[TraceRoost] Malformed /api/git-outcome body:', e)
        res.writeHead(400); res.end()
      }
    })
    return
  }

  if (req.method === 'POST' && url === '/api/repo-hash') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { workspace?: string }
        const workspace = body.workspace ?? ''
        if (!workspace) { res.writeHead(400); res.end(); return }
        let info: { name: string; hash: string | null; githubUrl: string | null } | null
        if (repoInfoCache.has(workspace)) {
          info = repoInfoCache.get(workspace) ?? null
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
          repoInfoCache.set(workspace, info)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ workspace, name: info?.name ?? null, hash: info?.hash ?? null, githubUrl: info?.githubUrl ?? null }))
      } catch (e) {
        console.warn('[TraceRoost] Malformed /api/repo-hash body:', e)
        res.writeHead(400); res.end()
      }
    })
    return
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(getHtml())
    return
  }

  const filePath = path.join(mediaDir, url)
  const ext = path.extname(filePath)
  const mime = MIME[ext]
  if (mime && fs.existsSync(filePath) && filePath.startsWith(mediaDir)) {
    res.writeHead(200, { 'Content-Type': mime })
    fs.createReadStream(filePath).pipe(res)
    return
  }

  res.writeHead(404); res.end('Not found')
})

// ── OTLP server ───────────────────────────────────────────────────────────────

/** Same cap as the VS Code extension's collector (src/otlpCollector.ts). */
const MAX_OTLP_BODY_BYTES = 50 * 1024 * 1024

const otlpServer = http.createServer((req, res) => {
  if (!isAllowedHostHeader(req.headers.host, BIND_HOST)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden — invalid Host header'); return
  }
  // Unauthenticated identify probe (the VS Code extension uses this to detect a standalone
  // server already running before starting its own collector) — same reasoning as /health above.
  if (req.method === 'GET' && req.url === '/traceroost/standalone') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ traceroost: true, kind: 'standalone' }))
    return
  }
  if (REQUIRE_TOKEN_EVERYWHERE && !isAuthorized(req, AUTH_TOKEN)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Unauthorized'); return
  }
  // Agents' exporters never send Origin; a web page POSTing fake spans always does, and must use a
  // no-preflight Content-Type (text/plain, form) to get its request through — refuse both.
  if (!isAllowedOrigin(req.headers.origin)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden — cross-origin request'); return
  }
  if (req.method !== 'POST') { res.writeHead(200); res.end(); return }
  if (!isAllowedOtlpContentType(req.headers['content-type'])) {
    res.writeHead(415, { 'Content-Type': 'text/plain' }); res.end('Unsupported Media Type'); return
  }
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  req.on('data', (c: Buffer) => {
    if (tooLarge) return
    size += c.length
    if (size > MAX_OTLP_BODY_BYTES) {
      tooLarge = true
      chunks.length = 0
      res.writeHead(413, { 'Content-Type': 'text/plain', 'Connection': 'close' }); res.end('Payload Too Large')
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (tooLarge) return
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
      const kind = classifyOtlpPayload(payload)
      if (req.url === '/v1/traces' || kind === 'traces') {
        const { count, agent } = processTraces(payload, req.url ?? '/v1/traces')
        if (count > 0) console.log(`[TraceRoost] Ingested ${count} span${count !== 1 ? 's' : ''} (${agent})`)
      } else if (req.url === '/v1/logs' || kind === 'logs') {
        const n = processLogs(payload, req.url ?? '/v1/logs')
        if (n > 0) console.log(`[TraceRoost] ${n} log event${n !== 1 ? 's' : ''} ingested`)
      } else if (kind === 'metrics' || req.url === '/v1/metrics') {
        // Metrics are accepted so OTLP exporters do not retry, but TraceRoost does not display them.
      } else {
        console.warn(`[TraceRoost] ignored POST ${req.url ?? '/'}: unrecognized OTLP JSON payload`)
      }
      schedulePushUpdate()
      scheduleSave()
    } catch (e) {
      console.error('[TraceRoost] Parse error:', e)
    }
    res.writeHead(200); res.end()
  })
})

// ── Start ─────────────────────────────────────────────────────────────────────
//
// Bind order: OTLP first (so auto-configure fires against the port actually bound, never the
// configured one racing ahead of the real listen), then UI. Each resolves independently via
// listenWithFallback — a conflict on one never blocks the other from starting on its own
// (possibly-fallback) port.

async function startOtlpServer(): Promise<void> {
  let bound: number
  try {
    bound = await listenWithFallback(otlpServer, OTLP_PORT, BIND_HOST)
  } catch (err) {
    console.error(`[TraceRoost] ${err instanceof PortScanExhaustedError ? err.message : `OTLP server error: ${err}`}`)
    process.exit(1)
  }
  recordResolvedPort('otlp', OTLP_PORT, bound)
  console.log(`[TraceRoost] OTLP receiver → http://localhost:${bound}`)

  // Auto-configure Claude Code, Codex, and Copilot to point at this collector — only after the
  // real bind succeeds, against `bound` (the port actually listening), never the static OTLP_PORT,
  // which may differ from it after a fallback.
  if (AUTOCONFIG_DISABLED) {
    console.log('[TraceRoost] Auto-configure disabled (TRACEROOST_NO_AUTOCONFIG=1) — agent config left untouched.')
  } else {
    Promise.all([
      autoConfigureClaudeCode(bound),
      autoConfigureCodex(bound),
      autoConfigureCopilotStandalone(bound),
    ]).then(([claudeResult, codexResult, copilotResults]) => {
      if (claudeResult.warning) {
        console.warn(`[TraceRoost] ${claudeResult.warning}`)
      }
      if (claudeResult.error) {
        console.warn(`[TraceRoost] Could not auto-configure Claude Code: ${claudeResult.error}`)
      } else if (claudeResult.changed) {
        console.log(`[TraceRoost] Claude Code configured — restart Claude Code in your terminal to activate tracing`)
      }
      if (codexResult.error) {
        console.warn(`[TraceRoost] Could not auto-configure Codex: ${codexResult.error}`)
      } else if (codexResult.changed) {
        console.log(`[TraceRoost] Codex configured — restart Codex in your terminal to activate tracing`)
      }
      const copilotChanged = copilotResults.filter(r => r.changed)
      const copilotErrors  = copilotResults.filter(r => r.error)
      if (copilotChanged.length > 0) {
        console.log(`[TraceRoost] Copilot configured — reload VS Code window to activate tracing (Ctrl+Shift+P → "Reload Window")`)
      }
      for (const r of copilotErrors) {
        console.warn(`[TraceRoost] Could not auto-configure Copilot: ${r.error}`)
      }
    }).catch(e => console.warn('[TraceRoost] Auto-configure error:', e))
  }
}

async function startUiServer(): Promise<void> {
  let bound: number
  try {
    bound = await listenWithFallback(uiServer, UI_PORT, BIND_HOST)
  } catch (err) {
    console.error(`[TraceRoost] ${err instanceof PortScanExhaustedError ? err.message : `UI server error: ${err}`}`)
    process.exit(1)
  }
  recordResolvedPort('ui', UI_PORT, bound)
  const mcpPort = await mcpServerReady

  const plainUrl = `http://localhost:${bound}`
  // Loopback doesn't need the token at all, so there's nothing to carry (and nothing to forget).
  const url = REQUIRE_TOKEN_EVERYWHERE ? `${plainUrl}/?token=${AUTH_TOKEN}` : plainUrl
  console.log(`[TraceRoost] Dashboard      → ${url}`)
  console.log(`[TraceRoost] MCP server     → http://localhost:${mcpPort}/mcp`)

  // Auto-open browser — includes the access token so the browser gets its auth cookie on
  // first load when the token is actually required; the printed URL above is the fallback if
  // auto-open fails or you're opening on another device.
  const cmd = process.platform === 'darwin' ? `open "${url}"`
            : process.platform === 'win32'  ? `start "" "${url}"`
            : `xdg-open "${url}"`
  exec(cmd, err => { if (err) console.log(`\nOpen ${url} in your browser\n`) })

  // Start log ingestion after the server is ready
  startLogIngestion()

  // Pro: forwarding scheduler. No timer runs unless an org is linked.
  cloud.startForwardScheduler({ log: (msg) => console.log(msg), onDrainStart: pushOrgStatusToClients, onDrainComplete: pushOrgStatusToClients })

  // Pro: pricing sync — own (longer) interval, see pricingSync.ts.
  cloud.startPricingSync({ onSync: pushOrgStatusToClients })
}

void startOtlpServer()
void startUiServer()

// ── Graceful shutdown — flush data before exit ────────────────────────────────

function shutdown() {
  if (saveTimer) clearTimeout(saveTimer)
  if (saveSpansNow()) {
    console.log(`\n[TraceRoost] Saved ${spans.length} spans to ${DATA_FILE}`)
  }
  outcomesDb?.save()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
