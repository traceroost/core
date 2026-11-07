/**
 * `traceroost doctor` — whether TraceRoost recognizes what each agent writes on this machine.
 *
 * Reads every local agent log itself (the same LogReader and classification as the server, see
 * src/adapters/), adds the OTLP counts of a TraceRoost server running here if there is one (over
 * loopback), and prints one row per agent: version seen, last data, setup state and status — the
 * same table as the dashboard's Settings → Agents. Exits 1 when any agent has unrecognized data.
 *
 * `--report <agent>` prints the GitHub issue "Report this" would open, in full — names, counts
 * and key/type structure only — and its link; `--open` then opens it in the browser. Nothing is
 * sent from here. No account, no network beyond loopback.
 */

import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { parse as parseJsonc } from 'jsonc-parser'
import { AdapterHealth, type AgentHealthRow } from '../src/adapters/health'
import { buildAgentReport } from '../src/adapters/report'
import { ADAPTERS } from '../src/adapters/registry'
import type { AdapterKey } from '../src/adapters/types'
import { COPILOT_DEFAULT_ENDPOINT, COPILOT_ENDPOINT_KEY, isTraceRoostEndpoint, vscodeUserSettingsPaths } from '../src/autoConfigNode'
import { LogReader, type OpenCodeSqlFactory } from '../src/logReader'
import { readResolvedPorts } from '../src/portResolver'
import { readPackageManifest } from '../src/serviceConfig'
import { isPidAlive } from './dataDirLock'
import { openInBrowser } from './openBrowser'
import { sqlWasmDir } from './sqlWasm'

export const DOCTOR_USAGE = 'traceroost doctor [--report <agent> [--open]]'

export interface DoctorIo {
  log: (line: string) => void
  error: (line: string) => void
  /** The running server's OTLP snapshot (GET /api/adapter-health), or undefined. */
  fetchServerHealth: () => Promise<unknown>
  /** The table from this machine's log files. */
  scanLocal: (health: AdapterHealth) => Promise<void>
  setupState: (key: AdapterKey) => string
  open: (url: string) => void
  now: () => number
}

const STATUS_TEXT: Record<AgentHealthRow['status'], string> = {
  'ok': 'OK',
  'missing-data': 'Missing data',
  'unrecognized': 'Unrecognized data',
  'no-data': 'No data',
  'not-verified': 'Not verified on this version',
}

function ago(ms: number | null, now: number): string {
  if (ms === null) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export async function runDoctorCli(args: string[], io: DoctorIo = defaultIo()): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.log(`Usage: ${DOCTOR_USAGE}\n` +
      '  Check that TraceRoost recognizes what each coding agent writes on this machine.\n' +
      '  --report <agent>  Print the GitHub issue "Report this" would open for that agent, in full.\n' +
      '  --open            With --report: open that issue form in your browser.\n' +
      `  Agents: ${ADAPTERS.map(a => a.key).join(', ')}`)
    return 0
  }
  let report: string | undefined
  let open = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--report' && args[i + 1] && !args[i + 1].startsWith('-')) { report = args[++i]; continue }
    if (args[i] === '--open') { open = true; continue }
    io.error(`Unknown option: ${args[i]}\nUsage: ${DOCTOR_USAGE}`)
    return 2
  }
  if (report !== undefined && !ADAPTERS.some(a => a.key === report)) {
    io.error(`Unknown agent: ${report} — one of ${ADAPTERS.map(a => a.key).join(', ')}`)
    return 2
  }
  if (open && report === undefined) {
    io.error('--open goes with --report <agent>')
    return 2
  }

  const health = new AdapterHealth(io.now)
  const server = await io.fetchServerHealth().catch(() => undefined)
  if (server) health.import(server)
  await io.scanLocal(health)
  const rows = health.rows()
  const now = io.now()

  if (report !== undefined) {
    const row = rows.find(r => r.key === report)!
    const version = row.versions.find(v => v.impact === 'loss') ?? row.versions.find(v => v.unknown > 0)
    if (!version) {
      io.log(`${row.label}: nothing unrecognized to report.`)
      return 0
    }
    const traceroostVersion = readPackageManifest(__dirname).version ?? 'unknown'
    const r = buildAgentReport(row, version.version, { traceroostVersion, os: `${process.platform} ${process.arch}` })!
    io.log(`${r.title}\n\n${r.body}\n\n${open ? 'Opening' : 'Open it with --open, or go to'}: ${r.url}`)
    if (open) io.open(r.url)
    return 0
  }

  const table = rows.map(r => [r.label, r.versionSeen ?? '—', ago(Math.max(r.lastFilesMs ?? 0, r.lastOtlpMs ?? 0) || null, now), io.setupState(r.key), STATUS_TEXT[r.status]])
  const head = ['Agent', 'Version seen', 'Last data', 'Setup', 'Status']
  const widths = head.map((h, i) => Math.max(h.length, ...table.map(t => t[i].length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()
  io.log(line(head))
  for (const t of table) io.log(line(t))
  if (!server) io.log('\n(OTLP counts come from a running TraceRoost server, and none answered — this is from local log files only.)')

  // Every version with unrecognized records is listed; only lost data fails the check.
  for (const r of rows.filter(x => x.status === 'missing-data' || x.status === 'unrecognized')) {
    for (const v of r.versions.filter(x => x.unknown > 0)) {
      const names = Object.entries(v.unknownNames).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ×${c}`).join(', ')
      io.log(`\n${r.label} ${v.version}: ${v.unknown} unrecognized of ${v.known + v.ignored + v.unknown} records — ${names}`)
      if (v.unreadFiles > 0) io.log(`  ${v.unreadFiles} session file${v.unreadFiles === 1 ? '' : 's'} gave no turns: missing from Traces.`)
      else if (v.impact === 'loss') io.log('  Records TraceRoost reads came without fields it needs: their numbers may be wrong.')
      else io.log('  Skipped; its sessions were still read.')
    }
    io.log(`  Report it: traceroost doctor --report ${r.key}`)
  }
  return rows.some(r => r.status === 'missing-data') ? 1 : 0
}

// ── The real machine ──────────────────────────────────────────────────────────

function defaultIo(): DoctorIo {
  return {
    log: l => console.log(l),
    error: l => console.error(l),
    fetchServerHealth,
    scanLocal,
    setupState,
    open: url => openInBrowser(url, err => console.error(`Could not open a browser: ${err.message}`)),
    now: Date.now,
  }
}

function fetchServerHealth(): Promise<unknown> {
  const ports = readResolvedPorts()
  if (!ports || !Number.isInteger(ports.ui) || !isPidAlive(ports.pid)) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: ports.ui, path: '/api/adapter-health', timeout: 2000 }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { body += c })
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : undefined) } catch { resolve(undefined) } })
    })
    req.on('timeout', () => { req.destroy(); resolve(undefined) })
    req.on('error', () => resolve(undefined))
  })
}

async function scanLocal(health: AdapterHealth): Promise<void> {
  let sqlFactory: OpenCodeSqlFactory | undefined
  try {
    const dir = sqlWasmDir()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const init = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<OpenCodeSqlFactory>
    if (dir) sqlFactory = await init({ locateFile: f => path.join(dir, f) })
  } catch { /* OpenCode reads off */ }
  const reader = new LogReader({ sqlFactory, observe: (f, o, mtimeMs) => health.observeFile(f, o, mtimeMs) })
  for (const { filePath, agentKey } of reader.collectFileMeta()) {
    if (agentKey !== 'opencode') reader.parseFile(filePath, agentKey)
  }
  reader.scanOpenCode()
}

/** Whether the agent is set up to send OTel to TraceRoost — read-only. */
function setupState(key: AdapterKey): string {
  const read = (f: string) => { try { return fs.readFileSync(f, 'utf8') } catch { return undefined } }
  switch (key) {
    case 'claude': {
      const text = read(path.join(os.homedir(), '.claude', 'settings.json'))
      if (text === undefined) return 'not set up'
      try {
        const endpoint = (JSON.parse(text) as { env?: Record<string, unknown> }).env?.['OTEL_EXPORTER_OTLP_ENDPOINT']
        return isTraceRoostEndpoint(endpoint) ? `OTel → ${endpoint}` : endpoint ? 'OTel elsewhere' : 'logs only'
      } catch { return 'settings unreadable' }
    }
    case 'codex': {
      const text = read(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'))
      const m = text && /\bendpoint\s*=\s*["'](http:\/\/localhost:\d{1,5})\/?["']/.exec(text)
      return m ? `OTel → ${m[1]}` : text === undefined ? 'not set up' : 'logs only'
    }
    case 'copilot_vscode': {
      for (const f of vscodeUserSettingsPaths()) {
        const text = read(f)
        if (!text) continue
        const s = parseJsonc(text, [], { allowTrailingComma: true }) as Record<string, unknown> | undefined
        if (s?.['github.copilot.chat.otel.enabled'] !== true) continue
        const endpoint = s[COPILOT_ENDPOINT_KEY] ?? COPILOT_DEFAULT_ENDPOINT
        if (isTraceRoostEndpoint(endpoint)) return `OTel → ${endpoint}`
      }
      return 'logs only'
    }
    default:
      return 'logs only'
  }
}
