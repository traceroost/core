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
import type { SessionSummaryCard, TimelineEntry, EditDetail } from './summarizers/summarizerTypes'
import { VSCODE_FAMILY_IDE_NAMES } from './vscodeFamilyIdes'
import { rankModelsByWeight, isTaskNotificationOnly, summarizeTaskNotification } from './summarizers/helpers'
import { stripDateSuffix } from './pricing'
import { CodexLimitCollector, claudeLimitHit, dedupeHits, CLAUDE_SYNTHETIC_MODEL, type LimitReading, type LimitHit, type PlanStatus } from './planUsage/limitReadings'
import { deriveSessionLanguage } from './language'
import { computeEditStats } from './editStats'
import { segmentClaudeTurns, type ClaudeTurnSpan } from './claudeTurns'
import { traceKey, derivedTraceKey, SOURCE_RANK_FULL_TRANSCRIPT, SOURCE_RANK_PARTIAL } from './traceIdentity'

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

function codexSessionsDirs(): string[] {
  const envVal = process.env['CODEX_HOME']
  if (envVal) {
    return envVal.split(',').map(p => p.trim()).filter(Boolean)
      .map(p => path.join(p, 'sessions'))
  }
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    const appData = process.env['APPDATA']
    if (local) candidates.push(path.join(local, 'Codex', 'sessions'))
    if (appData) candidates.push(path.join(appData, 'Codex', 'sessions'))
  }
  candidates.push(path.join(homeDir(), '.codex', 'sessions'))
  return candidates.filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
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

export interface FileState {
  bytesRead: number
  mtimeMs: number
}

// Line cache for incremental reads of growing transcripts (LogReader._readNewLines): only files
// modified within LINE_CACHE_RECENT_MS are cached (historical files are read once at startup and
// never again), within a total budget of LINE_CACHE_MAX_BYTES of file content.
const LINE_CACHE_MAX_BYTES = 32 * 1024 * 1024
const LINE_CACHE_RECENT_MS = 60 * 60 * 1000
const LINE_CACHE_PROBE_BYTES = 256

// ── Public interface ──────────────────────────────────────────────────────────

/** Minimal sql.js surface needed to open an external SQLite file read-only. */
export interface OpenCodeSqlFactory {
  Database: new (data: Buffer | Uint8Array) => {
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
    close(): void
  }
}

export interface LogReaderOptions {
  log?: (msg: string) => void
  /** When provided, enables reading OpenCode sessions from its SQLite DB. */
  sqlFactory?: OpenCodeSqlFactory
}

export interface LogSessionResult {
  card: SessionSummaryCard
  /** Workspace path extracted from the log file (cwd). May be empty for Copilot. */
  workspace: string
  /** Subscription plan-limit readings found in this session's log (Codex only today). Kept off the
   *  card on purpose: limit data comes only from logs, so it must survive an OTEL card replacing
   *  this one — see .staged-features/subscription-limit-usage.md. Absent when there are none. */
  limitReadings?: LimitReading[]
  /** Plan limits hit during this session. Absent when there are none. */
  limitHits?: LimitHit[]
  /** The plan status from this session's last rate-limit event (Codex only). Absent when none. */
  planStatus?: PlanStatus
}

/** A subagent transcript folded into its parent turn (see LogReader._claudeSubagentsByTurn). */
interface ClaudeSubagent {
  parsed: unknown[]
  /** The id it was stored under as its own session before stable trace identity. */
  legacyId: string
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

  constructor(options: LogReaderOptions = {}) {
    this.log = options.log ?? (() => { /* silent */ })
    this.sqlFactory = options.sqlFactory
  }

  /** Clears cached file state so the next scan re-reads all files from scratch. */
  clearFileState(): void {
    this.fileState.clear()
    this.lineCache.clear()
    this.lineCacheBytes = 0
    this.emittedTurns.clear()
  }

  /** Plain-object snapshot of the per-file mtime/size cache, for a caller to persist to disk
   *  (a sidecar JSON file, e.g.) so the next process start can restore it via `importFileState`
   *  instead of re-parsing every historical log file from scratch. See
   *  .staged-issues/scalability.md, risk #1. */
  exportFileState(): Record<string, FileState> {
    return Object.fromEntries(this.fileState)
  }

  /** Restores a snapshot from `exportFileState`. Merges into (does not clear) any state already
   *  present — call before the first `scan()`/`parseFile()` of a process, while `fileState` is
   *  still empty, so a restored entry causes an unchanged file to be skipped exactly like it
   *  would have been within the same still-running process. */
  importFileState(snapshot: Record<string, FileState>): void {
    for (const [filePath, state] of Object.entries(snapshot)) {
      this.fileState.set(filePath, state)
    }
  }

  /**
   * Collects all session files across all agents, sorted newest-first by mtime.
   * Does NOT read file contents. Used by the startup batch-loader to process
   * files in priority order without one big synchronous block.
   */
  collectFileMeta(): Array<{ filePath: string; mtimeMs: number; agentKey: string }> {
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

    const baseSessionId = path.basename(filePath, '.jsonl')
    const turns = segmentClaudeTurns(parsed)
    if (turns.length === 0) return []
    const legacyIds = legacySegmentIdsByLine(parsed, baseSessionId, isClaudePromptBoundary)
    const subagentsByTurn = this._claudeSubagentsByTurn(filePath, baseSessionId, turns)

    const results: LogSessionResult[] = []
    const aliased = new Set<string>()
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
      // What this turn was stored under before stable trace identity: the whole file or its n-th
      // 30-minute-gap segment, plus each folded subagent transcript. The writer retires those
      // rows; the first turn of each becomes the alias old deep links resolve to.
      const legacyId = legacyIds[turn.opening]
      card.supersedes = [legacyId, ...subagents.map(s => s.legacyId)]
      card.aliases = subagents.map(s => s.legacyId)
      if (!aliased.has(legacyId)) { aliased.add(legacyId); card.aliases.unshift(legacyId) }
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
      const usage = rawUsage as Record<string, number> | undefined
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
      try { stat = fs.statSync(file); raw = fs.readFileSync(file, 'utf-8') } catch { continue }
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
      list.push({ parsed, legacyId: path.basename(file, '.jsonl') })
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
    const { id: rolloutId, cwd: fileWorkspace } = codexSessionMeta(parsed)
    const conversationId = rolloutId || baseSessionId
    const legacyIds = legacySegmentIdsByLine(parsed, baseSessionId, isCodexLegacyBoundary)
    const results: LogSessionResult[] = []
    const aliased = new Set<string>()
    let runningTotalTokenUsage: Record<string, number> | undefined
    for (const turn of codexTurnRanges(parsed)) {
      const key = turn.turnId ? traceKey('codex', turn.turnId) : derivedTraceKey('codex', conversationId, turn.openingTs)
      const segment = this._parseCodexSegment(lines.slice(turn.start, turn.end), key, runningTotalTokenUsage, fileWorkspace)
      if (segment.cumulativeUsage) runningTotalTokenUsage = segment.cumulativeUsage
      if (!segment.result) continue
      const card = segment.result.card
      // The rollout's own id — Codex's thread id, the conversation id its OTEL card carries too.
      card.conversationId = conversationId
      if (!turn.turnId) card.derived = true
      const legacyId = legacyIds[turn.opening]
      card.supersedes = [legacyId]
      card.aliases = aliased.has(legacyId) ? [] : [legacyId]
      aliased.add(legacyId)
      results.push(segment.result)
    }
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
        if (payload?.['type'] === 'user_message' && !userRequest) {
          const msg = String(payload['message'] ?? '').trim()
          if (msg) userRequest = _extractCodexUserText(msg)
        }
        if (payload?.['type'] === 'token_count') {
          const info = payload['info'] as Record<string, unknown> | undefined
          if (info?.['model']) model = String(info['model'])
          const total = info?.['total_token_usage'] as Record<string, number> | undefined
          const last  = info?.['last_token_usage']  as Record<string, number> | undefined
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
  //   session.start        → data.sessionId, data.selectedModel, data.startTime, data.context.cwd
  //   user.message         → data.transformedContent (user request text)
  //   assistant.message    → data.outputTokens, data.toolRequests
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
   *  `id` (or its timestamp). `session.shutdown` reports input and cache tokens for the whole
   *  session only — they land on the last turn so the session's totals stay right; per-turn input
   *  for Copilot CLI is unknown. */
  private _parseCopilotFile(filePath: string, sessionId: string): LogSessionResult[] {
    const lines = this._readNewLines(filePath)
    if (!lines) return []

    let workspace = ''
    let sessionModel = ''
    let sessionStart = ''
    let totalInputFromShutdown = 0
    let totalCacheRead = 0
    let totalCacheCreate = 0
    let sawShutdown = false
    interface Turn {
      opening: string; first: string; last: string; model: string; userRequest: string
      totalOutput: number; turns: number; totalToolCalls: number
      toolCounts: Record<string, number>; filesChanged: Set<string>
    }
    const turns: Turn[] = []
    const newTurn = (opening: string): Turn => ({ opening, first: '', last: '', model: '', userRequest: '', totalOutput: 0, turns: 0, totalToolCalls: 0, toolCounts: {}, filesChanged: new Set() })
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
            const args = req['arguments'] as Record<string, unknown> | undefined
            const fp = String(args?.['path'] ?? args?.['file_path'] ?? '')
            if (fp && (name === 'edit' || name === 'write' || name === 'create')) {
              cur.filesChanged.add(fp)
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
            const usage = (entry as Record<string, unknown>)?.['usage'] as Record<string, number> | undefined
            if (!usage) continue
            totalInputFromShutdown += usage['inputTokens']     ?? 0
            totalCacheRead          += usage['cacheReadTokens']  ?? 0
            totalCacheCreate        += usage['cacheWriteTokens'] ?? 0
          }
        }
      }
    }

    // No prompt at all: the session's one (prompt-less) turn, as before.
    if (turns.length === 0 && leading) turns.push(leading)
    const results: LogSessionResult[] = []
    let model = sessionModel
    turns.forEach((turn, i) => {
      const first = turn.first || (i === 0 ? sessionStart : '')
      if (!first) return
      if (turn.model) model = turn.model
      const isLast = i === turns.length - 1
      const key = derivedTraceKey('copilot', sessionId, turn.opening || first)
      const card = _buildCard(key, 'copilot', model || 'copilot', first, turn.last || first, {
        totalInput: isLast ? totalInputFromShutdown : 0,
        totalOutput: turn.totalOutput,
        totalCacheRead: isLast ? totalCacheRead : 0,
        totalCacheCreate: isLast ? totalCacheCreate : 0,
        peakContextPerTurn: 0,
        turns: turn.turns,
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
      card.sourceRank = turn.totalOutput > 0 || (isLast && sawShutdown) ? SOURCE_RANK_FULL_TRANSCRIPT : SOURCE_RANK_PARTIAL
      card.supersedes = [sessionId]
      card.aliases = i === 0 ? [sessionId] : []
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
      completion?: number; prompt?: number; elapsedMs?: number; pushLine: number
    }
    const reqs: Req[] = []
    let sessionCreatedMs = 0
    let model = ''
    const parsed = lines.map(parseLogLine)
    parsed.forEach((e, lineIdx) => {
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
            pushLine: lineIdx,
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
    const legacyIds = legacySegmentIdsByLine(parsed, baseSessionId, isCopilotVSCodeRequestsPush, copilotVSCodePushTimestampMs)
    const results: LogSessionResult[] = []
    const aliased = new Set<string>()
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
      const legacyId = legacyIds[req.pushLine]
      card.supersedes = [legacyId]
      card.aliases = aliased.has(legacyId) ? [] : [legacyId]
      aliased.add(legacyId)
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
      card.supersedes = [sid]
      card.aliases = i === 0 ? [sid] : []
      results.push({ workspace, card })
    })
    return results
  }

  // ── OpenCode ──────────────────────────────────────────────────────────────────
  // Primary data source: ~/.local/share/opencode/opencode.db (SQLite)
  //   Tables: session (id, parent_id, title, cwd, time), message (id, session_id, data JSON)
  // Fallback: ~/.local/share/opencode/storage/message/*.json (one JSON per message)
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
        this.fileState.set(dbPath, { bytesRead: stat.size, mtimeMs: effectiveMtime })
      } catch {
        continue
      }

      if (this.sqlFactory) {
        try {
          results.push(...this._parseOpenCodeDb(dbPath))
        } catch (err) {
          this.log(`[LogReader] OpenCode DB error ${dbPath}: ${err}`)
          results.push(...this._parseOpenCodeJsonFallback(dataDir))
        }
      } else {
        results.push(...this._parseOpenCodeJsonFallback(dataDir))
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
          card.supersedes = [sessionId]
          card.aliases = ti === 0 ? [sessionId] : []
          results.push({ card, workspace })
        })
      }
      return this._onlyChanged(dbPath, results)
    } finally {
      db.close()
    }
  }

  private _parseOpenCodeJsonFallback(dataDir: string): LogSessionResult[] {
    // Reads ~/.local/share/opencode/storage/message/*.json as a fallback when
    // the SQLite DB is unavailable. Each file is one message; session grouping
    // uses the session_id field. Session title and cwd are not available here, and
    // neither is a reliable user-message order — so unlike the database reader this
    // stays one trace per session, under a derived key (session id + 'session').
    const msgDir = path.join(dataDir, 'storage', 'message')
    let names: string[]
    try { names = fs.readdirSync(msgDir).filter(n => n.endsWith('.json')) } catch { return [] }

    const sessions = new Map<string, {
      model: string; sessionTime: string
      tokIn: number; tokOut: number; tokReasoning: number
      tokCacheRead: number; tokCacheWrite: number; turns: number
    }>()

    for (const name of names) {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(fs.readFileSync(path.join(msgDir, name), 'utf-8')) as Record<string, unknown> } catch { continue }
      if (msg['role'] !== 'assistant') continue
      const sessionId = String(msg['session_id'] ?? '')
      if (!sessionId) continue
      const tokens = msg['tokens'] as Record<string, unknown> | undefined
      const cache  = tokens?.['cache'] as Record<string, unknown> | undefined
      const modelId = String(msg['id'] ?? '')
      let s = sessions.get(sessionId)
      if (!s) {
        s = { model: modelId, sessionTime: '', tokIn: 0, tokOut: 0, tokReasoning: 0, tokCacheRead: 0, tokCacheWrite: 0, turns: 0 }
        sessions.set(sessionId, s)
      }
      if (modelId && !s.model) s.model = modelId
      s.tokIn        += Number(tokens?.['input']     ?? 0)
      s.tokOut       += Number(tokens?.['output']    ?? 0)
      s.tokReasoning += Number(tokens?.['reasoning'] ?? 0)
      s.tokCacheRead += Number(cache?.['read']  ?? 0)
      s.tokCacheWrite+= Number(cache?.['write'] ?? 0)
      s.turns++
    }

    const results: LogSessionResult[] = []
    for (const [sessionId, s] of sessions) {
      const totalOutput = s.tokOut + s.tokReasoning
      const card = _buildCard(
        derivedTraceKey('opencode', sessionId, 'session'), 'opencode', s.model || 'opencode',
        s.sessionTime, s.sessionTime,
        {
          totalInput: s.tokIn, totalOutput, totalCacheRead: s.tokCacheRead,
          totalCacheCreate: s.tokCacheWrite, peakContextPerTurn: 0,
          turns: s.turns, totalToolCalls: 0, toolCounts: {},
          filesRead: new Set(), filesChanged: new Set(),
          filesWritten: new Set(), filesSearched: new Set(),
          userRequest: '', timeline: [], initiator: 'user',
        },
        '',
      )
      card.conversationId = sessionId
      card.derived = true
      card.supersedes = [sessionId]
      card.aliases = [sessionId]
      results.push({ card, workspace: '' })
    }
    return results
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
      const content = fs.readFileSync(filePath, 'utf-8')
      this.fileState.set(filePath, { bytesRead: stat.size, mtimeMs: stat.mtimeMs })
      return JSON.parse(content) as Record<string, unknown>
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
   *  file and .staged-issues/support-cursor-cli.md for exactly what this format does and doesn't
   *  contain. A turn opens at each `role: 'user'` line (those persist across a `--resume`, unlike
   *  `turn_ended`). The format has no record ids and no timestamps, so a turn's derived key is the
   *  session id plus the turn's position among the file's prompts (stable for this append-only
   *  file), and every turn's times fall back to the file's birthtime — only the last turn ends at
   *  its mtime. No token/usage data, model name, or tool-call success signal exists on disk; those
   *  stay honest gaps (0 / unknown), never guessed. */
  private _parseCursorFile(filePath: string): LogSessionResult[] {
    const rawLines = this._readNewLines(filePath)
    if (!rawLines) return []

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
      card.supersedes = [sessionId]
      card.aliases = i === 0 ? [sessionId] : []
      return { workspace: '', card }
    })
  }

  /** Returns all of the file's non-empty lines if it changed since the last read, else null. */
  private _readNewLines(filePath: string): string[] | null {
    try {
      const stat = fs.statSync(filePath)
      const prev = this.fileState.get(filePath)
      if (prev && stat.mtimeMs === prev.mtimeMs && stat.size === prev.bytesRead) return null

      // Always return the whole file's lines so each scan produces a complete card (a card
      // built from only the new lines would replace the full card and lose prior-turn data).
      // But these are append-only JSONL transcripts, so for a file that's actively growing,
      // only the appended bytes are read from disk — the earlier lines come from lineCache.
      const lines = this._readAllLinesIncremental(filePath, stat)
      this.fileState.set(filePath, { bytesRead: stat.size, mtimeMs: stat.mtimeMs })
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
      return this._onlyChanged(filePath, parseFn())
    } catch {
      return []
    }
  }

  /** A growing transcript is re-parsed whole, but only its newest turn usually changed: every
   *  earlier turn's card comes out identical. Returning those again would make every caller
   *  rewrite (and the cloud path rebuild a payload for) each turn of the file on every pass, so
   *  only turns whose card differs from the one last returned for this file go out. */
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

// ── Turn boundaries and legacy segment ids ─────────────────────────────────
//
// Every log source is read one turn per trace (claudeTurns.ts, codexTurnRanges, one per Copilot
// request …). Before stable trace identity a transcript was read whole, or split into segments at a
// 30-minute gap between two prompts, and each segment was stored under `<file id>` / `<file id>#n`.
// That gap algorithm survives below only to name those old rows, so the writer can retire them and
// alias their ids (deep links) to the per-turn keys that replace them — it no longer decides what
// a trace is.

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

// The gap between two consecutive prompts that used to start a new stored segment (see the section
// comment above). Only names legacy rows now.
export const LEGACY_SEGMENT_GAP_MS = 30 * 60_000

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

/**
 * The legacy segments of a log, as [start, end) index ranges into its parsed lines: a new segment
 * started before a prompt line (isPromptBoundary) more than LEGACY_SEGMENT_GAP_MS after the
 * highest prompt timestamp so far, walked back over immediately-preceding near-simultaneous
 * bookkeeping lines (WALKBACK_EPSILON_MS). getBoundaryTimestampMs defaults to the top-level
 * `timestamp` string (Claude/Codex); Copilot VS Code's numeric `v[0].timestamp` overrides it.
 */
function promptGapBoundaries(
  parsed: unknown[],
  isPromptBoundary: (entry: Record<string, unknown>) => boolean,
  getBoundaryTimestampMs: (entry: Record<string, unknown>) => number | null = defaultLineTimestampMs,
): Array<[number, number]> {
  if (parsed.length === 0) return []

  const timestamps: Array<number | null> = parsed.map(entry => {
    if (entry === undefined) return null
    try { return defaultLineTimestampMs(entry as Record<string, unknown>) } catch { return null }
  })

  const boundaries: number[] = [0]
  // Tracks the highest prompt timestamp seen so far, not just the most recently seen one — real
  // transcripts can contain an isolated out-of-order timestamp (confirmed on real Claude Code
  // data: one entry mid-file stamped a full day earlier than its neighbors, apparently from
  // Claude Code's own resume/continuation handling). Comparing against the max rather than the
  // last value keeps a single such anomaly from corrupting the gap baseline for every comparison
  // after it.
  let maxTs: number | null = null
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i] === undefined) continue
    const entry = parsed[i] as Record<string, unknown>
    if (!isPromptBoundary(entry)) continue

    const tsMs = getBoundaryTimestampMs(entry)
    if (tsMs === null) continue

    if (maxTs !== null && tsMs - maxTs > LEGACY_SEGMENT_GAP_MS) {
      let boundary = i
      while (boundary > 0) {
        const prevTs = timestamps[boundary - 1]
        const curTs = timestamps[boundary]
        if (prevTs === null || curTs === null) break
        const delta = curTs - prevTs
        if (delta < 0 || delta > WALKBACK_EPSILON_MS) break
        boundary--
      }
      // Never walk back past (or onto) the previous boundary — a segment must keep at least one
      // line, and the previous segment's own real content must stay its own.
      const prevBoundary = boundaries[boundaries.length - 1]
      boundaries.push(Math.max(boundary, prevBoundary + 1))
    }
    maxTs = Math.max(maxTs ?? tsMs, tsMs)
  }

  const segments: Array<[number, number]> = []
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b]
    const end = b + 1 < boundaries.length ? boundaries[b + 1] : parsed.length
    segments.push([start, end])
  }
  return segments
}

/** The id each line was stored under before stable trace identity: the file's own id for its
 *  first 30-minute-gap segment, `<id>#<n>` for later ones (see promptGapBoundaries). Kept only so
 *  the writer can retire those rows and alias their ids to the per-turn keys that replace them. */
function legacySegmentIdsByLine(
  parsed: unknown[],
  baseSessionId: string,
  isPromptBoundary: (entry: Record<string, unknown>) => boolean,
  getBoundaryTimestampMs?: (entry: Record<string, unknown>) => number | null,
): string[] {
  const ids: string[] = new Array(parsed.length)
  promptGapBoundaries(parsed, isPromptBoundary, getBoundaryTimestampMs).forEach(([start, end], segmentIndex) => {
    for (let i = start; i < end; i++) ids[i] = claudeSegmentSessionId(baseSessionId, segmentIndex)
  })
  return ids
}

function isClaudePromptBoundary(entry: Record<string, unknown>): boolean {
  return entry['type'] === 'user'
}


// turn_aborted counted as a legacy boundary too: Codex logs it at the *resumption* time, too far
// (0.1 s to 31 s) from the next turn's bookkeeping for the walkback to absorb it.
function isCodexLegacyBoundary(entry: Record<string, unknown>): boolean {
  if (entry['type'] !== 'event_msg') return false
  const payload = entry['payload'] as Record<string, unknown> | undefined
  return payload?.['type'] === 'user_message' || payload?.['type'] === 'turn_aborted'
}

/** The rollout's own session id (session_meta payload.id — Codex's thread id, the conversation
 *  id its OTEL spans carry as thread.id) and the cwd it recorded. */
function codexSessionMeta(parsed: unknown[]): { id: string; cwd: string } {
  for (const e of parsed) {
    if (e === undefined) continue
    const entry = e as Record<string, unknown>
    if (entry['type'] !== 'session_meta') continue
    const payload = entry['payload'] as Record<string, unknown> | undefined
    return { id: typeof payload?.['id'] === 'string' ? payload['id'] : '', cwd: payload?.['cwd'] ? String(payload['cwd']) : '' }
  }
  return { id: '', cwd: '' }
}

function codexTurnIdOf(entry: Record<string, unknown>, opening: boolean): string {
  const payload = entry['payload'] as Record<string, unknown> | undefined
  if (!payload) return ''
  // A turn_aborted names the turn it ended, not the one about to start.
  if (opening && payload['type'] === 'turn_aborted') return ''
  const id = payload['turn_id'] ?? payload['turnId']
  return typeof id === 'string' ? id : ''
}

export interface CodexTurnRange {
  start: number
  end: number
  /** Index of the turn's user_message line. */
  opening: number
  /** Codex's own turn id, or '' for a rollout that logs none (derived key). */
  turnId: string
  /** The user_message's own timestamp string — the derived key's opening. */
  openingTs: string
}

/** One range of rollout lines per turn — see LogReader._parseCodexFile. */
export function codexTurnRanges(parsed: unknown[]): CodexTurnRange[] {
  const timestamps = parsed.map(e => (e === undefined ? null : defaultLineTimestampMs(e as Record<string, unknown>)))
  const openings: number[] = []
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i] as Record<string, unknown> | undefined
    if (!e || e['type'] !== 'event_msg') continue
    if ((e['payload'] as Record<string, unknown> | undefined)?.['type'] === 'user_message') openings.push(i)
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

function isCopilotVSCodeRequestsPush(entry: Record<string, unknown>): boolean {
  const k = entry['k']
  return entry['kind'] === 2 && Array.isArray(k) && k.length === 1 && k[0] === 'requests'
    && Array.isArray(entry['v']) && (entry['v'] as unknown[]).length > 0
}

// A `kind: 2` push to `requests` is how VS Code's delta-log format records a new request — its
// timestamp is numeric epoch-ms nested at v[0].timestamp (a push can batch several requests; the
// first is the earliest new activity in it).
function copilotVSCodePushTimestampMs(entry: Record<string, unknown>): number | null {
  const first = (entry['v'] as Array<Record<string, unknown>>)[0]
  const ts = first?.['timestamp']
  return typeof ts === 'number' ? ts : null
}

/** The id a legacy segment was stored under: the file's own id for segment 0, `<id>#<n>` after.
 *  Shared by every log format — Claude-named only because it shipped first. */
export function claudeSegmentSessionId(baseSessionId: string, segmentIndex: number): string {
  return segmentIndex === 0 ? baseSessionId : `${baseSessionId}#${segmentIndex}`
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
  source: 'claude_code' | 'codex' | 'copilot' | 'opencode' | 'cursor',
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

// ── Text content helpers ──────────────────────────────────────────────────────

/**
 * Extracts the real user text from Copilot's `transformedContent` field, which
 * can be prefixed with injected XML-like blocks:
 *   <current_datetime>...</current_datetime>
 *   <system_reminder>...</system_reminder>
 * Returns the first non-empty line that isn't inside such a block.
 */
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
