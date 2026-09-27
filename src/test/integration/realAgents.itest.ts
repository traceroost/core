/**
 * Real AI agents against the real extension: drives the Claude Code CLI and the Codex CLI
 * non-interactively in a throwaway git repo, with the extension's own auto-config (activation
 * writes ~/.claude/settings.json and ~/.codex/config.toml under the temp home) as the only thing
 * pointing them at TraceRoost. Then asserts the session arrived from BOTH OTEL and the agent's
 * on-disk transcript, deduped into one row, with workspace = the repo, tokens, cost, model and a
 * git outcome. Captured transcripts, exported spans and the database are copied to
 * cfg.captureDir for tests/e2e/captures-to-fixtures.mjs.
 *
 * Driven by tests/e2e/real-agents.mjs (nightly / manual / release only — it spends API credits);
 * an agent whose CLI or key isn't available is absent from cfg.agents and its test is skipped.
 */
import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync, spawn } from 'child_process'
import * as vscode from 'vscode'
import {
  loadConfig, waitFor, httpRequest, mcpCall, globalStorageDir, queryDb, outputChannelText, samePath, sleep,
  type ItConfig, type Row,
} from './support'

const PROMPT = 'Create a file named hello.txt in the current directory containing exactly the text: hello from traceroost e2e. Do not create or modify any other file, and do not run any commands.'

function makeRepo(parent: string, name: string): string {
  const dir = path.join(parent, name)
  fs.mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@traceroost.invalid')
  git('config', 'user.name', 'TraceRoost E2E')
  git('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(dir, 'README.md'), '# agent sandbox\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  return fs.realpathSync.native(dir)
}

function runAgent(label: string, bin: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}, timeoutMs = 5 * 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // npm's global bins are .cmd shims on Windows, which Node only spawns through a shell.
    const shell = process.platform === 'win32' && /\.cmd$/i.test(bin)
    const quote = (a: string) => (shell ? `"${a.replace(/"/g, '\\"')}"` : a)
    const child = spawn(shell ? quote(bin) : bin, args.map(quote), { cwd, shell, env: { ...process.env, ...extraEnv }, windowsHide: true })
    let out = ''
    const onData = (d: Buffer) => { const s = d.toString(); out += s; process.stdout.write(`  [${label}] ${s}`) }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.stdin.end()
    const timer = setTimeout(() => { out += '\n[timed out]'; child.kill() }, timeoutMs)
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }) })
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: out + String(e) }) })
  })
}

function copyTree(src: string, dest: string): void {
  try { fs.cpSync(src, dest, { recursive: true }) } catch { /* nothing there */ }
}

suite('Real agents → TraceRoost (end to end)', () => {
  let cfg: ItConfig
  let ext: vscode.Extension<unknown>
  let dbPath: string

  suiteSetup(async () => {
    cfg = loadConfig()
    const found = vscode.extensions.getExtension(cfg.extensionId)
    assert.ok(found, `extension ${cfg.extensionId} is installed`)
    ext = found
    if (!ext.isActive) await ext.activate()
    dbPath = path.join(globalStorageDir(cfg, ext), 'traceroost.db')
    // Auto-config must have pointed both agents at this window's collector before they start.
    const endpoint = `http://localhost:${cfg.otlpPort}`
    await waitFor('auto-config of ~/.claude/settings.json', () =>
      (JSON.parse(fs.readFileSync(path.join(cfg.home, '.claude', 'settings.json'), 'utf8')) as { env?: Record<string, string> }).env?.OTEL_EXPORTER_OTLP_ENDPOINT === endpoint, 30_000)
    await waitFor('auto-config of ~/.codex/config.toml', () =>
      fs.readFileSync(path.join(cfg.home, '.codex', 'config.toml'), 'utf8').includes(endpoint), 30_000)
  })

  suiteTeardown(async () => {
    if (!cfg?.captureDir) return
    fs.mkdirSync(cfg.captureDir, { recursive: true })
    copyTree(path.join(cfg.home, '.claude', 'projects'), path.join(cfg.captureDir, 'claude-projects'))
    copyTree(path.join(cfg.home, '.codex', 'sessions'), path.join(cfg.captureDir, 'codex-sessions'))
    copyTree(path.join(cfg.home, '.claude', 'settings.json'), path.join(cfg.captureDir, 'claude-settings.json'))
    copyTree(path.join(cfg.home, '.codex', 'config.toml'), path.join(cfg.captureDir, 'codex-config.toml'))
    // The spans exactly as the collector ingested them — the extension's own export command.
    const dir = globalStorageDir(cfg, ext)
    const before = new Set(fs.readdirSync(dir))
    try {
      await vscode.commands.executeCommand('traceRoost.exportData')
      await sleep(3000)
      for (const f of fs.readdirSync(dir).filter(f => !before.has(f) && f.endsWith('.json'))) {
        fs.copyFileSync(path.join(dir, f), path.join(cfg.captureDir, `otel-${f}`))
      }
    } catch { /* best effort */ }
    copyTree(dbPath, path.join(cfg.captureDir, 'traceroost.db'))
    fs.writeFileSync(path.join(cfg.captureDir, 'output-channel.log'), outputChannelText(cfg))
  })

  async function sessionsFor(source: string, repo: string): Promise<Row[]> {
    const rows = await queryDb(ext.extensionPath, dbPath,
      'SELECT session_id, data_source, workspace, model, input_tokens, output_tokens, cost_usd, conversation_id, files_changed FROM sessions WHERE source = ?', [source])
    return rows.filter(r => samePath(String(r.workspace), repo))
  }

  async function assertIngested(agent: 'claude_code' | 'codex', repo: string, logDir: string): Promise<void> {
    // The transcript: the agent wrote its own log under the temp home.
    const transcripts = (function walk(d: string): string[] {
      let out: string[] = []
      for (const e of (() => { try { return fs.readdirSync(d, { withFileTypes: true }) } catch { return [] } })()) {
        const p = path.join(d, e.name)
        out = e.isDirectory() ? out.concat(walk(p)) : (p.endsWith('.jsonl') ? out.concat([p]) : out)
      }
      return out
    })(logDir)
    assert.ok(transcripts.length > 0, `${agent} wrote a transcript under ${logDir}`)

    // OTEL: the collector received this agent's telemetry (the span dump names it).
    const otelSeen = await waitFor(`${agent} OTEL spans at the collector`, async () => {
      await vscode.commands.executeCommand('traceRoost.dumpSpanAttrs')
      const text = outputChannelText(cfg)
      const re = agent === 'claude_code' ? /\[claude_code\.[a-z_.]+\]/ : /\[codex\.[a-z_.]+\]/
      return re.test(text) ? true : undefined
    }, 120_000, 5_000)
    assert.ok(otelSeen)

    // One session for this repo — OTEL and transcript deduped — with the details filled in. The
    // transcript is re-scanned every 30 s; OTEL arrives within seconds of the agent exiting.
    const rows = await waitFor(`exactly one ${agent} session for ${repo}`, async () => {
      const r = await sessionsFor(agent, repo)
      return r.length >= 1 ? r : undefined
    }, 150_000, 3_000)
    await sleep(35_000) // one more log-scan tick, so a duplicate transcript row would have landed
    const settled = await sessionsFor(agent, repo)
    assert.strictEqual(settled.length, 1, `${agent}: one deduped session for the repo, got ${JSON.stringify(settled, null, 1)}`)
    const row = settled[0] ?? rows[0]
    assert.ok(Number(row.input_tokens) > 0, `${agent}: input tokens (${row.input_tokens})`)
    assert.ok(Number(row.output_tokens) > 0, `${agent}: output tokens (${row.output_tokens})`)
    assert.ok(String(row.model).length > 0, `${agent}: model set`)
    const recent = await mcpCall(cfg.mcpPort, 'get_recent_sessions', { limit: 50, agent }) as Array<{ sessionId: string; cost_usd: number }>
    const cost = recent.find(r => r.sessionId === row.session_id)?.cost_usd ?? Number(row.cost_usd)
    assert.ok(cost > 0, `${agent}: cost > 0 (got ${cost})`)
    const changed = JSON.parse(String(row.files_changed || '[]')) as string[]
    assert.ok(changed.some(f => /hello\.txt$/.test(f)), `${agent}: hello.txt recorded as changed (${row.files_changed})`)

    // Git outcome: commit what the agent did, then wait for reconciliation to classify it (saved
    // with the next database write, which a keep-alive OTLP post triggers).
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', `${agent} change`], { cwd: repo })
    const outcome = await waitFor(`${agent} git outcome`, async () => {
      await httpRequest('POST', `http://127.0.0.1:${cfg.otlpPort}/v1/traces`, cfg.fixture.otlp)
      await sleep(1500)
      return (await queryDb(ext.extensionPath, dbPath, 'SELECT overall, reason FROM git_outcome WHERE session_id = ?', [row.session_id]))[0]
    }, 180_000, 5_000)
    assert.ok(['committed', 'merged'].includes(String(outcome.overall)), `${agent}: outcome committed/merged (got ${outcome.overall}: ${outcome.reason})`)
  }

  test('Claude Code CLI', async function () {
    const agent = cfg.agents?.claude
    if (!agent) { this.skip() }
    const repo = makeRepo(cfg.home, 'claude-sandbox')
    const r = await runAgent('claude', agent!.bin, [...agent!.args, PROMPT], repo, agent!.env)
    assert.strictEqual(r.code, 0, `claude exited ${r.code}`)
    assert.ok(fs.existsSync(path.join(repo, 'hello.txt')), 'claude created hello.txt')
    await assertIngested('claude_code', repo, path.join(cfg.home, '.claude', 'projects'))
  })

  test('Codex CLI', async function () {
    const agent = cfg.agents?.codex
    if (!agent) { this.skip() }
    const repo = makeRepo(cfg.home, 'codex-sandbox')
    const key = process.env.OPENAI_API_KEY
    if (agent!.login && key) {
      // Stores the key in $CODEX_HOME (= the temp home's .codex) — `codex login --with-api-key` reads stdin.
      await new Promise<void>((resolve, reject) => {
        const shell = process.platform === 'win32' && /\.cmd$/i.test(agent!.bin)
        const child = spawn(shell ? `"${agent!.bin}"` : agent!.bin, ['login', '--with-api-key'], { shell, env: process.env, windowsHide: true })
        child.stdin.end(key + '\n')
        child.on('close', code => (code === 0 ? resolve() : reject(new Error(`codex login exited ${code}`))))
        child.on('error', reject)
      })
    }
    const r = await runAgent('codex', agent!.bin, [...agent!.args, PROMPT], repo, { ...agent!.env, ...(key ? { CODEX_API_KEY: key } : {}) })
    assert.strictEqual(r.code, 0, `codex exited ${r.code}`)
    assert.ok(fs.existsSync(path.join(repo, 'hello.txt')), 'codex created hello.txt')
    await assertIngested('codex', repo, path.join(cfg.home, '.codex', 'sessions'))
  })
})
