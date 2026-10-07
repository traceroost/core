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
import { config as loadDotenv } from 'dotenv'
import { summarizeSpans } from '../src/spanSummarizer'
import { calcSessionCostUsd } from '../src/pricing'
import { autoConfigureClaudeCode, autoConfigureCodex, autoConfigureCopilotStandalone } from '../src/autoConfigNode'
import { classifyOtlpPayload } from '../src/otlpParser'
import { OtlpIngest } from '../src/otlpIngest'
import { mergeCardsByKey } from '../src/claudeConversation'
import { startMcpHttpServer } from '../src/mcpServer'
import { LogReader, findClaudeTranscripts, type OpenCodeSqlFactory } from '../src/logReader'
import { ClaudeTurnJoiner, setClaudeTurnJoiner, joinHoldMsFromEnv } from '../src/claudeTurnJoin'
import { ClaudeJoinRepository } from '../src/database/claudeJoinRepository'
import { computeOneShotStats } from '../src/oneShotRate'
import { languageFromRecord } from '../src/language'
import { editStatsFromRecord } from '../src/editStats'
import { classifySessionOutcome, onRunningGitCommandsChanged, type GitOutcome } from '../src/gitOutcome'
import { onActionLogChanged, getActionLogHistory } from '../src/actionLog'
import { ReconciliationService, type ReconcileResult } from '../src/reconcile/reconciliationService'
import { PlanUsageService, getPlanUsageService, setPlanUsageService } from '../src/planUsage/planUsageService'
import { startBackgroundReconciliation, type BackgroundWatcher } from '../src/reconcile/backgroundWatcher'
import { detectSessionRiskSignals } from '../src/sessionRiskSignals'
import { temperLoopSignalSeverity } from '../src/loopDetector'
import { generateSuggestions } from '../src/instructionAdvisor'
import type { Span } from '../src/types'
import type { SessionSummaryCard } from '../src/summarizers/summarizerTypes'
import { pruneSpans, DEFAULT_MAX_SPANS } from '../src/spanStore'
import { readServiceConfig, ensureAuthToken, ensureInstallId, isRunningFromNpx, readPackageManifest, writeServiceProcessRecord, clearServiceProcessRecord } from '../src/serviceConfig'
import { startVersionCheckLoop, getCachedVersionCheck } from './versionCheck'
import { tryAcquireDataDirLock, describeLockHolder, type DataDirLock } from './dataDirLock'
import { listenWithFallback, writeResolvedPorts, detectPortOwner, PortScanExhaustedError, type ResolvedPorts } from '../src/portResolver'
// TraceRoost Cloud (org link + upload) — only ever through this seam; see src/cloudBridge.ts.
import { cloud, type TraceManifestSource } from '../src/cloudBridge'
import { TRACE_STORE_REBUILT_MESSAGE } from '../src/database/traceStore'
import { traceKeysInWindow, localHorizonOf, countTracesInWindow, hasSettledKey } from '../src/traceIdentity'
import { resolveGithubUrl } from '../src/repoRemote'
import {
  isAllowedHostHeader, isAllowedOrigin, isAllowedOtlpContentType, isAuthorized, isLoopbackHost,
  extractCookieToken, authCookieHeader,
} from '../src/httpSecurity'
import { SseSessionSync, type SyncSummary } from './sseSessionSync'
import { autoConfigLogLines } from './autoConfigLog'
import { promptsFileFor, IMPORT_SOURCES } from './promptsFile'
import { handleInstructionMessage, loadInstructionState, saveInstructionState, MAX_INSTRUCTION_BODY_BYTES, type InstructionHost, type InstructionResult } from './instructionActions'
import { readBodyLimited } from './requestBody'
import { writeFileAtomic, quarantineCorruptFile } from '../src/fsAtomic'
import { openInBrowser } from './openBrowser'
import { decodePathSegment, redactTokenInUrl, mayPrintFullUrl } from './requestGuards'
import { OtelForwardGate } from './otelForwardGate'
import { retentionCutoffMs, pruneLogSessions } from './sessionRetention'
import { createRevisionForwardBatcher } from './revisionForwardBatcher'
import { agentKeyLabel, agentKeyDir } from './agentLabels'
import { generateCspNonce, dashboardCspHeader, UNAUTHORIZED_PAGE_CSP } from './dashboardCsp'
import { renderDashboardHtml } from './dashboardHtml'
import { knownWorkspace } from './instructionActions'

// Development builds only: load `.env` from the current working directory, so `pnpm run local` can
// point at a specific org environment (e.g. `TRACEROOST_ORG_ENV=test`) without exporting shell
// vars. `TRACEROOST_RELEASE_BUILD` is baked in by esbuild.js at build time (the same switch that
// pins the Cloud endpoint — see src/cloud/org/config.ts), so a shipped `npx traceroost` never
// reads a `.env`: the documented quick start runs it from inside whatever repository the developer
// is working on, and a `.env` committed there (`DATA_DIR=./docs/.cache`, `BIND_HOST=0.0.0.0`) must
// not decide where prompts are persisted or which interfaces the server binds. Release builds take
// settings from ~/.traceroost/config.json and real environment variables only.
if (!process.env.TRACEROOST_RELEASE_BUILD) loadDotenv({ quiet: true })

// `traceroost service install` persists its port/host/data-dir choices to
// ~/.traceroost/config.json (see src/serviceConfig.ts) so a background-service install and an
// ad-hoc `npx`/`node standalone/server.js` run share one config story. Env vars still win when
// set, matching this server's behavior before the config file existed. ensureAuthToken generates
// and persists a bearer token the first time this runs with none set yet.
const fileConfig = ensureInstallId(ensureAuthToken(readServiceConfig(undefined, m => console.warn(m))))
/** Days of log-sourced history this server keeps (standalone/sessionRetention.ts); `sessionRetentionDays`
 *  in ~/.traceroost/config.json, default 90 like the editor's `traceRoost.sessionRetentionDays`. */
const SESSION_RETENTION_DAYS = Number.isFinite(fileConfig.sessionRetentionDays) ? fileConfig.sessionRetentionDays : 90

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

// Set when this service's OTLP receiver fell back to a different port than requested — i.e. some
// other process already held OTLP_PORT (see listenWithFallback in startOtlpServer below). Unlike
// the VS Code extension's own collectorConflict (which fails outright and shows the analogous
// 'standalone' owner), this service keeps running on the fallback port, so there's no data loss —
// just two hosts running where the "one way per machine" story says there should be one. Read by
// getHtml() to inline into the page and by startOtlpServer to broadcast once the (async)
// port-owner probe resolves — see CollectorConflict in media/src/types.ts for the shared shape
// this mirrors, and CollectorConflictBanner in App.tsx for how it's rendered.
let collectorConflict: { owner: 'plugin' | 'foreign'; port: number; boundPort: number } | null = null

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
// src/portResolver.ts.
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
    // So a refused second server on this data dir can name this one's dashboard.
    dataDirLock.setPorts(record)
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
// Applied/dismissed instruction suggestions — the extension's instruction_applied/_dismissed tables.
const INSTRUCTIONS_FILE = path.join(DATA_DIR, 'instruction-suggestions.json')

// Running as the background service: record this process so `traceroost service stop/uninstall`
// can end it on Windows, where ending the Scheduled Task only kills the wrapper cmd.exe and not
// this node child (see standalone/service/windows.ts's endServerProcess).
if (process.env.TRACEROOST_SERVICE === '1') {
  try { writeServiceProcessRecord({ pid: process.pid, image: path.basename(process.execPath) }) } catch (e) { console.warn('[TraceRoost] Could not record the service process:', e) }
  process.on('exit', () => { try { clearServiceProcessRecord(process.pid) } catch { /* best effort */ } })
}

// ── Single writer per data dir ───────────────────────────────────────────────
//
// Taken before anything below reads or writes DATA_DIR: a second server on the same data dir
// would load spans.json, then overwrite the first one's saves (and race its forward queue) — see
// dataDirLock.ts. An ad-hoc run is refused outright. The background service instead waits for
// the dir to free up: launchd's KeepAlive would otherwise respawn a refused service every ~10 s,
// logging the refusal each time, and waiting means it takes over as soon as the ad-hoc run stops.
const dataDirLock: DataDirLock = (() => {
  const isService = process.env.TRACEROOST_SERVICE === '1'
  let first = tryAcquireDataDirLock(DATA_DIR, { service: isService })
  if (!first.ok && isService) {
    console.error(`${describeLockHolder(DATA_DIR, first.holder)}\n[TraceRoost] Running as the background service — waiting for the data directory to free up.`)
    while (!first.ok) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000)
      first = tryAcquireDataDirLock(DATA_DIR, { service: true })
    }
    console.log('[TraceRoost] Data directory is free — starting.')
  }
  if (!first.ok) {
    console.error(describeLockHolder(DATA_DIR, first.holder))
    process.exit(1)
  }
  return first.lock
})()
process.on('exit', () => dataDirLock.release())
dataDirLock.startHeartbeat(holder => {
  // Another server judged this one dead and took the dir over (only possible across hosts, or after
  // the lock file was tampered with) — stop without saving, so its spans.json isn't overwritten.
  console.error(`[TraceRoost] Lost the data directory lock on ${DATA_DIR}${holder ? ` to pid ${holder.pid} on ${holder.hostname}` : ''} — exiting without saving so the two servers don't overwrite each other.`)
  process.exit(1)
})
// This host's trace store — its cloud host id lives in the data dir, so this server and the
// editor extension (one shared link) each reconcile only their own traces.
cloud.setHostStore(DATA_DIR)

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

// Spans by `traceId\0spanId`, for OtlpIngest's injectSpanAttribute (a gen_ai log record attaching
// content to its span) — a Map lookup instead of a scan over up to MAX_SPANS spans per log record.
// Kept in step with `spans` by addSpan/pruneSpanStore/rebuildSpanIndex; never read anywhere else.
const spanIndex = new Map<string, Span>()
const spanIndexKey = (traceId: string, spanId: string) => `${traceId}\0${spanId}`
function rebuildSpanIndex(): void {
  spanIndex.clear()
  for (const span of spans) spanIndex.set(spanIndexKey(span.traceId, span.spanId), span)
}
/** pruneSpans() over the store, keeping the index in step. Returns how many were dropped. */
function pruneSpanStore(): number {
  const dropped = pruneSpans(spans, MAX_SPANS)
  if (dropped > 0) rebuildSpanIndex()
  return dropped
}

// Load persisted spans on startup
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  if (fs.existsSync(DATA_FILE)) {
    const { size } = fs.statSync(DATA_FILE)
    const MAX_LOADABLE_BYTES = 450 * 1024 * 1024 // stay clear of Node's ~512MB string ceiling
    if (size > MAX_LOADABLE_BYTES) {
      const backupFile = `${DATA_FILE}.bak`
      fs.renameSync(DATA_FILE, backupFile)
      console.warn(`[TraceRoost] ${DATA_FILE} was ${(size / 1024 / 1024).toFixed(0)}MB — too large to load safely. Moved it to ${backupFile} and starting fresh.`)
    } else {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (e) {
        // A torn file (a crash mid-write in a build that saved in place): move it aside instead of
        // letting the first save overwrite it — every OTEL span ever received is in there.
        const aside = quarantineCorruptFile(DATA_FILE)
        console.warn(`[TraceRoost] ${DATA_FILE} could not be parsed (${e instanceof Error ? e.message : String(e)})${aside ? ` — moved it to ${aside}` : ''}; starting with no stored spans.`)
        parsed = []
      }
      spans = Array.isArray(parsed) ? parsed as Span[] : []
      const dropped = pruneSpans(spans, MAX_SPANS)
      console.log(`[TraceRoost] Loaded ${spans.length} spans from ${DATA_FILE}${dropped ? ` (dropped ${dropped} oldest to respect the ${MAX_SPANS}-span cap)` : ''}`)
    }
  }
} catch (e) {
  console.warn('[TraceRoost] Could not load persisted data:', e)
}
rebuildSpanIndex()

/** spans.json holds every prompt and tool result an agent exported: owner-only, and replaced
 *  atomically (src/fsAtomic.ts) so a crash mid-save can't leave a torn file behind. */
function writeSpansFile(): void {
  writeFileAtomic(DATA_FILE, JSON.stringify(spans), { mode: 0o600 })
}

function saveSpansNow(): boolean {
  try {
    writeSpansFile()
    return true
  } catch (e) {
    if (e instanceof RangeError && spans.length > 1) {
      const keep = Math.floor(spans.length / 2)
      const dropped = spans.length - keep
      spans.splice(0, dropped)
      rebuildSpanIndex()
      dataVersion++
      console.warn(`[TraceRoost] Save failed (spans array too large to serialize) — dropped oldest ${dropped} spans and retrying`)
      try {
        writeSpansFile()
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
  spanIndex.set(spanIndexKey(span.traceId, span.spanId), span)
  const dropped = pruneSpanStore()
  if (dropped > 0) console.warn(`[TraceRoost] Pruned ${dropped} oldest spans to stay under the ${MAX_SPANS}-span cap`)
  dataVersion++
}

// ── Log file sessions ─────────────────────────────────────────────────────────

// Indexed by sessionId; OTEL-derived sessions (from spans) take precedence —
// when the same session ID appears in both, the OTEL version is used.
let logSessions: Map<string, SessionSummaryCard> = new Map()
/** False until the historical log pass has filled `logSessions`, and again while "clear all data"
 *  re-reads — the trace manifest waits for it (see traceManifestSource). */
let traceStoreReady = false

/** The one way a card enters `logSessions` — bumps `dataVersion` and drops any cached serialized
 *  form of the card (see `strippedCardJson`), in case a producer ever hands back the same object
 *  updated in place rather than a fresh one. */
function setLogSession(card: SessionSummaryCard): void {
  logSessions.set(card.sessionId, card)
  strippedCardJson.delete(card)
  dataVersion++
}

/** Drops the keys a re-read log file no longer produces (LogReader.takeRetiredKeys) — out of the
 *  dashboard and the trace manifest, which then retires them in the cloud. Returns true when any
 *  went. */
function retireLogSessions(): boolean {
  let removed = false
  for (const key of logReader.takeRetiredKeys()) {
    if (logSessions.delete(key)) removed = true
  }
  if (removed) dataVersion++
  return removed
}

// Host-independent reconciliation — created once outcomesDb opens, in
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

let pendingGitOutcomeResults = new Map<string, ReconcileResult>()
let pendingGitOutcomeFlush: ReturnType<typeof setTimeout> | undefined

/** Pushes an unsolicited reconciliation result to every open tab, exactly like DashboardPanel's
 *  pushGitOutcomeResult — the background watcher calls this via the service subscription below,
 *  so "leave Traces open through multiple commits and a merge" converges without the tab
 *  re-requesting anything. */
function pushGitOutcomeResult(r: ReconcileResult): void {
  pendingGitOutcomeResults.set(r.sessionId, r)
  if (pendingGitOutcomeFlush) return
  pendingGitOutcomeFlush = setTimeout(() => {
    pendingGitOutcomeFlush = undefined
    const pending = pendingGitOutcomeResults
    pendingGitOutcomeResults = new Map()
    const cards = new Map((buildSessionSummary()?.sessions ?? []).map(card => [card.sessionId, card]))
    for (const result of pending.values()) {
      const card = cards.get(result.sessionId)
      if (!card) continue
      const riskSignals = detectSessionRiskSignals(card, card.workspace)
      const temperedLoopSignals = temperLoopSignalSeverity(card.loopSignals ?? [], result.outcome)
      broadcastSse({ type: 'gitOutcome', sessionId: result.sessionId, outcome: result.outcome, riskSignals, temperedLoopSignals, revision: result.revision })
    }
  }, 50)
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
    ...languageFromRecord(raw, { filesRead: arrStr(raw['filesRead']), filesChanged: arrStr(raw['filesChanged']) }),
    ...editStatsFromRecord(raw, arrStr(raw['filesChanged'])),
  }
}

let logReader = new LogReader()
// A Claude OTEL interaction takes its transcript turn's key through this join (stable trace
// identity — see src/claudeTurnJoin.ts); summarizeSpans() reads it. Its decisions persist in
// outcomes-cache.db (claude_join), which opens in startLogIngestion(): until then nothing is
// decided, so a restart re-reading spans.json can't re-key a turn decided earlier.
const claudeTurnJoiner = new ClaudeTurnJoiner({ findTranscripts: findClaudeTranscripts, holdMs: joinHoldMsFromEnv(), awaitStore: true })
setClaudeTurnJoiner(claudeTurnJoiner)
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

// OTEL-built cards reach the cloud from here; runLogScan() forwards the log-built ones. With
// stable trace identity a turn's OTEL card and its transcript card share one
// key, so whichever is sent second is an update of the same cloud row — never a second row — and
// a lower source rank is never sent over a higher one (contentChangeForward.ts).
//
// Only forward one once it's been idle a while — and again whenever it changes after that and
// settles once more (standalone/otelForwardGate.ts): the editor host re-forwards an OTEL turn on
// every content change, and a turn that keeps growing after its first idle window used to stay
// frozen in the cloud at its first snapshot when this host had received its spans.
const OTEL_IDLE_MS = 3 * 60_000
const otelForwardGate = new OtelForwardGate(OTEL_IDLE_MS)

/** Logs a rejected forward instead of letting it become an unhandled rejection (the cloud calls
 *  catch internally; this is the last line of defense for the `void` chains below). */
function forwardFailed(what: string) {
  return (e: unknown) => console.warn(`[TraceRoost] ${what} failed:`, e)
}

function checkStaleOtelSessions() {
  if (!cloud.isLinked()) return
  const summary = buildSessionSummary()
  if (!summary) return
  const now = Date.now()
  for (const card of summary.sessions) {
    // A card the merge kept as OTEL outranks any log card of its key (stable trace identity: they
    // share it), so it is forwarded as an update of that key, not skipped for having a log
    // counterpart. One still waiting on its transcript join, or a synthesized in-progress root
    // (its root span hasn't arrived — a long tool run or permission prompt idles it), has no
    // settled key yet: skipped without being tracked, so the keyed card that replaces it under
    // the same traceId is still forwarded once it settles.
    if (card.dataSource !== 'otel' || !hasSettledKey(card)) continue
    if (!otelForwardGate.shouldForward(card, now)) continue
    // With reconciliation, the content-hash gate sends it as a newer revision of a key the log
    // card may already have delivered (and never over a higher-rank snapshot); without it, the
    // ledger-gated first send.
    if (reconciliationService) {
      void cloud.forwardOnContentChange(reconciliationService, card, m => console.log(m))
        .then(r => { if (r.enqueued) cloud.drainUploadsSoon() }, forwardFailed('OTEL trace forward'))
    } else {
      void cloud.enqueueSession(card, m => console.log(m))
        .then(r => { if (r.enqueued) cloud.drainUploadsSoon() }, forwardFailed('OTEL trace forward'))
    }
  }
}

const PLAN_USAGE_RETENTION_DAYS = 90
/** How long reconciliation results are collected before one forwarding pass (as in extension.ts). */
const REVISION_FORWARD_BATCH_MS = 1_000

/** Coalesced flush of outcomes-cache.db after plan-limit data lands — it's otherwise only saved
 *  at shutdown, and Claude's cached readings can't be re-derived from logs after a crash. */
let outcomesSaveTimer: ReturnType<typeof setTimeout> | null = null
function saveOutcomesSoon(): void {
  planUsageVersion++
  flushOutcomesSoon()
}

/** The coalesced save alone — also after a Claude join decision is stored (claude_join). */
function flushOutcomesSoon(): void {
  if (outcomesSaveTimer) return
  outcomesSaveTimer = setTimeout(() => {
    outcomesSaveTimer = null
    try { outcomesDb?.save() } catch { /* next save retries */ }
  }, 5_000)
}

/** Claude Code caches its plan-usage reading in ~/.claude.json; a new fetch there is a new
 *  reading even when no session log changed. Returns true when one was stored. */
function pollClaudePlanUsage(): boolean {
  if (!getPlanUsageService()?.pollClaudeCache()) return false
  saveOutcomesSoon()
  return true
}

function runLogScan() {
  // The historical pass (startup, or "clear all data") is reading files on its own schedule; a
  // scan racing it would see every not-yet-parsed file as changed and parse it a second time.
  if (historicalPassRunning) return
  const results = logReader.scan()
  let changed = pollClaudePlanUsage()
  if (getPlanUsageService()?.ingest(results)) saveOutcomesSoon()
  if (retireLogSessions()) changed = true
  for (const { card } of results) {
    card.oneShotStats = computeOneShotStats(card)
    setLogSession(card)
    changed = true
    // Cloud: enqueue this session for forwarding. Hard no-op unless an org is linked.
    //
    // scan() already only returns sessions whose underlying log file actually changed since the
    // last check (see LogReader's fileState), and this whole function is itself only reached on a
    // 5s interval or a 300ms-debounced fs.watch event -- so no extra debounce is needed here, only
    // in extension.ts's per-tick `onUpdate` (see contentChangeForward.ts). Once reconciliation is
    // available, the content-hash gate (live trace reconciliation) replaces the plain ledger-gated
    // enqueue: it re-forwards under a fresh revision whenever this session's rollup content
    // actually changed (not just on its first send). Falls back to the old first-send-only
    // behavior without a reconciliation service, same as before this feature.
    if (reconciliationService) {
      void cloud.forwardOnContentChange(reconciliationService, card, m => console.log(m))
        .then(r => { if (r.enqueued) cloud.drainUploadsSoon() }, forwardFailed('Trace forward'))
    } else {
      void cloud.enqueueSession(card, m => console.log(m))
        .then(r => { if (r.enqueued) cloud.drainUploadsSoon() }, forwardFailed('Trace forward'))
    }
  }
  if (changed) schedulePushUpdate()
}

// ── Retention (standalone/sessionRetention.ts) ───────────────────────────────
//
// Log-sourced cards older than SESSION_RETENTION_DAYS are dropped from `logSessions` once a day
// (the historical pass never reads their files in the first place — see ingestHistoricalLogs);
// the OTEL forward gate forgets traces that are no longer in the store at the same time.
function runRetention(): void {
  const cutoff = retentionCutoffMs(SESSION_RETENTION_DAYS)
  const removed = pruneLogSessions(logSessions, cutoff)
  if (removed.length > 0) {
    dataVersion++
    console.log(`[TraceRoost] Retention: dropped ${removed.length} trace${removed.length === 1 ? '' : 's'} older than ${SESSION_RETENTION_DAYS} days.`)
    schedulePushUpdate()
  }
  const live = new Set((buildSessionSummary()?.sessions ?? []).map(c => c.traceId))
  otelForwardGate.prune(live)
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
  } catch { /* no sql.js — no OpenCode database reads */ }

  // Git-outcome caching — a separate small sqlite file, see standalone/db/outcomesDb.ts.
  try {
    const { openOutcomesDb } = require('./db/outcomesDb') as typeof import('./db/outcomesDb')
    outcomesDb = await openOutcomesDb(DATA_DIR, m => console.warn(m))
  } catch { /* falls back to uncached git-outcome classification, same as before this existed */ }
  // Its trace tables predated stable trace identity and were dropped (src/database/traceStore.ts);
  // the logs are read from scratch on every start anyway, and spans.json holds raw spans, not keys.
  if (outcomesDb?.rebuiltTraceStore) {
    console.log(`[TraceRoost] ${TRACE_STORE_REBUILT_MESSAGE}`)
    cloud.dropQueuedTraces()
  }
  // Claude join decisions (claude_join) — the joiner has held every interaction until now.
  if (outcomesDb) {
    const joins = new ClaudeJoinRepository(outcomesDb.raw, flushOutcomesSoon)
    joins.prune(Date.now() - PLAN_USAGE_RETENTION_DAYS * 86_400_000)
    setInterval(() => joins.prune(Date.now() - PLAN_USAGE_RETENTION_DAYS * 86_400_000), 24 * 60 * 60 * 1000).unref()
    claudeTurnJoiner.attachStore(joins)
  } else {
    claudeTurnJoiner.attachStore(null)
  }
  dataVersion++

  // Live trace reconciliation — runs from server lifecycle, not from any
  // particular browser tab being open, so a commit/merge made while the tab is closed is already
  // reconciled by the time it's reopened. See reconciliationService.ts and backgroundWatcher.ts.
  if (outcomesDb) {
    // Subscription plan limits (src/planUsage/) share this small database. Readings follow the
    // same default retention the editor uses; rollups are kept a year.
    const planUsage = new PlanUsageService(outcomesDb.raw, { log: (m) => console.log(m) })
    setPlanUsageService(planUsage)
    planUsage.runRetention(PLAN_USAGE_RETENTION_DAYS)
    setInterval(() => planUsage.runRetention(PLAN_USAGE_RETENTION_DAYS), 24 * 60 * 60 * 1000).unref()
    pollClaudePlanUsage()
  }
  if (outcomesDb) {
    reconciliationService = new ReconciliationService(outcomesDb.raw)
    const unsubscribe = reconciliationService.subscribe(pushGitOutcomeResult)
    // See extension.ts's identical wiring — a background-detected revision change must reach the
    // forwarding queue, not just the open tab's UI. Batched (standalone/revisionForwardBatcher.ts):
    // one session listing per burst of results, nothing collected while unlinked.
    const revisionBatcher = createRevisionForwardBatcher<SessionSummaryCard>({
      listCards: () => buildSessionSummary()?.sessions ?? [],
      enqueue: (card, revision) => {
        void cloud.enqueueSession(card, m => console.log(m), revision)
          .then(res => { if (res.enqueued) cloud.drainUploadsSoon() }, forwardFailed('Revision forward'))
      },
      isLinked: () => cloud.isLinked(),
      batchMs: REVISION_FORWARD_BATCH_MS,
    })
    const unsubscribeForwarding = reconciliationService.subscribe(r => revisionBatcher.onResult(r))
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
    process.once('exit', () => { unsubscribe(); unsubscribeForwarding(); revisionBatcher.dispose(); backgroundWatcher?.dispose(); reconciliationService?.dispose() })
  }

  console.log(`[TraceRoost] Log ingestion enabled — scanning local trace logs (keeping ${SESSION_RETENTION_DAYS} days)`)
  try {
    await runHistoricalPass()
  } finally {
    // Only now start the poll and watcher: runLogScan() racing the initial pass would see every
    // not-yet-parsed file as "changed" and parse it (and enqueue it) a second time. Files that
    // change or appear during the pass are still caught — parseFile() records the state it read,
    // so scan() sees anything newer on its first run.
    setInterval(runLogScan, 5_000)
    traceStoreReady = true
    // Cloud: catch sessions that never got a matching transcript file at all — see the doc
    // comment on checkStaleOtelSessions for why this needs its own idle-based check rather
    // than firing from the same per-file-change trigger runLogScan uses.
    setInterval(checkStaleOtelSessions, 5_000)
    setInterval(runRetention, 24 * 60 * 60 * 1000).unref()
    // Watch log directories for file-system events so updates appear immediately,
    // without waiting for the next poll interval.
    setupLogWatcher()
    runLogScan()
  }
}

/** True while ingestHistoricalLogs() is in flight (startup, "clear all data") — runLogScan() stays
 *  out of the way until it's done. */
let historicalPassRunning = false

/** ingestHistoricalLogs() with the bookkeeping both callers need: the in-flight flag and clearing
 *  the progress banner even if the pass bailed out early. */
async function runHistoricalPass(): Promise<void> {
  if (historicalPassRunning) return
  historicalPassRunning = true
  try {
    await ingestHistoricalLogs()
  } finally {
    historicalPassRunning = false
    if (logIngestProgress) {
      logIngestProgress = null
      broadcastSse({ type: 'logIngest', logIngest: null })
    }
  }
}

/** Progress of the one-time historical log pass at startup; null once it's done. Inlined into
 *  the page and broadcast over SSE so the dashboard can show it instead of a bare spinner. */
let logIngestProgress: { done: number; total: number } | null = null

/** How long the initial pass may hold the event loop before yielding, so page loads, SSE and
 *  OTLP requests are served between slices rather than after the whole history is parsed. */
const INGEST_SLICE_MS = 30

async function ingestHistoricalLogs(): Promise<void> {
  const countByKey = new Map<string, number>()
  const retentionCutoff = retentionCutoffMs(SESSION_RETENTION_DAYS)

  // OpenCode: one DB file = many sessions, handled separately.
  const ocResults = logReader.scanOpenCode()
  for (const { card } of ocResults) {
    card.oneShotStats = computeOneShotStats(card)
    setLogSession(card)
    countByKey.set('opencode', (countByKey.get('opencode') ?? 0) + 1)
    // Cloud: enqueue this session for forwarding. Hard no-op unless an org is linked. Needed
    // here, not just in runLogScan() — this loop's own file reads update the same LogReader's
    // fileState that scan() checks, so a historical file read here first is invisible to
    // scan() as "new" forever after (see the note above the main loop below).
    void cloud.enqueueSession(card, m => console.log(m))
      .then(r => { if (r.enqueued) cloud.drainUploadsSoon() }, forwardFailed('Trace forward'))
  }

  // Parse the history in time slices, yielding between them: the dashboard opens right away and
  // fills in as sessions load (schedulePushUpdate below), with a progress banner meanwhile,
  // rather than the page request waiting behind the whole pass.
  //
  // Retention: files last modified before the cutoff are neither read here nor by the periodic
  // scan — their size/mtime is seeded into the reader's file state as "already seen", so scan()
  // only reads one again if it changes (which makes it recent, and a trace worth keeping).
  let files: ReturnType<typeof logReader.collectFileMeta>
  let skipped: ReturnType<typeof logReader.collectFileMeta>
  try {
    const all = logReader.collectFileMeta()
    files = retentionCutoff > 0 ? all.filter(f => f.mtimeMs >= retentionCutoff) : all
    skipped = retentionCutoff > 0 ? all.filter(f => f.mtimeMs < retentionCutoff) : []
  } catch { return }
  files = files.filter(f => f.agentKey !== 'opencode')  // already handled above
  if (skipped.length > 0) {
    const seed: Record<string, { bytesRead: number; mtimeMs: number }> = {}
    for (const f of skipped) {
      if (f.agentKey === 'opencode') continue
      try { seed[f.filePath] = { bytesRead: fs.statSync(f.filePath).size, mtimeMs: f.mtimeMs } } catch { /* vanished */ }
    }
    logReader.importFileState(seed)
    console.log(`[TraceRoost] Retention: skipping ${skipped.length} log file${skipped.length === 1 ? '' : 's'} last modified more than ${SESSION_RETENTION_DAYS} days ago.`)
  }

  logIngestProgress = { done: 0, total: files.length }
  broadcastSse({ type: 'logIngest', logIngest: logIngestProgress })
  let sliceStart = performance.now()

  for (const file of files) {
    if (performance.now() - sliceStart > INGEST_SLICE_MS) {
      await new Promise<void>(resolve => setImmediate(resolve))
      broadcastSse({ type: 'logIngest', logIngest: logIngestProgress })
      schedulePushUpdate()
      sliceStart = performance.now()
    }
    logIngestProgress.done++
    try {
      // One result per turn of the file whose card changed (one turn = one trace — see
      // LogReader.parseFile).
      const results = logReader.parseFile(file.filePath, file.agentKey)
      if (getPlanUsageService()?.ingest(results)) saveOutcomesSoon()
      for (const result of results) {
        result.card.oneShotStats = computeOneShotStats(result.card)
        setLogSession(result.card)
        countByKey.set(file.agentKey, (countByKey.get(file.agentKey) ?? 0) + 1)
        // Cloud: enqueue this session for forwarding. Hard no-op unless an org is linked.
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
        void cloud.enqueueSession(result.card, m => console.log(m))
          .then(r => { if (r.enqueued) cloud.drainUploadsSoon() }, forwardFailed('Trace forward'))
      }
    } catch { /* skip bad file */ }
  }
  retireLogSessions()
  // Cards read from a recently-modified file can still start before the cutoff (an old transcript
  // appended to today); retention is by trace start time, so apply it to what was just loaded.
  pruneLogSessions(logSessions, retentionCutoff)

  // Merge copilot_vscode and copilot_vscode_json into one display row
  const displayCounts = new Map<string, { label: string; dir: string; count: number }>()
  for (const [key, count] of countByKey) {
    const displayKey = key === 'copilot_vscode_json' ? 'copilot_vscode' : key
    const existing = displayCounts.get(displayKey)
    if (existing) { existing.count += count } else {
      displayCounts.set(displayKey, { label: agentKeyLabel(key), dir: agentKeyDir(key), count })
    }
  }

  const total = [...displayCounts.values()].reduce((s, v) => s + v.count, 0)
  if (total === 0) return
  const lines = [...displayCounts.values()]
    .sort((a, b) => b.count - a.count)
    .map(v => `  ${v.label.padEnd(20)} ${String(v.count).padStart(4)}  (${v.dir})`)
    .join('\n')
  console.log(`[TraceRoost] Loaded ${total} traces from local logs:\n${lines}`)
  // Push the final state to any SSE clients that connected before the scan finished.
  pushUpdate()
}

// ── OTLP parsing ──────────────────────────────────────────────────────────────
//
// The same parser the extension's collector runs (src/otlpIngest.ts), so a Codex trace is remapped
// to the same prompt-session id on either host, and gen_ai response content logged separately is
// attached to its span here too.

function agentLabelFromSpanName(name: string): string {
  if (name.startsWith('claude_code.')) return 'Claude Code'
  if (name.startsWith('codex.'))       return 'Codex'
  if (name === 'invoke_agent' || name.startsWith('copilot.')) return 'Copilot'
  return 'unknown'
}

/** The first agent seen in the current request, for the ingest log line. */
let ingestAgent = 'unknown'

const otlpIngest = new OtlpIngest({
  addSpan(span) {
    if (ingestAgent === 'unknown') ingestAgent = agentLabelFromSpanName(span.name)
    addSpan(span)
  },
  injectSpanAttribute(traceId, spanId, key, value) {
    const span = spanIndex.get(spanIndexKey(traceId, spanId))
    if (!span) return false
    const existing = span.attributes.find(a => a.key === key)
    if (existing) existing.value = { stringValue: value }
    else span.attributes.push({ key, value: { stringValue: value } })
    dataVersion++
    return true
  },
})

function processTraces(payload: unknown, collectorPath = '/v1/traces'): { count: number; agent: string } {
  ingestAgent = 'unknown'
  const count = otlpIngest.processTraces(payload, collectorPath)
  return { count, agent: ingestAgent }
}

function processLogs(payload: unknown, collectorPath = '/v1/logs'): number {
  return otlpIngest.processLogs(payload, collectorPath)
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

  return { isActive, lastActivityMs: lastMs, sessionCount: base.sessionCount, agentSources, currentSession, burnRate, avgInputTokens, avgOutputTokens, ...planLimitFields(latest, burnRate) }
}

/** The sidebar's live Plan limit card and compact meter line — absent when there's no plan-limit
 *  data. Same fields the editor's sidebarPanel.ts sends. */
function planLimitFields(latest: ReturnType<typeof sidebarPayloadBase>['latest'], burnRate: { costPerHour: number } | null) {
  const svc = getPlanUsageService()
  if (!svc) return { planLimit: null, planMeters: [] }
  try {
    return { planLimit: svc.liveCard(latest ?? undefined, burnRate) ?? null, planMeters: svc.meters() }
  } catch {
    return { planLimit: null, planMeters: [] }
  }
}

/** The dashboard's plan-limit snapshot (src/planUsage/), sent as its own `planUsage` message —
 *  null when there's no service. Rebuilt at most once per data version or Claude poll. */
let planUsageCache: { key: string; json: string } | null = null
function planUsageMessage(): string | null {
  const svc = getPlanUsageService()
  if (!svc) return null
  const key = `${dataVersion}|${planUsageVersion}`
  if (planUsageCache?.key === key) return planUsageCache.json
  try {
    const json = JSON.stringify({ type: 'planUsage', snapshot: svc.snapshot(buildSessionSummary()?.sessions ?? []) })
    planUsageCache = { key, json }
    return json
  } catch {
    return null
  }
}
let planUsageVersion = 0

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
let joinRecheckTimer: ReturnType<typeof setTimeout> | null = null

function buildSessionSummary(): ReturnType<typeof summarizeSpans> | null {
  if (summaryCache && summaryCache.version === dataVersion) return summaryCache.summary

  let summary: ReturnType<typeof summarizeSpans> | null = null
  try { summary = summarizeSpans(spans) } catch (e) { console.warn('[TraceRoost] summarizeSpans error:', e) }
  // A Claude interaction whose transcript join is on hold settles once the hold runs out — make
  // sure something recomputes then, even if no further span arrives.
  if (summary?.sessions.some(c => c.keyPending) && !joinRecheckTimer) {
    joinRecheckTimer = setTimeout(() => { joinRecheckTimer = null; dataVersion++; schedulePushUpdate() }, claudeTurnJoiner.holdMs + 50)
  }

  // Merge log-sourced sessions by canonical key (stable trace identity): a turn's OTEL and log
  // cards share one key, and the higher source rank wins — the rule the extension's database
  // writer applies too (see claudeConversation.ts's mergeCardsByKey).
  if (logSessions.size > 0) {
    const merged = sortNewestFirst(mergeCardsByKey(summary?.sessions ?? [], logSessions.values()))
    summary = { ...(summary ?? { backgroundSpans: [], efficiency: { totalInputTokens: 0, totalOutputTokens: 0, totalLlmCalls: 0, avgInputPerCall: 0, avgTtft: 0, cacheHitRate: 0, toolDefWaste: 0, sysInstructionWaste: 0, topTokenConsumers: [] } }), sessions: merged }
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

let lastSentPlanUsage: string | null = null
function pushUpdate() {
  if (pushUpdateTimer) { clearTimeout(pushUpdateTimer); pushUpdateTimer = null }
  lastPushUpdateAt = Date.now()
  if (sseClients.length === 0) return // nobody to tell — a tab that connects later gets a fresh payload
  const started = performance.now()
  // Nothing session-shaped changed: still send the live sidebar fields, as every push always has.
  if (!syncSseClients()) writeSse(updateFrame(derivedViews(), sseSync.revision, sseSync.revision, ''))
  const plan = planUsageMessage()
  if (plan && plan !== lastSentPlanUsage) { writeSse(plan); lastSentPlanUsage = plan }
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

// ── Dashboard HTML (template: standalone/dashboardHtml.ts) ──────────────────

function getHtml(nonce: string): string {
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

  return renderDashboardHtml({
    nonce,
    packageVersion: PACKAGE_VERSION,
    collectorConflictJson: JSON.stringify(collectorConflict),
    logIngestJson: JSON.stringify(logIngestProgress),
    sessionRev,
    sessionSummaryJson,
    sidebarInitJson,
  })
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

/** Settings → Clear all data (POST /api/clear from the page, POST /action {type:'clearAll'} from
 *  Settings.tsx's no-host path) — the extension's traceRoost.clearSessions: drop OTEL spans and the
 *  log-session cache, then re-read the local log files so log-sourced traces come back. */
function clearAllData(): void {
  traceStoreReady = false // see traceManifestSource
  spans = []
  rebuildSpanIndex()
  logSessions.clear()
  dataVersion++
  logReader.clearFileState()
  try { writeFileAtomic(DATA_FILE, '[]', { mode: 0o600 }) } catch (e) { console.warn('[TraceRoost] Could not clear data file:', e) }
  pushUpdate()          // send cleared state to clients immediately
  // Re-ingest on a later turn, after the caller's response is sent, so the client sees the cleared
  // state first. The same sliced, retention-aware pass as startup (with its progress banner and
  // ledger-gated enqueue) — not a synchronous scan() of the whole history on the event loop.
  setImmediate(() => {
    void runHistoricalPass()
      .catch(e => console.warn('[TraceRoost] Re-reading local logs after clearing data failed:', e))
      .finally(() => { traceStoreReady = true })
  })
}

// ── Instructions tab routes (polyfill → standalone/instructionActions.ts) ─────
const INSTRUCTION_GET_ROUTES = new Map([
  ['/api/instruction-files', 'getInstructionFiles'],
  ['/api/instructions/applied', 'getAppliedSuggestions'],
  ['/api/instructions/dismissed', 'getDismissedSuggestions'],
])
const INSTRUCTION_POST_ROUTES = new Map([
  ['/api/instructions/apply', 'applyInstructionSuggestion'],
  ['/api/instructions/dismiss', 'dismissInstructionSuggestion'],
  ['/api/instructions/remove', 'removeInstructionSuggestion'],
])

// No "current workspace": every message names its own, which instructionActions.ts accepts only if
// a recorded session ran there — so the Instructions tab covers every repo on this machine.
const instructionHost: InstructionHost = {
  sessions: () => buildSessionSummary()?.sessions ?? [],
  load: () => loadInstructionState(INSTRUCTIONS_FILE, m => console.warn(m)),
  save: (state) => saveInstructionState(INSTRUCTIONS_FILE, state),
}

function runInstructionMessage(msg: unknown): InstructionResult {
  const result = handleInstructionMessage(msg, instructionHost)
  if (result.error) console.warn(`[TraceRoost] ${result.error}`)
  if (result.changed) emitInstructionTelemetry(result.changed)
  return result
}

function sendInstructionResult(res: http.ServerResponse, result: InstructionResult): void {
  res.writeHead(result.status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ messages: result.messages, ...(result.error ? { error: result.error } : {}) }))
}

/** An automation prompt is a few KB; the rest is headroom. */
const MAX_PROMPT_BODY_BYTES = 1024 * 1024
/** A session export (Export tab JSON — per-session summaries, no timelines) runs to a few KB a
 *  session; the OTLP receiver's 50 MB cap leaves room for tens of thousands of them. */
const MAX_IMPORT_BODY_BYTES = 50 * 1024 * 1024
/** /action and /api/org carry one small webview message. */
const MAX_ACTION_BODY_BYTES = 64 * 1024
/** /api/git-outcome and /api/repo-hash: one session's workspace and changed-file list. */
const MAX_GIT_BODY_BYTES = 1024 * 1024
/** /api/git-outcomes: up to 20 000 session ids. */
const MAX_GIT_BATCH_BODY_BYTES = 4 * 1024 * 1024

/** `workspace` is a folder at least one recorded trace ran in (standalone/instructionActions.ts's
 *  knownWorkspace) — the only folders this server reads instruction files from or runs `git` in.
 *  Never an arbitrary path from the page. */
function isKnownWorkspace(workspace: string): boolean {
  return knownWorkspace(workspace, buildSessionSummary()?.sessions ?? [])
}

function sendTooLarge(res: http.ServerResponse): void {
  res.writeHead(413, { 'Content-Type': 'text/plain', 'Connection': 'close' }); res.end('Payload Too Large')
}

/** dashboardPanel.ts's emitInstructionTelemetry: after any apply / dismiss / remove, queue the
 *  workspace's instruction-telemetry rollup — a hard no-op unless an org is linked (and always in
 *  the core edition). */
function emitInstructionTelemetry(workspace: string): void {
  const state = loadInstructionState(INSTRUCTIONS_FILE, m => console.warn(m))
  const ledger = {
    applied: state.applied.filter(a => a.workspace === workspace).map(a => ({
      id: a.id,
      atIso: a.appliedAt || new Date().toISOString(),
      card: { id: a.id, category: a.category as 'context' | 'behavior' | 'prompting' },
    })),
    dismissed: state.dismissed.filter(d => d.workspace === workspace).map(d => ({ id: d.id, atIso: d.dismissedAt })),
    reverted: [],
  }
  void cloud.enqueueInstructionTelemetry(workspace, buildSessionSummary()?.sessions ?? [], ledger)
    .then(enqueued => { if (enqueued) cloud.drainUploadsSoon() })
    .catch(() => { /* telemetry is best-effort */ })
}

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
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': UNAUTHORIZED_PAGE_CSP })
      res.end(unauthorizedHtml(UI_PORT))
      return
    }
    // First request authenticated via ?token= or an Authorization header rather than an existing
    // cookie — hand the browser a cookie so every subsequent asset/API/SSE request just works.
    if (extractCookieToken(req) !== AUTH_TOKEN) {
      res.setHeader('Set-Cookie', authCookieHeader(AUTH_TOKEN))
      // A page opened with `?token=` in the address: now that the cookie carries it, send the
      // browser to the same page without it, so the token doesn't stay in the address bar and
      // browser history. Only the page itself — the cookie is already set on this response.
      if (req.method === 'GET' && (url === '/' || url === '/index.html') && new URLSearchParams((req.url ?? '').split('?')[1] ?? '').has('token')) {
        res.writeHead(302, { Location: url }); res.end()
        return
      }
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
    const plan = planUsageMessage()
    if (plan) res.write(`data: ${plan}\n\n`)
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
    readBodyLimited(req, MAX_IMPORT_BODY_BYTES).then(raw => {
      if (!raw) { sendTooLarge(res); return }
      try {
        const body = JSON.parse(raw.toString('utf-8')) as { sessions?: unknown[] }
        if (!Array.isArray(body.sessions)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'sessions array required' }))
          return
        }
        let imported = 0
        let skipped = 0
        for (const raw of body.sessions) {
          if (typeof raw !== 'object' || raw === null) continue
          const s = raw as Record<string, unknown>
          const id = typeof s['sessionId'] === 'string' ? s['sessionId'] : ''
          if (!id || !IMPORT_SOURCES.has(s['source'] as string)) continue
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
    }).catch(e => {
      console.warn(`[TraceRoost] ${url} error:`, e)
      if (!res.headersSent) { res.writeHead(500); res.end() }
    })
    return
  }

  if (req.method === 'POST' && url === '/api/clear') {
    clearAllData()
    res.writeHead(200); res.end()
    return
  }

  if (req.method === 'POST' && url === '/api/write-prompts-file') {
    readBodyLimited(req, MAX_PROMPT_BODY_BYTES).then(body => {
      if (!body) { sendTooLarge(res); return }
      try {
        const { agent, label, prompt } = JSON.parse(body.toString('utf-8')) as { agent: unknown; label: unknown; prompt: unknown }
        if (typeof label !== 'string' || typeof prompt !== 'string' || !prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'label and prompt strings are required' }))
          return
        }
        const { filename, agentName } = promptsFileFor(agent)
        // Under the data directory — not process.cwd(), which for the background service is `/` or
        // $HOME and for `npx traceroost` is whatever repo it was started in (where the file would
        // end up in git). The extension writes the same file into the open workspace folder.
        const filePath = path.join(DATA_DIR, filename)
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
        const entry = `## ${timestamp} — ${label}\n\n${prompt}\n\n---\n\n`
        let existing = ''
        try { existing = fs.readFileSync(filePath, 'utf-8') } catch { /* new file */ }
        const content = existing ? existing + entry : `# TraceRoost Prompts — ${agentName}\n\n${entry}`
        writeFileAtomic(filePath, content, { mode: 0o600 })
        console.log(`[TraceRoost] Prompt written to ${filePath}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ filename, path: filePath }))
      } catch (e) {
        console.warn('[TraceRoost] write-prompts-file error:', e)
        res.writeHead(500); res.end()
      }
    }).catch(e => {
      console.warn('[TraceRoost] write-prompts-file error:', e)
      if (!res.headersSent) { res.writeHead(500); res.end() }
    })
    return
  }

  if (req.method === 'GET' && url === '/api/instruction-suggestions') {
    const parsed = new URL(req.url ?? url, 'http://localhost')
    const workspace = parsed.searchParams.get('workspace')?.trim()
    if (!workspace) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'workspace query param is required' }))
      return
    }
    if (!isKnownWorkspace(workspace)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `${workspace} is not a workspace in the recorded sessions.` }))
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

  // Instructions tab (see standalone/instructionActions.ts): each route answers one webview
  // message with the messages dashboardPanel.ts would post back, which the polyfill re-dispatches.
  const instructionGet = INSTRUCTION_GET_ROUTES.get(url)
  if (req.method === 'GET' && instructionGet) {
    // `url` has its query string stripped; the workspace is in the raw req.url.
    const workspace = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('workspace')?.trim() ?? ''
    sendInstructionResult(res, runInstructionMessage({ type: instructionGet, workspace }))
    return
  }
  const instructionPost = req.method === 'POST' ? INSTRUCTION_POST_ROUTES.get(url) : undefined
  if (instructionPost) {
    readBodyLimited(req, MAX_INSTRUCTION_BODY_BYTES).then(body => {
      if (!body) { sendTooLarge(res); return }
      let msg: unknown
      try { msg = JSON.parse(body.toString('utf-8')) } catch {
        sendInstructionResult(res, { status: 400, messages: [], error: 'invalid JSON body' })
        return
      }
      // The route names the action; the body is the webview message itself.
      sendInstructionResult(res, runInstructionMessage(
        typeof msg === 'object' && msg !== null ? { ...msg, type: instructionPost } : msg))
    }).catch(e => {
      console.warn(`[TraceRoost] ${url} error:`, e)
      if (!res.headersSent) sendInstructionResult(res, { status: 500, messages: [], error: String(e) })
    })
    return
  }

  if (req.method === 'POST' && url === '/action') {
    readBodyLimited(req, MAX_ACTION_BODY_BYTES).then(async raw => {
      if (!raw) { sendTooLarge(res); return }
      try {
        const body = JSON.parse(raw.toString('utf-8')) as { type?: string }
        if (body.type === 'clearAll') {
          clearAllData()
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
    }).catch(e => {
      console.warn(`[TraceRoost] ${url} error:`, e)
      if (!res.headersSent) { res.writeHead(500); res.end() }
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

  // ── Org (TraceRoost Cloud) — AL 01 ──────────────────────────────────────────
  // GET returns the local status (no network). POST runs an action (link/leave/explain).
  // Both reply with an array of webview messages the polyfill re-dispatches.
  // Not served at all in the core edition (literal edition check, so esbuild drops the handler).
  if (process.env.TRACEROOST_EDITION !== 'core' && url === '/api/org' && (req.method === 'GET' || req.method === 'POST')) {
    readBodyLimited(req, MAX_ACTION_BODY_BYTES).then(async body => {
      if (!body) { sendTooLarge(res); return }
      const outbox: Record<string, unknown>[] = []
      const msg = req.method === 'GET'
        ? { type: 'getOrgStatus' }
        : (() => { try { return JSON.parse(body.toString('utf-8')) as { type: string } } catch { return { type: 'getOrgStatus' } } })()
      try {
        await cloud.handleOrgMessage(msg, {
          post: (m) => outbox.push(m),
          openExternal: (u) => {
            openInBrowser(u, () => { /* URL is also delivered as an orgLinkUrl message */ })
          },
          recentSessions: () => buildSessionSummary()?.sessions.slice(0, 25) ?? [],
          allLocalSessions: () => buildSessionSummary()?.sessions ?? [],
          buildPayloadPreview: (sessions) => cloud.buildPayloadPreview(sessions),
          onOpenOrgView: () => {
            // Deep-links into the org's own dashboard — see cloud/bridge.ts's orgViewUrl.
            const url = cloud.orgViewUrl()
            openInBrowser(url, err => console.warn(`[TraceRoost] Could not open ${url} in a browser: ${err.message}`))
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
    }).catch(e => {
      console.warn(`[TraceRoost] ${url} error:`, e)
      if (!res.headersSent) { res.writeHead(500); res.end() }
    })
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/timeline/')) {
    // Guarded decode: a malformed escape would otherwise throw out of this listener and take the
    // server down — from any web page, since GET needs no Origin (standalone/requestGuards.ts).
    const sessionId = decodePathSegment(url.slice('/api/timeline/'.length))
    if (sessionId === null) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad Request — malformed session id'); return }
    const summary = buildSessionSummary()
    const session = summary?.sessions.find(s => s.sessionId === sessionId) ?? null
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ timeline: session?.timeline ?? [] }))
    return
  }

  if (req.method === 'POST' && url === '/api/git-outcome') {
    readBodyLimited(req, MAX_GIT_BODY_BYTES).then(async raw => {
      if (!raw) { sendTooLarge(res); return }
      try {
        const body = JSON.parse(raw.toString('utf-8')) as {
          sessionId?: string; workspace?: string; filesChanged?: string[]; endTime?: string
        }
        const sessionId = body.sessionId ?? ''
        if (!sessionId) { res.writeHead(400); res.end(); return }
        // `git` runs in the workspace (and honours that directory's .git/config), so it must be one
        // a recorded trace names — an empty workspace is fine (classified "not applicable").
        if (body.workspace && !isKnownWorkspace(body.workspace)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `${body.workspace} is not a workspace in the recorded sessions.` }))
          return
        }
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
          console.warn(`[TraceRoost] Git-outcome classification failed for session ${sessionId}:`, err)
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
        const riskSignals = card ? detectSessionRiskSignals(card, body.workspace ?? '') : []
        const temperedLoopSignals = card ? temperLoopSignalSeverity(card.loopSignals ?? [], outcome) : null
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessionId, outcome, riskSignals, temperedLoopSignals, revision }))
      } catch (e) {
        console.warn('[TraceRoost] Malformed /api/git-outcome body:', e)
        res.writeHead(400); res.end()
      }
    }).catch(e => {
      console.warn(`[TraceRoost] ${url} error:`, e)
      if (!res.headersSent) { res.writeHead(500); res.end() }
    })
    return
  }

  if (req.method === 'POST' && url === '/api/git-outcomes') {
    readBodyLimited(req, MAX_GIT_BATCH_BODY_BYTES).then(raw => {
      if (!raw) { sendTooLarge(res); return }
      try {
        const body = JSON.parse(raw.toString('utf-8')) as { sessionIds?: unknown[] }
        const ids = [...new Set((body.sessionIds ?? []).filter((id): id is string => typeof id === 'string'))].slice(0, 20_000)
        const requested = new Set(ids)
        const cards = (buildSessionSummary()?.sessions ?? []).filter(card => requested.has(card.sessionId))
        const inputs = cards.map(card => ({
          sessionId: card.sessionId,
          workspace: card.workspace,
          filesChanged: card.filesChanged,
          endTime: card.startTime && card.durationMs && !Number.isNaN(Date.parse(card.startTime))
            ? new Date(Date.parse(card.startTime) + card.durationMs).toISOString()
            : card.startTime,
        }))
        const outcomes = reconciliationService?.getCachedOutcomes(inputs.map(input => input.sessionId)) ?? {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ outcomes }))

        // The HTTP reply paints persisted results first. Reconciliation publishes current results
        // through the existing SSE subscription, sharing one HEAD/trunk snapshot for this batch.
        setImmediate(() => {
          void (async () => {
            if (reconciliationService) {
              try {
                const results = await reconciliationService.reconcileMany(inputs)
                for (const result of results) {
                  if (result.deferred) broadcastSse({ type: 'gitOutcomeDeferred', sessionId: result.sessionId })
                }
              } catch (err) {
                console.warn('[TraceRoost] Batched git-outcome reconciliation failed:', err)
                await Promise.all(inputs.map(async input => {
                  try {
                    const result = await reconciliationService!.reconcile(input)
                    if (result.deferred) broadcastSse({ type: 'gitOutcomeDeferred', sessionId: result.sessionId })
                  } catch {
                    broadcastSse({ type: 'gitOutcome', sessionId: input.sessionId, outcome: null })
                  }
                }))
              }
              return
            }
            await Promise.all(cards.map(async card => {
              let outcome: GitOutcome | null = null
              try { outcome = await classifySessionOutcome(card.workspace, card.filesChanged) } catch { /* report unresolved below */ }
              const riskSignals = detectSessionRiskSignals(card, card.workspace)
              const temperedLoopSignals = temperLoopSignalSeverity(card.loopSignals ?? [], outcome)
              broadcastSse({ type: 'gitOutcome', sessionId: card.sessionId, outcome, riskSignals, temperedLoopSignals })
            }))
          })()
        })
      } catch (e) {
        console.warn('[TraceRoost] Malformed /api/git-outcomes body:', e)
        res.writeHead(400); res.end()
      }
    }).catch(e => {
      console.warn(`[TraceRoost] ${url} error:`, e)
      if (!res.headersSent) { res.writeHead(500); res.end() }
    })
    return
  }

  if (req.method === 'POST' && url === '/api/repo-hash') {
    readBodyLimited(req, MAX_GIT_BODY_BYTES).then(async raw => {
      if (!raw) { sendTooLarge(res); return }
      try {
        const body = JSON.parse(raw.toString('utf-8')) as { workspace?: string }
        const workspace = body.workspace ?? ''
        if (!workspace) { res.writeHead(400); res.end(); return }
        // Same rule as /api/git-outcome: `git` only ever runs in a folder a recorded trace names.
        if (!isKnownWorkspace(workspace)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `${workspace} is not a workspace in the recorded sessions.` }))
          return
        }
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
    }).catch(e => {
      console.warn(`[TraceRoost] ${url} error:`, e)
      if (!res.headersSent) { res.writeHead(500); res.end() }
    })
    return
  }

  if (url === '/' || url === '/index.html') {
    // Per-response nonce: only the page's own <script> tags run — see standalone/dashboardCsp.ts.
    const nonce = generateCspNonce()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': dashboardCspHeader(nonce) })
    res.end(getHtml(nonce))
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
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
    } catch {
      // Non-JSON (an exporter set to protobuf): accepted so it does not retry — as the extension does.
      console.warn(`[TraceRoost] Ignored POST ${req.url ?? '/'}: non-JSON payload (protobuf?)`)
      res.writeHead(200); res.end(); return
    }
    try {
      const kind = classifyOtlpPayload(payload)
      if (req.url === '/v1/traces' || kind === 'traces') {
        const { count, agent } = processTraces(payload, req.url ?? '/v1/traces')
        if (count > 0) console.log(`[TraceRoost] Ingested ${count} span${count !== 1 ? 's' : ''} (${agent})`)
      } else if (req.url === '/v1/logs' || kind === 'logs') {
        processLogs(payload, req.url ?? '/v1/logs')
      } else if (kind === 'metrics' || req.url === '/v1/metrics') {
        // Metrics are accepted so OTLP exporters do not retry, but TraceRoost does not display them.
      } else {
        console.warn(`[TraceRoost] Ignored POST ${req.url ?? '/'}: unrecognized OTLP JSON payload`)
      }
      schedulePushUpdate()
      scheduleSave()
    } catch (e) {
      // Malformed-but-parseable OTLP: a 400, as the extension's collector answers it.
      console.error('[TraceRoost] Malformed OTLP payload:', e)
      schedulePushUpdate()  // spans before the bad record were stored
      scheduleSave()
      res.writeHead(400); res.end(); return
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

  if (bound !== OTLP_PORT) {
    // Fell back rather than failing — find out who has the default port so the dashboard banner
    // (and this log line) can say something more useful than "a port was busy". Best-effort: a
    // failed probe just means no banner, not a startup error, since the fallback already succeeded.
    void detectPortOwner(OTLP_PORT).then(owner => {
      // 'standalone' means another TraceRoost server — necessarily on a different data dir, since a
      // second one on this dir is refused at startup (dataDirLock). Running two is a deliberate
      // choice, so one log line, no dashboard banner.
      if (owner === 'standalone') {
        console.log(`[TraceRoost] Port ${OTLP_PORT} is held by another TraceRoost server (with its own data directory); this one receives OTLP on ${bound}.`)
        return
      }
      collectorConflict = { owner, port: OTLP_PORT, boundPort: bound }
      if (owner === 'plugin') {
        console.warn(
          `[TraceRoost] Two TraceRoost hosts are running — the VS Code extension already holds port ${OTLP_PORT}; this service moved to port ${bound} instead.\n` +
          `  - Agents are already pointed at ${bound}, so nothing's being missed — but with both running, whichever one you close first silently stops collecting.\n` +
          `  - Recommended: keep this background service — it works even when VS Code is closed — and uninstall the extension (\`code --uninstall-extension agentlens.agentlens-dashboard\`), then reload.\n` +
          `  - Prefer VS Code instead? Stop this service with \`traceroost service stop\`.`
        )
      } else {
        console.warn(`[TraceRoost] Port ${OTLP_PORT} is in use by another application — this service moved to port ${bound} instead. Agents are already pointed at ${bound}, so nothing's being missed.`)
      }
      broadcastSse({ type: 'update', collectorConflict })
    }).catch(() => { /* best effort */ })
  }

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
      for (const { level, text } of autoConfigLogLines(claudeResult, codexResult, copilotResults)) console[level](text)
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
  // The token-bearing URL is printed only to an interactive terminal. As the background service
  // (or with stdout redirected — Docker logs, a pipe) stdout is a log file, and the token must not
  // end up in one: print a redacted URL and say where the token lives instead.
  const printable = mayPrintFullUrl({ service: process.env.TRACEROOST_SERVICE === '1', stdoutIsTty: process.stdout.isTTY === true })
    ? url : redactTokenInUrl(url)
  console.log(`[TraceRoost] Dashboard      → ${printable}`)
  if (printable !== url) console.log('[TraceRoost]                  (token: `authToken` in ~/.traceroost/config.json, or `traceroost service status`)')
  console.log(`[TraceRoost] MCP server     → http://localhost:${mcpPort}/mcp`)

  // Auto-open browser — includes the access token so the browser gets its auth cookie on
  // first load when the token is actually required; the printed URL above is the fallback if
  // auto-open fails or you're opening on another device.
  openInBrowser(url, () => console.log(`\nOpen ${printable} in your browser\n`))

  // Start log ingestion after the server is ready
  startLogIngestion()

  // Cloud: forwarding scheduler. No timer runs unless an org is linked.
  cloud.startForwardScheduler({ log: (msg) => console.log(msg), onDrainStart: pushOrgStatusToClients, onDrainComplete: pushOrgStatusToClients, traceManifest: traceManifestSource })
  // A link made outside this server (`traceroost org link`, another process on this data dir)
  // would otherwise go unnoticed until a restart: no forwarding timer, and no history queued.
  cloud.startLinkWatcher({
    allLocalSessions: () => buildSessionSummary()?.sessions ?? [],
    isWriter: () => dataDirLock.isOurs(),
    isReady: () => traceStoreReady,
    log: (msg) => console.log(msg),
    onLinkStateChange: pushOrgStatusToClients,
  })

  // Cloud: pricing sync — own (longer) interval, see pricingSync.ts.
  cloud.startPricingSync({ onSync: pushOrgStatusToClients })
}

// The trace manifest (stable trace identity, src/cloud/forward/traceManifest.ts) states which trace
// keys this install holds — so only while this process is the data dir's writer, and only once the
// historical log pass has finished (and not while "clear all data" re-reads): a manifest built
// from a half-loaded store would retire every trace not read yet (traceStoreReady, above).
const traceManifestSource: TraceManifestSource = {
  isWriter: () => dataDirLock.isOurs(),
  isReady: () => traceStoreReady,
  localHorizonMs: () => localHorizonOf(buildSessionSummary()?.sessions ?? []),
  listTraceKeys: (fromMs, toMs) => traceKeysInWindow(buildSessionSummary()?.sessions ?? [], fromMs, toMs),
  countTraces: (fromMs, toMs) => countTracesInWindow(buildSessionSummary()?.sessions ?? [], fromMs, toMs),
}

void startOtlpServer()
void startUiServer()

// ── Graceful shutdown — flush data before exit ────────────────────────────────

function shutdown() {
  if (saveTimer) clearTimeout(saveTimer)
  // Only while this is still the data dir's writer (see dataDirLock above); the lock itself is
  // released by its 'exit' handler, after these saves.
  if (dataDirLock.isOurs()) {
    if (saveSpansNow()) {
      console.log(`\n[TraceRoost] Saved ${spans.length} spans to ${DATA_FILE}`)
    }
    outcomesDb?.save()
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ── Last-resort error handlers ───────────────────────────────────────────────
//
// Without these, one throw out of a request listener or one rejected promise nobody awaited ends
// the process (Node ≥ 15 treats unhandled rejections as fatal): launchd/systemd restart the
// service, an ad-hoc `npx traceroost` and the Windows Scheduled Task do not, and in either case
// the agents' OTLP exporters don't retry, so everything they emit until the restart is lost. The
// server is a local dashboard, not a transaction system: log the error (every one — never
// swallowed silently) and keep serving, after flushing what's in memory so a follow-up crash
// loses nothing. Every store write is atomic (src/fsAtomic.ts), so flushing here is safe even
// mid-request.
function flushStoresBestEffort(): void {
  if (!dataDirLock.isOurs()) return
  try { saveSpansNow() } catch { /* logged by saveSpansNow */ }
  try { outcomesDb?.save() } catch (e) { console.error('[TraceRoost] Could not save the outcomes cache:', e) }
}
process.on('uncaughtException', (err, origin) => {
  console.error(`[TraceRoost] ${origin === 'unhandledRejection' ? 'Unhandled rejection' : 'Uncaught exception'} — continuing to serve:`, err)
  flushStoresBestEffort()
})
process.on('unhandledRejection', (reason) => {
  console.error('[TraceRoost] Unhandled promise rejection — continuing to serve:', reason)
})
