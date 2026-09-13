/**
 * TraceRoost MCP server — exposes session history to Claude Code and other
 * MCP-compatible agents so they can query their own past work.
 *
 * Tools:
 *   get_recent_sessions        — recent session summaries, newest-first
 *   get_workspace_patterns     — aggregate patterns across all sessions
 *   get_session_detail         — full timeline for one session
 *   find_relevant_context      — files and patterns relevant to a task description
 *   get_efficiency_report      — trends and recurring efficiency problems
 *   get_instruction_suggestions — pending Advisor suggestions for one workspace
 *   check_automation_triggers  — currently-triggered stuck-agent corrections for one workspace
 *
 * Transport: Streamable HTTP — expose via a route on an existing http.Server
 * or start a dedicated server with startMcpHttpServer().
 */

import * as http from 'http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { calcTokenCostUsd } from './pricing'
import type { SessionSummaryCard, TimelineEntry } from './summarizers/summarizerTypes'
import { generateSuggestions } from './instructionAdvisor'
import { readAllInstructionContent } from './instructionFiles'
import { checkAutomationTriggers } from './automationEngine'
import { isAllowedHostHeader, isAuthorized, isLoopbackHost } from './httpSecurity'

// ── Session accessor ──────────────────────────────────────────────────────────

// Accepts either a live SessionRepository (VS Code extension) or a plain
// function returning the current session array (standalone).
export type SessionAccessor = () => SessionSummaryCard[]

// ── Cost helper ───────────────────────────────────────────────────────────────

function sessionCost(s: SessionSummaryCard): number {
  return calcTokenCostUsd(
    s.inputTokens - s.cacheReadTokens - (s.cacheCreateTokens ?? 0),
    s.cacheReadTokens,
    s.cacheCreateTokens ?? 0,
    s.outputTokens,
    s.model,
  )
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_recent_sessions',
    description:
      'Returns recent TraceRoost session summaries — cost, turns, model, prompt excerpt, ' +
      'top tools used, loop signals. Use this to orient yourself to what has been worked ' +
      'on recently before starting a new task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit:     { type: 'number',  description: 'Max sessions to return (default 10, max 50)' },
        agent:     { type: 'string',  description: 'Filter by agent: copilot | claude_code | codex' },
        workspace: { type: 'string',  description: 'Filter by workspace path prefix' },
      },
    },
  },
  {
    name: 'get_workspace_patterns',
    description:
      'Returns aggregate patterns across all sessions: most-accessed files, average cost ' +
      'and turn count, common efficiency problems, top tools. Use this to understand ' +
      'the codebase context before starting work.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Filter by workspace path prefix' },
        days:      { type: 'number', description: 'Only include sessions from the last N days (default: all)' },
      },
    },
  },
  {
    name: 'get_session_detail',
    description:
      'Returns the full timeline (LLM calls, tool calls, file edits) for one session. ' +
      'Use this to learn from a specific past session in detail.',
    inputSchema: {
      type: 'object' as const,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID from get_recent_sessions' },
      },
    },
  },
  {
    name: 'find_relevant_context',
    description:
      'Given a task description, keyword-matches against past session prompts and returns ' +
      'files accessed in similar sessions, estimated cost/turns, and known traps. ' +
      'Reliable for established workflows (e.g. "add auth", "fix sidebar tests"); ' +
      'unreliable for novel tasks where keyword overlap is weak — file suggestions ' +
      'may pull in unrelated sessions. Treat results as a sanity check, not a reading list.',
    inputSchema: {
      type: 'object' as const,
      required: ['task'],
      properties: {
        task:      { type: 'string', description: 'Short description of the task you are about to start' },
        workspace: { type: 'string', description: 'Filter sessions by workspace path prefix' },
      },
    },
  },
  {
    name: 'get_efficiency_report',
    description:
      'Returns efficiency trends: are sessions getting more or less expensive? Which ' +
      'agent/model combinations are most efficient? What are the recurring loop signals ' +
      'and efficiency insights? Use this to understand systemic patterns.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Filter by workspace path prefix' },
        days:      { type: 'number', description: 'Analyse sessions from last N days (default 30)' },
      },
    },
  },
  {
    name: 'get_instruction_suggestions',
    description:
      'Returns pending suggestions for improving the agent instruction file (CLAUDE.md, AGENTS.md, etc.) ' +
      'for the specified workspace. Suggestions are derived from patterns in past sessions and include ' +
      'ready-to-paste text. Use this at the start of a session to check for improvements before beginning work. ' +
      'workspace is REQUIRED — cross-workspace suggestions are not meaningful.',
    inputSchema: {
      type: 'object' as const,
      required: ['workspace'],
      properties: {
        workspace: { type: 'string', description: 'Absolute path of the workspace root (required)' },
      },
    },
  },
  {
    name: 'check_automation_triggers',
    description:
      'Checks the four built-in stuck-agent automations (Context Compaction, Loop Breaker, ' +
      'Error Cascade Stop, Turn Limit Wrap-up) against the workspace\'s current in-progress, ' +
      'recently-active session(s), and returns any that are currently triggered with ready-to-use ' +
      'correction prompt text. Evaluated against TraceRoost\'s default thresholds, not any ' +
      'per-user customization made in the Settings panel (that lives only in the dashboard\'s ' +
      'browser storage, not reachable from MCP). Read-only — safe to call repeatedly; a trigger ' +
      'is only returned once per session until its underlying condition changes, so calling this ' +
      'periodically during a long task and following whatever it returns is a reasonable ' +
      'self-check pattern. workspace is REQUIRED.',
    inputSchema: {
      type: 'object' as const,
      required: ['workspace'],
      properties: {
        workspace: { type: 'string', description: 'Absolute path of the workspace root (required)' },
      },
    },
  },
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

function handleGetRecentSessions(
  sessions: SessionSummaryCard[],
  args: { limit?: number; agent?: string; workspace?: string },
) {
  let filtered = sessions
  if (args.agent)     filtered = filtered.filter(s => s.source === args.agent)
  if (args.workspace) filtered = filtered.filter(s => s.sessionId.includes(args.workspace!) || (s.userRequest ?? '').includes(args.workspace!))
  const limit = Math.min(args.limit ?? 10, 50)
  const top = filtered.slice(0, limit)
  return top.map(s => ({
    sessionId:   s.sessionId,
    date:        s.startTime.slice(0, 16).replace('T', ' '),
    agent:       s.source,
    model:       s.model,
    prompt:      s.userRequest ? s.userRequest.slice(0, 120) + (s.userRequest.length > 120 ? '…' : '') : null,
    turns:       s.totalLlmCalls,
    cost_usd:    +sessionCost(s).toFixed(4),
    durationMin: +(s.durationMs / 60000).toFixed(1),
    errors:      s.errors,
    topTools:    Object.entries(s.toolCounts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t}×${n}`),
    loopSignals: (s.loopSignals ?? []).map(l => l.type),
    filesChanged: s.filesChanged?.slice(0, 5) ?? [],
  }))
}

function handleGetWorkspacePatterns(
  sessions: SessionSummaryCard[],
  args: { workspace?: string; days?: number },
) {
  let filtered = sessions
  if (args.days) {
    const cutoff = Date.now() - args.days * 86_400_000
    filtered = filtered.filter(s => Date.parse(s.startTime) >= cutoff)
  }
  if (filtered.length === 0) return { message: 'No sessions found matching the filters.' }

  // File frequency
  const fileFreq = new Map<string, number>()
  for (const s of filtered) {
    for (const f of [...(s.filesRead ?? []), ...(s.filesChanged ?? [])]) {
      fileFreq.set(f, (fileFreq.get(f) ?? 0) + 1)
    }
  }
  const hotFiles = [...fileFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([file, count]) => ({ file, sessions: count, pct: Math.round(count / filtered.length * 100) }))

  // Tool frequency
  const toolFreq = new Map<string, number>()
  for (const s of filtered) {
    for (const [t, n] of Object.entries(s.toolCounts ?? {})) {
      toolFreq.set(t, (toolFreq.get(t) ?? 0) + n)
    }
  }
  const topTools = [...toolFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tool, total]) => ({ tool, total }))

  // Loop signal frequency
  const signalFreq = new Map<string, number>()
  for (const s of filtered) {
    for (const sig of s.loopSignals ?? []) {
      signalFreq.set(sig.type, (signalFreq.get(sig.type) ?? 0) + 1)
    }
  }
  const loopSignals = [...signalFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }))

  // Averages
  const totalCost  = filtered.reduce((s, sess) => s + sessionCost(sess), 0)
  const totalTurns = filtered.reduce((s, sess) => s + sess.totalLlmCalls, 0)
  const totalCache = filtered.reduce((s, sess) => s + sess.cacheHitRate, 0)
  const errorSess  = filtered.filter(s => s.errors > 0).length

  // Agent/model breakdown
  const agentMap = new Map<string, { sessions: number; cost: number; turns: number }>()
  for (const s of filtered) {
    const key = `${s.source}/${s.model}`
    const e = agentMap.get(key) ?? { sessions: 0, cost: 0, turns: 0 }
    e.sessions++; e.cost += sessionCost(s); e.turns += s.totalLlmCalls
    agentMap.set(key, e)
  }
  const agentBreakdown = [...agentMap.entries()]
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .slice(0, 6)
    .map(([key, v]) => ({ agentModel: key, sessions: v.sessions, avgCost: +(v.cost / v.sessions).toFixed(4), avgTurns: +(v.turns / v.sessions).toFixed(1) }))

  return {
    sessionCount:    filtered.length,
    avgCostUsd:      +(totalCost / filtered.length).toFixed(4),
    avgTurns:        +(totalTurns / filtered.length).toFixed(1),
    avgCacheHitRate: +(totalCache / filtered.length * 100).toFixed(0) + '%',
    errorRate:       Math.round(errorSess / filtered.length * 100) + '%',
    hotFiles,
    topTools,
    loopSignals,
    agentBreakdown,
  }
}

function handleGetSessionDetail(
  sessions: SessionSummaryCard[],
  getTimeline: ((id: string) => unknown[]) | null,
  args: { sessionId: string },
) {
  const s = sessions.find(x => x.sessionId === args.sessionId)
  if (!s) return { error: `Session ${args.sessionId} not found.` }

  const timeline = getTimeline ? getTimeline(s.sessionId) : s.timeline ?? []
  return {
    sessionId:    s.sessionId,
    date:         s.startTime.slice(0, 19).replace('T', ' '),
    agent:        s.source,
    model:        s.model,
    prompt:       s.userRequest || null,
    cost_usd:     +sessionCost(s).toFixed(4),
    turns:        s.totalLlmCalls,
    errors:       s.errors,
    outcome:      s.outcome,
    loopSignals:  s.loopSignals ?? [],
    filesRead:    s.filesRead ?? [],
    filesChanged: s.filesChanged ?? [],
    toolCounts:   s.toolCounts,
    timeline:     (timeline as { type: string; label: string; durationMs: number; isError?: boolean }[])
      .slice(0, 80)
      .map(e => ({ type: e.type, label: e.label, ms: e.durationMs, error: e.isError || false })),
  }
}

function handleFindRelevantContext(
  sessions: SessionSummaryCard[],
  args: { task: string; workspace?: string },
) {
  const taskWords = new Set(
    args.task.toLowerCase().replace(/[^a-z0-9\s/_.]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  )
  if (taskWords.size === 0) return { message: 'Task description too short to match against history.' }

  // Score each session by word overlap with the task description
  const scored = sessions.map(s => {
    const req = (s.userRequest ?? '').toLowerCase()
    const overlap = [...taskWords].filter(w => req.includes(w)).length
    return { s, score: overlap }
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score)

  const similar = scored.slice(0, 15).map(x => x.s)
  if (similar.length === 0) return { message: 'No past sessions closely match this task description. No history to draw from yet.' }

  // Aggregate files from similar sessions
  const fileFreq = new Map<string, number>()
  for (const s of similar) {
    for (const f of [...(s.filesRead ?? []), ...(s.filesChanged ?? [])]) {
      fileFreq.set(f, (fileFreq.get(f) ?? 0) + 1)
    }
  }
  const relevantFiles = [...fileFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([file, count]) => ({ file, appearsIn: count, pct: Math.round(count / similar.length * 100) }))

  // Cost and turn estimates
  const costs  = similar.map(s => sessionCost(s))
  const turns  = similar.map(s => s.totalLlmCalls)
  const minC   = +Math.min(...costs).toFixed(3), maxC = +Math.max(...costs).toFixed(3)
  const avgC   = +(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(3)
  const avgT   = +(turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1)

  // Common loop signals in similar sessions
  const sigFreq = new Map<string, number>()
  for (const s of similar) {
    for (const sig of s.loopSignals ?? []) {
      sigFreq.set(sig.type, (sigFreq.get(sig.type) ?? 0) + 1)
    }
  }
  const knownTraps = [...sigFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([type, count]) => `${type} (${count}/${similar.length} similar sessions)`)

  return {
    matchedSessions: similar.length,
    estimatedCostUsd: { min: minC, avg: avgC, max: maxC },
    estimatedTurns:   avgT,
    relevantFiles,
    knownTraps: knownTraps.length > 0 ? knownTraps : null,
    tip: relevantFiles.length > 0
      ? `Consider mentioning these files upfront: ${relevantFiles.slice(0, 3).map(f => f.file).join(', ')}`
      : null,
  }
}

function handleGetEfficiencyReport(
  sessions: SessionSummaryCard[],
  args: { workspace?: string; days?: number },
) {
  const cutoffDays = args.days ?? 30
  const cutoff = Date.now() - cutoffDays * 86_400_000
  const recent = sessions.filter(s => Date.parse(s.startTime) >= cutoff)
  if (recent.length === 0) return { message: `No sessions in the last ${cutoffDays} days.` }

  // Week-over-week cost trend (split into two halves)
  const mid = Date.now() - (cutoffDays / 2) * 86_400_000
  const firstHalf  = recent.filter(s => Date.parse(s.startTime) < mid)
  const secondHalf = recent.filter(s => Date.parse(s.startTime) >= mid)
  const avgFirst  = firstHalf.length  > 0 ? firstHalf.reduce((s, x)  => s + sessionCost(x), 0) / firstHalf.length  : 0
  const avgSecond = secondHalf.length > 0 ? secondHalf.reduce((s, x) => s + sessionCost(x), 0) / secondHalf.length : 0
  const trend = avgFirst === 0 ? 'no data'
    : avgSecond > avgFirst * 1.15 ? 'increasing ↑'
    : avgSecond < avgFirst * 0.85 ? 'decreasing ↓'
    : 'stable →'

  // Loop signal totals
  const sigFreq = new Map<string, number>()
  for (const s of recent) {
    for (const sig of s.loopSignals ?? []) {
      sigFreq.set(sig.type, (sigFreq.get(sig.type) ?? 0) + 1)
    }
  }
  const topSignals = [...sigFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count, rate: Math.round(count / recent.length * 100) + '%' }))

  // Best agent/model combos by cost efficiency
  const agentMap = new Map<string, { n: number; totalCost: number; totalTurns: number; errors: number }>()
  for (const s of recent) {
    const key = `${s.source}/${s.model || 'unknown'}`
    const e = agentMap.get(key) ?? { n: 0, totalCost: 0, totalTurns: 0, errors: 0 }
    e.n++; e.totalCost += sessionCost(s); e.totalTurns += s.totalLlmCalls; e.errors += s.errors
    agentMap.set(key, e)
  }
  const agentRanking = [...agentMap.entries()]
    .filter(([, v]) => v.n >= 2)
    .map(([key, v]) => ({
      agentModel: key, sessions: v.n,
      avgCostUsd: +(v.totalCost / v.n).toFixed(4),
      avgTurns:   +(v.totalTurns / v.n).toFixed(1),
      errorRate:  Math.round(v.errors / v.n * 100) + '%',
    }))
    .sort((a, b) => a.avgCostUsd - b.avgCostUsd)

  return {
    period:       `last ${cutoffDays} days`,
    sessionCount: recent.length,
    costTrend:    trend,
    avgCostUsd:   +(recent.reduce((s, x) => s + sessionCost(x), 0) / recent.length).toFixed(4),
    avgTurns:     +(recent.reduce((s, x) => s + x.totalLlmCalls, 0) / recent.length).toFixed(1),
    errorRate:    Math.round(recent.filter(s => s.errors > 0).length / recent.length * 100) + '%',
    topLoopSignals: topSignals,
    agentRanking,
  }
}

function handleGetInstructionSuggestions(
  sessions: SessionSummaryCard[],
  args: { workspace?: string },
) {
  const workspace = args.workspace?.trim()
  if (!workspace) {
    return { error: 'workspace is required — instruction suggestions are project-scoped.' }
  }
  const filtered = sessions.filter(s => (s.workspace ?? '') === workspace || s.workspace?.startsWith(workspace))
  if (filtered.length < 5) {
    return { message: `Not enough history for workspace "${workspace}" (${filtered.length} sessions, need 5).`, suggestions: [] }
  }
  const existingText = readAllInstructionContent(workspace)
  const suggestions = generateSuggestions(filtered, existingText)
  return suggestions.map(s => ({
    id:            s.id,
    category:      s.category,
    title:         s.title,
    evidence:      s.evidence,
    suggestedText: s.suggestedText,
    targetAgents:  s.targetAgents,
    priority:      s.priority,
  }))
}

function handleCheckAutomationTriggers(
  sessions: SessionSummaryCard[],
  getTimeline: ((id: string) => unknown[]) | null,
  args: { workspace?: string },
) {
  const workspace = args.workspace?.trim()
  if (!workspace) {
    return { error: 'workspace is required — automation triggers are project-scoped.' }
  }
  const timelineFor = (id: string): TimelineEntry[] => {
    if (getTimeline) return getTimeline(id) as TimelineEntry[]
    return sessions.find(s => s.sessionId === id)?.timeline ?? []
  }
  const triggers = checkAutomationTriggers(sessions, workspace, timelineFor)
  if (triggers.length === 0) {
    return { message: `No triggered automations for workspace "${workspace}".`, triggers: [] }
  }
  return { triggers }
}

// ── MCP Server factory ────────────────────────────────────────────────────────

export interface McpServerOptions {
  /** Returns the current session list. Called on every tool invocation. */
  getSessions: SessionAccessor
  /** Optionally load full timeline for a session (VS Code has this; standalone uses session.timeline). */
  getTimeline?: (sessionId: string) => unknown[]
}

export function createMcpServer(opts: McpServerOptions): Server {
  const server = new Server(
    { name: 'traceroost', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const sessions = opts.getSessions()
    const args = (req.params.arguments ?? {}) as Record<string, unknown>

    let result: unknown
    switch (req.params.name) {
      case 'get_recent_sessions':
        result = handleGetRecentSessions(sessions, args as { limit?: number; agent?: string; workspace?: string })
        break
      case 'get_workspace_patterns':
        result = handleGetWorkspacePatterns(sessions, args as { workspace?: string; days?: number })
        break
      case 'get_session_detail':
        result = handleGetSessionDetail(sessions, opts.getTimeline ?? null, args as { sessionId: string })
        break
      case 'find_relevant_context':
        result = handleFindRelevantContext(sessions, args as { task: string; workspace?: string })
        break
      case 'get_efficiency_report':
        result = handleGetEfficiencyReport(sessions, args as { workspace?: string; days?: number })
        break
      case 'get_instruction_suggestions':
        result = handleGetInstructionSuggestions(sessions, args as { workspace?: string })
        break
      case 'check_automation_triggers':
        result = handleCheckAutomationTriggers(sessions, opts.getTimeline ?? null, args as { workspace?: string })
        break
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    }
  })

  return server
}

// ── HTTP route handler ────────────────────────────────────────────────────────

/**
 * Handles a single HTTP request as an MCP endpoint.
 * Mount this on a route (e.g. `/mcp`) in your existing HTTP server.
 *
 * Each request gets its own transport instance (stateless per-request for
 * Streamable HTTP). The server instance is reused across requests.
 */
export function handleMcpRequest(
  server: Server,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  // Simple GET health check so opening the URL in a browser gives a clear response.
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', server: 'traceroost-mcp', transport: 'streamable-http', endpoint: req.url }))
    return
  }

  // Buffer and parse the body before passing to the transport.
  let raw = ''
  req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
  req.on('end', () => {
    let parsedBody: unknown
    try { parsedBody = raw ? JSON.parse(raw) : undefined } catch { parsedBody = undefined }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    server.connect(transport)
      .then(() => transport.handleRequest(req, res, parsedBody))
      .then(() => { res.on('finish', () => { transport.close().catch(() => {}) }) })
      .catch(err => {
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })) }
      })
  })
}

// ── Standalone HTTP server ────────────────────────────────────────────────────

/**
 * Starts a dedicated HTTP server for the MCP endpoint.
 * Used when there is no existing HTTP server to attach to.
 */
export function startMcpHttpServer(
  opts: McpServerOptions,
  port: number,
  bindHost = '127.0.0.1',
  authToken = '',
): http.Server {
  const server = createMcpServer(opts)
  // Only enforced once bindHost is exposed beyond loopback — the default local setup and
  // existing MCP clients (this repo's own Claude Code / editor integrations) point at
  // 127.0.0.1 with no way to supply a token, so they must keep working unauthenticated.
  const requireToken = !isLoopbackHost(bindHost)
  const httpServer = http.createServer((req, res) => {
    if (!isAllowedHostHeader(req.headers.host, bindHost)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden — invalid Host header'); return
    }
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id, Authorization')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (requireToken && !isAuthorized(req, authToken)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Unauthorized'); return
    }
    handleMcpRequest(server, req, res)
  })
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[TraceRoost] Port ${port} (MCP) already in use — stop the process using it or set MCP_PORT=<other> to use a different port.`)
      process.exit(1)
    }
    throw err
  })
  httpServer.listen(port, bindHost)
  return httpServer
}
