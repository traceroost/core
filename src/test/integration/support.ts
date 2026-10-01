/**
 * Shared plumbing for the extension-host integration suites (`*.itest.ts`). Everything here goes
 * through public surfaces only — the extension's contributed commands, its OTLP and MCP ports, the
 * files it writes (its sql.js database, its Output-channel log) — never through module internals.
 */
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import * as vscode from 'vscode'

/** Written by tests/e2e/vscode/run.mjs; its path arrives as TRACEROOST_IT_CONFIG. */
export interface ItConfig {
  extensionId: string
  edition: 'core' | 'full'
  userDataDir: string
  home: string
  repo: string
  otlpPort: number
  mcpPort: number
  fixture: { sessionId: string; rootSpanId: string; file: string; otlp: unknown; model: string }
  /** realAgents suite only. */
  agents?: Record<string, { bin: string; args: string[]; env?: Record<string, string>; login?: boolean } | undefined>
  captureDir?: string
}

export function loadConfig(): ItConfig {
  const file = process.env.TRACEROOST_IT_CONFIG
  if (!file) throw new Error('TRACEROOST_IT_CONFIG is not set — run the suite through tests/e2e/vscode/run.mjs')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ItConfig
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function waitFor<T>(what: string, fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 60_000, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) { lastErr = e }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${lastErr ? ` (last error: ${lastErr})` : ''}`)
    }
    await sleep(intervalMs)
  }
}

export function httpRequest(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(url, {
      method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}), ...headers },
      timeout: 15_000,
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error(`${method} ${url} timed out`)))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

/** One stateless MCP `tools/call` (src/mcpServer.ts) — returns the tool's parsed JSON result. */
export async function mcpCall(port: number, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await httpRequest('POST', `http://127.0.0.1:${port}/mcp`,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { Accept: 'application/json, text/event-stream' })
  if (res.status !== 200) throw new Error(`MCP ${name} → ${res.status}: ${res.text.slice(0, 300)}`)
  const payloads = res.text.trim().startsWith('{')
    ? [res.text]
    : res.text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
  for (const p of payloads) {
    const msg = JSON.parse(p) as { result?: { content?: Array<{ text?: string }> }; error?: unknown }
    if (msg.error) throw new Error(`MCP ${name} error: ${JSON.stringify(msg.error)}`)
    const text = msg.result?.content?.[0]?.text
    if (text !== undefined) return JSON.parse(text)
  }
  throw new Error(`MCP ${name}: no result in ${res.text.slice(0, 300)}`)
}

/**
 * A copy of an OTLP trace payload with fresh trace/span ids — a new session as far as the collector
 * is concerned. Re-posting the *same* payload is deduplicated by span id and changes nothing, so it
 * can't be used to make the extension write (and save) its database.
 */
export function freshTrace(otlp: unknown): unknown {
  const text = JSON.stringify(otlp)
  const ids = new Map<string, string>()
  const rand = (len: number) => Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return JSON.parse(text.replace(/"(traceId|spanId|parentSpanId)":"([0-9a-f]+)"/g, (_m, k: string, id: string) => {
    if (!ids.has(id)) ids.set(id, rand(id.length))
    return `"${k}":"${ids.get(id)}"`
  }))
}

/** Where VS Code keeps this extension's globalStorage for the isolated --user-data-dir. */
export function globalStorageDir(cfg: ItConfig, ext: vscode.Extension<unknown>): string {
  return path.join(cfg.userDataDir, 'User', 'globalStorage', ext.id.toLowerCase())
}

// ── The extension's sql.js database, read from disk ──────────────────────────
//
// Loaded with the sql.js the extension itself ships (dist/sql-wasm.js + .wasm), so this also
// proves those assets are present and loadable from the installed location.

type SqlJs = { Database: new (data?: Uint8Array) => { exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; close(): void } }
let sqlJs: Promise<SqlJs> | undefined

export function loadSqlJs(extensionPath: string): Promise<SqlJs> {
  if (!sqlJs) {
    const init = require(path.join(extensionPath, 'dist', 'sql-wasm.js')) as (cfg: { locateFile: (f: string) => string }) => Promise<SqlJs>
    sqlJs = init({ locateFile: f => path.join(extensionPath, 'dist', f) })
  }
  return sqlJs
}

export type Row = Record<string, unknown>

/** Runs `sql` against a fresh snapshot of the database file (the extension saves it periodically). */
export async function queryDb(extensionPath: string, dbPath: string, sql: string, params: unknown[] = []): Promise<Row[]> {
  if (!fs.existsSync(dbPath)) return []
  const SQL = await loadSqlJs(extensionPath)
  const db = new SQL.Database(fs.readFileSync(dbPath))
  try {
    const res = db.exec(sql, params)
    if (res.length === 0) return []
    return res[0].values.map(v => Object.fromEntries(res[0].columns.map((c, i) => [c, v[i]])))
  } finally {
    db.close()
  }
}

// ── The TraceRoost Output channel, as VS Code logs it to disk ────────────────

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** Contents of every Output-channel log file VS Code wrote for a channel named "TraceRoost". */
export function outputChannelText(cfg: ItConfig): string {
  return walk(path.join(cfg.userDataDir, 'logs'))
    .filter(f => /(^|[-\\/])TraceRoost\.log$/.test(f))
    .map(f => fs.readFileSync(f, 'utf8'))
    .join('\n')
}

/** Lines of the TraceRoost Output channel that report a failure. */
export function outputChannelErrors(text: string): string[] {
  return text.split(/\r?\n/).filter(l =>
    /Failed to|could not load|Could not|\bfailed:|error:|Error:|EADDRINUSE|ENOENT|EPERM|EACCES|Cannot find module|auto-configure .* failed/i.test(l),
  )
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}
