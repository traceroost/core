import { claudeUsageRows } from './claudeUsageLines'
/**
 * Reads local session logs for Claude Code, Codex, Copilot CLI, Copilot Chat (VS Code sidebar),
 * and Cursor CLI, and synthesises SessionSummaryCard records.
 *
 * Agent log paths (Mac → Windows → Linux):
 *
 *   Claude Code  ~/.claude/projects/<project>/<uuid>.jsonl
 *                %APPDATA%\Claude\projects\<project>\<uuid>.jsonl
 *                Override: CLAUDE_CONFIG_DIR (comma-separated list of config dirs)
 *
 *   Codex        ~/.codex/sessions/<project>/<uuid>.jsonl
 *                %LOCALAPPDATA%\Codex\sessions\<project>\<uuid>.jsonl  (Windows)
 *                Override: CODEX_HOME (comma-separated list of home dirs)
 *
 *   Copilot CLI  ~/.copilot/session-state/<uuid>/events.jsonl
 *                %APPDATA%\copilot\session-state\<uuid>\events.jsonl  (Windows)
 *
 *   Copilot Chat ~/Library/Application Support/<IDE>/User/workspaceStorage/<hash>/chatSessions/<uuid>.jsonl
 *   (VS Code-   %APPDATA%\<IDE>\User\workspaceStorage\<hash>\chatSessions\<uuid>.jsonl
 *   family IDE) ~/.config/<IDE>/User/workspaceStorage/<hash>/chatSessions/<uuid>.jsonl
 *               where <IDE> is any VS Code-family IDE (see VSCODE_FAMILY_IDE_NAMES)
 *
 *   Cursor CLI   ~/.cursor/projects/<sanitized-workspace>/agent-transcripts/<uuid>/<uuid>.jsonl
 *   (cursor-     %APPDATA%\Cursor\projects\...  (Windows, unconfirmed — mirrors Claude's convention)
 *   agent)       ~/.config/cursor/projects/...  (XDG_CONFIG_HOME override — checked live on
 *                2026-09-19 against cursor-agent 2026.09.18-9a7762b/macOS: setting
 *                XDG_CONFIG_HOME relocates its *config* (cli-config.json, chats/) but NOT
 *                agent-transcripts, which stayed under the real ~/.cursor/projects regardless.
 *                cursorAgentProjectsDirs() below still probes the XDG path defensively — a
 *                nonexistent directory there is silently filtered out — in case a future version
 *                does honor it; one platform's one version confirmed not honoring it isn't proof
 *                no version ever will).
 *                Confirmed against real output from cursor-agent 2026.09.18 (and re-verified
 *                2026-09-19, including a real `--resume`d multi-turn session). Separate from, and
 *                not to be confused with, Cursor the IDE's own undocumented state.vscdb chat
 *                store — investigated and concluded not viable to ingest (enterprise-only OTEL
 *                export, no stable local format), independent of this CLI agent.
 *
 * Data available from logs (vs OTEL):
 *   Claude / Codex: session ID, workspace, model, timestamps, full token counts
 *                   (incl. cache reads/writes), tool calls
 *   Copilot CLI:    session ID, workspace, model, timestamps, input/output/cache tokens
 *   Copilot Chat:   session ID, workspace, initial model, timestamps, output tokens per turn
 *                   (input tokens and cache tokens are not stored by VS Code)
 *   Cursor CLI:     session ID, tool calls (name + counts). NOT available: workspace (no cwd
 *                   anywhere in the file; the project dirname is sanitized/lossy, so it's left
 *                   blank rather than guessed), model name, any token/usage counts, per-line
 *                   timestamps (session start/end fall back to file birthtime/mtime), and
 *                   tool-call success/failure (only a session-level turn_ended status exists).
 *   Not available in any log: TTFT, per-tool timing, streaming speed, loop signals
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
import type { SessionSummaryCard, TimelineEntry, EditDetail } from './summarizers/summarizerTypes'
import { VSCODE_FAMILY_IDE_NAMES } from './vscodeFamilyIdes'
import { rankModelsByWeight, isTaskNotificationOnly, summarizeTaskNotification, APPLY_PATCH_FILE_HEADER_RE } from './summarizers/helpers'
import { stripDateSuffix } from './pricing'
import { CodexLimitCollector, claudeLimitHit, dedupeHits, CLAUDE_SYNTHETIC_MODEL, type LimitReading, type LimitHit, type PlanStatus } from './planUsage/limitReadings'
import { deriveSessionLanguage } from './language'
import { computeEditStats } from './editStats'
import { segmentClaudeTurns, type ClaudeTurnSpan } from './claudeTurns'
import { traceKey, derivedTraceKey, SOURCE_RANK_FULL_TRANSCRIPT, SOURCE_RANK_PARTIAL } from './traceIdentity'
import { observeAntigravity, observeOpenCodeDb, observeRecords, type FileObservation } from './adapters/classify'
import { decodeExecutor, decodeGeneration, executorModelFor, resolveModel, type AntigravityExecutor, type AntigravityUsage } from './adapters/antigravity/proto'
import { ANTIGRAVITY_STEP_USER_INPUT } from './adapters/antigravity/known'

// ── Cross-platform home resolution ────────────────────────────────────────────

function homeDir(): string {
  return os.homedir()
}

function claudeProjectsDirs(): string[] {
  // Env override: comma-separated list of Claude config dirs (each must have a projects/ sub-dir).
  const envVal = process.env['CLAUDE_CONFIG_DIR']
  if (envVal) {
    return envVal.split(',').map(p => p.trim()).filter(Boolean)
      .map(p => (p.endsWith('projects') ? p : path.join(p, 'projects')))
  }

  const home = homeDir()
  const candidates: string[] = [path.join(home, '.claude', 'projects')]

  // Windows: Claude Code uses %APPDATA%\Claude\projects
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData) candidates.unshift(path.join(appData, 'Claude', 'projects'))
  } else {
    // XDG_CONFIG_HOME on Linux/Mac
    const xdg = process.env['XDG_CONFIG_HOME']
    if (xdg) candidates.push(path.join(xdg, 'claude', 'projects'))
  }

  return candidates.filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
}

/** Where Codex keeps rollouts: each Codex home's `sessions/` (YYYY/MM/DD/rollout-*.jsonl), plus
 *  its `archived_sessions/` (flat) when there is one — where Codex moves a session it archives.
 *  Same file, same turn ids: an archived session keeps its traces rather than gaining copies. */
function codexSessionsDirs(): string[] {
  const isDir = (d: string) => { try { return fs.statSync(d).isDirectory() } catch { return false } }
  const withArchive = (sessionsDirs: string[]) => sessionsDirs.flatMap(d => {
    const archive = path.join(path.dirname(d), 'archived_sessions')
    return isDir(archive) ? [d, archive] : [d]
  })
  const envVal = process.env['CODEX_HOME']
  if (envVal) {
    return withArchive(envVal.split(',').map(p => p.trim()).filter(Boolean)
      .map(p => path.join(p, 'sessions')))
  }
  return withArchive(codexHomeSessionsDirs().filter(isDir))
}

function codexHomeSessionsDirs(): string[] {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    const appData = process.env['APPDATA']
    if (local) candidates.push(path.join(local, 'Codex', 'sessions'))
    if (appData) candidates.push(path.join(appData, 'Codex', 'sessions'))
  }
  candidates.push(path.join(homeDir(), '.codex', 'sessions'))
  return candidates
}

function openCodeDataDirs(): string[] {
  const envVal = process.env['OPENCODE_DATA_DIR']
  if (envVal) {
    return envVal.split(',').map(p => p.trim()).filter(Boolean)
      .filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
  }
  const home = homeDir()
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData) candidates.push(path.join(appData, 'opencode'))
  } else {
    const xdgData = process.env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share')
    candidates.push(path.join(xdgData, 'opencode'))
  }
  return candidates.filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
}

function cursorAgentProjectsDirs(): string[] {
  const home = homeDir()
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData) candidates.push(path.join(appData, 'Cursor', 'projects'))
  } else {
    const xdg = process.env['XDG_CONFIG_HOME']
    if (xdg) candidates.push(path.join(xdg, 'cursor', 'projects'))
  }
  candidates.push(path.join(home, '.cursor', 'projects'))
  return candidates.filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
}

/** Walks `<projectsDir>/<sanitized-workspace>/agent-transcripts/<uuid>/<uuid>.jsonl` across every
 *  cursorAgentProjectsDirs() root. Three levels deep — deeper than every other source — because
 *  Cursor CLI groups transcripts by workspace directory first, unlike Claude/Codex which put
 *  session files directly under one project folder. */
function collectCursorTranscriptFiles(): string[] {
  const files: string[] = []
  for (const projectsDir of cursorAgentProjectsDirs()) {
    let projectDirs: string[]
    try { projectDirs = fs.readdirSync(projectsDir) } catch { continue }
    for (const projectDir of projectDirs) {
      const transcriptsDir = path.join(projectsDir, projectDir, 'agent-transcripts')
      let sessionDirs: string[]
      try { sessionDirs = fs.readdirSync(transcriptsDir) } catch { continue }
      for (const sessionDir of sessionDirs) {
        const f = path.join(transcriptsDir, sessionDir, `${sessionDir}.jsonl`)
        try { if (fs.statSync(f).isFile()) files.push(f) } catch { /* skip */ }
      }
    }
  }
  return files
}

/** Antigravity CLI (`agy`) roots: `~/.gemini/antigravity-cli/` on every OS (agy resolves it from
 *  the home directory, `%USERPROFILE%` on Windows). Override: ANTIGRAVITY_CLI_DIR (comma-separated
 *  roots — the name agentsview uses; agy itself has no relocation variable on record). Only the
 *  CLI's tree: the Antigravity app/IDE trees (`~/.gemini/antigravity`, `antigravity-ide`) and the
 *  `antigravity-backup` copy are never read. */
function antigravityCliRoots(): string[] {
  const isDir = (d: string) => { try { return fs.statSync(d).isDirectory() } catch { return false } }
  const envVal = process.env['ANTIGRAVITY_CLI_DIR']
  if (envVal) return envVal.split(',').map(p => p.trim()).filter(Boolean).filter(isDir)
  return [path.join(homeDir(), '.gemini', 'antigravity-cli')].filter(isDir)
}

/** One Antigravity CLI conversation: its brain transcript and/or its SQLite database. */
export interface AntigravityConversation {
  root: string
  id: string
  /** `brain/<id>/.system_generated/logs/transcript.jsonl`, null when absent. */
  transcript: string | null
  /** `conversations/<id>.db`, null when absent (a `.pb`-only or not-yet-flushed conversation). */
  db: string | null
}

const ANTIGRAVITY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

function antigravityTranscriptPath(root: string, id: string): string {
  return path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
}

/** Every conversation under every antigravityCliRoots() root: the union of brain transcripts and
 *  `conversations/*.db` by id. Encrypted `*.pb` streams, `implicit/` and third-party
 *  `*.trajectory.json` decodes are ignored. */
function collectAntigravityConversations(): AntigravityConversation[] {
  const out: AntigravityConversation[] = []
  const isFile = (f: string) => { try { return fs.statSync(f).isFile() } catch { return false } }
  for (const root of antigravityCliRoots()) {
    const byId = new Map<string, AntigravityConversation>()
    let brainDirs: string[] = []
    try { brainDirs = fs.readdirSync(path.join(root, 'brain')) } catch { /* no brain dir */ }
    for (const id of brainDirs) {
      if (!ANTIGRAVITY_ID_RE.test(id)) continue
      const t = antigravityTranscriptPath(root, id)
      if (isFile(t)) byId.set(id, { root, id, transcript: t, db: null })
    }
    let convFiles: string[] = []
    try { convFiles = fs.readdirSync(path.join(root, 'conversations')) } catch { /* no conversations dir */ }
    for (const name of convFiles) {
      if (!name.endsWith('.db')) continue
      const id = name.slice(0, -3)
      if (!ANTIGRAVITY_ID_RE.test(id)) continue
      const db = path.join(root, 'conversations', name)
      if (!isFile(db)) continue
      const c = byId.get(id)
      if (c) c.db = db
      else byId.set(id, { root, id, transcript: null, db })
    }
    out.push(...byId.values())
  }
  return out
}

/** The conversation a tracked Antigravity path names — its transcript, or its database when it
 *  has no transcript (the unit collectFileMeta lists). */
function antigravityConversationOf(filePath: string): AntigravityConversation | null {
  if (filePath.endsWith('.db')) {
    const id = path.basename(filePath, '.db')
    const root = path.dirname(path.dirname(filePath))
    if (!ANTIGRAVITY_ID_RE.test(id)) return null
    const t = antigravityTranscriptPath(root, id)
    let transcript: string | null = null
    try { if (fs.statSync(t).isFile()) transcript = t } catch { /* none */ }
    return { root, id, transcript, db: filePath }
  }
  if (path.basename(filePath) !== 'transcript.jsonl') return null
  const convDir = path.dirname(path.dirname(path.dirname(filePath)))  // brain/<id>
  const id = path.basename(convDir)
  const root = path.dirname(path.dirname(convDir))
  if (!ANTIGRAVITY_ID_RE.test(id)) return null
  const dbPath = path.join(root, 'conversations', `${id}.db`)
  let db: string | null = null
  try { if (fs.statSync(dbPath).isFile()) db = dbPath } catch { /* none */ }
  return { root, id, transcript: filePath, db }
}

/** What change detection sees of one conversation: the unit file (transcript, else database), its
 *  size, the newest mtime over the transcript, the database and a WAL that holds frames (`-shm` is
 *  transient and ignored), and the bytes a read would load. history.jsonl is shared by every
 *  conversation, so it is re-read when a conversation changes, not tracked per conversation. */
function antigravityState(c: AntigravityConversation): { unit: string; size: number; mtimeMs: number; totalBytes: number } | null {
  const stat = (f: string | null) => { if (!f) return null; try { return fs.statSync(f) } catch { return null } }
  const t = stat(c.transcript), d = stat(c.db), w = c.db ? stat(c.db + '-wal') : null
  const unitStat = t ?? d
  if (!unitStat) return null
  const walLive = w && w.size > 32 ? w : null
  return {
    unit: t ? c.transcript! : c.db!,
    size: unitStat.size,
    mtimeMs: Math.max(t?.mtimeMs ?? 0, d?.mtimeMs ?? 0, walLive?.mtimeMs ?? 0),
    totalBytes: (t?.size ?? 0) + (d?.size ?? 0) + (walLive?.size ?? 0),
  }
}

/** Claude Code transcripts named by a session id: <projects>/<project>/<sessionId>.jsonl in every
 *  claudeProjectsDirs() root — how an OTEL interaction finds its transcript (claudeTurnJoin.ts). */
export function findClaudeTranscripts(claudeSessionId: string): string[] {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(claudeSessionId)) return []
  const files: string[] = []
  for (const projectsDir of claudeProjectsDirs()) {
    let projects: string[]
    try { projects = fs.readdirSync(projectsDir) } catch { continue }
    for (const project of projects) {
      const f = path.join(projectsDir, project, `${claudeSessionId}.jsonl`)
      try { if (fs.statSync(f).isFile()) files.push(f) } catch { /* not this project */ }
    }
  }
  return files
}

function copilotSessionStateDir(): string | null {
  // Copilot CLI writes session logs to ~/.copilot/session-state/<uuid>/events.jsonl
  // automatically, with no env setup required.
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData) candidates.push(path.join(appData, 'copilot', 'session-state'))
  }
  candidates.push(path.join(homeDir(), '.copilot', 'session-state'))
  return candidates.find(d => { try { return fs.statSync(d).isDirectory() } catch { return false } }) ?? null
}

function vscodeFamilyWorkspaceStorageRoots(): string[] {
  // Returns all existing workspaceStorage directories across every known
  // VS Code-family IDE (see VSCODE_FAMILY_IDE_NAMES). Copilot Chat and other
  // VS Code extensions always write chatSessions under the host IDE's directory,
  // so scanning all of them covers Cursor, Windsurf, VSCodium, Trae, Kiro, etc.
  const home = homeDir()
  const candidates: string[] = []

  for (const name of VSCODE_FAMILY_IDE_NAMES) {
    switch (process.platform) {
      case 'win32': {
        const appData = process.env['APPDATA']
        if (appData) candidates.push(path.join(appData, name, 'User', 'workspaceStorage'))
        break
      }
      case 'darwin':
        candidates.push(path.join(home, 'Library', 'Application Support', name, 'User', 'workspaceStorage'))
        break
      default: {
        const xdg = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config')
        candidates.push(path.join(xdg, name, 'User', 'workspaceStorage'))
        break
      }
    }
  }

  return candidates.filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
}

// ── File state tracking ───────────────────────────────────────────────────────

/** How long a Codex rollout must have sat still before a turn with no turn_id is taken as one the
 *  rollout will never give an id to (see LogReader._parseCodexFile). */
export const CODEX_TURN_ID_SETTLE_MS = 2_000

export interface FileState {
  bytesRead: number
  mtimeMs: number
  /** The trace keys the file's last complete read produced (see LogReader.takeRetiredKeys).
   *  Persisted with the rest of the state so a key the file stops producing after a restart is
   *  still noticed. */
  keys?: string[]
}

// Line cache for incremental reads of growing transcripts (LogReader._readNewLines): only files
// modified within LINE_CACHE_RECENT_MS are cached (historical files are read once at startup and
// never again), within a total budget of LINE_CACHE_MAX_BYTES of file content.
const LINE_CACHE_MAX_BYTES = 32 * 1024 * 1024
const LINE_CACHE_RECENT_MS = 60 * 60 * 1000
const LINE_CACHE_PROBE_BYTES = 256

/**
 * Largest log file the reader will load into memory (a transcript, a Copilot chat snapshot, a
 * subagent transcript, or the OpenCode database plus its WAL). Files are read whole — a card is
 * built from the whole file every pass — and a multi-GB one (an agent looping for days, or a
 * planted file under ~/.claude/projects) would throw `RangeError`/OOM on every scan, forever,
 * because a failed read left no file state to say "don't retry". Above this, the file is skipped
 * with one warning, its state recorded so it isn't tried again until it changes. The real
 * transcripts seen so far are a few MB; 512 MB is far beyond any legitimate session.
 */
export const MAX_LOG_FILE_BYTES = 512 * 1024 * 1024

// ── Public interface ──────────────────────────────────────────────────────────

/** Minimal sql.js surface needed to open an external SQLite file read-only. */
export interface OpenCodeSqlFactory {
  Database: new (data: Buffer | Uint8Array) => {
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
    close(): void
  }
}

/** Agents whose transcripts record token usage on every answered turn (see _flushObservation). */
const USAGE_IN_TRANSCRIPT = new Set(['claude', 'codex'])

function hasUsage(card: SessionSummaryCard): boolean {
  return card.inputTokens + card.outputTokens + card.cacheReadTokens + card.cacheCreateTokens > 0
}

export interface LogReaderOptions {
  log?: (msg: string) => void
  /** When provided, enables reading OpenCode sessions from its SQLite DB. */
  sqlFactory?: OpenCodeSqlFactory
  /** Overrides MAX_LOG_FILE_BYTES (tests). */
  maxFileBytes?: number
  /** Called with what each file just read held, by record class (adapters/classify.ts) — the
   *  whole file every time, so a caller replaces that file's previous observation — and the
   *  file's modification time. A complete read also reports how many turns the file produced
   *  (`obs.turns`), so a file whose records the parser couldn't turn into anything shows. */
  observe?: (filePath: string, obs: FileObservation, mtimeMs: number) => void
}

export interface LogSessionResult {
  card: SessionSummaryCard
  /** Workspace path extracted from the log file (cwd). May be empty for Copilot. */
  workspace: string
  /** Subscription plan-limit readings found in this session's log (Codex only today). Kept off the
   *  card on purpose: limit data comes only from logs, so it must survive an OTEL card replacing
   *  this one. Absent when there are none. */
  limitReadings?: LimitReading[]
  /** Plan limits hit during this session. Absent when there are none. */
  limitHits?: LimitHit[]
  /** The plan status from this session's last rate-limit event (Codex only). Absent when none. */
  planStatus?: PlanStatus
}

/** A subagent transcript folded into its parent turn (see LogReader._claudeSubagentsByTurn). */
interface ClaudeSubagent {
  parsed: unknown[]
}

/** Claude Code subagent transcripts: subagents/agent-*.jsonl (or agent-*.jsonl in older layouts). */
function isClaudeSubagentFile(filePath: string): boolean {
  return path.basename(filePath).startsWith('agent-')
}

/** SQL NULL (and an absent column) → null; anything else → its string form. */
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

export class LogReader {
  private readonly log: (msg: string) => void
  private readonly sqlFactory: OpenCodeSqlFactory | undefined
  private readonly fileState = new Map<string, FileState>()
  // Lines already read from actively-growing JSONL files, so a re-scan reads only appended
  // bytes — see _readNewLines. LRU (Map insertion order), bounded by LINE_CACHE_MAX_BYTES.
  private readonly lineCache = new Map<string, { offset: number; lines: string[]; probe: Buffer }>()
  private lineCacheBytes = 0
  // Root-level agent-*.jsonl → the parent session its lines name (see _claudeAgentFileSessionId).
  private readonly agentFileSessionIds = new Map<string, { mtimeMs: number; size: number; sessionId: string }>()
  // filePath → turn key → fingerprint of the last card emitted for it — see _onlyChanged.
  private readonly emittedTurns = new Map<string, Map<string, string>>()
  // filePath → the trace keys its last complete read produced, and the keys no file produces any
  // more, waiting for takeRetiredKeys — see _onlyChanged.
  private readonly fileKeys = new Map<string, Set<string>>()
  private retiredKeys = new Set<string>()
  // The file the current parse actually read (set by _readNewLines/_readJsonFile on success) and
  // its mtime, so a read that failed is never mistaken for a file that now produces no turns.
  private lastRead: string | null = null
  private lastReadMtimeMs = 0
  // Files skipped for exceeding MAX_LOG_FILE_BYTES, so each is warned about once (see _tooLarge).
  private readonly oversizeWarned = new Set<string>()
  private readonly maxFileBytes: number
  private readonly observe: ((filePath: string, obs: FileObservation, mtimeMs: number) => void) | undefined
  // The observation _observe made of the file being parsed, held until _processFileMulti knows
  // how many turns the parse produced.
  private pendingObs: { filePath: string; logKey: string; obs: FileObservation; mtimeMs: number } | null = null

  constructor(options: LogReaderOptions = {}) {
    this.log = options.log ?? (() => { /* silent */ })
    this.sqlFactory = options.sqlFactory
    this.maxFileBytes = options.maxFileBytes ?? MAX_LOG_FILE_BYTES
    this.observe = options.observe
  }

  /** Hands one file's records to the `observe` option, classified against its adapter. `records`
   *  is a thunk so a file isn't parsed a second time when nobody is observing. */
  private _observe(filePath: string, logKey: string, records: () => readonly unknown[]): void {
    if (!this.observe) return
    this._flushObservation()
    try {
      const obs = observeRecords(logKey, records())
      if (obs) this.pendingObs = { filePath, logKey, obs, mtimeMs: this.lastReadMtimeMs }
    } catch (err) {
      this.log(`[LogReader] adapter health error ${filePath}: ${err}`)
    }
  }

  /** Hands the held observation over, with the turns the file gave (FileObservation.turns) only
   *  when the read was complete — a Codex rollout held for its turn ids, for one, isn't; it's
   *  read again next pass. Claude Code and Codex record token usage in every answered turn, so
   *  for them only turns that carry it count: a turn read without it lost what matters most. */
  private _flushObservation(read?: { filePath: string; results: readonly LogSessionResult[] }): void {
    const pending = this.pendingObs
    if (!pending || !this.observe) return
    this.pendingObs = null
    let obs = pending.obs
    if (read && read.filePath === pending.filePath) {
      const counted = USAGE_IN_TRANSCRIPT.has(pending.logKey) ? read.results.filter(r => hasUsage(r.card)) : read.results
      obs = { ...obs, turns: counted.length }
    }
    try { this.observe(pending.filePath, obs, pending.mtimeMs) } catch (err) { this.log(`[LogReader] adapter health error ${pending.filePath}: ${err}`) }
  }

  /** True (after recording the file's state so it isn't retried until it changes, and warning
   *  once) when `size` bytes is more than this reader will load — see MAX_LOG_FILE_BYTES. */
  private _tooLarge(filePath: string, size: number, mtimeMs: number): boolean {
    if (size <= this.maxFileBytes) return false
    this.fileState.set(filePath, { bytesRead: size, mtimeMs })
    this.lineCache.delete(filePath)
    if (!this.oversizeWarned.has(filePath)) {
      this.oversizeWarned.add(filePath)
      this.log(`[LogReader] Skipping ${filePath}: ${(size / 1024 / 1024).toFixed(0)} MB is over the ${(this.maxFileBytes / 1024 / 1024).toFixed(0)} MB limit for a single log file.`)
    }
    return true
  }

  /** Clears cached file state so the next scan re-reads all files from scratch. */
  clearFileState(): void {
    this.fileState.clear()
    this.lineCache.clear()
    this.lineCacheBytes = 0
    this.emittedTurns.clear()
    this.fileKeys.clear()
    this.retiredKeys.clear()
  }

  /** Plain-object snapshot of the per-file mtime/size cache, for a caller to persist to disk
   *  (a sidecar JSON file, e.g.) so the next process start can restore it via `importFileState`
   *  instead of re-parsing every historical log file from scratch (see logFileState.ts). */
  exportFileState(): Record<string, FileState> {
    const out: Record<string, FileState> = {}
    for (const [filePath, state] of this.fileState) {
      const keys = this.fileKeys.get(filePath)
      out[filePath] = keys && keys.size > 0 ? { bytesRead: state.bytesRead, mtimeMs: state.mtimeMs, keys: [...keys] } : { bytesRead: state.bytesRead, mtimeMs: state.mtimeMs }
    }
    // A file whose state was dropped to force a re-read (a Claude subagent changed, a Codex turn
    // held for its turn_id) keeps its keys, under a state that never matches, so the next process
    // re-reads it and still notices any key it stopped producing.
    for (const [filePath, keys] of this.fileKeys) {
      if (!(filePath in out) && keys.size > 0) out[filePath] = { bytesRead: -1, mtimeMs: -1, keys: [...keys] }
    }
    return out
  }

  /** Restores a snapshot from `exportFileState`. Merges into (does not clear) any state already
   *  present — call before the first `scan()`/`parseFile()` of a process, while `fileState` is
   *  still empty, so a restored entry causes an unchanged file to be skipped exactly like it
   *  would have been within the same still-running process. */
  importFileState(snapshot: Record<string, FileState>): void {
    for (const [filePath, state] of Object.entries(snapshot)) {
      this.fileState.set(filePath, { bytesRead: state.bytesRead, mtimeMs: state.mtimeMs })
      if (state.keys && state.keys.length > 0) this.fileKeys.set(filePath, new Set(state.keys))
    }
  }

  /**
   * The trace keys that a re-read file stopped producing — and that no other file still produces
   * (a resumed or forked transcript can carry the same turn) — since the last call. A host removes
   * them from its store: a key is a pure function of what the file says, so one the file no longer
   * yields (a turn read before its prompt line was written, a turn whose boundaries moved) names
   * no turn any more. Kept out of the store, it drops out of the trace manifest too, and the cloud
   * retires the row it was sent under. Nothing from a read that failed: that file's keys stay.
   */
  takeRetiredKeys(): string[] {
    if (this.retiredKeys.size === 0) return []
    const out = [...this.retiredKeys].filter(k => ![...this.fileKeys.values()].some(keys => keys.has(k)))
    this.retiredKeys = new Set()
    return out
  }

  /**
   * Collects all session files across all agents. Does NOT read file contents. Used by the
   * startup batch-loader to process files without one big synchronous block.
   * `minMtimeMs` leaves out files last modified before it (the standalone server's retention
   * cutoff — standalone/sessionRetention.ts); the extension applies its retention to its database
   * instead and passes nothing.
   */
  collectFileMeta(opts: { minMtimeMs?: number } = {}): Array<{ filePath: string; mtimeMs: number; agentKey: string }> {
    const entries: Array<{ filePath: string; mtimeMs: number; agentKey: string }> = []

    // Claude
    for (const projectsDir of claudeProjectsDirs()) {
      for (const filePath of this._collectJsonlFiles(projectsDir)) {
        // A subagent transcript is folded into its parent's turn, never parsed on its own.
        if (isClaudeSubagentFile(filePath)) continue
        try { entries.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs, agentKey: 'claude' }) } catch { /* skip */ }
      }
    }
    // Codex
    for (const sessionsDir of codexSessionsDirs()) {
      for (const filePath of this._collectJsonlFiles(sessionsDir)) {
        try { entries.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs, agentKey: 'codex' }) } catch { /* skip */ }
      }
    }
    // Copilot CLI session-state
    const stateDir = copilotSessionStateDir()
    if (stateDir) {
      try {
        for (const d of fs.readdirSync(stateDir)) {
          const f = path.join(stateDir, d, 'events.jsonl')
          try { entries.push({ filePath: f, mtimeMs: fs.statSync(f).mtimeMs, agentKey: 'copilot' }) } catch { /* skip */ }
        }
      } catch { /* ignore */ }
    }

    // Copilot Chat (VS Code sidebar) — workspaceStorage/<hash>/chatSessions/
    // Two file formats exist: <uuid>.jsonl (delta log, newer) and <uuid>.json (full snapshot, older).
    // Prefer .jsonl; skip a .json file when a .jsonl sibling exists for the same session UUID.
    // Build a Set from the directory listing to avoid per-file fs.existsSync calls.
    for (const root of vscodeFamilyWorkspaceStorageRoots()) {
      try {
        for (const hashDir of fs.readdirSync(root)) {
          const chatDir = path.join(root, hashDir, 'chatSessions')
          let names: string[]
          try { names = fs.readdirSync(chatDir) } catch { continue }
          const jsonlIds = new Set(names.filter(n => n.endsWith('.jsonl')).map(n => n.slice(0, -6)))
          for (const name of names) {
            if (name.endsWith('.jsonl')) {
              const f = path.join(chatDir, name)
              try { entries.push({ filePath: f, mtimeMs: fs.statSync(f).mtimeMs, agentKey: 'copilot_vscode' }) } catch { /* skip */ }
            } else if (name.endsWith('.json') && !jsonlIds.has(name.slice(0, -5))) {
              const f = path.join(chatDir, name)
              try { entries.push({ filePath: f, mtimeMs: fs.statSync(f).mtimeMs, agentKey: 'copilot_vscode_json' }) } catch { /* skip */ }
            }
          }
        }
      } catch { /* root not accessible */ }
    }

    // OpenCode — one entry per data dir (the DB file itself is the tracked unit)
    for (const dataDir of openCodeDataDirs()) {
      const dbPath = path.join(dataDir, 'opencode.db')
      try { entries.push({ filePath: dbPath, mtimeMs: fs.statSync(dbPath).mtimeMs, agentKey: 'opencode' }) } catch { /* skip */ }
    }

    // Cursor CLI (cursor-agent)
    for (const filePath of collectCursorTranscriptFiles()) {
      try { entries.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs, agentKey: 'cursor' }) } catch { /* skip */ }
    }

    // Antigravity CLI — one entry per conversation: its transcript, else its database, at the
    // newest mtime over both (and the WAL), the state parseFile records.
    for (const c of collectAntigravityConversations()) {
      const st = antigravityState(c)
      if (st) entries.push({ filePath: st.unit, mtimeMs: st.mtimeMs, agentKey: 'antigravity' })
    }

    const min = opts.minMtimeMs
    if (min !== undefined && min > 0) return entries.filter(e => e.mtimeMs >= min)

    // Newest first — caller processes in this order so recent sessions appear first.
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return entries
  }

  /**
   * Parses a single file identified by collectFileMeta() and returns one result per turn whose
   * card changed since the last scan (one turn = one trace — see claudeTurns.ts,
   * codexTurnRanges). Returns [] if the file is unchanged.
   */
  parseFile(filePath: string, agentKey: string): LogSessionResult[] {
    const sessionId = agentKey === 'copilot'
      ? path.basename(path.dirname(filePath))  // directory name is session UUID
      : agentKey === 'copilot_vscode_json'
        ? path.basename(filePath, '.json')
        : path.basename(filePath, '.jsonl')

    switch (agentKey) {
      case 'claude':
        if (isClaudeSubagentFile(filePath)) return []
        this._invalidateIfClaudeSubagentsChanged(filePath)
        return this._processFileMulti(filePath, () => this._parseClaudeFile(filePath))
      case 'codex':               return this._processFileMulti(filePath, () => this._parseCodexFile(filePath))
      case 'copilot':             return this._processFileMulti(filePath, () => this._parseCopilotFile(filePath, sessionId))
      case 'copilot_vscode':      return this._processFileMulti(filePath, () => this._parseCopilotVSCodeFile(filePath))
      case 'copilot_vscode_json': return this._processFileMulti(filePath, () => this._parseCopilotVSCodeJsonFile(filePath, sessionId))
      case 'opencode':            return []  // OpenCode DB returns multiple sessions; use _scanOpenCode
      case 'cursor':              return this._processFileMulti(filePath, () => this._parseCursorFile(filePath))
      case 'antigravity': {
        const c = antigravityConversationOf(filePath)
        return c ? this._processAntigravity(c) : []
      }
      default:                    return []
    }
  }

  /** Returns all directories that should be watched for file changes. */
  getWatchDirs(): string[] {
    return [
      ...claudeProjectsDirs(),
      ...codexSessionsDirs(),
      ...((() => { const d = copilotSessionStateDir(); return d ? [d] : [] })()),
      ...vscodeFamilyWorkspaceStorageRoots(),
      ...openCodeDataDirs(),
      ...cursorAgentProjectsDirs(),
      ...antigravityCliRoots(),
    ]
  }

  /**
   * Scans all log directories and returns new/updated session results.
   * Files that are new or have changed since the last scan are re-parsed.
   */
  scan(): LogSessionResult[] {
    return [
      ...this._scanClaude(),
      ...this._scanCodex(),
      ...this._scanCopilot(),
      ...this._scanCopilotVSCode(),
      ...this._scanOpenCode(),
      ...this._scanCursor(),
      ...this._scanAntigravity(),
    ]
  }

  // ── Claude Code ─────────────────────────────────────────────────────────────

  private _scanClaude(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    for (const projectsDir of claudeProjectsDirs()) {
      this._collectJsonlFiles(projectsDir).forEach(filePath => {
        if (isClaudeSubagentFile(filePath)) return
        this._invalidateIfClaudeSubagentsChanged(filePath)
        results.push(...this._processFileMulti(filePath, () => this._parseClaudeFile(filePath)))
      })
    }
    return results
  }

  /** Reads a Claude Code transcript and returns one result per turn — see claudeTurns.ts for
   *  where a turn starts, and dedupeByUuid for why duplicate lines are dropped first. Each turn is
   *  keyed by its `promptId` (traceKey('claude', promptId)); a transcript from before Claude Code
   *  stamped promptIds gets derived keys. The turn's subagent transcripts (subagents/agent-*.jsonl)
   *  are folded into it — usage, tool calls and files — and never get a key of their own. */
  private _parseClaudeFile(filePath: string): LogSessionResult[] {
    const rawLines = this._readNewLines(filePath)
    if (!rawLines) return []
    // Every line is JSON.parse'd once here and the parsed rows are shared by the dedupe, the
    // turn segmentation and the per-turn parser.
    const { lines, parsed } = dedupeParsedByUuid(rawLines, rawLines.map(parseLogLine))
    this._observe(filePath, 'claude', () => parsed)

    const baseSessionId = path.basename(filePath, '.jsonl')
    const turns = segmentClaudeTurns(parsed)
    if (turns.length === 0) return []
    const subagentsByTurn = this._claudeSubagentsByTurn(filePath, baseSessionId, turns)

    const results: LogSessionResult[] = []
    for (let t = 0; t < turns.length; t++) {
      const turn = turns[t]
      const key = turn.exact ? traceKey('claude', turn.turnId) : derivedTraceKey('claude', baseSessionId, turn.turnId)
      const subagents = subagentsByTurn.get(t) ?? []
      const result = this._parseClaudeTurn(
        turn.indices.map(i => lines[i]), turn.indices.map(i => parsed[i]), key,
        (parsed[turn.opening] as Record<string, unknown>)['timestamp'] as string | undefined, subagents,
      )
      if (!result) continue
      const card = result.card
      // Every turn of a file is one conversation — the conversation marker groups by it.
      card.conversationId = baseSessionId
      if (!turn.exact) card.derived = true
      if (subagents.length > 0) card.subagentCount = subagents.length
      results.push(result)
    }
    return results
  }

  /** `parsed[i]` is `lines[i]` already JSON.parse'd (undefined when it doesn't parse). */
  private _parseClaudeTurn(
    lines: string[],
    parsed: unknown[],
    sessionId: string,
    openingTimestamp: string | undefined,
    subagents: ClaudeSubagent[] = [],
  ): LogSessionResult | null {
    let workspace = ''
    let claudeSessionId = ''
    let gitBranch = ''
    let model = ''
    let firstTimestamp = openingTimestamp ?? ''
    let lastTimestamp = ''
    let userRequest = ''
    let taskNotificationFallback = ''
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0
    let peakContextPerTurn = 0
    let turns = 0, totalToolCalls = 0
    let hasFastMode = false
    // Sessions can mix models (subagents on a cheaper model, or a mid-session /model
    // switch) — track token volume per model so the card can report the dominant one
    // instead of whichever model happened to answer last.
    const modelTokens = new Map<string, number>()
    const filesChanged = new Set<string>()
    const filesWritten = new Set<string>()
    const filesRead    = new Set<string>()
    const toolCounts: Record<string, number> = {}
    const timeline: TimelineEntry[] = []
    let idx = 0
    let initiator: 'user' | 'agent' | 'api' = 'user'
    const limitHits: LimitHit[] = []
    // Span ids name blob files (database/writer.ts), so they must be unique across traces: the
    // line's own uuid when it has one, else this trace's key plus a position.
    const spanIdFor = (kind: 'u' | 'a', entry: Record<string, unknown>) =>
      typeof entry['uuid'] === 'string' && entry['uuid'] ? `log-${kind}-${entry['uuid']}` : `log-${kind}-${sessionId.slice(0, 8)}-${idx}`

    const addAssistant = (entry: Record<string, unknown>, ts: string | undefined, billable: boolean, subagent: boolean) => {
      const msg = entry['message'] as Record<string, unknown> | undefined
      // Limit refusals and API errors Claude Code writes itself carry model '<synthetic>' and
      // zero usage: not an LLM call, so they don't set the model or count as a turn.
      const synthetic = msg?.['model'] === CLAUDE_SYNTHETIC_MODEL
      if (synthetic) {
        const hit = claudeLimitHit(entry, sessionId)
        if (hit) limitHits.push(hit)
      }
      let lineModel = model
      if (msg?.['model'] && !synthetic) {
        lineModel = msg['model'] as string
        if (!subagent) model = lineModel
      }
      const rawUsage = msg?.['usage'] as Record<string, unknown> | undefined
      if (rawUsage?.['speed'] === 'fast' && !subagent) hasFastMode = true
      const usage = tokenUsage(rawUsage)
      let msgTotalInput = 0, msgCacheRead = 0, msgCacheCreate = 0, msgOutput = 0
      if (usage && billable && !synthetic) {
        const inp  = usage['input_tokens']                ?? 0
        const cr   = usage['cache_read_input_tokens']     ?? 0
        const cc   = usage['cache_creation_input_tokens'] ?? 0
        msgTotalInput = inp + cr + cc
        msgCacheRead = cr
        msgCacheCreate = cc
        msgOutput = usage['output_tokens'] ?? 0
        totalInput       += inp
        totalOutput      += msgOutput
        totalCacheRead   += cr
        totalCacheCreate += cc
        const turnContext = inp + cr + cc
        if (turnContext > peakContextPerTurn) peakContextPerTurn = turnContext
        turns++
        if (lineModel) {
          modelTokens.set(lineModel, (modelTokens.get(lineModel) ?? 0) + msgTotalInput + msgOutput)
        }
      }
      const content = (msg?.['content'] as Array<Record<string, unknown>>) ?? []
      let hasToolCall = false
      const msgEditDetails: EditDetail[] = []
      for (const block of content) {
        if (block['type'] === 'tool_use' && block['name']) {
          hasToolCall = true; totalToolCalls++
          const name = block['name'] as string
          toolCounts[name] = (toolCounts[name] ?? 0) + 1
          const inp = (block['input'] ?? {}) as Record<string, unknown>
          const fp  = String(inp['file_path'] ?? inp['filePath'] ?? inp['path'] ?? '')
          if (fp) {
            if (name === 'Read' || name === 'read_file') filesRead.add(fp)
            else if (['Edit','MultiEdit','replace_string_in_file','NotebookEdit'].includes(name)) filesChanged.add(fp)
            else if (name === 'Write' || name === 'create_file') { filesChanged.add(fp); filesWritten.add(fp) }
          }
          if (name === 'MultiEdit' && Array.isArray(inp['edits'])) {
            for (const e of inp['edits'] as Array<Record<string, unknown>>) {
              const efp = e['file_path'] ?? e['filePath'] ?? fp
              if (efp) {
                msgEditDetails.push({
                  filePath: String(efp),
                  toolName: 'Edit',
                  oldString: _strOrUndef(e['old_string'] ?? e['oldString']),
                  newString: _strOrUndef(e['new_string'] ?? e['newString']),
                })
              }
            }
          } else if (fp && ['Edit','replace_string_in_file','NotebookEdit','Write','create_file'].includes(name)) {
            msgEditDetails.push({
              filePath: fp,
              toolName: name,
              oldString: _strOrUndef(inp['old_string'] ?? inp['oldString']),
              newString: _strOrUndef(inp['new_string'] ?? inp['newString']),
              content: _strOrUndef(inp['content']),
            })
          }
        }
      }
      const responseText = (content.find(b => b['type'] === 'text') as Record<string,string> | undefined)?.['text']
      const label = hasToolCall ? 'Tool calls' : 'Response'
      timeline.push({
        type: hasToolCall ? 'tool' : 'llm',
        spanId: spanIdFor('a', entry),
        label: subagent ? `Subagent: ${label}` : label,
        model: lineModel || undefined,
        inputTokens: msgTotalInput || undefined,
        outputTokens: msgOutput || undefined,
        cacheReadTokens: msgCacheRead || undefined,
        cacheCreateTokens: msgCacheCreate || undefined,
        durationMs: 0,
        isError: false,
        timestamp: ts ?? '',
        responseText,
        editDetails: msgEditDetails.length > 0 ? msgEditDetails : undefined,
      })
      idx++
    }

    const usageLines = claudeUsageRows(parsed)
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (parsed[lineIndex] === undefined) continue
      const entry = parsed[lineIndex] as Record<string, unknown>

      const ts = entry['timestamp'] as string | undefined
      if (ts) { if (!firstTimestamp) firstTimestamp = ts; lastTimestamp = ts }
      if (entry['cwd'] && !workspace) workspace = entry['cwd'] as string
      if (typeof entry['sessionId'] === 'string' && entry['sessionId']) claudeSessionId = entry['sessionId'] as string
      // The branch checked out when this turn ran (Claude Code writes it on every line).
      if (!gitBranch) gitBranch = recordedBranch(entry['gitBranch'])

      if (entry['type'] === 'user') {
        const content = (entry['message'] as Record<string, unknown>)?.['content']
        const text = _extractTextContent(content)
        // A sidechain line (an older transcript's inline subagent) is never the turn's prompt.
        if (!userRequest && text && entry['isSidechain'] !== true) {
          // <local-command-caveat> prefix → session started via `claude -p` (non-interactive API).
          if (initiator === 'user' && text.startsWith('<local-command-caveat>')) {
            initiator = 'api'
            const afterCaveat = text.replace(/^<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/i, '').trim()
            userRequest = afterCaveat || '[api session]'
          } else if (isTaskNotificationOnly(text)) {
            // A background Bash/Agent task result on a synthetic turn, not typed by a human —
            // keep scanning for a real prompt; remember a fallback in case none ever shows up.
            if (!taskNotificationFallback) taskNotificationFallback = summarizeTaskNotification(text)
          } else {
            userRequest = text
          }
        }
        timeline.push({ type: 'user_input', spanId: spanIdFor('u', entry), label: 'User', durationMs: 0, isError: false, timestamp: ts ?? '', responseText: text })
        idx++
      }

      if (entry['type'] === 'assistant') addAssistant(entry, ts, usageLines.has(lineIndex), false)
    }

    // Folded subagent transcripts: their LLM calls are this turn's (OTEL counts them under the
    // same interaction), so they add usage, tool calls, files and timeline entries — in time order.
    if (subagents.length > 0) {
      const own = timeline.length
      for (const sub of subagents) {
        const subUsage = claudeUsageRows(sub.parsed)
        sub.parsed.forEach((e, i) => {
          if (e === undefined) return
          const entry = e as Record<string, unknown>
          if (entry['type'] !== 'assistant') return
          const ts = entry['timestamp'] as string | undefined
          if (ts && ts > lastTimestamp) lastTimestamp = ts
          addAssistant(entry, ts, subUsage.has(i), true)
        })
      }
      if (timeline.length > own) {
        const ms = (t: TimelineEntry) => Date.parse(t.timestamp) || 0
        timeline.splice(0, timeline.length, ...timeline.map((t, i) => ({ t, i })).sort((a, b) => (ms(a.t) - ms(b.t)) || (a.i - b.i)).map(x => x.t))
      }
    }

    if (!firstTimestamp) return null
    if (!userRequest && taskNotificationFallback) {
      userRequest = taskNotificationFallback
      initiator = 'agent'
    }
    // Rank by token volume rather than reporting whichever model answered last;
    // the fast-mode suffix is a session-wide flag, so it's only applied to the
    // primary (highest-volume) model, matching the existing single-value behavior.
    const rankedModels = rankModelsByWeight(modelTokens)
    const primaryBase = rankedModels[0] || model
    // Strip a trailing date suffix (Anthropic's model field is often date-suffixed,
    // e.g. claude-opus-4-7-20260315) before appending -fast — otherwise the date
    // ends up in the middle of the string instead of at the end, where pricing.ts's
    // own date-stripping regex can no longer reach it, and the session silently
    // prices at the standard (non-fast) rate instead of the real fast-mode rate.
    const effectiveModel = (primaryBase && hasFastMode) ? `${stripDateSuffix(primaryBase)}-fast` : primaryBase
    const models = rankedModels.length > 0
      ? [effectiveModel || 'claude', ...rankedModels.slice(1)]
      : (effectiveModel ? [effectiveModel] : [])
    const card = _buildCard(sessionId, 'claude_code', effectiveModel || 'claude', firstTimestamp, lastTimestamp, { totalInput, totalOutput, totalCacheRead, totalCacheCreate, peakContextPerTurn, turns, totalToolCalls, toolCounts, filesRead, filesChanged, filesWritten, filesSearched: new Set(), userRequest, timeline, initiator }, workspace, models)
    // Claude Code's own session id — equal to the file name for a main transcript. Shared with
    // its OTEL spans' session.id, which is how claudeTurnJoin.ts finds this transcript.
    if (claudeSessionId) card.claudeSessionId = claudeSessionId
    if (gitBranch) card.gitBranch = gitBranch
    card.sourceRank = turns > 0 ? SOURCE_RANK_FULL_TRANSCRIPT : SOURCE_RANK_PARTIAL
    const hits = dedupeHits(limitHits)
    return { workspace, card, ...(hits.length > 0 ? { limitHits: hits } : {}) }
  }

  /** The subagent transcripts of `parentPath` (Claude Code's subagents/agent-*.jsonl beside it, or
   *  an older install's agent-*.jsonl next to it whose lines name this session), each assigned to
   *  the turn that spawned it: the turn whose promptId its lines carry, else the last turn that
   *  started at or before its first line. Records each file's state so a later change to it
   *  re-parses the parent (see _invalidateIfClaudeSubagentsChanged). */
  private _claudeSubagentsByTurn(parentPath: string, baseSessionId: string, turns: ClaudeTurnSpan[]): Map<number, ClaudeSubagent[]> {
    const byTurn = new Map<number, ClaudeSubagent[]>()
    const turnByPromptId = new Map(turns.flatMap((t, i) => t.exact ? [[t.turnId, i] as const] : []))
    for (const file of this._claudeSubagentFiles(parentPath, baseSessionId)) {
      let raw: string
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
        if (this._tooLarge(file, stat.size, stat.mtimeMs)) continue
        raw = fs.readFileSync(file, 'utf-8')
      } catch { continue }
      this.fileState.set(file, { bytesRead: stat.size, mtimeMs: stat.mtimeMs })
      const rawLines = raw.split('\n').filter(l => l.trim())
      const { parsed } = dedupeParsedByUuid(rawLines, rawLines.map(parseLogLine))
      let firstMs = 0
      let turnIndex: number | undefined
      for (const e of parsed) {
        if (e === undefined) continue
        const entry = e as Record<string, unknown>
        const pid = typeof entry['promptId'] === 'string' ? entry['promptId'] : ''
        if (turnIndex === undefined && pid && turnByPromptId.has(pid)) turnIndex = turnByPromptId.get(pid)
        const ms = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : NaN
        if (!firstMs && Number.isFinite(ms)) firstMs = ms
      }
      if (turnIndex === undefined) {
        turnIndex = 0
        for (let i = 0; i < turns.length; i++) if (turns[i].startMs > 0 && turns[i].startMs <= firstMs) turnIndex = i
      }
      const list = byTurn.get(turnIndex) ?? []
      list.push({ parsed })
      byTurn.set(turnIndex, list)
    }
    return byTurn
  }

  private _claudeSubagentFiles(parentPath: string, baseSessionId: string): string[] {
    const files: string[] = []
    const dir = path.dirname(parentPath)
    const subDir = path.join(dir, baseSessionId, 'subagents')
    try {
      for (const name of fs.readdirSync(subDir)) {
        if (name.startsWith('agent-') && name.endsWith('.jsonl')) files.push(path.join(subDir, name))
      }
    } catch { /* no subagents directory */ }
    // An older layout kept agent-*.jsonl beside the parent; its lines carry the parent's sessionId.
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue
        const file = path.join(dir, name)
        if (this._claudeAgentFileSessionId(file) === baseSessionId) files.push(file)
      }
    } catch { /* directory gone */ }
    return files
  }

  /** The `sessionId` the first lines of a root-level agent-*.jsonl name — cached per file state. */
  private _claudeAgentFileSessionId(file: string): string {
    let stat: fs.Stats
    try { stat = fs.statSync(file) } catch { return '' }
    const cached = this.agentFileSessionIds.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.sessionId
    let sessionId = ''
    try {
      const fd = fs.openSync(file, 'r')
      try {
        const buf = Buffer.alloc(Math.min(stat.size, 64 * 1024))
        fs.readSync(fd, buf, 0, buf.length, 0)
        for (const line of buf.toString('utf-8').split('\n')) {
          const e = parseLogLine(line) as Record<string, unknown> | undefined
          if (e && typeof e['sessionId'] === 'string' && e['sessionId']) { sessionId = e['sessionId']; break }
        }
      } finally { fs.closeSync(fd) }
    } catch { /* unreadable */ }
    this.agentFileSessionIds.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, sessionId })
    return sessionId
  }

  /** A subagent transcript can grow while its parent's file doesn't; forget the parent's state
   *  when any of its subagent files changed so the next pass re-parses (cheaply — lineCache). */
  private _invalidateIfClaudeSubagentsChanged(parentPath: string): void {
    if (!this.fileState.has(parentPath)) return
    const base = path.basename(parentPath, '.jsonl')
    for (const file of this._claudeSubagentFiles(parentPath, base)) {
      const prev = this.fileState.get(file)
      try {
        const stat = fs.statSync(file)
        if (!prev || prev.mtimeMs !== stat.mtimeMs || prev.bytesRead !== stat.size) {
          this.fileState.delete(parentPath)
          return
        }
      } catch { /* vanished */ }
    }
  }

  // ── Codex ───────────────────────────────────────────────────────────────────

  private _scanCodex(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    for (const sessionsDir of codexSessionsDirs()) {
      this._collectJsonlFiles(sessionsDir).forEach(filePath => {
        results.push(...this._processFileMulti(filePath, () => this._parseCodexFile(filePath)))
      })
    }
    return results
  }

  /** Reads a Codex CLI rollout and returns one result per turn. A turn opens at a `user_message`
   *  (or, from 0.167, a `UserMessage` item_completed — codexPromptText)
   *  (walked back over the near-simultaneous bookkeeping lines logged just before it — see
   *  WALKBACK_EPSILON_MS) and is keyed by Codex's own `turn_id` (task_started / turn_context):
   *  traceKey('codex', turn_id), the same key the Codex OTEL card gets from its spans' turn id. A
   *  user_message that lands inside a running turn (same turn_id) opens nothing. A rollout from
   *  before Codex logged turn ids gets derived keys (conversation id + the prompt's timestamp).
   *  Verify at scale: turn_id equality between rollouts and OTEL spans rests on one sample.
   *
   *  Codex's token_count events report a total_token_usage that's cumulative for the *entire
   *  file*, not per-turn (confirmed on real data: input_tokens climbing monotonically across an
   *  8-day span), so _parseCodexSegment takes the previous turn's ending cumulative usage as a
   *  baseline and subtracts it; the baseline carries forward across turns with no token_count
   *  events of their own. */
  private _parseCodexFile(filePath: string): LogSessionResult[] {
    const lines = this._readNewLines(filePath)
    if (!lines) return []

    const baseSessionId = path.basename(filePath, '.jsonl')
    const parsed = lines.map(parseLogLine)
    this._observe(filePath, 'codex', () => parsed)
    const { id: rolloutId, cwd: fileWorkspace, branch: fileBranch } = codexSessionMeta(parsed)
    const conversationId = rolloutId || baseSessionId
    const results: LogSessionResult[] = []
    let runningTotalTokenUsage: Record<string, number> | undefined
    // Codex logs a turn's user_message before the task_started / turn_context line that carries
    // its turn_id. A rollout read in between has one turn with no id yet — a derived key the next
    // read replaces with traceKey('codex', turn_id). While the file is still fresh (written within
    // CODEX_TURN_ID_SETTLE_MS), such a turn is held: not emitted (so neither stored nor sent under
    // the derived key), and the file's state is dropped so the next scan reads it again. Once the
    // file has sat still that long, the turn is what the rollout says it is and goes out derived.
    const fresh = Date.now() - this.lastReadMtimeMs < CODEX_TURN_ID_SETTLE_MS
    let held = false
    for (const turn of codexTurnRanges(parsed)) {
      if (!turn.turnId && fresh) { held = true; continue }
      const key = turn.turnId ? traceKey('codex', turn.turnId) : derivedTraceKey('codex', conversationId, turn.openingTs)
      const segment = this._parseCodexSegment(lines.slice(turn.start, turn.end), key, runningTotalTokenUsage, fileWorkspace)
      if (segment.cumulativeUsage) runningTotalTokenUsage = segment.cumulativeUsage
      if (!segment.result) continue
      const card = segment.result.card
      // The rollout's own id — Codex's thread id, the conversation id its OTEL card carries too.
      card.conversationId = conversationId
      // The branch the rollout recorded when the session started.
      if (fileBranch) card.gitBranch = fileBranch
      if (!turn.turnId) card.derived = true
      results.push(segment.result)
    }
    if (held) this.fileState.delete(filePath)
    return results
  }

  private _parseCodexSegment(
    lines: string[],
    sessionId: string,
    baselineUsage: Record<string, number> | undefined,
    fileWorkspace = '',
  ): { result: LogSessionResult | null; cumulativeUsage: Record<string, number> | undefined } {
    let workspace = ''

    let model = ''
    let firstTimestamp = ''
    let lastTimestamp = ''
    let userRequest = ''
    let turns = 0
    // Codex token_count events carry both per-turn (last_token_usage) and cumulative
    // (total_token_usage) counts. We use the final total_token_usage because:
    //   1. The sum of per-turn last_token_usage drifts from the authoritative total
    //      (background tasks, retries, etc. can cause minor discrepancies).
    //   2. OpenAI input_tokens includes cached_input_tokens, so we must subtract to
    //      get the non-cached portion that _buildCard expects for correct billing.
    let lastTotalUsage: Record<string, number> | undefined
    const limits = new CodexLimitCollector(sessionId)

    for (const line of lines) {
      let entry: Record<string, unknown>
      try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }

      const ts = entry['timestamp'] as string | undefined
      // turn_aborted is logged when the user comes back, not when the turn stopped — it would
      // stretch whichever turn's range it lands in.
      const aborted = (entry['payload'] as Record<string, unknown> | undefined)?.['type'] === 'turn_aborted'
      if (ts && !aborted) {
        if (!firstTimestamp) firstTimestamp = ts
        if (entry['type'] === 'event_msg') lastTimestamp = ts
      }

      // session_meta carries the actual project working directory
      if (entry['type'] === 'session_meta' && !workspace) {
        const payload = entry['payload'] as Record<string, unknown> | undefined
        if (payload?.['cwd']) workspace = String(payload['cwd'])
      }

      // turn_context carries the model name (and, in newer rollouts, the turn's cwd)
      if (entry['type'] === 'turn_context') {
        const payload = entry['payload'] as Record<string, unknown> | undefined
        if (payload?.['model']) model = String(payload['model'])
        if (payload?.['cwd'] && !workspace) workspace = String(payload['cwd'])
      }

      if (entry['type'] === 'event_msg') {
        const payload = entry['payload'] as Record<string, unknown> | undefined
        if (!userRequest) {
          const msg = codexPromptText(entry)?.trim()
          if (msg) userRequest = _extractCodexUserText(msg)
        }
        if (payload?.['type'] === 'token_count') {
          const info = payload['info'] as Record<string, unknown> | undefined
          if (info?.['model']) model = String(info['model'])
          const total = tokenUsage(info?.['total_token_usage'])
          const last  = tokenUsage(info?.['last_token_usage'])
          if (total) lastTotalUsage = total
          if (last) turns++
          limits.add(payload, ts)
        }
      }
    }

    if (!firstTimestamp) return { result: null, cumulativeUsage: lastTotalUsage }
    workspace = workspace || fileWorkspace

    // total_token_usage is cumulative for the whole file — this segment's own contribution is
    // the delta from the previous segment's ending cumulative value (0 for segment 0). A segment
    // with no token_count events of its own (lastTotalUsage undefined) contributed nothing new.
    let totalCacheRead = 0, totalInput = 0, totalOutput = 0
    if (lastTotalUsage) {
      const baseCacheRead = baselineUsage?.['cached_input_tokens'] ?? 0
      const baseInputRaw  = Math.max(0, (baselineUsage?.['input_tokens'] ?? 0) - baseCacheRead)
      const baseOutput    = baselineUsage?.['output_tokens'] ?? 0

      const curCacheRead = lastTotalUsage['cached_input_tokens'] ?? 0
      // input_tokens includes cached, so subtract to get the raw (non-cached) portion that
      // _buildCard will re-add alongside cacheRead.
      const curInputRaw  = Math.max(0, (lastTotalUsage['input_tokens'] ?? 0) - curCacheRead)
      // output_tokens already includes reasoning_output_tokens (a breakdown of it, as in OpenAI's
      // usage.output_tokens_details) — adding the two billed reasoning twice.
      const curOutput    = lastTotalUsage['output_tokens'] ?? 0

      totalCacheRead = Math.max(0, curCacheRead - baseCacheRead)
      totalInput     = Math.max(0, curInputRaw - baseInputRaw)
      totalOutput    = Math.max(0, curOutput - baseOutput)
    }

    const limitReadings = limits.readingsOut()
    const limitHits = limits.hitsOut()
    const planStatus = limits.statusOut()
    return {
      result: {
        workspace,
        ...(limitReadings.length > 0 ? { limitReadings } : {}),
        ...(limitHits.length > 0 ? { limitHits } : {}),
        ...(planStatus ? { planStatus } : {}),
        card: {
          ..._buildCard(sessionId, 'codex', model || 'codex', firstTimestamp, lastTimestamp, { totalInput, totalOutput, totalCacheRead, totalCacheCreate: 0, peakContextPerTurn: 0, turns, totalToolCalls: 0, toolCounts: {}, filesRead: new Set(), filesChanged: new Set(), filesWritten: new Set(), filesSearched: new Set(), userRequest: userRequest.slice(0, 500), timeline: [], initiator: 'user' }, workspace),
          sourceRank: lastTotalUsage ? SOURCE_RANK_FULL_TRANSCRIPT : SOURCE_RANK_PARTIAL,
        },
      },
      cumulativeUsage: lastTotalUsage,
    }
  }

  // ── Copilot CLI ──────────────────────────────────────────────────────────────
  // Reads ~/.copilot/session-state/<uuid>/events.jsonl — written automatically,
  // no env setup required. Each directory is one session (dirname = session ID).
  //
  // Key event types:
  //   session.start        → data.sessionId, data.selectedModel (before 1.0.107), data.startTime, data.context.cwd
  //   session.model_change → data.newModel ('auto' when Copilot picks); session.auto_mode_resolved → data.chosenModel
  //   user.message         → data.transformedContent (user request text)
  //   assistant.message    → data.outputTokens (before 1.0.107), data.toolRequests, data.model
  //   session.usage_record → data.usage.{model,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}, one per
  //                          model call (1.0.107+; earlier versions wrote it without `usage`)
  //   session.shutdown     → data.modelMetrics[model].usage.{inputTokens,cacheReadTokens,cacheWriteTokens}

  private _scanCopilot(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    const stateDir = copilotSessionStateDir()
    if (!stateDir) return results

    let sessionDirs: string[]
    try {
      sessionDirs = fs.readdirSync(stateDir)
    } catch { return results }

    for (const sessionDirName of sessionDirs) {
      const eventsFile = path.join(stateDir, sessionDirName, 'events.jsonl')
      results.push(...this._processFileMulti(eventsFile, () => this._parseCopilotFile(eventsFile, sessionDirName)))
    }

    return results
  }

  /** One result per turn: a turn opens at each `user.message` (session.start and anything else
   *  before the first prompt belong to the first turn). The format has no per-turn id of its own
   *  that's been verified, so keys are derived from the session id plus the prompt event's own
   *  `id` (or its timestamp). From 1.0.107 every model call writes a `session.usage_record` with
   *  its own tokens, so each turn gets exactly its own; `assistant.message` stopped carrying
   *  outputTokens then. Before that, `session.shutdown` reports input and cache tokens for the
   *  whole session only — they land on the last turn so the session's totals stay right, and
   *  per-turn input is unknown. A file with usage records never uses the shutdown totals (they
   *  are the same tokens again). */
  private _parseCopilotFile(filePath: string, sessionId: string): LogSessionResult[] {
    const lines = this._readNewLines(filePath)
    if (!lines) return []
    this._observe(filePath, 'copilot', () => lines.map(parseLogLine))

    let workspace = ''
    let sessionModel = ''
    let sessionStart = ''
    let totalInputFromShutdown = 0
    let totalCacheRead = 0
    let totalCacheCreate = 0
    let sawShutdown = false
    let sawUsageRecord = false
    interface Turn {
      opening: string; first: string; last: string; model: string; userRequest: string
      totalOutput: number; turns: number; totalToolCalls: number
      toolCounts: Record<string, number>; filesChanged: Set<string>
      /** From session.usage_record (1.0.107+). */
      usage: { input: number; output: number; cacheRead: number; cacheCreate: number; calls: number }
    }
    const turns: Turn[] = []
    const newTurn = (opening: string): Turn => ({
      opening, first: '', last: '', model: '', userRequest: '', totalOutput: 0, turns: 0, totalToolCalls: 0, toolCounts: {}, filesChanged: new Set(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 },
    })
    let leading: Turn | undefined

    for (const line of lines) {
      let event: Record<string, unknown>
      try { event = JSON.parse(line) as Record<string, unknown> } catch { continue }

      const type = event['type'] as string | undefined
      const data = event['data'] as Record<string, unknown> | undefined
      const ts = event['timestamp'] as string | undefined
      if (type === 'user.message' && data) {
        const opening = typeof event['id'] === 'string' && event['id'] ? event['id'] : (ts ?? String(turns.length))
        turns.push(newTurn(opening))
      }
      const cur = turns[turns.length - 1] ?? (leading ??= newTurn(''))
      if (ts) {
        if (!cur.first) cur.first = ts
        // Not session.shutdown: that is when the CLI was quit, not when the turn ended.
        if (type === 'user.message' || type === 'assistant.message') cur.last = ts
      }
      if (!type || !data) continue

      if (type === 'session.start') {
        if (data['selectedModel']) sessionModel = String(data['selectedModel'])
        const ctx = data['context'] as Record<string, unknown> | undefined
        if (ctx?.['cwd']) workspace = String(ctx['cwd'])
        if (data['startTime']) sessionStart = String(data['startTime'])
      }

      // 1.0.107+: session.start names no model. The first concrete one is the session's fallback
      // for a turn with no model of its own ('auto' is Copilot choosing, resolved just after).
      if (!sessionModel && type === 'session.model_change' && typeof data['newModel'] === 'string' && data['newModel'] !== 'auto') sessionModel = data['newModel']
      if (!sessionModel && type === 'session.auto_mode_resolved' && typeof data['chosenModel'] === 'string') sessionModel = data['chosenModel']

      if (type === 'session.usage_record') {
        const raw = data['usage'] as Record<string, unknown> | undefined
        const usage = tokenUsage(raw)
        if (usage && Object.keys(usage).length > 0) {
          sawUsageRecord = true
          cur.usage.input       += copilotFreshInput(usage)
          cur.usage.output      += usage['outputTokens']     ?? 0
          cur.usage.cacheRead   += usage['cacheReadTokens']  ?? 0
          cur.usage.cacheCreate += usage['cacheWriteTokens'] ?? 0
          cur.usage.calls++
          if (typeof raw?.['model'] === 'string' && raw['model']) cur.model = raw['model']
        }
      }

      if (type === 'user.message' && !cur.userRequest) {
        cur.userRequest = _extractCopilotUserText(String(data['transformedContent'] ?? ''))
      }

      if (type === 'assistant.message') {
        const outTok = data['outputTokens'] as number | undefined
        if (outTok) { cur.totalOutput += outTok; cur.turns++ }
        const toolReqs = data['toolRequests'] as Array<Record<string, unknown>> | undefined
        if (toolReqs) {
          for (const req of toolReqs) {
            const name = String(req['name'] ?? '')
            if (!name) continue
            cur.totalToolCalls++
            cur.toolCounts[name] = (cur.toolCounts[name] ?? 0) + 1
            // Track file paths from write/edit tools
            const rawArgs = req['arguments']
            if (name === 'apply_patch') {
              // GPT-family models edit through apply_patch, whose arguments are the patch text
              // itself (a string), or an object carrying it; the files are in its headers.
              for (const fp of applyPatchFilePaths(rawArgs)) cur.filesChanged.add(fp)
            } else {
              const args = rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : undefined
              const fp = String(args?.['path'] ?? args?.['file_path'] ?? '')
              if (fp && (name === 'edit' || name === 'write' || name === 'create')) {
                cur.filesChanged.add(fp)
              }
            }
          }
        }
        if (data['model']) cur.model = String(data['model'])
      }

      if (type === 'session.shutdown') {
        // modelMetrics[model].usage has the real cumulative token counts.
        // data['currentTokens'] is only the context window size at shutdown — do not use it.
        const metrics = data['modelMetrics'] as Record<string, Record<string, unknown>> | undefined
        if (metrics) {
          sawShutdown = true
          for (const entry of Object.values(metrics)) {
            const usage = tokenUsage((entry as Record<string, unknown> | null)?.['usage'])
            if (!usage) continue
            totalInputFromShutdown += copilotFreshInput(usage)
            totalCacheRead          += usage['cacheReadTokens']  ?? 0
            totalCacheCreate        += usage['cacheWriteTokens'] ?? 0
          }
        }
      }
    }

    // No prompt at all: the session's one (prompt-less) turn, as before — but only once it has
    // activity of its own. A session read between session.start and its first user.message (the
    // user can sit at the prompt for minutes) would otherwise get a turn keyed off session.start
    // that the first prompt then replaces with its own key: the early key reaches the cloud, and
    // no store holds it.
    if (turns.length === 0 && leading && (leading.turns > 0 || leading.totalOutput > 0 || leading.totalToolCalls > 0 || leading.usage.calls > 0)) turns.push(leading)
    const results: LogSessionResult[] = []
    let model = sessionModel
    turns.forEach((turn, i) => {
      const first = turn.first || (i === 0 ? sessionStart : '')
      if (!first) return
      if (turn.model) model = turn.model
      const isLast = i === turns.length - 1
      const key = derivedTraceKey('copilot', sessionId, turn.opening || first)
      const u = turn.usage
      const card = _buildCard(key, 'copilot', model || 'copilot', first, turn.last || first, {
        totalInput: sawUsageRecord ? u.input : isLast ? totalInputFromShutdown : 0,
        totalOutput: sawUsageRecord ? u.output : turn.totalOutput,
        totalCacheRead: sawUsageRecord ? u.cacheRead : isLast ? totalCacheRead : 0,
        totalCacheCreate: sawUsageRecord ? u.cacheCreate : isLast ? totalCacheCreate : 0,
        peakContextPerTurn: 0,
        turns: sawUsageRecord ? u.calls : turn.turns,
        totalToolCalls: turn.totalToolCalls,
        toolCounts: turn.toolCounts,
        filesRead: new Set(),
        filesChanged: turn.filesChanged,
        filesWritten: new Set(),
        filesSearched: new Set(),
        userRequest: turn.userRequest.slice(0, 500),
        timeline: [],
        initiator: 'user',
      }, workspace)
      card.conversationId = sessionId
      card.derived = true
      card.sourceRank = turn.totalOutput > 0 || u.calls > 0 || (isLast && sawShutdown) ? SOURCE_RANK_FULL_TRANSCRIPT : SOURCE_RANK_PARTIAL
      results.push({ workspace, card })
    })
    return results
  }

  // ── Copilot Chat (VS Code sidebar) ───────────────────────────────────────────
  // Reads workspaceStorage/<hash>/chatSessions/<uuid>.jsonl — written automatically
  // by VS Code for every Copilot Chat panel session, no env setup required.
  //
  // The JSONL is a delta log; each line is an operation on a shared session object:
  //   kind=0  initial session snapshot (creationDate, sessionId, selectedModel)
  //   kind=1  set  — k is key path, v is new value
  //   kind=2  push — k is key path, v is array of items to append
  //
  // Data available: sessionId, creationDate, workspace (via workspace.json),
  //   initial model, completionTokens per turn, turn timestamps, turn duration.
  // NOT available: input tokens, cache tokens, model per turn.

  private _scanCopilotVSCode(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    for (const root of vscodeFamilyWorkspaceStorageRoots()) {
      try {
        for (const hashDir of fs.readdirSync(root)) {
          const chatDir = path.join(root, hashDir, 'chatSessions')
          let names: string[]
          try { names = fs.readdirSync(chatDir) } catch { continue }
          const jsonlIds = new Set(names.filter(n => n.endsWith('.jsonl')).map(n => n.slice(0, -6)))
          for (const name of names) {
            if (name.endsWith('.jsonl')) {
              const filePath = path.join(chatDir, name)
              results.push(...this._processFileMulti(filePath, () => this._parseCopilotVSCodeFile(filePath)))
            } else if (name.endsWith('.json') && !jsonlIds.has(name.slice(0, -5))) {
              const filePath = path.join(chatDir, name)
              const sessionId = path.basename(filePath, '.json')
              results.push(...this._processFileMulti(filePath, () => this._parseCopilotVSCodeJsonFile(filePath, sessionId)))
            }
          }
        }
      } catch { /* root not accessible */ }
    }
    return results
  }

  /** Reads a Copilot Chat (VS Code) delta log and returns one result per request — a request is
   *  this format's turn, keyed by its own `requestId` (traceKey('copilot', requestId)); a request
   *  with none gets a derived key from the chat id plus its timestamp. A `kind: 1` update
   *  (e.g. `k: ["requests", N, "completionTokens"]`) addresses request N by its position in the
   *  *whole session's* requests array, so requests are numbered in push order across the file.
   *  completionTokens appears in three formats depending on VS Code / Copilot Chat version:
   *    Format A (current):  kind=1, k=["requests", N, "completionTokens"], v=number
   *    Format B (current):  embedded in the kind=2 push object as req.completionTokens
   *    Format C (pre-mid-2026): kind=1, k=["requests", N, "result"], v.usage.completionTokens
   *      (Format C also carries v.usage.promptTokens — per-turn input tokens.)
   *  A later kind=1 value (the streaming-final one) wins over Format B. */
  private _parseCopilotVSCodeFile(filePath: string): LogSessionResult[] {
    const lines = this._readNewLines(filePath)
    if (!lines) return []
    const workspace = _vscodeChatWorkspace(filePath)

    interface Req {
      requestId: string; ts?: number; text: string; rendered: string; modelId: string
      completion?: number; prompt?: number; elapsedMs?: number
    }
    const reqs: Req[] = []
    let sessionCreatedMs = 0
    let model = ''
    const parsed = lines.map(parseLogLine)
    this._observe(filePath, 'copilot_vscode', () => parsed)
    parsed.forEach(e => {
      if (e === undefined) return
      const entry = e as Record<string, unknown>
      const kind = entry['kind'] as number | undefined
      const k = entry['k']
      const v = entry['v']

      // kind=0: initial session snapshot
      if (kind === 0 && v && typeof v === 'object') {
        const sv = v as Record<string, unknown>
        if (typeof sv['creationDate'] === 'number') sessionCreatedMs = sv['creationDate']
        const inputState = sv['inputState'] as Record<string, unknown> | undefined
        const selModel = inputState?.['selectedModel'] as Record<string, unknown> | undefined
        const meta = selModel?.['metadata'] as Record<string, unknown> | undefined
        if (typeof meta?.['family'] === 'string') model = meta['family']
        else if (typeof selModel?.['id'] === 'string') model = selModel['id']
      }

      // kind=2 push to 'requests' — new request(s). k must be exactly ['requests'];
      // k=['requests', N, 'response'] are sub-array pushes for a request's response entries.
      if (kind === 2 && Array.isArray(k) && k.length === 1 && k[0] === 'requests' && Array.isArray(v)) {
        for (const r of v as Array<Record<string, unknown>>) {
          const msg = r?.['message'] as Record<string, unknown> | undefined
          reqs.push({
            requestId: typeof r?.['requestId'] === 'string' ? r['requestId'] : '',
            ts: typeof r?.['timestamp'] === 'number' ? r['timestamp'] : undefined,
            // message.text is the raw user prompt — much cleaner than renderedUserMessage.
            text: typeof msg?.['text'] === 'string' ? (msg['text'] as string).trim() : '',
            rendered: '',
            modelId: typeof r?.['modelId'] === 'string' ? (r['modelId'] as string).replace(/^copilot\//, '') : '',
            completion: typeof r?.['completionTokens'] === 'number' ? r['completionTokens'] : undefined,
          })
        }
      }

      // kind=1 sets on a specific request key (Format A/C, or late-arriving streaming final value)
      if (kind === 1 && Array.isArray(k) && k[0] === 'requests' && typeof k[1] === 'number') {
        const req = reqs[k[1] as number]
        if (!req) return
        if (k[2] === 'completionTokens' && typeof v === 'number') req.completion = v
        if (k[2] === 'result' && v && typeof v === 'object') {
          const result = v as Record<string, unknown>
          const usage = result['usage'] as Record<string, number> | undefined
          if (typeof usage?.['completionTokens'] === 'number') req.completion = usage['completionTokens']
          if (typeof usage?.['promptTokens'] === 'number') req.prompt = usage['promptTokens']
          const timings = result['timings'] as Record<string, unknown> | undefined
          if (typeof timings?.['totalElapsed'] === 'number') req.elapsedMs = timings['totalElapsed']
          // renderedUserMessage: fallback when message.text isn't available
          const meta = result['metadata'] as Record<string, unknown> | undefined
          const rendered = meta?.['renderedUserMessage'] as Array<Record<string, unknown>> | undefined
          if (rendered && !req.rendered) {
            for (const chunk of rendered) {
              if (chunk['type'] === 1 && typeof chunk['text'] === 'string') {
                req.rendered = _extractVSCodeCopilotUserText(chunk['text'])
                if (req.rendered) break
              }
            }
          }
        }
      }
    })

    const baseSessionId = path.basename(filePath, '.jsonl')
    const results: LogSessionResult[] = []
    reqs.forEach((req, i) => {
      // The chat panel's creation time stands in only for a first request with no timestamp of
      // its own: a panel can sit open for hours before its first message.
      const startMs = req.ts ?? (i === 0 ? sessionCreatedMs : 0)
      if (!startMs) return
      const key = req.requestId ? traceKey('copilot', req.requestId) : derivedTraceKey('copilot', baseSessionId, String(startMs))
      const startTs = new Date(startMs).toISOString()
      const endTs = new Date(startMs + Math.max(0, req.elapsedMs ?? 0)).toISOString()
      const card = _buildCard(key, 'copilot', req.modelId || model || 'copilot', startTs, endTs, {
        totalInput: req.prompt ?? 0,
        totalOutput: req.completion ?? 0,
        totalCacheRead: 0,
        totalCacheCreate: 0,
        peakContextPerTurn: 0,
        turns: req.completion !== undefined ? 1 : 0,
        totalToolCalls: 0,
        toolCounts: {},
        filesRead: new Set(),
        filesChanged: new Set(),
        filesWritten: new Set(),
        filesSearched: new Set(),
        userRequest: (req.text || req.rendered).slice(0, 500),
        timeline: [],
        initiator: 'user',
      }, workspace)
      card.conversationId = baseSessionId
      if (!req.requestId) card.derived = true
      card.sourceRank = req.completion !== undefined ? SOURCE_RANK_FULL_TRANSCRIPT : SOURCE_RANK_PARTIAL
      results.push({ workspace, card })
    })
    return results
  }

  // ── Copilot Chat (VS Code sidebar) — legacy JSON snapshot format ─────────────
  // Older Copilot Chat versions (before the delta-log JSONL format) wrote each
  // session as a single <uuid>.json file containing the full session state object.
  // These files are only collected when no .jsonl sibling exists for the same UUID.
  //
  // Data available: sessionId, creationDate, lastMessageDate, model (from per-turn
  //   modelId or inputState.selectedModel), user prompt (message.text), turn count,
  //   tool call presence.
  // Not available: output/input/cache tokens (not stored in older format).

  /** One result per request, keyed by its `requestId` like the delta-log format (derived from the
   *  chat id plus the request's timestamp, or position, when it has none). Requests carry their
   *  own timestamps; the snapshot's lastMessageDate closes the last one. */
  private _parseCopilotVSCodeJsonFile(filePath: string, sessionId: string): LogSessionResult[] {
    const data = this._readJsonFile(filePath)
    if (!data) return []
    this._observe(filePath, 'copilot_vscode_json', () => [data])

    const creationMs = typeof data['creationDate'] === 'number' ? data['creationDate'] : 0
    const lastMs     = typeof data['lastMessageDate'] === 'number' ? data['lastMessageDate'] : 0
    if (!creationMs) return []

    const requests = data['requests']
    if (!Array.isArray(requests) || requests.length === 0) return []

    const workspace = _vscodeChatWorkspace(filePath)

    // Model: inputState's selected model; a request's own modelId when there is none
    let sessionModel = ''
    const inputState = data['inputState'] as Record<string, unknown> | undefined
    if (inputState) {
      const selModel = inputState['selectedModel'] as Record<string, unknown> | undefined
      const meta = selModel?.['metadata'] as Record<string, unknown> | undefined
      if (typeof meta?.['family'] === 'string') sessionModel = meta['family']
      else if (typeof selModel?.['id'] === 'string') sessionModel = selModel['id']
    }

    const sid = String(data['sessionId'] ?? sessionId)
    const reqs = requests as Array<Record<string, unknown>>
    const results: LogSessionResult[] = []
    let prevStartMs = creationMs
    reqs.forEach((req, i) => {
      let userRequest = ''
      const msg = req['message'] as Record<string, unknown> | undefined
      if (typeof msg?.['text'] === 'string' && (msg['text'] as string).trim()) {
        userRequest = (msg['text'] as string).trim()
      } else if (Array.isArray(msg?.['parts'])) {
        // Older format: message has no top-level text, only a parts array
        for (const part of msg['parts'] as Array<Record<string, unknown>>) {
          if (typeof part['text'] === 'string' && (part['text'] as string).trim()
              && !((part['text'] as string).trim().startsWith('<'))) {
            userRequest = (part['text'] as string).trim()
            break
          }
        }
      }
      let totalToolCalls = 0
      const toolCounts: Record<string, number> = {}
      const response = req['response']
      if (Array.isArray(response)) {
        for (const entry of response as Array<Record<string, unknown>>) {
          if (entry['kind'] === 'toolInvocationSerialized') {
            totalToolCalls++
            const toolId = String(entry['toolId'] ?? 'unknown')
            toolCounts[toolId] = (toolCounts[toolId] ?? 0) + 1
          }
        }
      }
      const model = sessionModel || (typeof req['modelId'] === 'string' ? (req['modelId'] as string).replace(/^copilot\//, '') : '')
      // A request with no timestamp of its own (the oldest snapshots) starts where the one before
      // it did — the chat's creation time for the first.
      const ownTs = typeof req['timestamp'] === 'number' ? req['timestamp'] : 0
      const startMs = ownTs || prevStartMs
      prevStartMs = startMs
      const endMs = i === reqs.length - 1 ? Math.max(startMs, lastMs) : startMs
      const requestId = typeof req['requestId'] === 'string' ? req['requestId'] : ''
      const key = requestId ? traceKey('copilot', requestId) : derivedTraceKey('copilot', sid, ownTs ? String(ownTs) : `#${i}`)
      const card = _buildCard(key, 'copilot', model || 'copilot', new Date(startMs).toISOString(), new Date(endMs).toISOString(), {
        totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheCreate: 0,
        peakContextPerTurn: 0,
        turns: 1,
        totalToolCalls,
        toolCounts,
        filesRead: new Set(), filesChanged: new Set(), filesWritten: new Set(), filesSearched: new Set(),
        userRequest: userRequest.slice(0, 500),
        timeline: [], initiator: 'user',
      }, workspace)
      card.conversationId = sid
      if (!requestId) card.derived = true
      // This format stores no token counts at all.
      card.sourceRank = SOURCE_RANK_PARTIAL
      results.push({ workspace, card })
    })
    return results
  }

  // ── OpenCode ──────────────────────────────────────────────────────────────────
  // Primary data source: ~/.local/share/opencode/opencode.db (SQLite)
  //   Tables: session (id, parent_id, title, cwd, time), message (id, session_id, data JSON)
  // Override: OPENCODE_DATA_DIR (comma-separated list of data dirs)
  //
  // Only root sessions (parent_id IS NULL / '') are included in this pass.
  // Subagent session attribution is left for a follow-up.

  /** Public entry point for the initial batch load in extension.ts. */
  scanOpenCode(): LogSessionResult[] {
    return this._scanOpenCode()
  }

  private _scanOpenCode(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    const dirs = openCodeDataDirs()

    for (const dataDir of dirs) {
      const dbPath = path.join(dataDir, 'opencode.db')
      const walPath = dbPath + '-wal'
      try {
        const stat = fs.statSync(dbPath)
        // Also check WAL mtime — OpenCode writes to the WAL, not the DB file directly.
        let walMtime = 0
        try { walMtime = fs.statSync(walPath).mtimeMs } catch { /* no WAL */ }
        const effectiveMtime = Math.max(stat.mtimeMs, walMtime)
        const prev = this.fileState.get(dbPath)
        if (prev && effectiveMtime === prev.mtimeMs && stat.size === prev.bytesRead) continue
        // The database and its WAL are both read whole and merged in memory.
        let walSize = 0
        try { walSize = fs.statSync(walPath).size } catch { /* no WAL */ }
        if (this._tooLarge(dbPath, stat.size + walSize, effectiveMtime)) {
          // _tooLarge recorded stat.size + walSize; store the real size so a WAL checkpoint (which
          // shrinks the pair) reads as a change and is tried again.
          this.fileState.set(dbPath, { bytesRead: stat.size, mtimeMs: effectiveMtime })
          continue
        }
        this.fileState.set(dbPath, { bytesRead: stat.size, mtimeMs: effectiveMtime })
      } catch {
        continue
      }

      // The database is the only source read. The JSON message files that may sit beside it
      // (older OpenCode storage) carry no user-message order or start times — read instead of a
      // database that failed to open, they keyed the same turns differently (one 'session' key per
      // conversation, started 1970). A failed read (a WAL caught mid-write) is retried on the next
      // scan instead: its state is dropped so the file reads as changed.
      if (!this.sqlFactory) continue
      try {
        results.push(...this._parseOpenCodeDb(dbPath))
      } catch (err) {
        this.log(`[LogReader] OpenCode DB error ${dbPath}: ${err}`)
        this.fileState.delete(dbPath)
      }
    }
    return results
  }

  private _parseOpenCodeDb(dbPath: string): LogSessionResult[] {
    let buf: Uint8Array = fs.readFileSync(dbPath)
    const walPath = dbPath + '-wal'
    try {
      const wal = fs.readFileSync(walPath)
      if (wal.length > 32) buf = _mergeWal(buf, wal)
    } catch { /* no WAL file — main DB is fully checkpointed */ }
    const db = new this.sqlFactory!.Database(buf)
    if (this.observe) {
      try { this.observe(dbPath, observeOpenCodeDb(db), this.fileState.get(dbPath)?.mtimeMs ?? Date.now()) } catch (err) { this.log(`[LogReader] adapter health error ${dbPath}: ${err}`) }
    }
    try {
      // ── Session rows ───────────────────────────────────────────────────────
      const sessRows = db.exec(`
        SELECT s.id, s.directory, s.title, s.time_created,
               json_extract(s.model, '$.id') AS model_id,
               s.tokens_input, s.tokens_output, s.tokens_reasoning,
               s.tokens_cache_read, s.tokens_cache_write
        FROM session s
        WHERE (s.parent_id IS NULL OR s.parent_id = '')
          AND (s.tokens_input + s.tokens_output + s.tokens_cache_read + s.tokens_cache_write) > 0
        ORDER BY s.time_created DESC
      `)
      if (!sessRows[0]) return []
      const sc = (n: string) => sessRows[0].columns.indexOf(n)
      const sessionIds = sessRows[0].values.map(r => String(r[sc('id')]))
      if (sessionIds.length === 0) return []

      // ── Message rows (per-turn timing & token breakdown) ──────────────────
      // db.exec() doesn't accept bind parameters — inline quoted IDs (trusted, same-DB source).
      const inList = sessionIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',')
      const msgRows = db.exec(
        `SELECT session_id, id AS msg_id,
                json_extract(data,'$.role')           AS role,
                json_extract(data,'$.time.created')   AS t_created,
                json_extract(data,'$.time.completed') AS t_completed,
                json_extract(data,'$.tokens.input')   AS tok_in,
                json_extract(data,'$.tokens.output')  AS tok_out,
                json_extract(data,'$.tokens.reasoning')   AS tok_reason,
                json_extract(data,'$.tokens.cache.read')  AS tok_cr,
                json_extract(data,'$.tokens.cache.write') AS tok_cw,
                json_extract(data,'$.parentID')       AS parent_id,
                time_created                          AS row_created
         FROM message WHERE session_id IN (${inList})
         ORDER BY time_created ASC`,
      )

      // ── Part rows (user text, tool names, files, tool I/O for timeline) ──────
      // part table may be absent in older DB versions — gracefully skip if so.
      let partRows: Array<{ columns: string[]; values: unknown[][] }> = []
      try {
        partRows = db.exec(
          `SELECT p.session_id, p.message_id AS message_id, p.time_created AS part_ts,
                  json_extract(m.data,'$.role')                 AS msg_role,
                  json_extract(p.data,'$.type')                 AS type,
                  json_extract(p.data,'$.text')                 AS text,
                  json_extract(p.data,'$.tool')                 AS tool_name,
                  json_extract(p.data,'$.callID')               AS call_id,
                  json_extract(p.data,'$.state.input.filePath') AS file_path,
                  json_extract(p.data,'$.state.input')          AS tool_input_json,
                  substr(json_extract(p.data,'$.state.output'),1,2000) AS tool_output,
                  json_extract(p.data,'$.state.status')         AS tool_status
           FROM part p JOIN message m ON m.id = p.message_id
           WHERE p.session_id IN (${inList})
           ORDER BY p.time_created ASC`,
        )
      } catch { /* part table absent in this DB version */ }

      // Index by session
      interface MsgInfo {
        msgId: string; role: string; parentId: string; tCreated: number; tCompleted: number
        tokIn: number; tokOut: number; tokReason: number; tokCR: number; tokCW: number; hasTokens: boolean
      }
      interface PartInfo {
        messageId: string; partTs: number; msgRole: string; type: string
        text: string | null; toolName: string | null; callId: string | null
        filePath: string | null; toolInputJson: string | null
        toolOutput: string | null; toolStatus: string | null
      }
      const msgsBySess  = new Map<string, MsgInfo[]>()
      const partsBySess = new Map<string, PartInfo[]>()

      if (msgRows[0]) {
        const mc = (n: string) => msgRows[0].columns.indexOf(n)
        const num = (r: unknown[], n: string) => Number(r[mc(n)] ?? 0) || 0
        for (const r of msgRows[0].values) {
          const sid = String(r[mc('session_id')])
          if (!msgsBySess.has(sid)) msgsBySess.set(sid, [])
          const role = String(r[mc('role')] ?? '')
          if (role !== 'assistant' && role !== 'user') continue
          msgsBySess.get(sid)!.push({
            msgId: String(r[mc('msg_id')]),
            role,
            parentId: String(r[mc('parent_id')] ?? ''),
            tCreated:   num(r, 't_created') || num(r, 'row_created'),
            tCompleted: num(r, 't_completed'),
            tokIn: num(r, 'tok_in'), tokOut: num(r, 'tok_out'), tokReason: num(r, 'tok_reason'),
            tokCR: num(r, 'tok_cr'), tokCW: num(r, 'tok_cw'),
            hasTokens: ['tok_in', 'tok_out', 'tok_reason', 'tok_cr', 'tok_cw'].some(n => r[mc(n)] !== null && r[mc(n)] !== undefined),
          })
        }
      }
      if (partRows[0]) {
        const pc = (n: string) => partRows[0].columns.indexOf(n)
        for (const r of partRows[0].values) {
          const sid = String(r[pc('session_id')])
          if (!partsBySess.has(sid)) partsBySess.set(sid, [])
          partsBySess.get(sid)!.push({
            messageId:    String(r[pc('message_id')]      ?? ''),
            partTs:       Number(r[pc('part_ts')]         ?? 0),
            msgRole:      String(r[pc('msg_role')]        ?? ''),
            type:         String(r[pc('type')]            ?? ''),
            text:          strOrNull(r[pc('text')]),
            toolName:      strOrNull(r[pc('tool_name')]),
            callId:        strOrNull(r[pc('call_id')]),
            filePath:      strOrNull(r[pc('file_path')]),
            toolInputJson: strOrNull(r[pc('tool_input_json')]),
            toolOutput:    strOrNull(r[pc('tool_output')]),
            toolStatus:    strOrNull(r[pc('tool_status')]),
          })
        }
      }

      // ── Build cards: one per turn ──────────────────────────────────────────
      // A turn opens at each user message; an assistant message belongs to the user message its
      // parentID names, else to the latest user message created before it. Keys are derived
      // (OpenCode has no turn id of its own): the session id plus the user message's own id.
      const results: LogSessionResult[] = []
      for (const row of sessRows[0].values) {
        const sessionId = String(row[sc('id')] ?? '')
        if (!sessionId) continue

        const timeMs    = Number(row[sc('time_created')]      ?? 0)
        const modelId   = String(row[sc('model_id')]          ?? '')
        const workspace = String(row[sc('directory')]         ?? '')
        const title     = String(row[sc('title')] ?? '')
        const session = {
          tokIn:  Number(row[sc('tokens_input')]      ?? 0),
          tokOut: Number(row[sc('tokens_output')]     ?? 0) + Number(row[sc('tokens_reasoning')] ?? 0),
          tokCR:  Number(row[sc('tokens_cache_read')] ?? 0),
          tokCW:  Number(row[sc('tokens_cache_write')]?? 0),
        }

        const msgs  = msgsBySess.get(sessionId)  ?? []
        const parts = partsBySess.get(sessionId) ?? []
        interface OcTurn { opening: string; startMs: number; assistants: MsgInfo[]; messageIds: Set<string> }
        const turns: OcTurn[] = []
        const turnOfUser = new Map<string, OcTurn>()
        for (const m of msgs) {
          if (m.role === 'user') {
            const t: OcTurn = { opening: m.msgId, startMs: m.tCreated, assistants: [], messageIds: new Set([m.msgId]) }
            turns.push(t)
            turnOfUser.set(m.msgId, t)
            continue
          }
          let t = turnOfUser.get(m.parentId) ?? turns[turns.length - 1]
          if (!t) {
            // No user message recorded (an older database): the session's one turn.
            t = { opening: `session@${timeMs}`, startMs: timeMs, assistants: [], messageIds: new Set() }
            turns.push(t)
          }
          t.assistants.push(m)
          t.messageIds.add(m.msgId)
        }
        if (turns.length === 0) turns.push({ opening: `session@${timeMs}`, startMs: timeMs, assistants: [], messageIds: new Set() })
        const turnOfMessage = new Map<string, OcTurn>()
        for (const t of turns) for (const id of t.messageIds) turnOfMessage.set(id, t)
        // Per-message token counts when the database records them; an older one only has the
        // session's totals — those go on the session's last turn so they're counted once.
        const perMessageTokens = msgs.some(m => m.hasTokens)

        turns.forEach((turn, ti) => {
          const turnParts = parts.filter(p => (turnOfMessage.get(p.messageId) ?? (turns.length === 1 ? turn : undefined)) === turn)
          const startMs = turn.startMs || timeMs
          const startTs = startMs > 0 ? new Date(startMs).toISOString() : ''

          // User request: the turn's own first user-typed text; the AI-generated session title
          // stands in when there is none.
          let userRequest = ''
          for (const p of turnParts) {
            if (p.msgRole === 'user' && p.type === 'text' && p.text) { userRequest = p.text.slice(0, 500); break }
          }
          if (!userRequest) userRequest = title.slice(0, 500)

          // Tools, files, and timeline events built in a single pass (parts are ASC by time).
          // LLM entries come from messages; tool entries come from tool parts.
          // We merge them by timestamp so the Flow tab shows real interleaved activity.
          const toolCounts: Record<string, number> = {}
          const filesRead    = new Set<string>()
          const filesWritten = new Set<string>()
          const filesChanged = new Set<string>()
          let totalToolCalls = 0
          type Pending = { ts: number; entry: TimelineEntry }
          const llmEvents:  Pending[] = []
          const toolEvents: Pending[] = []

          let llmIdx = 0
          let lastCompleted = 0
          let tokIn = 0, tokOut = 0, tokCR = 0, tokCW = 0
          for (const m of turn.assistants) {
            const durationMs = m.tCompleted > m.tCreated ? m.tCompleted - m.tCreated : 0
            llmEvents.push({
              ts: m.tCreated,
              entry: {
                type: 'llm', spanId: `oc-${m.msgId}`,
                label: `Turn ${++llmIdx}`,
                durationMs,
                inputTokens: m.tokIn, outputTokens: m.tokOut,
                isError: false,
                timestamp: m.tCreated > 0 ? new Date(m.tCreated).toISOString() : startTs,
                model: modelId || undefined,
              },
            })
            if (m.tCompleted > lastCompleted) lastCompleted = m.tCompleted
            tokIn += m.tokIn; tokOut += m.tokOut + m.tokReason; tokCR += m.tokCR; tokCW += m.tokCW
          }
          if (!perMessageTokens && ti === turns.length - 1) {
            tokIn = session.tokIn; tokOut = session.tokOut; tokCR = session.tokCR; tokCW = session.tokCW
          }

          for (const p of turnParts) {
            if (p.type !== 'tool' || !p.toolName) continue
            toolCounts[p.toolName] = (toolCounts[p.toolName] ?? 0) + 1
            totalToolCalls++
            if (p.filePath) {
              const t = p.toolName.toLowerCase()
              if (t === 'read' || t === 'glob' || t === 'grep') {
                filesRead.add(p.filePath)
              } else if (t === 'write' || t === 'edit' || t === 'patch') {
                filesWritten.add(p.filePath)
                filesChanged.add(p.filePath)
              }
            }
            const isError = p.toolStatus === 'error'
            const label = p.filePath
              ? `${p.toolName}: ${p.filePath.split('/').pop()}`
              : p.toolName
            toolEvents.push({
              ts: p.partTs,
              entry: {
                type: 'tool', spanId: `oc-tool-${p.callId ?? p.partTs}`,
                label,
                action: p.toolName,
                toolInput: p.toolInputJson ?? undefined,
                resultSummary: p.toolOutput ? p.toolOutput.slice(0, 200) : undefined,
                fullResult: p.toolOutput ?? undefined,
                durationMs: 0,
                isError,
                errorMessage: isError ? (p.toolOutput ?? undefined) : undefined,
                timestamp: p.partTs > 0 ? new Date(p.partTs).toISOString() : startTs,
              },
            })
          }

          // Merge LLM and tool events in chronological order
          const timeline: TimelineEntry[] = [...llmEvents, ...toolEvents].sort((a, b) => a.ts - b.ts).map(e => e.entry)
          const endTs = lastCompleted > 0 ? new Date(lastCompleted).toISOString() : startTs

          const card = _buildCard(
            derivedTraceKey('opencode', sessionId, turn.opening), 'opencode', modelId || 'opencode',
            startTs, endTs,
            {
              totalInput: tokIn, totalOutput: tokOut,
              totalCacheRead: tokCR, totalCacheCreate: tokCW, peakContextPerTurn: 0,
              turns: turn.assistants.length, totalToolCalls, toolCounts,
              filesRead, filesChanged, filesWritten, filesSearched: new Set(),
              userRequest, timeline, initiator: 'user',
            },
            workspace,
          )
          card.conversationId = sessionId
          card.derived = true
          card.sourceRank = tokIn + tokOut > 0 ? SOURCE_RANK_FULL_TRANSCRIPT : SOURCE_RANK_PARTIAL
          results.push({ card, workspace })
        })
      }
      return this._onlyChanged(dbPath, results)
    } finally {
      db.close()
    }
  }

  // ── Shared helpers ────────────────────────────────────────────────────────────

  private _collectJsonlFiles(dir: string): string[] {
    const results: string[] = []
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) results.push(...this._collectJsonlFiles(full))
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(full)
      }
    } catch { /* directory gone or no permission */ }
    return results
  }

  /** Reads and parses a JSON file, updating file state. Returns null if unchanged or on error. */
  private _readJsonFile(filePath: string): Record<string, unknown> | null {
    try {
      const stat = fs.statSync(filePath)
      const prev = this.fileState.get(filePath)
      if (prev && stat.mtimeMs === prev.mtimeMs && stat.size === prev.bytesRead) return null
      if (this._tooLarge(filePath, stat.size, stat.mtimeMs)) return null
      const content = fs.readFileSync(filePath, 'utf-8')
      this.fileState.set(filePath, { bytesRead: stat.size, mtimeMs: stat.mtimeMs })
      const parsed = JSON.parse(content) as Record<string, unknown>
      this.lastRead = filePath
      this.lastReadMtimeMs = stat.mtimeMs
      return parsed
    } catch (err) {
      this.log(`[LogReader] read error ${filePath}: ${err}`)
      return null
    }
  }

  // ── Cursor CLI (cursor-agent) ────────────────────────────────────────────────

  private _scanCursor(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    for (const filePath of collectCursorTranscriptFiles()) {
      results.push(...this._processFileMulti(filePath, () => this._parseCursorFile(filePath)))
    }
    return results
  }

  /** Reads a Cursor CLI transcript, one result per turn — see the doc comment at the top of this
   *  file and ARCHITECTURE.md's "Cursor CLI — transcript log" for exactly what this format does
   *  and doesn't contain. A turn opens at each `role: 'user'` line (those persist across a `--resume`, unlike
   *  `turn_ended`). The format has no record ids and no timestamps, so a turn's derived key is the
   *  session id plus the turn's position among the file's prompts (stable for this append-only
   *  file), and every turn's times fall back to the file's birthtime — only the last turn ends at
   *  its mtime. No token/usage data, model name, or tool-call success signal exists on disk; those
   *  stay honest gaps (0 / unknown), never guessed. */
  private _parseCursorFile(filePath: string): LogSessionResult[] {
    const rawLines = this._readNewLines(filePath)
    if (!rawLines) return []
    this._observe(filePath, 'cursor', () => rawLines.map(parseLogLine))

    const sessionId = path.basename(filePath, '.jsonl')
    interface Turn {
      userRequest: string; totalToolCalls: number; toolCounts: Record<string, number>
      filesRead: Set<string>; filesChanged: Set<string>; filesWritten: Set<string>; timeline: TimelineEntry[]
    }
    const newTurn = (): Turn => ({ userRequest: '', totalToolCalls: 0, toolCounts: {}, filesRead: new Set(), filesChanged: new Set(), filesWritten: new Set(), timeline: [] })
    const turns: Turn[] = []
    let leading: Turn | undefined
    let lastTurnFailed = false
    let idx = 0
    const spanPrefix = `${sessionId.slice(0, 8)}`

    for (const line of rawLines) {
      let entry: Record<string, unknown>
      try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }

      if (entry['type'] === 'turn_ended') {
        // NOT a per-turn record — confirmed against a real `--resume`d session (2026-09-19):
        // resuming removes the *previous* turn's `turn_ended` line and appends exactly one new
        // one at the new end of file, so only the most recently completed turn's status survives.
        // It is that turn's error count; earlier turns' status is gone by the time this is read.
        lastTurnFailed = entry['status'] !== 'success'
        continue
      }

      const role = entry['role']
      if (role !== 'user' && role !== 'assistant') continue
      const content = ((entry['message'] as Record<string, unknown> | undefined)?.['content'] ?? []) as Array<Record<string, unknown>>

      if (role === 'user') {
        const turn = turns.length === 0 && leading ? leading : newTurn()
        turns.push(turn)
        const text = _extractTextContent(content)
        if (!turn.userRequest && text) {
          // The first user turn wraps the actual prompt in <user_query> tags, alongside a
          // human-prose <timestamp> block that isn't machine-parseable — strip both, keep the query.
          const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
          turn.userRequest = (match ? match[1] : text).trim()
        }
        turn.timeline.push({ type: 'user_input', spanId: `log-u-${spanPrefix}-${idx}`, label: 'User', durationMs: 0, isError: false, timestamp: '', responseText: text })
        idx++
        continue
      }

      const turn = turns[turns.length - 1] ?? (leading ??= newTurn())
      let hasToolCall = false
      for (const block of content) {
        if (block['type'] === 'tool_use' && block['name']) {
          hasToolCall = true
          turn.totalToolCalls++
          const name = block['name'] as string
          turn.toolCounts[name] = (turn.toolCounts[name] ?? 0) + 1
          const inp = (block['input'] ?? {}) as Record<string, unknown>
          const fp = String(inp['path'] ?? inp['file_path'] ?? inp['filePath'] ?? '')
          if (fp) {
            if (name === 'Read') turn.filesRead.add(fp)
            else if (name === 'Write') { turn.filesChanged.add(fp); turn.filesWritten.add(fp) }
            else if (name === 'Edit' || name === 'MultiEdit') turn.filesChanged.add(fp)
          }
        }
      }
      const responseText = (content.find(b => b['type'] === 'text') as Record<string, string> | undefined)?.['text']
      turn.timeline.push({
        type: hasToolCall ? 'tool' : 'llm',
        spanId: `log-a-${spanPrefix}-${idx}`,
        label: hasToolCall ? 'Tool calls' : 'Response',
        durationMs: 0,
        isError: false,
        timestamp: '',
        responseText,
      })
      idx++
    }

    if (turns.length === 0 && leading && leading.timeline.length > 0) turns.push(leading)
    if (turns.length === 0) return []

    let stat: fs.Stats
    try { stat = fs.statSync(filePath) } catch { return [] }
    // No per-line timestamps exist in this format at all — bounds fall back to file
    // birthtime/mtime (birthtime can read as 0 on some filesystems, hence the fallback to mtime).
    const startMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
    const endMs = Math.max(startMs, stat.mtimeMs)
    const firstTimestamp = new Date(startMs).toISOString()

    return turns.map((turn, i) => {
      const isLast = i === turns.length - 1
      const card = _buildCard(derivedTraceKey('cursor', sessionId, `#${i}`), 'cursor', 'cursor-agent', firstTimestamp, isLast ? new Date(endMs).toISOString() : firstTimestamp, {
        totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheCreate: 0,
        peakContextPerTurn: 0, turns: 1, totalToolCalls: turn.totalToolCalls, toolCounts: turn.toolCounts,
        filesRead: turn.filesRead, filesChanged: turn.filesChanged, filesWritten: turn.filesWritten,
        filesSearched: new Set(), userRequest: turn.userRequest, timeline: turn.timeline, initiator: 'user',
      })
      card.errors = isLast && lastTurnFailed ? 1 : 0
      card.conversationId = sessionId
      card.derived = true
      card.sourceRank = SOURCE_RANK_PARTIAL
      return { workspace: '', card }
    })
  }

  // ── Antigravity CLI (agy) ─────────────────────────────────────────────────────
  // Best-effort, from third-party evidence (see src/adapters/antigravity/known.ts, README →
  // Antigravity). One conversation = brain/<id>/.system_generated/logs/transcript.jsonl (steps:
  // prompts, assistant text, tool calls) + conversations/<id>.db (gen_metadata: tokens, model).

  private _scanAntigravity(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    for (const c of collectAntigravityConversations()) results.push(...this._processAntigravity(c))
    return results
  }

  /** Reads one conversation when its transcript, database or WAL changed (antigravityState), one
   *  result per turn that changed. A read that throws (a WAL caught mid-write) records no state,
   *  so the next scan tries again. */
  private _processAntigravity(c: AntigravityConversation): LogSessionResult[] {
    const st = antigravityState(c)
    if (!st) return []
    const prev = this.fileState.get(st.unit)
    if (prev && prev.mtimeMs === st.mtimeMs && prev.bytesRead === st.size) return []
    if (this._tooLarge(st.unit, st.totalBytes, st.mtimeMs)) {
      // Record the unit's own size so the state matches next pass (and a checkpoint that shrinks
      // the WAL reads as a change, like OpenCode's).
      this.fileState.set(st.unit, { bytesRead: st.size, mtimeMs: st.mtimeMs })
      return []
    }
    let results: LogSessionResult[]
    try {
      results = this._parseAntigravityConversation(c, st.mtimeMs, st.unit)
    } catch (err) {
      this.log(`[LogReader] Antigravity read error ${st.unit}: ${err}`)
      this.pendingObs = null
      return []
    }
    this.fileState.set(st.unit, { bytesRead: st.size, mtimeMs: st.mtimeMs })
    this._flushObservation({ filePath: st.unit, results })
    return this._onlyChanged(st.unit, results)
  }

  /** history.jsonl and cache/last_conversations.json of one root, re-read only when either changed. */
  private readonly agyHistory = new Map<string, { stamp: string; history: AntigravityHistoryRow[]; lastConversations: Map<string, string> }>()

  private _antigravityHistory(root: string): { history: AntigravityHistoryRow[]; lastConversations: Map<string, string> } {
    const histPath = path.join(root, 'history.jsonl')
    const lastPath = path.join(root, 'cache', 'last_conversations.json')
    const statOf = (f: string) => { try { return fs.statSync(f) } catch { return null } }
    const h = statOf(histPath), l = statOf(lastPath)
    const stamp = `${h?.mtimeMs ?? 0}:${h?.size ?? 0}:${l?.mtimeMs ?? 0}:${l?.size ?? 0}`
    const cached = this.agyHistory.get(root)
    if (cached && cached.stamp === stamp) return cached
    const history: AntigravityHistoryRow[] = []
    if (h && h.size <= this.maxFileBytes) {
      try {
        for (const line of fs.readFileSync(histPath, 'utf-8').split('\n')) {
          const row = parseLogLine(line) as Record<string, unknown> | undefined
          if (!row || typeof row !== 'object') continue
          const display = typeof row['display'] === 'string' ? row['display'] : ''
          const timestamp = typeof row['timestamp'] === 'number' ? row['timestamp'] : NaN
          if (!display || !Number.isFinite(timestamp)) continue
          history.push({
            display, timestamp,
            workspace: antigravityWorkspace(row['workspace']),
            conversationId: typeof row['conversationId'] === 'string' ? row['conversationId'] : '',
          })
        }
      } catch (err) { this.log(`[LogReader] Antigravity history read error ${histPath}: ${err}`) }
    }
    history.sort((a, b) => a.timestamp - b.timestamp)
    // workspace → most recent conversation; newer than history, so it wins for its conversation.
    const lastConversations = new Map<string, string>()
    if (l && l.size <= 16 * 1024 * 1024) {
      try {
        const obj = JSON.parse(fs.readFileSync(lastPath, 'utf-8')) as unknown
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          for (const [ws, id] of Object.entries(obj as Record<string, unknown>)) {
            const w = antigravityWorkspace(ws)
            if (w && typeof id === 'string') lastConversations.set(id, w)
          }
        }
      } catch (err) { this.log(`[LogReader] Antigravity last_conversations read error ${lastPath}: ${err}`) }
    }
    const entry = { stamp, history, lastConversations }
    this.agyHistory.set(root, entry)
    return entry
  }

  /** Reads one Antigravity conversation into one result per user turn:
   *
   *  - A turn opens at each transcript `USER_INPUT` step, and at each database step of type 14
   *    (USER_INPUT) the transcript hasn't caught up with; steps before the first opener join the
   *    first turn. Key: derivedTraceKey('antigravity', <conversation id>, `step:<opener index>`)
   *    — step indices are stable and append-only.
   *  - Tokens come only from the database's gen_metadata: each generation with non-zero usage
   *    belongs to the turn holding its highest step index, and becomes one LLM timeline entry.
   *    Output already includes thinking; cache write is never recorded (0).
   *  - Without a database (or with no usage-bearing generation in the turn yet), the turn has no
   *    token counts, its model is the `agy` placeholder that matches no rate — so cost reads as
   *    unknown, never $0 — and it is SOURCE_RANK_PARTIAL, like Cursor's.
   *  - Tool calls come from planner steps' `tool_calls` (name + args); no result, error or
   *    duration exists, so every tool entry is isError: false, durationMs: 0. */
  private _parseAntigravityConversation(c: AntigravityConversation, mtimeMs: number, unit: string): LogSessionResult[] {
    // ── Transcript ─────────────────────────────────────────────────────────
    let records: unknown[] | null = null
    const lines: AntigravityStep[] = []
    if (c.transcript) {
      const raw = fs.readFileSync(c.transcript, 'utf-8').split('\n').filter(l => l.trim())
      records = raw.map(parseLogLine)
      for (const r of records) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) continue
        const o = r as Record<string, unknown>
        if (typeof o['step_index'] !== 'number' || !Number.isFinite(o['step_index'])) continue
        lines.push({
          idx: o['step_index'] as number,
          type: typeof o['type'] === 'string' ? o['type'] : '',
          ms: typeof o['created_at'] === 'string' ? (Date.parse(o['created_at']) || 0) : 0,
          content: typeof o['content'] === 'string' ? o['content'] : '',
          thinking: typeof o['thinking'] === 'string' ? o['thinking'] : '',
          toolCalls: Array.isArray(o['tool_calls']) ? (o['tool_calls'] as unknown[]) : [],
        })
      }
      // Lines are not necessarily in step order.
      lines.sort((a, b) => a.idx - b.idx)
    }

    // ── Database ───────────────────────────────────────────────────────────
    const dbStepTypes = new Map<number, number>()
    const generations: Array<{ row: number; stepIdx: number; plannerIdx: number; usage: AntigravityUsage; model: string | null }> = []
    let observed = false
    if (c.db && this.sqlFactory) {
      let buf: Uint8Array = fs.readFileSync(c.db)
      try {
        const wal = fs.readFileSync(c.db + '-wal')
        if (wal.length > 32) buf = _mergeWal(buf, wal)
      } catch { /* no WAL — fully checkpointed */ }
      const db = new this.sqlFactory.Database(buf)
      try {
        if (this.observe) {
          this._flushObservation()
          try { this.pendingObs = { filePath: unit, logKey: 'antigravity', obs: observeAntigravity(records, db), mtimeMs } } catch (err) { this.log(`[LogReader] adapter health error ${unit}: ${err}`) }
          observed = true
        }
        const tables = new Set((db.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`)[0]?.values ?? []).map(r => String(r[0])))
        if (tables.has('steps')) {
          for (const [idx, type] of db.exec(`SELECT idx, step_type FROM steps ORDER BY idx`)[0]?.values ?? []) {
            if (typeof idx === 'number') dbStepTypes.set(idx, Number(type))
          }
        }
        const executors: AntigravityExecutor[] = []
        if (tables.has('executor_metadata')) {
          for (const [data] of db.exec(`SELECT data FROM executor_metadata ORDER BY idx`)[0]?.values ?? []) {
            const e = data instanceof Uint8Array ? decodeExecutor(data) : null
            if (e) executors.push(e)
          }
        }
        if (tables.has('gen_metadata')) {
          for (const [row, data] of db.exec(`SELECT idx, data FROM gen_metadata ORDER BY idx`)[0]?.values ?? []) {
            if (typeof row !== 'number' || !(data instanceof Uint8Array)) continue
            const g = decodeGeneration(data)
            // A generation with no (or all-zero) usage is a failed or retried attempt.
            if (!g?.usage || g.usage.input + g.usage.output + g.usage.cacheRead === 0) continue
            const stepIdx = g.stepIndices.length > 0 ? Math.max(...g.stepIndices) : row
            generations.push({
              row, stepIdx, plannerIdx: g.stepIndices[0] ?? row, usage: g.usage,
              model: resolveModel(g.model, g.displayName, executorModelFor(executors, stepIdx)),
            })
          }
        }
      } finally {
        db.close()
      }
    }
    if (this.observe && !observed) {
      this._flushObservation()
      try { this.pendingObs = { filePath: unit, logKey: 'antigravity', obs: observeAntigravity(records, null), mtimeMs } } catch (err) { this.log(`[LogReader] adapter health error ${unit}: ${err}`) }
    }

    // ── Turns ──────────────────────────────────────────────────────────────
    const lineByIdx = new Map<number, AntigravityStep>()
    for (const l of lines) if (!lineByIdx.has(l.idx)) lineByIdx.set(l.idx, l)
    const openerSet = new Set<number>()
    for (const l of lines) if (l.type === 'USER_INPUT') openerSet.add(l.idx)
    for (const [idx, type] of dbStepTypes) if (type === ANTIGRAVITY_STEP_USER_INPUT && !lineByIdx.has(idx)) openerSet.add(idx)
    let openers = [...openerSet].sort((a, b) => a - b)
    if (openers.length === 0) {
      // No prompt recorded at all: one turn from the first step that shows any work.
      const work = [...lines.filter(l => l.type === 'PLANNER_RESPONSE').map(l => l.idx), ...generations.map(g => g.stepIdx)]
      if (work.length === 0) return []
      openers = [Math.min(...lines.map(l => l.idx), ...work)]
    }
    const turnOf = (idx: number): number => {
      let t = 0
      for (let k = 0; k < openers.length; k++) if (openers[k] <= idx) t = k
      return t
    }

    // Prompts and workspace from history.jsonl / last_conversations.json.
    const { history, lastConversations } = this._antigravityHistory(c.root)
    const own = history.filter(r => r.conversationId === c.id)
    const usedRows = new Set<AntigravityHistoryRow>()
    const prompts = openers.map(idx => {
      const line = lineByIdx.get(idx)
      const text = line?.type === 'USER_INPUT' ? stripAntigravityEnvelope(line.content) : ''
      return { idx, text, ms: line?.ms ?? 0, row: null as AntigravityHistoryRow | null, fromTranscript: !!line }
    })
    const take = (p: typeof prompts[number], match: (r: AntigravityHistoryRow) => boolean) => {
      if (p.row) return
      const r = own.find(x => !usedRows.has(x) && match(x))
      if (r) { p.row = r; usedRows.add(r) }
    }
    // By time — exact ms, then the same second — then by text; a database-only opener (no
    // transcript line yet) takes the next unclaimed prompt after the previous turn's.
    for (const p of prompts) if (p.ms) take(p, r => r.timestamp === p.ms)
    for (const p of prompts) if (p.ms) take(p, r => Math.floor(r.timestamp / 1000) === Math.floor(p.ms / 1000))
    for (const p of prompts) if (p.text) take(p, r => r.display.trim() === p.text.trim())
    let floorMs = 0
    for (const p of prompts) {
      if (!p.fromTranscript) take(p, r => r.timestamp >= floorMs)
      floorMs = Math.max(floorMs, p.row?.timestamp ?? p.ms)
    }
    let workspace = lastConversations.get(c.id) ?? ''
    if (!workspace) workspace = [...own].reverse().find(r => r.workspace)?.workspace ?? ''
    if (!workspace) {
      // Older history rows carry no conversationId: an unambiguous same-text prompt within ±60 s.
      for (const p of prompts) {
        if (!p.text || !p.ms) continue
        const hits = history.filter(r => !r.conversationId && r.workspace && r.display.trim() === p.text.trim() && Math.abs(r.timestamp - p.ms) <= 60_000)
        if (hits.length === 1) { workspace = hits[0].workspace; break }
      }
    }

    // ── Cards ──────────────────────────────────────────────────────────────
    const spanPrefix = c.id.slice(0, 8)
    const toIso = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : '')
    const results: LogSessionResult[] = []
    for (let t = 0; t < openers.length; t++) {
      const turnLines = lines.filter(l => turnOf(l.idx) === t)
      const turnGens = generations.filter(g => turnOf(g.stepIdx) === t)
      const p = prompts[t]
      const userRequest = p.row?.display ?? p.text
      const times = turnLines.map(l => l.ms).filter(ms => ms > 0)
      const startMs = p.ms || p.row?.timestamp || (times.length ? Math.min(...times) : 0) || mtimeMs
      const endMs = Math.max(startMs, ...times)

      const toolCounts: Record<string, number> = {}
      const filesRead = new Set<string>(), filesChanged = new Set<string>(), filesWritten = new Set<string>(), filesSearched = new Set<string>()
      let totalToolCalls = 0
      const events: Array<{ ms: number; entry: TimelineEntry }> = []
      if (userRequest || p.fromTranscript) {
        events.push({ ms: startMs, entry: { type: 'user_input', spanId: `agy-u-${spanPrefix}-${p.idx}`, label: 'User', durationMs: 0, isError: false, timestamp: toIso(startMs), responseText: userRequest || undefined } })
      }
      const planners = turnLines.filter(l => l.type === 'PLANNER_RESPONSE')
      for (const l of planners) {
        const at = l.ms || startMs
        l.toolCalls.forEach((call, k) => {
          if (!call || typeof call !== 'object') return
          const name = typeof (call as Record<string, unknown>)['name'] === 'string' ? (call as Record<string, string>)['name'] : ''
          if (!name) return
          const rawArgs = (call as Record<string, unknown>)['args']
          const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {}
          totalToolCalls++
          toolCounts[name] = (toolCounts[name] ?? 0) + 1
          const f = antigravityToolFiles(name, args)
          if (f.read) filesRead.add(f.read)
          if (f.changed) filesChanged.add(f.changed)
          if (f.written) filesWritten.add(f.written)
          if (f.searched) filesSearched.add(f.searched)
          const target = f.read ?? f.changed ?? f.searched
          events.push({ ms: at, entry: {
            type: 'tool', spanId: `agy-tool-${spanPrefix}-${l.idx}-${k}`,
            label: target ? `${name}: ${path.basename(target)}` : name,
            action: name,
            toolInput: Object.keys(args).length > 0 ? JSON.stringify(args) : undefined,
            durationMs: 0, isError: false, timestamp: toIso(at),
          } })
        })
      }

      let totalInput = 0, totalOutput = 0, totalCacheRead = 0, peak = 0
      const modelTokens = new Map<string, number>()
      if (turnGens.length > 0) {
        turnGens.forEach((g, k) => {
          const planner = lineByIdx.get(g.plannerIdx) ?? lineByIdx.get(g.stepIdx)
          const at = planner?.ms || startMs
          totalInput += g.usage.input
          totalOutput += g.usage.output
          totalCacheRead += g.usage.cacheRead
          peak = Math.max(peak, g.usage.input + g.usage.cacheRead)
          if (g.model) modelTokens.set(g.model, (modelTokens.get(g.model) ?? 0) + g.usage.input + g.usage.cacheRead + g.usage.output)
          events.push({ ms: at, entry: {
            type: 'llm', spanId: `agy-gen-${spanPrefix}-${g.row}`, label: `Turn ${k + 1}`,
            model: g.model ?? undefined,
            inputTokens: g.usage.input + g.usage.cacheRead, outputTokens: g.usage.output,
            cacheReadTokens: g.usage.cacheRead, cacheCreateTokens: 0,
            durationMs: 0, isError: false, timestamp: toIso(at),
            responseText: planner?.content || undefined, thinking: planner?.thinking || undefined,
          } })
        })
      } else {
        planners.forEach((l, k) => {
          const at = l.ms || startMs
          if (!l.content && !l.thinking && l.toolCalls.length > 0) return
          events.push({ ms: at, entry: {
            type: 'llm', spanId: `agy-step-${spanPrefix}-${l.idx}`, label: `Turn ${k + 1}`,
            durationMs: 0, isError: false, timestamp: toIso(at),
            responseText: l.content || undefined, thinking: l.thinking || undefined,
          } })
        })
      }
      const models = rankModelsByWeight(modelTokens)
      const hasUsage = turnGens.length > 0
      const timeline = events.sort((a, b) => a.ms - b.ms).map(e => e.entry)
      const card = _buildCard(
        derivedTraceKey('antigravity', c.id, `step:${p.idx}`), 'antigravity',
        hasUsage ? (models[0] ?? ANTIGRAVITY_PLACEHOLDER_MODEL) : ANTIGRAVITY_PLACEHOLDER_MODEL,
        toIso(startMs), toIso(endMs),
        {
          totalInput, totalOutput, totalCacheRead, totalCacheCreate: 0, peakContextPerTurn: peak,
          turns: hasUsage ? turnGens.length : planners.length,
          totalToolCalls, toolCounts, filesRead, filesChanged, filesWritten, filesSearched,
          userRequest, timeline, initiator: 'user',
        },
        workspace,
        hasUsage && models.length > 0 ? models : undefined,
      )
      card.conversationId = c.id
      card.derived = true
      card.sourceRank = hasUsage ? SOURCE_RANK_FULL_TRANSCRIPT : SOURCE_RANK_PARTIAL
      results.push({ card, workspace })
    }
    return results
  }

  /** Returns all of the file's non-empty lines if it changed since the last read, else null. */
  private _readNewLines(filePath: string): string[] | null {
    try {
      const stat = fs.statSync(filePath)
      const prev = this.fileState.get(filePath)
      if (prev && stat.mtimeMs === prev.mtimeMs && stat.size === prev.bytesRead) return null
      if (this._tooLarge(filePath, stat.size, stat.mtimeMs)) return null

      // Always return the whole file's lines so each scan produces a complete card (a card
      // built from only the new lines would replace the full card and lose prior-turn data).
      // But these are append-only JSONL transcripts, so for a file that's actively growing,
      // only the appended bytes are read from disk — the earlier lines come from lineCache.
      const lines = this._readAllLinesIncremental(filePath, stat)
      this.fileState.set(filePath, { bytesRead: stat.size, mtimeMs: stat.mtimeMs })
      this.lastRead = filePath
      this.lastReadMtimeMs = stat.mtimeMs
      return lines
    } catch (err) {
      this.lineCache.delete(filePath)
      this.log(`[LogReader] read error ${filePath}: ${err}`)
      return null
    }
  }

  private _readAllLinesIncremental(filePath: string, stat: fs.Stats): string[] {
    const cached = this.lineCache.get(filePath)
    this.lineCache.delete(filePath)
    if (cached) this.lineCacheBytes -= cached.offset

    let lines: string[] = []
    let offset = 0
    let fd: number | undefined
    try {
      fd = fs.openSync(filePath, 'r')
      // Reuse the cache only if the file still starts with exactly what we read before: it must
      // not have shrunk, and the bytes just before our offset must be unchanged (a rewritten or
      // replaced file falls back to a full read).
      if (cached && stat.size >= cached.offset && cached.offset > 0) {
        const probeLen = Math.min(LINE_CACHE_PROBE_BYTES, cached.offset)
        const probe = Buffer.alloc(probeLen)
        fs.readSync(fd, probe, 0, probeLen, cached.offset - probeLen)
        if (probe.equals(cached.probe)) {
          lines = cached.lines
          offset = cached.offset
        }
      }
      const buf = Buffer.alloc(stat.size - offset)
      let got = 0
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, offset + got)
        if (n === 0) break
        got += n
      }
      const chunk = buf.subarray(0, got)
      // Only whole lines are cached; a trailing line still being written is returned this time
      // and re-read from its start next time. '\n' never occurs inside a multi-byte UTF-8
      // sequence, so splitting the bytes there is safe.
      const lastNl = chunk.lastIndexOf(0x0a)
      const complete = lastNl >= 0 ? chunk.subarray(0, lastNl + 1).toString('utf-8') : ''
      const tail = chunk.subarray(lastNl + 1).toString('utf-8')
      const newLines = complete.split('\n').filter(l => l.trim())
      const allComplete = newLines.length > 0 ? lines.concat(newLines) : lines
      const newOffset = offset + lastNl + 1

      const recentlyModified = Date.now() - stat.mtimeMs < LINE_CACHE_RECENT_MS
      if (recentlyModified && newOffset > 0 && newOffset <= LINE_CACHE_MAX_BYTES) {
        const probeLen = Math.min(LINE_CACHE_PROBE_BYTES, newOffset)
        const probe = Buffer.alloc(probeLen)
        fs.readSync(fd, probe, 0, probeLen, newOffset - probeLen)
        this.lineCache.set(filePath, { offset: newOffset, lines: allComplete, probe })
        this.lineCacheBytes += newOffset
        for (const [k, v] of this.lineCache) {
          if (this.lineCacheBytes <= LINE_CACHE_MAX_BYTES) break
          this.lineCache.delete(k)
          this.lineCacheBytes -= v.offset
        }
      }
      return tail.trim() ? allComplete.concat([tail]) : allComplete.slice()
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }

  /** Checks whether a file changed since the last scan; if so, delegates to parseFn (which reads
   *  its own bytes via _readNewLines — the state update happens there). For parsers that return
   *  one result per turn. Of a
   *  changed file only the turns whose card actually changed are returned (see _onlyChanged). */
  private _processFileMulti(
    filePath: string,
    parseFn: () => LogSessionResult[],
  ): LogSessionResult[] {
    try {
      const stat = fs.statSync(filePath)
      const prev = this.fileState.get(filePath)
      if (prev && stat.mtimeMs === prev.mtimeMs && stat.size === prev.bytesRead) return []
      this.lastRead = null
      const results = parseFn()
      const complete = this.lastRead === filePath
      this._flushObservation(complete && this.fileState.has(filePath) ? { filePath, results } : undefined)
      // Only a read that succeeded says what the file now produces (see _onlyChanged).
      return complete ? this._onlyChanged(filePath, results) : results
    } catch {
      this._flushObservation()
      return []
    }
  }

  /** A growing transcript is re-parsed whole, but only its newest turn usually changed: every
   *  earlier turn's card comes out identical. Returning those again would make every caller
   *  rewrite (and the cloud path rebuild a payload for) each turn of the file on every pass, so
   *  only turns whose card differs from the one last returned for this file go out.
   *
   *  Only ever called with a complete read of the file, so it also records the file's key set and
   *  notes any key it stopped producing (takeRetiredKeys). */
  private _onlyChanged(filePath: string, results: LogSessionResult[]): LogSessionResult[] {
    const prev = this.emittedTurns.get(filePath)
    const next = new Map<string, string>()
    const changed: LogSessionResult[] = []
    for (const r of results) {
      const fp = crypto.createHash('sha1').update(JSON.stringify(r)).digest('base64')
      next.set(r.card.sessionId, fp)
      if (prev?.get(r.card.sessionId) !== fp) changed.push(r)
    }
    this.emittedTurns.set(filePath, next)

    const keys = new Set(next.keys())
    for (const k of this.fileKeys.get(filePath) ?? []) {
      if (!keys.has(k)) this.retiredKeys.add(k)
    }
    if (keys.size > 0) this.fileKeys.set(filePath, keys)
    else this.fileKeys.delete(filePath)
    return changed
  }
}

// ── Shared card builder ───────────────────────────────────────────────────────

interface CardAccum {
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreate: number
  peakContextPerTurn: number
  turns: number
  totalToolCalls: number
  toolCounts: Record<string, number>
  filesRead: Set<string>
  filesChanged: Set<string>
  filesWritten: Set<string>
  filesSearched: Set<string>
  userRequest: string
  timeline: TimelineEntry[]
  initiator: 'user' | 'agent' | 'api'
}

// ── Turn boundaries ─────────────────────────────────────────────────────────
//
// Every log source is read one turn per trace (claudeTurns.ts, codexTurnRanges, one per Copilot
// request …).

/**
 * Drops any line whose `uuid` was already seen earlier in the file, keeping the first
 * occurrence. Confirmed on real transcript data: Claude Code can re-serialize and re-append a
 * large block of earlier conversation history into the same file — observed as a ~466-entry
 * (user/assistant/attachment) block sharing exact uuids and timestamps with much earlier entries,
 * differing only by one added field, plausibly a resume-across-version artifact rather than
 * anything this tool controls. Left uncaught, that block's old timestamps land late in the file
 * and get read as real new activity, and its content gets double-counted into turns/tokens/tool
 * calls. Lines with no `uuid` at all (session_meta, turn_context, and other non-message event
 * types) are never deduplicated — there's no reliable key to dedupe them by, and they're not
 * the source of this problem.
 */
export function dedupeByUuid(lines: string[]): string[] {
  return dedupeParsedByUuid(lines, lines.map(parseLogLine)).lines
}

/**
 * An agent's usage object with only its token counts that are finite, non-negative numbers; any
 * other value (a string, null, a nested object) is left out, so the caller's `?? 0` applies.
 * Usage was cast straight to numbers, so one non-numeric field in a log line ("12" or "n/a")
 * turned a trace's token totals into string concatenations and its cost into NaN.
 * Undefined when `raw` isn't an object.
 */
export function tokenUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
  }
  return out
}

/** Copilot CLI's `inputTokens` (session.usage_record, session.shutdown modelMetrics) counts the
 *  whole prompt — cache reads and writes included — while _buildCard adds the cache counts to the
 *  input it is given. This is the fresh part. */
function copilotFreshInput(usage: Record<string, number>): number {
  return Math.max(0, (usage['inputTokens'] ?? 0) - (usage['cacheReadTokens'] ?? 0) - (usage['cacheWriteTokens'] ?? 0))
}

/** JSON.parse of one log line, or undefined when it doesn't parse (JSON never yields undefined). */
function parseLogLine(line: string): unknown {
  try { return JSON.parse(line) as unknown } catch { return undefined }
}

/** dedupeByUuid over lines the caller already parsed (`parsed[i]` is `lines[i]` parsed, see
 *  parseLogLine); returns the kept lines alongside their parsed rows. */
function dedupeParsedByUuid(lines: string[], parsed: unknown[]): { lines: string[]; parsed: unknown[] } {
  const seen = new Set<string>()
  const result: string[] = []
  const resultParsed: unknown[] = []
  for (let i = 0; i < lines.length; i++) {
    const keep = () => { result.push(lines[i]); resultParsed.push(parsed[i]) }
    if (parsed[i] === undefined) { keep(); continue }
    const uuid = (parsed[i] as Record<string, unknown>)['uuid']
    if (typeof uuid !== 'string') { keep(); continue }
    if (seen.has(uuid)) continue
    seen.add(uuid)
    keep()
  }
  return { lines: result, parsed: resultParsed }
}

// A chain of bookkeeping events immediately preceding a real prompt (Codex: thread_settings_
// applied, task_started, and — only discovered by checking a second real file, after task_started
// alone turned out to have exactly the same problem as user_message — turn_aborted when the prior
// turn was interrupted rather than completed cleanly) all get logged within milliseconds of the
// new turn's own timestamp, arriving *before* the actual prompt-boundary line in file order.
// Anchoring the split purely on a fixed set of named event types is a losing game — every real
// file checked so far has turned up one more type in the cluster. WALKBACK_EPSILON_MS instead
// walks the boundary backward over *any* immediately-preceding lines within this tight a gap of
// each other, regardless of type, so an unrecognized future bookkeeping event is handled the same
// way as the ones already found rather than needing its own name added to a list.
const WALKBACK_EPSILON_MS = 2000

function defaultLineTimestampMs(entry: Record<string, unknown>): number | null {
  const ts = entry['timestamp'] as string | undefined
  const tsMs = ts ? Date.parse(ts) : NaN
  return Number.isFinite(tsMs) ? tsMs : null
}

/** The rollout's own session id (session_meta payload.id — Codex's thread id, the conversation
 *  id its OTEL spans carry as thread.id) and the cwd it recorded. */
function codexSessionMeta(parsed: unknown[]): { id: string; cwd: string; branch: string } {
  for (const e of parsed) {
    if (e === undefined) continue
    const entry = e as Record<string, unknown>
    if (entry['type'] !== 'session_meta') continue
    const payload = entry['payload'] as Record<string, unknown> | undefined
    const git = payload?.['git'] as Record<string, unknown> | undefined
    return {
      id: typeof payload?.['id'] === 'string' ? payload['id'] : '',
      cwd: payload?.['cwd'] ? String(payload['cwd']) : '',
      branch: recordedBranch(git?.['branch']),
    }
  }
  return { id: '', cwd: '', branch: '' }
}

/** A branch name an agent recorded, or '' — a detached HEAD (`HEAD`) names no branch. */
function recordedBranch(value: unknown): string {
  if (typeof value !== 'string') return ''
  const b = value.trim()
  return b && b !== 'HEAD' && b.length <= 255 ? b : ''
}

function codexTurnIdOf(entry: Record<string, unknown>, opening: boolean): string {
  const payload = entry['payload'] as Record<string, unknown> | undefined
  if (!payload) return ''
  // A turn_aborted names the turn it ended, not the one about to start.
  if (opening && payload['type'] === 'turn_aborted') return ''
  const id = payload['turn_id'] ?? payload['turnId']
  return typeof id === 'string' ? id : ''
}

/** The prompt a Codex rollout line carries, or null when it isn't one: an `event_msg`
 *  `user_message` (`payload.message`), or — from 0.167, which stopped writing user_message — an
 *  `event_msg` `item_completed` whose item is a `UserMessage` (its text content parts). */
export function codexPromptText(entry: Record<string, unknown>): string | null {
  if (entry['type'] !== 'event_msg') return null
  const payload = entry['payload'] as Record<string, unknown> | undefined
  if (payload?.['type'] === 'user_message') return String(payload['message'] ?? '')
  if (payload?.['type'] !== 'item_completed') return null
  const item = payload['item'] as Record<string, unknown> | undefined
  if (item?.['type'] !== 'UserMessage') return null
  const parts = Array.isArray(item['content']) ? item['content'] as Array<Record<string, unknown>> : []
  return parts.filter(p => typeof p?.['text'] === 'string').map(p => p['text'] as string).join('\n')
}

export interface CodexTurnRange {
  start: number
  end: number
  /** Index of the turn's prompt line (codexPromptText). */
  opening: number
  /** Codex's own turn id, or '' for a rollout that logs none (derived key). */
  turnId: string
  /** The prompt line's own timestamp string — the derived key's opening. */
  openingTs: string
}

/** One range of rollout lines per turn — see LogReader._parseCodexFile. */
export function codexTurnRanges(parsed: unknown[]): CodexTurnRange[] {
  const timestamps = parsed.map(e => (e === undefined ? null : defaultLineTimestampMs(e as Record<string, unknown>)))
  const openings: number[] = []
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i] as Record<string, unknown> | undefined
    if (e && codexPromptText(e) !== null) openings.push(i)
  }
  if (openings.length === 0) return []

  const ranges: CodexTurnRange[] = []
  for (let k = 0; k < openings.length; k++) {
    const opening = openings[k]
    let boundary = k === 0 ? 0 : opening
    // Never walk back onto (or past) the previous turn's own user_message.
    while (k > 0 && boundary - 1 > openings[k - 1]) {
      const prevTs = timestamps[boundary - 1]
      const curTs = timestamps[boundary]
      if (prevTs === null || curTs === null) break
      const delta = curTs - prevTs
      if (delta < 0 || delta > WALKBACK_EPSILON_MS) break
      boundary--
    }
    if (k > 0) ranges[ranges.length - 1].end = boundary
    const entry = parsed[opening] as Record<string, unknown>
    ranges.push({ start: boundary, end: parsed.length, opening, turnId: '', openingTs: String(entry['timestamp'] ?? opening) })
  }

  let anyTurnId = false
  for (const r of ranges) {
    for (let i = r.start; i < r.end && !r.turnId; i++) {
      const e = parsed[i] as Record<string, unknown> | undefined
      if (e) r.turnId = codexTurnIdOf(e, true)
    }
    if (r.turnId) anyTurnId = true
  }
  // A user_message inside a running turn (same turn_id — or none, in a rollout that otherwise
  // logs turn ids) is a message to that turn, not a new one.
  const merged: CodexTurnRange[] = []
  for (const r of ranges) {
    const prev = merged[merged.length - 1]
    if (prev && ((r.turnId && r.turnId === prev.turnId) || (!r.turnId && anyTurnId))) {
      prev.end = r.end
      continue
    }
    merged.push(r)
  }
  return merged
}

/** Copilot Chat's workspace: the sibling workspace.json two levels up
 *  (workspaceStorage/<hash>/workspace.json), '' for a no-folder or untitled window. */
function _vscodeChatWorkspace(chatFilePath: string): string {
  try {
    const wj = JSON.parse(fs.readFileSync(path.join(path.dirname(chatFilePath), '..', 'workspace.json'), 'utf-8')) as Record<string, unknown>
    const folderUri = String(wj['folder'] ?? '')
    if (folderUri.startsWith('file:///')) {
      let p = decodeURIComponent(folderUri.slice(7))  // strip 'file://'
      // On Windows file:///C:/... → /C:/... → strip leading slash
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
      return p
    }
  } catch { /* no workspace.json — no-folder or untitled window */ }
  return ''
}

function _buildCard(
  sessionId: string,
  source: 'claude_code' | 'codex' | 'copilot' | 'opencode' | 'cursor' | 'antigravity',
  model: string,
  firstTimestamp: string,
  lastTimestamp: string,
  acc: CardAccum,
  workspace = '',
  models?: string[],
): SessionSummaryCard {
  const startMs  = _parseTs(firstTimestamp)
  const endMs    = _parseTs(lastTimestamp)
  const durationMs = (endMs > 0 && startMs > 0) ? Math.max(0, endMs - startMs) : 0
  // Use total context (raw + cache read + cache create) as the denominator so the
  // rate stays 0–1. Using raw input_tokens alone produces rates >> 1 in multi-turn
  // sessions where the cached context dwarfs the new tokens added each turn.
  const totalContext = acc.totalInput + acc.totalCacheRead + acc.totalCacheCreate
  const cacheHitRate = totalContext > 0 ? acc.totalCacheRead / totalContext : 0

  return {
    sessionId,
    traceId: sessionId,
    source,
    dataSource: 'log',
    initiator: acc.initiator,
    workspace,
    userRequest: acc.userRequest.slice(0, 500),
    model,
    models: models ?? (model ? [model] : []),
    turns: acc.turns,
    inputTokens: totalContext,
    outputTokens: acc.totalOutput,
    cacheReadTokens: acc.totalCacheRead,
    cacheCreateTokens: acc.totalCacheCreate,
    cacheHitRate,
    durationMs,
    startTime: startMs > 0 ? new Date(startMs).toISOString() : '',
    filesRead:     Array.from(acc.filesRead),
    filesSearched: Array.from(acc.filesSearched),
    filesChanged:  Array.from(acc.filesChanged),
    filesWritten:  Array.from(acc.filesWritten),
    toolCounts: acc.toolCounts,
    totalToolCalls: acc.totalToolCalls,
    totalLlmCalls: acc.turns,
    errors: 0,
    outcome: acc.totalToolCalls > 0 ? 'tool_calls' : 'text_response',
    timeline: acc.timeline,
    backgroundSpans: [],
    loopSignals: [],
    peakContextPerTurn: acc.turns > 1 ? acc.peakContextPerTurn : undefined,
    ...deriveSessionLanguage({ filesRead: [...acc.filesRead], filesChanged: [...acc.filesChanged], filesWritten: [...acc.filesWritten] }),
    ...computeEditStats({ filesChanged: [...acc.filesChanged], timeline: acc.timeline }),
  }
}

// ── Antigravity helpers ───────────────────────────────────────────────────────

/** The model a turn without token data reports: matches no rate, so its cost reads as unknown
 *  (~$?) rather than $0 — like Cursor's `cursor-agent`. */
export const ANTIGRAVITY_PLACEHOLDER_MODEL = 'agy'

interface AntigravityStep {
  idx: number
  type: string
  ms: number
  content: string
  thinking: string
  toolCalls: unknown[]
}

interface AntigravityHistoryRow {
  display: string
  timestamp: number
  workspace: string
  conversationId: string
}

/** An absolute workspace path (`/…`, `\\…` or `X:\…` / `X:/…`), else '' — a relative one is no cwd. */
function antigravityWorkspace(v: unknown): string {
  if (typeof v !== 'string') return ''
  const w = v.trim()
  if (w.startsWith('/') || w.startsWith('\\\\')) return w
  return /^[A-Za-z]:[\\/]/.test(w) ? w : ''
}

const AGY_ENVELOPE_RE = /^<USER_REQUEST>([\s\S]*)<\/USER_REQUEST>\s*<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>\s*(?:<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>\s*)?$/

/** A `USER_INPUT` step's prompt without agy's injected envelope — `<USER_REQUEST>…</USER_REQUEST>`
 *  then `<ADDITIONAL_METADATA>…</ADDITIONAL_METADATA>` and an optional
 *  `<USER_SETTINGS_CHANGE>…</USER_SETTINGS_CHANGE>`, the whole string and nothing else (agentsview's
 *  antigravityCLIUserRequestRegex). Only the envelope's framing newlines are removed. An incomplete
 *  envelope, literal tags inside a prompt, or an empty request keep the original text. */
export function stripAntigravityEnvelope(s: string): string {
  const m = AGY_ENVELOPE_RE.exec(s.trim())
  if (!m) return s
  let request = m[1]
  if (request.startsWith('\r\n')) request = request.slice(2)
  else if (request.startsWith('\n')) request = request.slice(1)
  if (request.endsWith('\r\n')) request = request.slice(0, -2)
  else if (request.endsWith('\n')) request = request.slice(0, -1)
  return request.trim() ? request : s
}

/** A path from a tool argument: a `file://` URI decoded to a path, anything else as written. */
function antigravityArgPath(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = args[k]
    if (typeof v !== 'string' || !v.trim()) continue
    const raw = v.trim()
    if (!raw.startsWith('file://')) return raw
    try { return fileURLToPath(raw) } catch {
      try { return decodeURIComponent(raw.slice('file://'.length)) } catch { return raw.slice('file://'.length) }
    }
  }
  return undefined
}

/** Files one Antigravity tool call names, by tool and argument key — agentsview's observed names
 *  (best-effort: not confirmed for every agy version; README lists them to verify). `list_dir`
 *  names a directory, not a file, so it records nothing. */
export function antigravityToolFiles(name: string, args: Record<string, unknown>): { read?: string; changed?: string; written?: string; searched?: string } {
  switch (name) {
    case 'view_file':
      return { read: antigravityArgPath(args, ['AbsolutePath', 'AbsolutePathURI', 'path']) }
    case 'write_to_file': {
      const f = antigravityArgPath(args, ['TargetFile', 'file_path', 'path'])
      return { changed: f, written: f }
    }
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return { changed: antigravityArgPath(args, ['TargetFile', 'file_path', 'path']) }
    case 'grep_search':
      return { searched: antigravityArgPath(args, ['SearchPath', 'SearchPathURI', 'path']) }
    default:
      return {}
  }
}

// ── Text content helpers ──────────────────────────────────────────────────────

/**
 * Extracts the real user text from Copilot's `transformedContent` field, which
 * can be prefixed with injected XML-like blocks:
 *   <current_datetime>...</current_datetime>
 *   <system_reminder>...</system_reminder>
 * Returns the first non-empty line that isn't inside such a block.
 */
/** Files named by an apply_patch call's headers (`*** Update|Add|Delete File: <path>`, `*** Move
 *  to: <path>`). `rawArgs` is the patch text, or an object holding it under one of the keys the
 *  agents use. Only real paths count, never the `*** Begin Patch` / `*** End Patch` markers. */
export function applyPatchFilePaths(rawArgs: unknown): string[] {
  let patch = ''
  if (typeof rawArgs === 'string') patch = rawArgs
  else if (rawArgs && typeof rawArgs === 'object') {
    const a = rawArgs as Record<string, unknown>
    const v = a['input'] ?? a['patch'] ?? a['command'] ?? a['patchText']
    patch = Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : ''
  }
  const out = new Set<string>()
  for (const line of patch.split('\n')) {
    const m = line.match(APPLY_PATCH_FILE_HEADER_RE)
    const fp = m?.[1].trim()
    if (fp && /[\\/]/.test(fp)) out.add(fp)
  }
  return [...out]
}

function _extractCopilotUserText(raw: string): string {
  // Split into lines, skip lines that are entirely part of injected XML blocks.
  const lines = raw.split('\n')
  let inTag = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Opening XML-like injection tag — enter skip mode
    if (/^<[a-z_]+[^>]*>/.test(trimmed) && !trimmed.startsWith('</')) {
      // If the tag closes on the same line, skip just this line
      if (/<\/[a-z_]+>$/.test(trimmed)) continue
      inTag = true
      continue
    }
    // Closing tag — exit skip mode
    if (/^<\/[a-z_]+>/.test(trimmed)) { inTag = false; continue }
    if (inTag) continue
    return trimmed
  }
  return ''
}

/**
 * Strips IDE-injected context from a Codex user_message event.
 * When invoked from within VS Code, Codex prepends context in the form:
 *   "# Context from my IDE setup:\n\n## Active file: ...\n\n## My request for Codex:\n<actual prompt>"
 * The actual user text always follows "## My request for Codex:".
 * For plain messages (no preamble), the raw text is returned as-is.
 */
function _extractCodexUserText(raw: string): string {
  const marker = '## My request for Codex:\n'
  const idx = raw.indexOf(marker)
  if (idx !== -1) return raw.slice(idx + marker.length).trim()
  return raw
}

function _extractVSCodeCopilotUserText(raw: string): string {
  // renderedUserMessage is prefixed with injected XML blocks (<attachments>, <context>, …).
  // The actual user-typed text follows after the last closing tag.
  // Greedy match up through the last </tag> then take what remains.
  const stripped = raw.replace(/^[\s\S]*<\/[^>]+>\s*/, '').trim()
  if (stripped && stripped !== raw.trim()) return stripped.split('\n')[0]?.trim() ?? ''
  // stripped is empty → entire message was XML with no trailing user text (e.g. attachment-only).
  if (!stripped) return ''
  return raw.trim().split('\n')[0]?.trim() ?? ''
}

function _extractTextContent(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
        return (block['text'] as string).trim()
      }
    }
  }
  return ''
}

function _strOrUndef(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') { return undefined }
  return String(v)
}

/**
 * Merges committed WAL frames into the database buffer so sql.js can read
 * sessions written since the last checkpoint. SQLite WAL format (https://sqlite.org/fileformat2.html#walformat):
 *   - 32-byte header: magic, version, page size, seq, salt1, salt2, cksum1, cksum2
 *   - Frames: 24-byte frame header + pageSize bytes of page data
 *     Frame header: pgno (4), dbSize (4), salt1 (4), salt2 (4), cksum1 (4), cksum2 (4)
 * Like SQLite's own reader, a frame is valid only if its salts match the header and its
 * cumulative checksum (seeded by the header's) matches; reading stops at the first invalid
 * frame. Only frames up to and including the last valid commit frame (non-zero dbSize) are
 * applied — later frames are an in-flight or rolled-back transaction SQLite would not show.
 */
function _mergeWal(dbBuf: Uint8Array, walBuf: Uint8Array): Uint8Array {
  const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (walBuf.length < 32) return dbBuf
  const wDv = dv(walBuf)
  const magic = wDv.getUint32(0)
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return dbBuf
  const pageSize = wDv.getUint32(8)
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return dbBuf
  const salt1 = wDv.getUint32(16)
  const salt2 = wDv.getUint32(20)

  // Checksum words are big-endian when the magic's low bit is set, little-endian otherwise.
  const bigEndian = (magic & 1) === 1
  let s0 = 0, s1 = 0
  const checksum = (off: number, len: number) => {
    for (let i = off; i < off + len; i += 8) {
      s0 = (s0 + wDv.getUint32(i, !bigEndian) + s1) >>> 0
      s1 = (s1 + wDv.getUint32(i + 4, !bigEndian) + s0) >>> 0
    }
  }
  checksum(0, 24)
  if (s0 !== wDv.getUint32(24) || s1 !== wDv.getUint32(28)) return dbBuf  // corrupt/unsynced header

  const FRAME = 24 + pageSize
  // Last valid commit: the byte offset just past its frame, and the db size (pages) it records.
  let commitEnd = 0
  let commitPages = 0
  for (let off = 32; off + FRAME <= walBuf.length; off += FRAME) {
    const pgno   = wDv.getUint32(off)
    const dbSize = wDv.getUint32(off + 4)
    if (pgno === 0) break
    if (wDv.getUint32(off + 8) !== salt1 || wDv.getUint32(off + 12) !== salt2) break  // stale generation
    checksum(off, 8)
    checksum(off + 24, pageSize)
    if (s0 !== wDv.getUint32(off + 16) || s1 !== wDv.getUint32(off + 20)) break  // torn/unsynced write
    if (dbSize !== 0) { commitEnd = off + FRAME; commitPages = dbSize }
  }
  if (commitEnd === 0) return dbBuf

  let result = new Uint8Array(dbBuf)
  for (let off = 32; off < commitEnd; off += FRAME) {
    const pageOff = (wDv.getUint32(off) - 1) * pageSize
    const pageEnd = pageOff + pageSize
    if (pageEnd > result.length) {
      const ext = new Uint8Array(pageEnd)
      ext.set(result)
      result = ext
    }
    result.set(walBuf.subarray(off + 24, off + 24 + pageSize), pageOff)
  }
  // The last commit records the database's size after it — a VACUUM can shrink it.
  const size = commitPages * pageSize
  return result.length > size ? result.slice(0, size) : result
}

function _parseTs(ts: string): number {
  if (!ts) return 0
  // ISO string
  const ms = Date.parse(ts)
  if (!isNaN(ms)) return ms
  // Unix nanoseconds (very large numbers)
  const n = parseInt(ts)
  if (!isNaN(n) && n > 1e15) return Math.floor(n / 1e6)  // ns → ms
  return 0
}
