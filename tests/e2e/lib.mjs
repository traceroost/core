// Shared helpers for the end-to-end suites in tests/e2e/ (artifact smoke, configure scripts,
// real agents) and the VS Code integration runner. Plain Node ESM with no dependencies beyond
// node: builtins, so each script runs from a bare checkout on any OS the workflow targets
// (.github/workflows/windows-e2e.yml) — including against a globally-installed npm tarball, where
// none of this repo's node_modules are on the resolution path.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const IS_WIN = process.platform === 'win32'

export function log(...args) {
  console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...args)
}

export class SkipError extends Error {}

/** A GitHub Actions notice (shows on the run summary) when running there, a plain line otherwise. */
export function notice(msg) {
  if (process.env.GITHUB_ACTIONS) console.log(`::notice::${msg.replace(/\r?\n/g, '%0A')}`)
  else console.log(`NOTICE: ${msg}`)
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** Polls `fn` until it returns a truthy value (which is returned) or `timeoutMs` elapses. */
export async function waitFor(what, fn, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) { lastErr = e }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${lastErr ? ` (last error: ${lastErr.message ?? lastErr})` : ''}`)
    }
    await sleep(intervalMs)
  }
}

/** A port nothing is listening on right now (bind :0 on loopback, read it back, release it). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** Distinct free ports (so two calls in a row can't hand back the same just-released port). */
export async function freePorts(n) {
  const out = new Set()
  while (out.size < n) out.add(await freePort())
  return [...out]
}

export function request(method, url, { body, headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    const req = http.request(url, {
      method,
      headers: {
        ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error(`${method} ${url} timed out`)))
    req.on('error', reject)
    if (data !== undefined) req.write(data)
    req.end()
  })
}

export async function getJson(url) {
  const res = await request('GET', url)
  if (res.status !== 200) throw new Error(`GET ${url} → ${res.status}: ${res.text.slice(0, 300)}`)
  return JSON.parse(res.text)
}

export async function postJson(url, body) {
  const res = await request('POST', url, { body })
  if (res.status < 200 || res.status >= 300) throw new Error(`POST ${url} → ${res.status}: ${res.text.slice(0, 300)}`)
  return res.text ? JSON.parse(res.text) : null
}

/**
 * One MCP `tools/call` against a TraceRoost MCP endpoint (stateless streamable HTTP — see
 * src/mcpServer.ts's handleMcpRequest). Returns the tool's parsed JSON result.
 */
export async function mcpCall(url, name, args = {}) {
  const res = await request('POST', url, {
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    headers: { Accept: 'application/json, text/event-stream' },
  })
  if (res.status !== 200) throw new Error(`MCP ${name} → ${res.status}: ${res.text.slice(0, 300)}`)
  // The transport may answer as a single JSON body or as an SSE stream of `data:` lines.
  const payloads = res.text.trim().startsWith('{')
    ? [res.text]
    : res.text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
  for (const p of payloads) {
    const msg = JSON.parse(p)
    if (msg.error) throw new Error(`MCP ${name} error: ${JSON.stringify(msg.error)}`)
    const text = msg.result?.content?.[0]?.text
    if (text !== undefined) return JSON.parse(text)
  }
  throw new Error(`MCP ${name}: no result in response: ${res.text.slice(0, 300)}`)
}

// ── Isolated home directory ──────────────────────────────────────────────────

/**
 * A throwaway home directory, plus the environment that points every home-relative lookup this
 * product does at it: `os.homedir()` (HOME on POSIX, USERPROFILE on Windows) and the Windows
 * per-user app-data roots (logReader.ts / autoConfigNode.ts read APPDATA and LOCALAPPDATA).
 * Overrides that would redirect lookups elsewhere (CLAUDE_CONFIG_DIR, CODEX_HOME,
 * XDG_CONFIG_HOME) are cleared so the defaults under the temp home are what gets exercised.
 */
export function makeTempHome(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `traceroost-${label}-`))
  // Resolve 8.3 short names (RUNNER~1) so paths compare equal to what the product reports.
  const home = fs.realpathSync.native(root)
  const appData = path.join(home, 'AppData', 'Roaming')
  const localAppData = path.join(home, 'AppData', 'Local')
  fs.mkdirSync(appData, { recursive: true })
  fs.mkdirSync(localAppData, { recursive: true })
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  }
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'TRACEROOST_ORG_ENV', 'TRACEROOST_ORG_URL']) delete env[k]
  if (IS_WIN) {
    // HOMEDRIVE/HOMEPATH are what some tools fall back to when USERPROFILE is unset; keep them in step.
    env.HOMEDRIVE = home.slice(0, 2)
    env.HOMEPATH = home.slice(2)
  }
  return { home, env, cleanup: () => rmrf(home) }
}

export function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* best effort */ }
}

// ── Git fixture repo ─────────────────────────────────────────────────────────

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * A real local git repository on `main` with one initial commit — what the fixture sessions
 * "work in". Returns its realpath (Windows: long-name, drive-letter form).
 */
export function makeGitRepo(parent, name = 'fixture-repo') {
  const dir = path.join(parent, name)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'e2e@traceroost.invalid')
  git(dir, 'config', 'user.name', 'TraceRoost E2E')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'initial')
  return fs.realpathSync.native(dir)
}

// ── Claude Code fixture session ──────────────────────────────────────────────
//
// One Claude Code conversation described twice, the two ways TraceRoost ingests Claude:
//   - OTLP/JSON spans (what Claude Code's OTEL exporter posts to /v1/traces), and
//   - the on-disk transcript (~/.claude/projects/<sanitized cwd>/<session id>.jsonl).
// Both carry the same Claude session id, so the product should count them as ONE session.
// The session writes `hello.txt` in the fixture repo; the caller commits it so the git-outcome
// classifier has something to find.

const hex = (n) => crypto.randomBytes(n).toString('hex')
const nano = (ms) => `${BigInt(Math.round(ms)) * 1_000_000n}`
const attr = (key, v) => ({
  key,
  value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: String(v) },
})

export const FIXTURE_MODEL = 'claude-sonnet-4-6'

/** Claude Code's project-directory naming: every non-alphanumeric character of the cwd becomes `-`. */
export function claudeProjectDirName(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export function claudeFixture({ repo, startMs = Date.now() - 10 * 60_000, prompt = 'Create hello.txt containing hello' }) {
  const sessionId = crypto.randomUUID()
  const traceId = hex(16)
  const rootId = hex(8)
  const llm1 = hex(8)
  const llm2 = hex(8)
  const toolId = hex(8)
  const file = path.join(repo, 'hello.txt')
  const span = (spanId, parentSpanId, name, atMs, durMs, attributes) => ({
    traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, kind: 1,
    startTimeUnixNano: nano(startMs + atMs), endTimeUnixNano: nano(startMs + atMs + durMs),
    attributes, status: { code: 0 },
  })
  const otlp = {
    resourceSpans: [{
      resource: { attributes: [attr('service.name', 'claude-code'), attr('session.id', sessionId)] },
      scopeSpans: [{
        scope: { name: 'com.anthropic.claude_code' },
        spans: [
          span(rootId, undefined, 'claude_code.interaction', 0, 6000, [
            attr('user_prompt', prompt), attr('interaction.duration_ms', 6000),
          ]),
          span(llm1, rootId, 'claude_code.llm_request', 100, 1500, [
            attr('input_tokens', 1200), attr('output_tokens', 80), attr('cache_creation_tokens', 900),
            attr('gen_ai.request.model', FIXTURE_MODEL), attr('stop_reason', 'tool_use'), attr('ttft_ms', 300),
          ]),
          span(toolId, llm1, 'claude_code.tool', 1700, 50, [
            attr('tool_name', 'Write'),
            attr('tool_input', JSON.stringify({ file_path: file, content: 'hello\n' })),
            attr('duration_ms', 50),
          ]),
          span(llm2, rootId, 'claude_code.llm_request', 1900, 900, [
            attr('input_tokens', 400), attr('output_tokens', 30), attr('cache_read_tokens', 900),
            attr('gen_ai.request.model', FIXTURE_MODEL), attr('stop_reason', 'end_turn'), attr('ttft_ms', 200),
          ]),
        ],
      }],
    }],
  }
  const iso = (at) => new Date(startMs + at).toISOString()
  const base = { sessionId, cwd: repo, version: '2.1.0', gitBranch: 'main', userType: 'external', isSidechain: false }
  const u1 = crypto.randomUUID(); const a1 = crypto.randomUUID(); const u2 = crypto.randomUUID(); const a2 = crypto.randomUUID()
  const toolUseId = `toolu_${hex(12)}`
  const transcript = [
    { ...base, type: 'user', uuid: u1, parentUuid: null, timestamp: iso(0), message: { role: 'user', content: prompt } },
    { ...base, type: 'assistant', uuid: a1, parentUuid: u1, timestamp: iso(1600), requestId: `req_${hex(8)}`, message: {
      id: `msg_${hex(8)}`, role: 'assistant', model: FIXTURE_MODEL, stop_reason: 'tool_use',
      usage: { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 },
      content: [{ type: 'tool_use', id: toolUseId, name: 'Write', input: { file_path: file, content: 'hello\n' } }],
    } },
    { ...base, type: 'user', uuid: u2, parentUuid: a1, timestamp: iso(1760), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: toolUseId, content: `File created successfully at: ${file}` },
    ] } },
    { ...base, type: 'assistant', uuid: a2, parentUuid: u2, timestamp: iso(2800), requestId: `req_${hex(8)}`, message: {
      id: `msg_${hex(8)}`, role: 'assistant', model: FIXTURE_MODEL, stop_reason: 'end_turn',
      usage: { input_tokens: 400, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
      content: [{ type: 'text', text: 'Created hello.txt.' }],
    } },
  ]
  return { sessionId, traceId, rootSpanId: rootId, file, otlp, transcript }
}

/** Writes the fixture's transcript where Claude Code would, under `home`. Returns the file path. */
export function writeClaudeTranscript(home, fixture, repo) {
  const dir = path.join(home, '.claude', 'projects', claudeProjectDirName(repo))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${fixture.sessionId}.jsonl`)
  fs.writeFileSync(file, fixture.transcript.map(l => JSON.stringify(l)).join('\n') + '\n')
  return file
}

/** Materializes the file the fixture session "wrote" and commits it, so the outcome is decidable. */
export function commitFixtureChange(repo, fixture) {
  fs.writeFileSync(fixture.file, 'hello\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'add hello.txt')
}

// ── Processes ────────────────────────────────────────────────────────────────

/**
 * Spawns a long-running process, teeing its output to our stdout with a prefix and keeping the
 * last lines for error reports. `stop()` kills the whole tree (Windows: taskkill /T — a plain
 * kill leaves node's children, and the ports they hold, behind).
 */
export function startProcess(label, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const tail = []
  const onData = (d) => {
    for (const line of d.toString().split(/\r?\n/)) {
      if (!line) continue
      tail.push(line); if (tail.length > 200) tail.shift()
      console.log(`  [${label}] ${line}`)
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  let exited = null
  const exitPromise = new Promise(resolve => child.on('exit', (code, signal) => { exited = { code, signal }; resolve(exited) }))
  child.on('error', (e) => { tail.push(`spawn error: ${e.message}`) })
  return {
    child,
    tail,
    get exited() { return exited },
    output: () => tail.join('\n'),
    async stop() {
      if (exited) return exited
      if (IS_WIN) {
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
      } else {
        child.kill('SIGTERM')
      }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 5000)
      await exitPromise
      clearTimeout(timer)
      return exited
    },
  }
}

/** `npm`/`npx`/`pnpm` and globally installed bins are .cmd shims on Windows; Node refuses to spawn a
 *  .cmd without a shell (CVE-2024-27980), so run those through one there. Args must be shell-safe. */
export function run(cmd, args, opts = {}) {
  const shell = IS_WIN && !/\.(exe|com)$/i.test(cmd) && !path.isAbsolute(cmd) ? true : (opts.shell ?? false)
  const quoted = shell ? args.map(a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args
  log(`$ ${cmd} ${args.join(' ')}`)
  const file = shell && /\s/.test(cmd) ? `"${cmd}"` : cmd
  return execFileSync(file, quoted, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts, shell })
}

/** Like run(), but never throws on a non-zero exit: returns { status, stdout, stderr } (both streams captured). */
export function tryRun(cmd, args, opts = {}) {
  const shell = IS_WIN && !/\.(exe|com)$/i.test(cmd) && !path.isAbsolute(cmd) ? true : (opts.shell ?? false)
  const quoted = shell ? args.map(a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args
  const file = shell && /\s/.test(cmd) ? `"${cmd}"` : cmd
  log(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(file, quoted, { encoding: 'utf8', ...opts, shell, stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') }
}

/** Runs `fn` as a named step; prints PASS/FAIL, collects the failure instead of throwing, so a
 *  suite reports every broken step at once. A SkipError reports as SKIP. */
export function stepRunner() {
  const results = []
  async function step(name, fn) {
    const t0 = Date.now()
    log(`▶ ${name}`)
    try {
      const v = await fn()
      results.push({ name, status: 'pass', ms: Date.now() - t0 })
      log(`✔ ${name} (${Date.now() - t0} ms)`)
      return v
    } catch (e) {
      if (e instanceof SkipError) {
        results.push({ name, status: 'skip', ms: Date.now() - t0, reason: e.message })
        notice(`${name}: skipped — ${e.message}`)
        return undefined
      }
      results.push({ name, status: 'fail', ms: Date.now() - t0, error: e })
      console.error(`✘ ${name}: ${e.stack ?? e}`)
      if (process.env.GITHUB_ACTIONS) console.log(`::error title=${name}::${String(e.message ?? e).replace(/\r?\n/g, '%0A')}`)
      return undefined
    }
  }
  function summary() {
    console.log('\nSummary:')
    for (const r of results) console.log(`  ${r.status.toUpperCase().padEnd(4)} ${r.name} (${r.ms} ms)${r.reason ? ` — ${r.reason}` : ''}`)
    const failed = results.filter(r => r.status === 'fail')
    if (process.env.GITHUB_STEP_SUMMARY) {
      const lines = [`### ${path.basename(process.argv[1])} on ${process.platform}-${process.arch}`, '', '| step | result | ms |', '| --- | --- | --- |',
        ...results.map(r => `| ${r.name} | ${r.status}${r.reason ? ` (${r.reason})` : ''} | ${r.ms} |`), '']
      try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n') } catch { /* ignore */ }
    }
    return failed.length
  }
  return { step, summary, results }
}
