#!/usr/bin/env node
/**
 * TraceRoost capture — records real OTLP telemetry from a live agent session
 * and saves it as a fixture file for deterministic demo replay.
 *
 * Works with: Claude Code, Codex (via standalone server on port 4318)
 * Copilot note: Copilot telemetry routes through the VS Code extension, not the
 * standalone server, so it cannot be captured this way. Run a mixed session with
 * Claude Code or Codex instead.
 *
 * Prerequisites:
 *   pnpm run local        (standalone server must be running)
 *
 * Usage:
 *   pnpm run capture -- [name]
 *   pnpm run capture -- my-refactor-session
 *   pnpm run capture -- --duration 120    # auto-save after 120 seconds
 *   pnpm run capture -- --clear           # wipe existing data before recording
 *   pnpm run capture:list                 # list saved fixtures
 *   pnpm run capture -- --delete my-session
 *
 * Workflow:
 *   1. Start standalone server:  pnpm run local
 *   2. Start capture:            pnpm run capture -- my-session
 *   3. Run your Claude Code / Codex session normally
 *   4. Press s (or wait for --duration) to save
 *   5. Replay later:             pnpm run demo -- --fixture my-session
 */

import * as http from 'node:http'
import * as fs   from 'node:fs'
import * as path from 'node:path'
import * as os   from 'node:os'
import * as readline from 'node:readline'

// ── CLI ────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function flag(name: string, fallback: string): string {
  const i = args.indexOf('--' + name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
function hasFlag(name: string): boolean { return args.includes('--' + name) }

const UI_PORT  = parseInt(flag('ui-port', '3000')) || 3000
const DURATION = parseInt(flag('duration', '0'))   || 0   // 0 = manual save key
const DO_CLEAR = hasFlag('clear')
const DO_LIST  = hasFlag('list')
const DO_DELETE = hasFlag('delete')
const DELETE_NAME = DO_DELETE ? (args[args.indexOf('--delete') + 1] ?? '') : ''
const nameArg  = args.find(a => !a.startsWith('--') && a !== DELETE_NAME)
const SESSION_NAME = nameArg ?? `session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`

const FIXTURES_DIR = path.join(__dirname, 'fixtures')
const SAVE_KEY = 's'

// ── Fixture format ─────────────────────────────────────────────────────────────

interface SpanAttr {
  key: string
  value: Record<string, unknown>
}
interface CapturedSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: string
  endTime: string
  attributes: SpanAttr[]
  status?: { code: number; message?: string }
}
interface Fixture {
  name: string
  capturedAt: string
  durationMs: number
  spanCount: number
  agents: string[]
  spans: CapturedSpan[]
}

// ── Logging ────────────────────────────────────────────────────────────────────

function log(msg: string) { process.stdout.write(`\x1b[36m[capture]\x1b[0m ${msg}\n`) }
function ok(msg: string)  { process.stdout.write(`\x1b[32m  ✓\x1b[0m ${msg}\n`) }
function warn(msg: string){ process.stdout.write(`\x1b[33m  !\x1b[0m ${msg}\n`) }
function err(msg: string) { process.stderr.write(`\x1b[31m  ✗\x1b[0m ${msg}\n`) }

function clearLine() {
  if (process.stdout.isTTY) {
    process.stdout.write('\r\x1b[K')
  }
}
function progress(captured: number, total: number) {
  if (!process.stdout.isTTY) return
  const agents = total > 0 ? '' : ' (waiting for first span…)'
  process.stdout.write(`\r\x1b[36m[capture]\x1b[0m ${captured} new span${captured !== 1 ? 's' : ''} captured${agents}`)
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function checkServer(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.request(
      { hostname: '127.0.0.1', port: UI_PORT, method: 'GET', path: '/', timeout: 2000 },
      () => resolve(true)
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

function postJson(p: string, body: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { hostname: '127.0.0.1', port: UI_PORT, method: 'POST', path: p,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { res.resume(); res.on('end', resolve) }
    )
    req.on('error', reject)
    req.write(data); req.end()
  })
}

function detectAgents(spans: CapturedSpan[]): string[] {
  const agents = new Set<string>()
  for (const s of spans) {
    if (s.name.startsWith('claude_code.')) agents.add('claude_code')
    else if (s.name === 'invoke_agent' || s.name.startsWith('chat/') || s.name.startsWith('execute_tool/')) agents.add('copilot')
    else if (s.name.startsWith('codex.')) agents.add('codex')
  }
  return [...agents]
}

// ── List fixtures ──────────────────────────────────────────────────────────────

function listFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    log('No fixtures directory found. Capture a session first.')
    return
  }
  const files = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json'))
  if (files.length === 0) {
    log('No fixtures saved yet.')
    return
  }
  log(`Saved fixtures in ${FIXTURES_DIR}:\n`)
  for (const f of files) {
    try {
      const fixture: Fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf-8'))
      const agents = fixture.agents?.join(', ') ?? 'unknown'
      const date = new Date(fixture.capturedAt).toLocaleString()
      const dur = fixture.durationMs > 0 ? `${Math.round(fixture.durationMs / 1000)}s` : '?'
      const name = f.replace('.json', '')
      process.stdout.write(
        `  \x1b[32m${name}\x1b[0m  ${fixture.spanCount} spans  ${dur}  [${agents}]  ${date}\n`
      )
    } catch {
      process.stdout.write(`  ${f}  (unreadable)\n`)
    }
  }
  process.stdout.write('\n')
  process.stdout.write('Replay with:  pnpm run demo -- --fixture <name>\n')
}

// ── Delete fixture ─────────────────────────────────────────────────────────────

function deleteFixture(name: string) {
  const fp = path.join(FIXTURES_DIR, name + '.json')
  if (!fs.existsSync(fp)) { err(`Fixture not found: ${name}`); process.exit(1) }
  fs.unlinkSync(fp)
  ok(`Deleted ${fp}`)
}

// ── Save fixture ───────────────────────────────────────────────────────────────

function saveFixture(name: string, spans: CapturedSpan[], startMs: number) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true })
  const fp = path.join(FIXTURES_DIR, name + '.json')

  // Compute actual duration from span timestamps
  let minNano = BigInt('9'.repeat(20))
  let maxNano = 0n
  for (const s of spans) {
    const st = BigInt(s.startTime), et = BigInt(s.endTime)
    if (st < minNano) minNano = st
    if (et > maxNano) maxNano = et
  }
  const durationMs = spans.length > 0
    ? Number((maxNano - minNano) / 1_000_000n)
    : Date.now() - startMs

  const fixture: Fixture = {
    name,
    capturedAt: new Date().toISOString(),
    durationMs,
    spanCount: spans.length,
    agents: detectAgents(spans),
    spans,
  }
  fs.writeFileSync(fp, JSON.stringify(fixture, null, 2), 'utf-8')
  return fp
}

// ── SSE capture ────────────────────────────────────────────────────────────────

function startCapture(): Promise<CapturedSpan[]> {
  return new Promise((resolve, reject) => {
    const captured = new Map<string, CapturedSpan>()  // spanId → span (dedup)
    let seenOnConnect = new Set<string>()             // spanIds present before we started
    let initialised = false
    let done = false
    let durationTimer: ReturnType<typeof setTimeout> | undefined
    let keypressHandler: ((str: string, key: readline.Key) => void) | undefined
    const hadRawMode = process.stdin.isTTY ? process.stdin.isRaw : false

    function cleanupInput() {
      if (keypressHandler) {
        process.stdin.off('keypress', keypressHandler)
        keypressHandler = undefined
      }
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(hadRawMode)
        if (!hadRawMode) { process.stdin.pause() }
      }
    }

    function finish() {
      if (done) return
      done = true
      if (durationTimer) { clearTimeout(durationTimer); durationTimer = undefined }
      cleanupInput()
      req.destroy()
      resolve([...captured.values()])
    }

    function cancel() {
      if (done) return
      done = true
      if (durationTimer) { clearTimeout(durationTimer); durationTimer = undefined }
      cleanupInput()
      req.destroy()
      reject(new Error('Capture cancelled'))
    }

    // Connect to SSE stream
    const req = http.request(
      { hostname: '127.0.0.1', port: UI_PORT, method: 'GET', path: '/events' },
      res => {
        let buf = ''
        res.on('data', (chunk: Buffer) => {
          if (done) return
          buf += chunk.toString()
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            let msg: { type: string; spans?: CapturedSpan[] }
            try { msg = JSON.parse(line.slice(6)) } catch { continue }
            if (msg.type !== 'update' || !Array.isArray(msg.spans)) continue

            if (!initialised) {
              // First message: record which spans already existed before our session
              seenOnConnect = new Set(msg.spans.map(s => s.spanId))
              initialised = true
              clearLine()
              log(`Baseline: ${seenOnConnect.size} pre-existing spans (ignored)`)
              log('Recording started — run your agent session now\n')
              if (process.stdin.isTTY) {
                log(`Press "${SAVE_KEY}" to save and exit${DURATION > 0 ? `, or wait ${DURATION}s for auto-save` : ''}.\n`)
              } else if (DURATION > 0) {
                log(`Auto-saving in ${DURATION}s\n`)
              } else {
                warn(`No interactive terminal detected. Start capture with --duration <seconds> to auto-save.`)
              }
              progress(0, 0)
            } else {
              // Subsequent messages: add any new spans not seen at connect time
              for (const s of msg.spans) {
                if (!seenOnConnect.has(s.spanId) && !captured.has(s.spanId)) {
                  captured.set(s.spanId, s)
                }
              }
              clearLine()
              progress(captured.size, msg.spans.length)
            }
          }
        })
        res.on('error', reject)
        res.on('end', () => { if (!done) finish() })
      }
    )
    req.on('error', reject)
    req.end()

    // Duration auto-stop
    if (DURATION > 0) {
      durationTimer = setTimeout(() => {
        clearLine()
        log(`Duration ${DURATION}s reached — saving…`)
        finish()
      }, DURATION * 1000)
    }

    // Interactive save key. Ctrl+C intentionally cancels; save is bound to a
    // plain key so package runners and terminal signal handling do not interfere.
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin)
      process.stdin.setRawMode(true)
      process.stdin.resume()
      keypressHandler = (_str, key) => {
        if (key.ctrl && key.name === 'c') {
          clearLine()
          log('Ctrl+C — cancelling without saving. Press "s" to save.')
          cancel()
          return
        }
        if ((key.name || '').toLowerCase() === SAVE_KEY) {
          clearLine()
          log(`"${SAVE_KEY}" pressed — saving…`)
          finish()
        }
      }
      process.stdin.on('keypress', keypressHandler)
    }
  })
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Utility commands
  if (DO_LIST)   { listFixtures(); return }
  if (DO_DELETE) { deleteFixture(DELETE_NAME); return }

  // Health check
  const alive = await checkServer()
  if (!alive) {
    err(`Cannot reach http://127.0.0.1:${UI_PORT}`)
    err('Start the standalone server first:  pnpm run local')
    process.exit(1)
  }

  log(`Saving fixture as: \x1b[32m${SESSION_NAME}\x1b[0m`)
  if (DO_CLEAR) {
    warn('Clearing existing span data (--clear flag)')
    await postJson('/api/clear', {})
    ok('Server cleared')
  } else {
    warn('Existing spans will be excluded from the fixture (connect-time baseline)')
    warn('Use --clear to wipe the server before recording for a clean slate')
  }

  log(`Dashboard: http://localhost:${UI_PORT}`)
  log('─────────────────────────────────────────────────')
  log('Connecting to SSE stream…\n')

  const startMs = Date.now()
  const spans = await startCapture()

  if (spans.length === 0) {
    warn('No new spans captured — nothing to save.')
    warn('Make sure the agent session ran AFTER capture started.')
    warn('If you used --clear, rerun capture with the updated standalone server so the baseline starts empty.')
    warn('For Codex/Claude, restart the agent terminal after standalone configures OTEL; running agents keep old telemetry settings.')
    warn('Check the standalone terminal for "[OTLP] ... ingested" lines. If none appear, the agent is not sending to this collector/port.')
    process.exit(1)
  }

  process.stdout.write('\n')
  const fp = saveFixture(SESSION_NAME, spans, startMs)
  const agents = detectAgents(spans).join(', ') || 'unknown'
  ok(`Saved ${spans.length} spans → ${fp}`)
  ok(`Agents detected: ${agents}`)
  log('')
  log(`Replay command:`)
  log(`  pnpm run demo -- --fixture ${SESSION_NAME}`)
  log(`  pnpm run demo:tour -- --fixture ${SESSION_NAME}`)
}

main().catch(e => { err(String(e)); process.exit(1) })
