import { claudeUsageLines } from './claudeUsageLines'
/**
 * Reads local session logs for Claude Code, Codex, Copilot CLI, and
 * Copilot Chat (VS Code sidebar), and synthesises SessionSummaryCard records.
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
 * Data available from logs (vs OTEL):
 *   Claude / Codex: session ID, workspace, model, timestamps, full token counts
 *                   (incl. cache reads/writes), tool calls
 *   Copilot CLI:    session ID, workspace, model, timestamps, input/output/cache tokens
 *   Copilot Chat:   session ID, workspace, initial model, timestamps, output tokens per turn
 *                   (input tokens and cache tokens are not stored by VS Code)
 *   Not available in any log: TTFT, per-tool timing, streaming speed, loop signals
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { SessionSummaryCard, TimelineEntry, EditDetail } from './summarizers/summarizerTypes'
import { VSCODE_FAMILY_IDE_NAMES } from './vscodeFamilyIdes'
import { rankModelsByWeight } from './summarizers/helpers'
import { stripDateSuffix } from './pricing'

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

interface FileState {
  bytesRead: number
  mtimeMs: number
}

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
}

/** Wraps a single-or-null result as an array, for parsers that only ever produce one session
 *  per file (everything except Claude Code — see splitClaudeLinesOnPromptGaps). */
function _single(result: LogSessionResult | null): LogSessionResult[] {
  return result ? [result] : []
}

export class LogReader {
  private readonly log: (msg: string) => void
  private readonly sqlFactory: OpenCodeSqlFactory | undefined
  private readonly fileState = new Map<string, FileState>()

  constructor(options: LogReaderOptions = {}) {
    this.log = options.log ?? (() => { /* silent */ })
    this.sqlFactory = options.sqlFactory
  }

  /** Clears cached file state so the next scan re-reads all files from scratch. */
  clearFileState(): void {
    this.fileState.clear()
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

    // Newest first — caller processes in this order so recent sessions appear first.
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return entries
  }

  /**
   * Parses a single file identified by collectFileMeta() and returns any results if the file is
   * new or has grown since the last scan (usually one; Claude Code transcripts can yield more
   * than one when a large gap between prompts splits the file into multiple sessions — see
   * splitClaudeLinesOnPromptGaps). Returns [] if unchanged.
   */
  parseFile(filePath: string, agentKey: string): LogSessionResult[] {
    const sessionId = agentKey === 'copilot'
      ? path.basename(path.dirname(filePath))  // directory name is session UUID
      : agentKey === 'copilot_vscode_json'
        ? path.basename(filePath, '.json')
        : path.basename(filePath, '.jsonl')

    switch (agentKey) {
      case 'claude':              return this._processFileMulti(filePath, () => this._parseClaudeFile(filePath))
      case 'codex':               return this._processFileMulti(filePath, () => this._parseCodexFile(filePath))
      case 'copilot':             return _single(this._processFile(filePath, () => this._parseCopilotFile(filePath, sessionId)))
      case 'copilot_vscode':      return this._processFileMulti(filePath, () => this._parseCopilotVSCodeFile(filePath))
      case 'copilot_vscode_json': return _single(this._processFile(filePath, () => this._parseCopilotVSCodeJsonFile(filePath, sessionId)))
      case 'opencode':            return []  // OpenCode DB returns multiple sessions; use _scanOpenCode
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
    ]
  }

  // ── Claude Code ─────────────────────────────────────────────────────────────

  private _scanClaude(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    for (const projectsDir of claudeProjectsDirs()) {
      this._collectJsonlFiles(projectsDir).forEach(filePath => {
        results.push(...this._processFileMulti(filePath, () => this._parseClaudeFile(filePath)))
      })
    }
    return results
  }

  /** Reads a Claude Code transcript and splits it into one or more session results — see
   *  splitClaudeLinesOnPromptGaps for why a single file can yield more than one session, and
   *  dedupeByUuid for why duplicate lines are dropped before any of that runs. */
  private _parseClaudeFile(filePath: string): LogSessionResult[] {
    const rawLines = this._readNewLines(filePath)
    if (!rawLines) return []
    const lines = dedupeByUuid(rawLines)

    const baseSessionId = path.basename(filePath, '.jsonl')
    const segments = splitClaudeLinesOnPromptGaps(lines)
    const results: LogSessionResult[] = []
    segments.forEach((segmentLines, segmentIndex) => {
      const result = this._parseClaudeSegment(segmentLines, claudeSegmentSessionId(baseSessionId, segmentIndex))
      if (result) results.push(result)
    })
    // Tag every segment with the file they came from, but only when the file actually split into
    // more than one — a lone segment's conversationId equal to its own sessionId is meaningless.
    // The frontend uses this to group and color-code rows that are really one conversation split
    // across multiple session cards.
    if (results.length > 1) {
      for (const r of results) r.card.conversationId = baseSessionId
    }
    return results
  }

  private _parseClaudeSegment(lines: string[], sessionId: string): LogSessionResult | null {
    let workspace = ''
    let model = ''
    let firstTimestamp = ''
    let lastTimestamp = ''
    let userRequest = ''
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
    const usageLines = claudeUsageLines(lines)

    for (const [lineIndex, line] of lines.entries()) {
      let entry: Record<string, unknown>
      try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }

      const ts = entry['timestamp'] as string | undefined
      if (ts) { if (!firstTimestamp) firstTimestamp = ts; lastTimestamp = ts }
      if (entry['cwd'] && !workspace) workspace = entry['cwd'] as string

      if (entry['type'] === 'user') {
        // isSidechain: true → session was spawned by the Agent tool, not typed by a human.
        // <local-command-caveat> prefix → session started via `claude -p` (non-interactive API).
        if (!userRequest) {
          if (entry['isSidechain'] === true) initiator = 'agent'
        }
        const content = (entry['message'] as Record<string, unknown>)?.['content']
        const text = _extractTextContent(content)
        if (!userRequest && text) {
          if (initiator === 'user' && text.startsWith('<local-command-caveat>')) {
            initiator = 'api'
            const afterCaveat = text.replace(/^<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/i, '').trim()
            userRequest = afterCaveat || '[api session]'
          } else {
            userRequest = text
          }
        }
        timeline.push({ type: 'user_input', spanId: `log-u-${idx}`, label: 'User', durationMs: 0, isError: false, timestamp: ts ?? '', responseText: text })
        idx++
      }

      if (entry['type'] === 'assistant') {
        const msg = entry['message'] as Record<string, unknown> | undefined
        if (msg?.['model']) model = msg['model'] as string
        const rawUsage = msg?.['usage'] as Record<string, unknown> | undefined
        if (rawUsage?.['speed'] === 'fast') hasFastMode = true
        const usage = rawUsage as Record<string, number> | undefined
        let msgTotalInput = 0, msgCacheRead = 0, msgCacheCreate = 0, msgOutput = 0
        if (usage && usageLines.has(lineIndex)) {
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
          if (model) {
            modelTokens.set(model, (modelTokens.get(model) ?? 0) + msgTotalInput + msgOutput)
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
        timeline.push({
          type: hasToolCall ? 'tool' : 'llm',
          spanId: `log-a-${idx}`,
          label: hasToolCall ? 'Tool calls' : 'Response',
          model: model || undefined,
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
    }

    if (!firstTimestamp) return null
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
    return { workspace, card: _buildCard(sessionId, 'claude_code', effectiveModel || 'claude', firstTimestamp, lastTimestamp, { totalInput, totalOutput, totalCacheRead, totalCacheCreate, peakContextPerTurn, turns, totalToolCalls, toolCounts, filesRead, filesChanged, filesWritten, filesSearched: new Set(), userRequest, timeline, initiator }, workspace, models) }
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

  /** Reads a Codex CLI transcript and splits it into one or more session results — same
   *  one-file-can-span-real-days problem as Claude Code (confirmed on real data: files spanning
   *  two real weeks with multi-day gaps between prompts), same fix. See
   *  splitCodexLinesOnPromptGaps for what counts as a new prompt in this format. No duplicate-uuid
   *  issue found in Codex's format during validation (unlike Claude Code's — see dedupeByUuid),
   *  so no dedup step here; revisit if real data ever shows otherwise.
   *
   *  One thing splitting alone doesn't handle: Codex's token_count events report a
   *  total_token_usage that's cumulative for the *entire file*, not per-turn — confirmed on real
   *  data (input_tokens climbing 16k → 33k → ... → 489k monotonically across an 8-day span with
   *  no resets). Slicing lines into segments without accounting for this would give every segment
   *  after the first the *entire session's* running total, not its own — segment 3 would report
   *  segments 0+1+2+3's combined tokens as if they were its own. _parseCodexSegment takes the
   *  previous segment's ending cumulative usage as a baseline and subtracts it, so each segment
   *  reports only its own delta; running_totalTokenUsage carries that baseline forward across
   *  segments (including ones with no token_count events of their own, which must inherit the
   *  prior segment's cumulative value unchanged, not reset to zero). */
  private _parseCodexFile(filePath: string): LogSessionResult[] {
    const lines = this._readNewLines(filePath)
    if (!lines) return []

    const baseSessionId = path.basename(filePath, '.jsonl')
    const segments = splitCodexLinesOnPromptGaps(lines)
    const results: LogSessionResult[] = []
    let runningTotalTokenUsage: Record<string, number> | undefined
    segments.forEach((segmentLines, segmentIndex) => {
      const parsed = this._parseCodexSegment(segmentLines, claudeSegmentSessionId(baseSessionId, segmentIndex), runningTotalTokenUsage)
      if (parsed.result) results.push(parsed.result)
      if (parsed.cumulativeUsage) runningTotalTokenUsage = parsed.cumulativeUsage
    })
    // See the matching comment in _parseClaudeFile — same conversationId tagging, same reason.
    if (results.length > 1) {
      for (const r of results) r.card.conversationId = baseSessionId
    }
    return results
  }

  private _parseCodexSegment(
    lines: string[],
    sessionId: string,
    baselineUsage: Record<string, number> | undefined,
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

    for (const line of lines) {
      let entry: Record<string, unknown>
      try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }

      const ts = entry['timestamp'] as string | undefined
      if (ts) {
        if (!firstTimestamp) firstTimestamp = ts
        if (entry['type'] === 'event_msg') lastTimestamp = ts
      }

      // session_meta carries the actual project working directory
      if (entry['type'] === 'session_meta' && !workspace) {
        const payload = entry['payload'] as Record<string, unknown> | undefined
        if (payload?.['cwd']) workspace = String(payload['cwd'])
      }

      // turn_context carries the model name
      if (entry['type'] === 'turn_context') {
        const payload = entry['payload'] as Record<string, unknown> | undefined
        if (payload?.['model']) model = String(payload['model'])
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
        }
      }
    }

    if (!firstTimestamp) return { result: null, cumulativeUsage: undefined }

    // total_token_usage is cumulative for the whole file — this segment's own contribution is
    // the delta from the previous segment's ending cumulative value (0 for segment 0). A segment
    // with no token_count events of its own (lastTotalUsage undefined) contributed nothing new.
    let totalCacheRead = 0, totalInput = 0, totalOutput = 0
    if (lastTotalUsage) {
      const baseCacheRead = baselineUsage?.['cached_input_tokens'] ?? 0
      const baseInputRaw  = Math.max(0, (baselineUsage?.['input_tokens'] ?? 0) - baseCacheRead)
      const baseOutput    = (baselineUsage?.['output_tokens'] ?? 0) + (baselineUsage?.['reasoning_output_tokens'] ?? 0)

      const curCacheRead = lastTotalUsage['cached_input_tokens'] ?? 0
      // input_tokens includes cached, so subtract to get the raw (non-cached) portion that
      // _buildCard will re-add alongside cacheRead.
      const curInputRaw  = Math.max(0, (lastTotalUsage['input_tokens'] ?? 0) - curCacheRead)
      // Include reasoning tokens in output — they're billed at the output rate for o-series.
      const curOutput    = (lastTotalUsage['output_tokens'] ?? 0) + (lastTotalUsage['reasoning_output_tokens'] ?? 0)

      totalCacheRead = Math.max(0, curCacheRead - baseCacheRead)
      totalInput     = Math.max(0, curInputRaw - baseInputRaw)
      totalOutput    = Math.max(0, curOutput - baseOutput)
    }

    return {
      result: {
        workspace,
        card: _buildCard(sessionId, 'codex', model || 'codex', firstTimestamp, lastTimestamp, { totalInput, totalOutput, totalCacheRead, totalCacheCreate: 0, peakContextPerTurn: 0, turns, totalToolCalls: 0, toolCounts: {}, filesRead: new Set(), filesChanged: new Set(), filesWritten: new Set(), filesSearched: new Set(), userRequest: userRequest.slice(0, 500), timeline: [], initiator: 'user' }, workspace),
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
      const result = this._processFile(eventsFile, () => this._parseCopilotFile(eventsFile, sessionDirName))
      if (result) results.push(result)
    }

    return results
  }

  private _parseCopilotFile(filePath: string, sessionId: string): LogSessionResult | null {
    const lines = this._readNewLines(filePath)
    if (!lines) return null

    let workspace = ''
    let model = ''
    let firstTimestamp = ''
    let lastTimestamp = ''
    let userRequest = ''
    let totalOutput = 0
    let totalInputFromShutdown = 0
    let totalCacheRead = 0
    let totalCacheCreate = 0
    let turns = 0, totalToolCalls = 0
    const toolCounts: Record<string, number> = {}
    const filesChanged = new Set<string>()

    for (const line of lines) {
      let event: Record<string, unknown>
      try { event = JSON.parse(line) as Record<string, unknown> } catch { continue }

      const ts = event['timestamp'] as string | undefined
      if (ts) {
        if (!firstTimestamp) firstTimestamp = ts
        const type = event['type'] as string | undefined
        if (type === 'user.message' || type === 'assistant.message' || type === 'session.shutdown') lastTimestamp = ts
      }

      const type = event['type'] as string | undefined
      const data = event['data'] as Record<string, unknown> | undefined
      if (!type || !data) continue

      if (type === 'session.start') {
        if (data['selectedModel']) model = String(data['selectedModel'])
        const ctx = data['context'] as Record<string, unknown> | undefined
        if (ctx?.['cwd']) workspace = String(ctx['cwd'])
        if (data['startTime'] && !firstTimestamp) firstTimestamp = String(data['startTime'])
      }

      if (type === 'user.message' && !userRequest) {
        userRequest = _extractCopilotUserText(String(data['transformedContent'] ?? ''))
      }

      if (type === 'assistant.message') {
        const outTok = data['outputTokens'] as number | undefined
        if (outTok) { totalOutput += outTok; turns++ }
        const toolReqs = data['toolRequests'] as Array<Record<string, unknown>> | undefined
        if (toolReqs) {
          for (const req of toolReqs) {
            const name = String(req['name'] ?? '')
            if (!name) continue
            totalToolCalls++
            toolCounts[name] = (toolCounts[name] ?? 0) + 1
            // Track file paths from write/edit tools
            const args = req['arguments'] as Record<string, unknown> | undefined
            const fp = String(args?.['path'] ?? args?.['file_path'] ?? '')
            if (fp && (name === 'edit' || name === 'write' || name === 'create')) {
              filesChanged.add(fp)
            }
          }
        }
        if (data['model']) model = String(data['model'])
      }

      if (type === 'session.shutdown') {
        // modelMetrics[model].usage has the real cumulative token counts.
        // data['currentTokens'] is only the context window size at shutdown — do not use it.
        const metrics = data['modelMetrics'] as Record<string, Record<string, unknown>> | undefined
        if (metrics) {
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

    if (!firstTimestamp) return null

    return {
      workspace,
      card: _buildCard(sessionId, 'copilot', model || 'copilot', firstTimestamp, lastTimestamp, {
        totalInput: totalInputFromShutdown,
        totalOutput,
        totalCacheRead,
        totalCacheCreate,
        peakContextPerTurn: 0,
        turns,
        totalToolCalls,
        toolCounts,
        filesRead: new Set(),
        filesChanged,
        filesWritten: new Set(),
        filesSearched: new Set(),
        userRequest: userRequest.slice(0, 500),
        timeline: [],
        initiator: 'user',
      }, workspace),
    }
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
              const result = this._processFile(filePath, () => this._parseCopilotVSCodeJsonFile(filePath, sessionId))
              if (result) results.push(result)
            }
          }
        }
      } catch { /* root not accessible */ }
    }
    return results
  }

  /** Reads a Copilot Chat (VS Code) transcript and splits it into one or more session results —
   *  same one-file-can-span-real-days problem as Claude Code and Codex (confirmed on real data:
   *  files spanning up to 121.7 real hours, one gap alone 61.5 hours). See
   *  splitCopilotVSCodeLinesOnPromptGaps for what counts as a new prompt in this format. No
   *  cumulative-counter issue like Codex's (this format's token counts are already keyed per-turn
   *  index, not a running total) and no duplicate-uuid issue like Claude Code's found in this
   *  format during validation — but a different wrinkle unique to this format: a `kind: 1` update
   *  (e.g. `k: ["requests", N, "completionTokens"]`) addresses request N by its position in the
   *  *whole session's* requests array, not a position relative to whichever segment it happens to
   *  fall in. Re-parsing each segment's lines starting a local turn counter at 0 would misalign
   *  every kind=1 update after the first segment. _parseCopilotVSCodeSegment takes the number of
   *  requests already pushed by prior segments as startingTurnIndex and continues counting from
   *  there, so a segment's own turn-index keys line up with what kind=1 updates actually address. */
  private _parseCopilotVSCodeFile(filePath: string): LogSessionResult[] {
    const lines = this._readNewLines(filePath)
    if (!lines) return []

    // Workspace from sibling workspace.json two levels up (workspaceStorage/<hash>/workspace.json)
    // — read once per file, not per segment, since it's the same for every segment in this file.
    const workspaceJsonPath = path.join(path.dirname(filePath), '..', 'workspace.json')
    let workspace = ''
    try {
      const wj = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8')) as Record<string, unknown>
      const folderUri = String(wj['folder'] ?? '')
      if (folderUri.startsWith('file:///')) {
        let p = decodeURIComponent(folderUri.slice(7))  // strip 'file://'
        // On Windows file:///C:/... → /C:/... → strip leading slash
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
        workspace = p
      }
    } catch { /* no workspace.json — no-folder or untitled window */ }

    const baseSessionId = path.basename(filePath, '.jsonl')
    const segments = splitCopilotVSCodeLinesOnPromptGaps(lines)
    const results: LogSessionResult[] = []
    let startingTurnIndex = 0
    segments.forEach((segmentLines, segmentIndex) => {
      const parsed = this._parseCopilotVSCodeSegment(
        segmentLines,
        claudeSegmentSessionId(baseSessionId, segmentIndex),
        workspace,
        startingTurnIndex,
      )
      if (parsed.result) results.push(parsed.result)
      startingTurnIndex += parsed.turnsPushed
    })
    // See the matching comment in _parseClaudeFile — same conversationId tagging, same reason.
    if (results.length > 1) {
      for (const r of results) r.card.conversationId = baseSessionId
    }
    return results
  }

  private _parseCopilotVSCodeSegment(
    lines: string[],
    sessionId: string,
    workspace: string,
    startingTurnIndex: number,
  ): { result: LogSessionResult | null; turnsPushed: number } {
    let sessionCreatedMs = 0
    let model = ''
    let userRequest = ''
    let totalOutput = 0

    // Per-turn data keyed by turn index.
    // completionTokens appears in three formats depending on VS Code / Copilot Chat version:
    //   Format A (current):  kind=1, k=["requests", N, "completionTokens"], v=number
    //   Format B (current):  embedded in kind=2 push object as req.completionTokens
    //   Format C (pre-mid-2026): kind=1, k=["requests", N, "result"], v.usage.completionTokens
    //     Format C also carries v.usage.promptTokens (per-turn input tokens — correct for billing).
    // kind=1 always takes precedence over Format B (arrives later, streaming-final value).
    const turnCompletionTokens = new Map<number, number>()
    const turnPromptTokens = new Map<number, number>()  // Format C only
    const turnTimestamps: number[] = []
    // Continues the whole session's turn numbering rather than starting at 0 — see this method's
    // own doc comment on _parseCopilotVSCodeFile for why.
    let requestPushCount = startingTurnIndex

    for (const line of lines) {
      let entry: Record<string, unknown>
      try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }

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

      // kind=2 push to 'requests' — new turn(s); may already carry completionTokens (Format B).
      // k must be exactly ['requests']; k=['requests', N, 'response'] are sub-array pushes for
      // turn response entries and must not be treated as new request objects.
      if (kind === 2 && Array.isArray(k) && k.length === 1 && k[0] === 'requests' && Array.isArray(v)) {
        for (let j = 0; j < (v as unknown[]).length; j++) {
          const req = (v as Array<Record<string, unknown>>)[j]
          const turnIdx = requestPushCount + j
          if (typeof req['timestamp'] === 'number') turnTimestamps[turnIdx] = req['timestamp']
          // Format B: completionTokens already in the push object (don't overwrite kind=1 value)
          if (typeof req['completionTokens'] === 'number' && !turnCompletionTokens.has(turnIdx)) {
            turnCompletionTokens.set(turnIdx, req['completionTokens'])
          }
          // Format B: message.text is the raw user prompt — much cleaner than renderedUserMessage.
          // Checks against this *segment's* own first turn (startingTurnIndex), not the whole
          // session's global turn 0 — every segment after the first needs its own prompt captured
          // from its own first turn, not just the file's very first one.
          if (turnIdx === startingTurnIndex && !userRequest) {
            const msg = req['message'] as Record<string, unknown> | undefined
            if (typeof msg?.['text'] === 'string' && (msg['text'] as string).trim()) {
              userRequest = (msg['text'] as string).trim()
            }
          }
          // Format B: modelId field (e.g. "copilot/gpt-4.1")
          if (!model && typeof req['modelId'] === 'string') {
            model = (req['modelId'] as string).replace(/^copilot\//, '')
          }
        }
        requestPushCount += (v as unknown[]).length
      }

      // kind=1 sets on a specific request key (Format A/C, or late-arriving streaming final value)
      if (kind === 1 && Array.isArray(k) && k[0] === 'requests' && typeof k[1] === 'number') {
        const idx = k[1] as number
        // Format A: output tokens stored directly at the completionTokens key
        if (k[2] === 'completionTokens' && typeof v === 'number') {
          turnCompletionTokens.set(idx, v)
        }
        if (k[2] === 'result' && v && typeof v === 'object') {
          const result = v as Record<string, unknown>
          // Format C (pre-mid-2026): token counts nested inside result.usage
          const usage = result['usage'] as Record<string, number> | undefined
          if (usage) {
            if (typeof usage['completionTokens'] === 'number') {
              turnCompletionTokens.set(idx, usage['completionTokens'])
            }
            if (typeof usage['promptTokens'] === 'number') {
              turnPromptTokens.set(idx, usage['promptTokens'])
            }
          }
          // User message from renderedUserMessage (any-turn fallback when message.text not available)
          if (!userRequest) {
            const meta = result['metadata'] as Record<string, unknown> | undefined
            const rendered = meta?.['renderedUserMessage'] as Array<Record<string, unknown>> | undefined
            if (rendered) {
              for (const chunk of rendered) {
                if (chunk['type'] === 1 && typeof chunk['text'] === 'string') {
                  userRequest = _extractVSCodeCopilotUserText(chunk['text'])
                  if (userRequest) break
                }
              }
            }
          }
        }
      }
    }

    for (const tokens of turnCompletionTokens.values()) totalOutput += tokens
    let totalInput = 0
    for (const tokens of turnPromptTokens.values()) totalInput += tokens
    const turns = turnCompletionTokens.size
    const validTs = turnTimestamps.filter((n): n is number => n !== undefined)
    if (turns === 0) return { result: null, turnsPushed: 0 }

    // Prefers the earliest real turn timestamp over sessionCreatedMs (the kind=0 snapshot, when
    // the chat panel itself was first created) for two reasons: it's only present in whichever
    // segment happens to contain the file's very first line, so every later segment needs a
    // fallback anyway — and confirmed on real data, even segment 0 needs it: a chat panel can sit
    // open for many hours before its first real message, which made sessionCreatedMs alone show a
    // 66-73 hour "duration" for sessions whose actual turns spanned well under 90 minutes.
    const startMs = validTs.length > 0 ? Math.min(...validTs) : sessionCreatedMs
    if (startMs === 0) return { result: null, turnsPushed: 0 }
    const startTs = new Date(startMs).toISOString()
    const lastTurnMs = validTs.length > 0 ? Math.max(...validTs) : startMs
    const endTs = new Date(lastTurnMs).toISOString()

    return {
      turnsPushed: requestPushCount - startingTurnIndex,
      result: {
        workspace,
        card: _buildCard(sessionId, 'copilot', model || 'copilot', startTs, endTs, {
        totalInput,
        totalOutput,
        totalCacheRead: 0,
        totalCacheCreate: 0,
        peakContextPerTurn: 0,
        turns,
        totalToolCalls: 0,
        toolCounts: {},
        filesRead: new Set(),
        filesChanged: new Set(),
        filesWritten: new Set(),
        filesSearched: new Set(),
        userRequest: userRequest.slice(0, 500),
        timeline: [],
        initiator: 'user',
        }, workspace),
      },
    }
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

  private _parseCopilotVSCodeJsonFile(filePath: string, sessionId: string): LogSessionResult | null {
    const data = this._readJsonFile(filePath)
    if (!data) return null

    const creationMs = typeof data['creationDate'] === 'number' ? data['creationDate'] : 0
    const lastMs     = typeof data['lastMessageDate'] === 'number' ? data['lastMessageDate'] : 0
    if (!creationMs) return null

    const requests = data['requests']
    if (!Array.isArray(requests) || requests.length === 0) return null

    // Workspace from sibling workspace.json two levels up (workspaceStorage/<hash>/workspace.json)
    const workspaceJsonPath = path.join(path.dirname(filePath), '..', 'workspace.json')
    let workspace = ''
    try {
      const wj = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8')) as Record<string, unknown>
      const folderUri = String(wj['folder'] ?? '')
      if (folderUri.startsWith('file:///')) {
        let p = decodeURIComponent(folderUri.slice(7))
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
        workspace = p
      }
    } catch { /* no workspace.json — no-folder or untitled window */ }

    // Model: prefer per-turn modelId on first request; fall back to inputState
    let model = ''
    const inputState = data['inputState'] as Record<string, unknown> | undefined
    if (inputState) {
      const selModel = inputState['selectedModel'] as Record<string, unknown> | undefined
      const meta = selModel?.['metadata'] as Record<string, unknown> | undefined
      if (typeof meta?.['family'] === 'string') model = meta['family']
      else if (typeof selModel?.['id'] === 'string') model = selModel['id']
    }

    let userRequest = ''
    let totalToolCalls = 0
    const toolCounts: Record<string, number> = {}

    for (const req of requests as Array<Record<string, unknown>>) {
      if (!model && typeof req['modelId'] === 'string') {
        model = (req['modelId'] as string).replace(/^copilot\//, '')
      }
      if (!userRequest) {
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
      }
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
    }

    const sid = String(data['sessionId'] ?? sessionId)
    const startTs = new Date(creationMs).toISOString()
    const endTs   = new Date(lastMs || creationMs).toISOString()

    return {
      workspace,
      card: _buildCard(sid, 'copilot', model || 'copilot', startTs, endTs, {
        totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheCreate: 0,
        peakContextPerTurn: 0,
        turns: (requests as unknown[]).length,
        totalToolCalls,
        toolCounts,
        filesRead: new Set(), filesChanged: new Set(), filesWritten: new Set(), filesSearched: new Set(),
        userRequest: userRequest.slice(0, 500),
        timeline: [], initiator: 'user',
      }, workspace),
    }
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
                json_extract(data,'$.tokens.output')  AS tok_out
         FROM message WHERE session_id IN (${inList})
         ORDER BY time_created ASC`,
      )

      // ── Part rows (user text, tool names, files, tool I/O for timeline) ──────
      // part table may be absent in older DB versions — gracefully skip if so.
      let partRows: Array<{ columns: string[]; values: unknown[][] }> = []
      try {
        partRows = db.exec(
          `SELECT p.session_id, p.message_id, p.time_created AS part_ts,
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
      interface MsgInfo { msgId: string; tCreated: number; tCompleted: number; tokIn: number; tokOut: number }
      interface PartInfo {
        partTs: number; msgRole: string; type: string
        text: string | null; toolName: string | null; callId: string | null
        filePath: string | null; toolInputJson: string | null
        toolOutput: string | null; toolStatus: string | null
      }
      const msgsBySess  = new Map<string, MsgInfo[]>()
      const partsBySess = new Map<string, PartInfo[]>()

      if (msgRows[0]) {
        const mc = (n: string) => msgRows[0].columns.indexOf(n)
        for (const r of msgRows[0].values) {
          const sid = String(r[mc('session_id')])
          if (!msgsBySess.has(sid)) msgsBySess.set(sid, [])
          if (String(r[mc('role')]) === 'assistant') {
            msgsBySess.get(sid)!.push({
              msgId: String(r[mc('msg_id')]),
              tCreated:   Number(r[mc('t_created')]   ?? 0),
              tCompleted: Number(r[mc('t_completed')] ?? 0),
              tokIn:  Number(r[mc('tok_in')]  ?? 0),
              tokOut: Number(r[mc('tok_out')] ?? 0),
            })
          }
        }
      }
      if (partRows[0]) {
        const pc = (n: string) => partRows[0].columns.indexOf(n)
        for (const r of partRows[0].values) {
          const sid = String(r[pc('session_id')])
          if (!partsBySess.has(sid)) partsBySess.set(sid, [])
          partsBySess.get(sid)!.push({
            partTs:       Number(r[pc('part_ts')]         ?? 0),
            msgRole:      String(r[pc('msg_role')]        ?? ''),
            type:         String(r[pc('type')]            ?? ''),
            text:         r[pc('text')]           != null ? String(r[pc('text')])           : null,
            toolName:     r[pc('tool_name')]      != null ? String(r[pc('tool_name')])      : null,
            callId:       r[pc('call_id')]        != null ? String(r[pc('call_id')])        : null,
            filePath:     r[pc('file_path')]      != null ? String(r[pc('file_path')])      : null,
            toolInputJson:r[pc('tool_input_json')]!= null ? String(r[pc('tool_input_json')]): null,
            toolOutput:   r[pc('tool_output')]    != null ? String(r[pc('tool_output')])    : null,
            toolStatus:   r[pc('tool_status')]    != null ? String(r[pc('tool_status')])    : null,
          })
        }
      }

      // ── Build cards ────────────────────────────────────────────────────────
      const results: LogSessionResult[] = []
      for (const row of sessRows[0].values) {
        const sessionId = String(row[sc('id')] ?? '')
        if (!sessionId) continue

        const timeMs    = Number(row[sc('time_created')]      ?? 0)
        const startTs   = timeMs > 0 ? new Date(timeMs).toISOString() : ''
        const modelId   = String(row[sc('model_id')]          ?? '')
        const workspace = String(row[sc('directory')]         ?? '')
        const tokIn     = Number(row[sc('tokens_input')]      ?? 0)
        const tokOut    = Number(row[sc('tokens_output')]     ?? 0)
        const tokReason = Number(row[sc('tokens_reasoning')]  ?? 0)
        const tokCR     = Number(row[sc('tokens_cache_read')] ?? 0)
        const tokCW     = Number(row[sc('tokens_cache_write')]?? 0)
        const title     = String(row[sc('title')] ?? '')

        const msgs  = msgsBySess.get(sessionId)  ?? []
        const parts = partsBySess.get(sessionId) ?? []

        // User request: last user-typed text (parts are ordered ASC, so last wins).
        // OpenCode sessions are multi-turn; the most recent prompt best identifies current work.
        // Falls back to AI-generated session title if no user text parts exist.
        let userRequest = title.slice(0, 500)
        for (const p of parts) {
          if (p.msgRole === 'user' && p.type === 'text' && p.text) {
            userRequest = p.text.slice(0, 500)
          }
        }

        // Tools, files, and timeline events built in a single pass (parts are ASC by time).
        // LLM entries come from messages; tool entries come from tool parts.
        // We merge them by timestamp so the Flow tab shows real interleaved activity.
        const toolCounts: Record<string, number> = {}
        const filesRead    = new Set<string>()
        const filesWritten = new Set<string>()
        const filesChanged = new Set<string>()
        let totalToolCalls = 0

        // Keyed events: msgId → LLM entry (filled from msgs), callId → tool entry
        type PendingLlm  = { ts: number; entry: TimelineEntry }
        type PendingTool = { ts: number; entry: TimelineEntry }
        const llmEvents:  PendingLlm[]  = []
        const toolEvents: PendingTool[] = []

        // LLM entries from assistant messages
        let llmIdx = 0
        let lastCompleted = 0
        for (const m of msgs) {
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
        }

        // Tool entries from tool parts
        for (const p of parts) {
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
        const allEvents = [...llmEvents, ...toolEvents].sort((a, b) => a.ts - b.ts)
        const timeline: TimelineEntry[] = allEvents.map(e => e.entry)

        const endTs = lastCompleted > 0 ? new Date(lastCompleted).toISOString() : startTs

        const card = _buildCard(
          sessionId, 'opencode', modelId || 'opencode',
          startTs, endTs,
          {
            totalInput: tokIn, totalOutput: tokOut + tokReason,
            totalCacheRead: tokCR, totalCacheCreate: tokCW, peakContextPerTurn: 0,
            turns: msgs.length, totalToolCalls, toolCounts,
            filesRead, filesChanged, filesWritten, filesSearched: new Set(),
            userRequest, timeline, initiator: 'user',
          },
          workspace,
        )
        results.push({ card, workspace })
      }
      return results
    } finally {
      db.close()
    }
  }

  private _parseOpenCodeJsonFallback(dataDir: string): LogSessionResult[] {
    // Reads ~/.local/share/opencode/storage/message/*.json as a fallback when
    // the SQLite DB is unavailable. Each file is one message; session grouping
    // uses the session_id field. Session title and cwd are not available here.
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
        sessionId, 'opencode', s.model || 'opencode',
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

  /** Returns only the new bytes since last read, split into lines. Returns null if unchanged. */
  private _readNewLines(filePath: string): string[] | null {
    try {
      const stat = fs.statSync(filePath)
      const prev = this.fileState.get(filePath)
      if (prev && stat.mtimeMs === prev.mtimeMs && stat.size === prev.bytesRead) return null

      // Always re-read the whole file so each scan produces a complete card.
      // Incremental reads (seeking to prev.bytesRead) produced partial cards that
      // then replaced the full card in logSessions, losing prior-turn data.
      const content = fs.readFileSync(filePath, 'utf-8')
      this.fileState.set(filePath, { bytesRead: stat.size, mtimeMs: stat.mtimeMs })
      return content.split('\n').filter(l => l.trim())
    } catch (err) {
      this.log(`[LogReader] read error ${filePath}: ${err}`)
      return null
    }
  }

  /** Checks if a file has changed since last scan; if so, delegates to parseFn. */
  private _processFile(
    filePath: string,
    parseFn: () => LogSessionResult | null,
  ): LogSessionResult | null {
    try {
      const stat = fs.statSync(filePath)
      const prev = this.fileState.get(filePath)
      if (prev && stat.mtimeMs === prev.mtimeMs && stat.size === prev.bytesRead) return null
      // parseFn reads its own bytes via _readNewLines; state update happens there.
      return parseFn()
    } catch {
      return null
    }
  }

  /** Same change-detection as _processFile, for parsers that can return multiple session results
   *  from one file (currently only Claude Code). */
  private _processFileMulti(
    filePath: string,
    parseFn: () => LogSessionResult[],
  ): LogSessionResult[] {
    try {
      const stat = fs.statSync(filePath)
      const prev = this.fileState.get(filePath)
      if (prev && stat.mtimeMs === prev.mtimeMs && stat.size === prev.bytesRead) return []
      return parseFn()
    } catch {
      return []
    }
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

// ── Session splitting on prompt boundaries ──────────────────────────────────
//
// A Claude Code CLI transcript file is one continuous JSONL log for as long as the terminal
// session stays open — which can span real days if the user leaves it running, comes back later,
// and keeps typing prompts into the same window. Treating that whole file as one "session" is
// what made session duration read as wildly inflated (see .staged-issues/
// split-sessions-on-prompt-boundaries.md for the empirical data that proved a smaller idle-gap-
// capping fix wasn't enough on its own). This splits the file into segments at a genuinely large
// gap between two consecutive user prompts — never mid-turn — so each segment is a complete,
// coherent chunk of work rather than an arbitrarily severed one.

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
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of lines) {
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch { result.push(line); continue }
    const uuid = entry['uuid']
    if (typeof uuid !== 'string') { result.push(line); continue }
    if (seen.has(uuid)) continue
    seen.add(uuid)
    result.push(line)
  }
  return result
}

// A gap between two consecutive user prompts longer than this starts a new session segment.
// Deliberately larger than summarizers/helpers.ts's IDLE_GAP_THRESHOLD_MS (10 min) — that one
// answers "was this pause part of active work within one sitting," this one answers "is this
// genuinely a different sitting." 30 minutes is a first-pass guess, not a calibrated value — same
// honesty standard as every other threshold in this project. See the staged issue for the open
// question on whether to also force a split at real calendar-day boundaries.
export const SESSION_SPLIT_GAP_MS = 30 * 60_000

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

/**
 * Splits a log's lines into segments, one per group of consecutive prompts with no gap between
 * them exceeding SESSION_SPLIT_GAP_MS. A split point always falls before a line isPromptBoundary
 * identifies as a new prompt, walked back over any immediately-preceding near-simultaneous
 * bookkeeping lines (see WALKBACK_EPSILON_MS) — a segment's tool calls and assistant responses
 * always stay grouped with the prompt that triggered them, never split mid-turn. What counts as
 * "a new prompt," and where its timestamp lives, differs per log format (Claude Code: `type:
 * 'user'`, top-level `timestamp` string; Codex: an `event_msg` whose payload type is
 * `user_message`/`turn_aborted`, same top-level string; Copilot VS Code chat: a `kind: 2` push to
 * `requests`, numeric epoch-ms nested inside `v[0].timestamp`), so each format gets its own thin
 * wrapper below rather than sharing one predicate — this function holds only the boundary/gap
 * algorithm itself, tested once and reused by all of them. getBoundaryTimestampMs defaults to the
 * top-level-string extraction (Claude/Codex); Copilot VS Code's wrapper overrides it. The
 * walkback's own per-line timestamps always use the top-level-string form regardless — no format
 * checked so far has shown a bookkeeping-cluster-bleed issue whose fix needs anything else, and a
 * format where most lines simply lack a top-level timestamp (Copilot VS Code) makes the walkback a
 * natural no-op rather than needing its own special-casing.
 *
 * Pure and independently testable on purpose: this only needs the raw lines and produces raw
 * line groups, so it can be verified against real transcript data without touching any of the
 * token/tool/file accounting in each format's own per-segment parser.
 */
function defaultLineTimestampMs(entry: Record<string, unknown>): number | null {
  const ts = entry['timestamp'] as string | undefined
  const tsMs = ts ? Date.parse(ts) : NaN
  return Number.isFinite(tsMs) ? tsMs : null
}

function splitLinesOnPromptGaps(
  lines: string[],
  isPromptBoundary: (entry: Record<string, unknown>) => boolean,
  getBoundaryTimestampMs: (entry: Record<string, unknown>) => number | null = defaultLineTimestampMs,
): string[][] {
  if (lines.length === 0) return []

  const timestamps: Array<number | null> = lines.map(line => {
    try { return defaultLineTimestampMs(JSON.parse(line) as Record<string, unknown>) } catch { return null }
  })

  const boundaries: number[] = [0]
  // Tracks the highest prompt timestamp seen so far, not just the most recently seen one — real
  // transcripts can contain an isolated out-of-order timestamp (confirmed on real Claude Code
  // data: one entry mid-file stamped a full day earlier than its neighbors, apparently from
  // Claude Code's own resume/continuation handling). Comparing against the max rather than the
  // last value keeps a single such anomaly from corrupting the gap baseline for every comparison
  // after it.
  let maxTs: number | null = null
  for (let i = 0; i < lines.length; i++) {
    let entry: Record<string, unknown>
    try { entry = JSON.parse(lines[i]) as Record<string, unknown> } catch { continue }
    if (!isPromptBoundary(entry)) continue

    const tsMs = getBoundaryTimestampMs(entry)
    if (tsMs === null) continue

    if (maxTs !== null && tsMs - maxTs > SESSION_SPLIT_GAP_MS) {
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

  const segments: string[][] = []
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b]
    const end = b + 1 < boundaries.length ? boundaries[b + 1] : lines.length
    segments.push(lines.slice(start, end))
  }
  return segments
}

export function splitClaudeLinesOnPromptGaps(lines: string[]): string[][] {
  return splitLinesOnPromptGaps(lines, entry => entry['type'] === 'user')
}

// Also treats turn_aborted as a boundary trigger, not just user_message. Confirmed on real data:
// when a turn was left incomplete and the user comes back later, Codex logs turn_aborted stamped
// with the *resumption* time — but the delta from turn_aborted to the following turn's
// thread_settings_applied/task_started varies too widely (0.1s to 31s across 7 real occurrences
// in one file) for WALKBACK_EPSILON_MS to reliably absorb it into the same cluster. turn_aborted
// needs to trigger gap detection on its own rather than relying on being swept in by a later
// anchor — unlike thread_settings_applied/task_started, which are reliably near-simultaneous with
// their user_message and are handled by the walkback instead.
export function splitCodexLinesOnPromptGaps(lines: string[]): string[][] {
  return splitLinesOnPromptGaps(lines, entry => {
    if (entry['type'] !== 'event_msg') return false
    const payload = entry['payload'] as Record<string, unknown> | undefined
    return payload?.['type'] === 'user_message' || payload?.['type'] === 'turn_aborted'
  })
}

function isCopilotVSCodeRequestsPush(entry: Record<string, unknown>): boolean {
  const k = entry['k']
  return entry['kind'] === 2 && Array.isArray(k) && k.length === 1 && k[0] === 'requests'
    && Array.isArray(entry['v']) && (entry['v'] as unknown[]).length > 0
}

// A `kind: 2` push to `requests` is how VS Code's delta-log format for the Copilot Chat panel
// records a new turn — timestamp is numeric epoch-ms nested at v[0].timestamp, not a top-level
// ISO string (this format's own convention, confirmed against real transcripts, unlike Claude
// Code's/Codex's). A push can batch more than one new request at once (confirmed on real data —
// rare, ~6% of pushes in one file, but real); since a single line can't be split, this uses the
// batch's first request's timestamp for gap detection, which is the earliest new activity in it.
// Token/turn accounting for this format is already keyed per-turn-index rather than a cumulative
// running total (unlike Codex's total_token_usage), so — unlike Codex — no baseline-diffing is
// needed between segments; each segment's own per-line accumulation over just its own lines is
// already correct on its own.
export function splitCopilotVSCodeLinesOnPromptGaps(lines: string[]): string[][] {
  return splitLinesOnPromptGaps(
    lines,
    isCopilotVSCodeRequestsPush,
    entry => {
      const first = (entry['v'] as Array<Record<string, unknown>>)[0]
      const ts = first?.['timestamp']
      return typeof ts === 'number' ? ts : null
    },
  )
}

/** Segment 0 keeps the file's own session ID unchanged — the common case (a file that never
 *  needs splitting) gets no ID churn at all. Later segments get a stable, deterministic suffix.
 *  Shared by every log format's splitting — the naming is Claude-specific only because it shipped
 *  first; the logic itself is format-agnostic. */
export function claudeSegmentSessionId(baseSessionId: string, segmentIndex: number): string {
  return segmentIndex === 0 ? baseSessionId : `${baseSessionId}#${segmentIndex}`
}

function _buildCard(
  sessionId: string,
  source: 'claude_code' | 'codex' | 'copilot' | 'opencode',
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
 * Merges outstanding WAL frames into the database buffer so sql.js can read
 * sessions written since the last checkpoint. SQLite WAL format (spec §2):
 *   - 32-byte header: magic, version, page size, seq, salt1, salt2, cksum1, cksum2
 *   - Frames: 24-byte frame header + pageSize bytes of page data
 *     Frame header: pgno (4), dbSize (4), salt1 (4), salt2 (4), cksum1 (4), cksum2 (4)
 * Frames whose salts don't match the WAL header belong to a stale WAL — stop there.
 */
function _mergeWal(dbBuf: Uint8Array, walBuf: Uint8Array): Uint8Array {
  const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (walBuf.length < 32) return dbBuf
  const wDv = dv(walBuf)
  const magic = wDv.getUint32(0)
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return dbBuf
  const pageSize = wDv.getUint32(8)
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) return dbBuf
  const salt1 = wDv.getUint32(16)
  const salt2 = wDv.getUint32(20)

  const FRAME = 24 + pageSize
  let result = new Uint8Array(dbBuf)
  let off = 32

  while (off + FRAME <= walBuf.length) {
    const pgno   = wDv.getUint32(off)
    const fSalt1 = wDv.getUint32(off + 8)
    const fSalt2 = wDv.getUint32(off + 12)
    if (fSalt1 !== salt1 || fSalt2 !== salt2) break  // stale generation
    if (pgno >= 1) {
      const pageOff = (pgno - 1) * pageSize
      const pageEnd = pageOff + pageSize
      if (pageEnd > result.length) {
        const ext = new Uint8Array(pageEnd)
        ext.set(result)
        result = ext
      }
      result.set(walBuf.slice(off + 24, off + 24 + pageSize), pageOff)
    }
    off += FRAME
  }

  return result
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
