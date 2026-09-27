#!/usr/bin/env node
// Real AI agents on this OS → TraceRoost (VS Code extension, dev build). Spends API credits, so
// the workflow runs it nightly / on manual dispatch / for releases only — never per PR.
//
// Expects the agent CLIs installed globally (the workflow does it):
//   npm install -g @anthropic-ai/claude-code @openai/codex
// and the keys in the environment: ANTHROPIC_API_KEY (Claude Code), OPENAI_API_KEY (Codex).
// An agent whose key or CLI is missing is skipped with a notice; with neither available the
// script exits 0 after saying so.
//
//   node tests/e2e/real-agents.mjs [--only claude|codex]
//
// Flags used (checked against the CLIs' own references, Sep 2026):
//   claude -p <prompt> --permission-mode acceptEdits --model <m> --max-turns 6 --max-budget-usd 0.50 --output-format json
//   codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -m <m> <prompt>
//     (the runner is the sandbox; Codex's own Windows sandbox would make the run nondeterministic)
// Models are overridable with E2E_CLAUDE_MODEL / E2E_CODEX_MODEL.
//
// Captured transcripts, exported OTEL spans and the database land in
// test-results/e2e/capture-real-agents/ — turn them into committed fixtures with
// tests/e2e/captures-to-fixtures.mjs.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  REPO_ROOT, IS_WIN, notice, log, assert, assertEqual, waitFor, freePorts, getJson, postJson, request, mcpCall,
  makeTempHome, makeGitRepo, git, startProcess, stepRunner, sleep, rmrf,
} from './lib.mjs'

const argv = process.argv.slice(2)
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined

function globalBin(name) {
  const r = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8', shell: IS_WIN })
  if (r.status !== 0) return undefined
  const prefix = r.stdout.trim()
  const bin = IS_WIN ? path.join(prefix, `${name}.cmd`) : path.join(prefix, 'bin', name)
  return fs.existsSync(bin) ? bin : undefined
}

function version(bin) {
  const r = spawnSync(IS_WIN ? `"${bin}"` : bin, ['--version'], { encoding: 'utf8', shell: IS_WIN })
  return (r.stdout || r.stderr || '').trim()
}

const agents = {}
if (!only || only === 'claude') {
  const bin = globalBin('claude')
  if (!process.env.ANTHROPIC_API_KEY) notice('Claude Code: ANTHROPIC_API_KEY secret is not set — skipping the Claude Code run')
  else if (!bin) notice('Claude Code: `claude` not found in the global npm prefix — install @anthropic-ai/claude-code')
  else {
    log(`claude ${version(bin)} at ${bin}`)
    agents.claude = {
      bin,
      args: ['-p', '--permission-mode', 'acceptEdits', '--model', process.env.E2E_CLAUDE_MODEL || 'haiku',
        '--max-turns', '6', '--max-budget-usd', '0.50', '--output-format', 'json'],
      env: {},
    }
  }
}
if (!only || only === 'codex') {
  const bin = globalBin('codex')
  if (!process.env.OPENAI_API_KEY) notice('Codex: OPENAI_API_KEY secret is not set — skipping the Codex run')
  else if (!bin) notice('Codex: `codex` not found in the global npm prefix — install @openai/codex')
  else {
    log(`codex ${version(bin)} at ${bin}`)
    agents.codex = {
      bin,
      args: ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-m', process.env.E2E_CODEX_MODEL || 'gpt-5-mini'],
      // No keys in this file (it's copied into the uploaded logs): VS Code, and so the extension
      // host that spawns the agents, inherits this process's environment, which has them.
      env: {},
      login: true,
    }
  }
}

if (Object.keys(agents).length === 0) {
  notice('Real-agent E2E: no agent has both its CLI and its API key available — nothing to run.')
  process.exit(0)
}

const outDir = path.join(REPO_ROOT, 'test-results', 'e2e')
fs.mkdirSync(outDir, { recursive: true })
const agentsConfig = path.join(outDir, 'agents-config.json')
fs.writeFileSync(agentsConfig, JSON.stringify(agents, null, 2))
const cleanup = () => { try { fs.rmSync(agentsConfig, { force: true }) } catch { /* gone */ } }

// ── 1. The VS Code extension (src/test/integration/realAgents.itest.ts) ──────
const runner = path.join(REPO_ROOT, 'tests', 'e2e', 'vscode', 'run.mjs')
const args = [runner, '--suites', 'realAgents', '--agents-config', agentsConfig, '--label', 'real-agents']
const cmd = process.platform === 'linux' && !process.env.DISPLAY ? 'xvfb-run' : process.execPath
const r = spawnSync(cmd, cmd === 'xvfb-run' ? ['-a', process.execPath, ...args] : args, { stdio: 'inherit', cwd: REPO_ROOT })
cleanup()

// ── 2. The standalone server (`traceroost`, this checkout's build) ───────────
// Same agents, same prompt, against the standalone server's own auto-config: both ingestion paths,
// one deduped session per agent run (claudeConversation.ts), workspace/tokens/cost/model/outcome.

const PROMPT = 'Create a file named hello.txt in the current directory containing exactly the text: hello from traceroost e2e. Do not create or modify any other file, and do not run any commands.'
const samePath = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b)

function runAgentCli(agent, repo, env) {
  const a = agents[agent]
  const argv = [...a.args, PROMPT]
  const quoted = IS_WIN ? argv.map(x => `"${x.replace(/"/g, '\\"')}"`) : argv
  log(`$ ${agent} ${a.args.join(' ')} <prompt>  (cwd ${repo})`)
  const res = spawnSync(IS_WIN ? `"${a.bin}"` : a.bin, quoted, { cwd: repo, env, shell: IS_WIN, encoding: 'utf8', timeout: 5 * 60_000, input: '' })
  process.stdout.write(`${res.stdout ?? ''}${res.stderr ?? ''}`)
  return res.status
}

async function standaloneStage() {
  const { step, summary } = stepRunner()
  const t = makeTempHome('agents-standalone')
  const [ui, otlp, mcp] = await freePorts(3)
  const env = { ...t.env, UI_PORT: String(ui), OTLP_PORT: String(otlp), MCP_PORT: String(mcp) }
  const srv = startProcess('traceroost', process.execPath, [path.join(REPO_ROOT, 'standalone', 'cli.js')], { env })
  const base = `http://127.0.0.1:${ui}`
  const captureDir = path.join(outDir, 'capture-real-agents-standalone')
  try {
    await waitFor('the standalone server', async () => (await request('GET', `${base}/health`)).status === 200, { timeoutMs: 60_000 })
    await waitFor('auto-config of both agents', () =>
      fs.readFileSync(path.join(t.home, '.claude', 'settings.json'), 'utf8').includes(`localhost:${otlp}`)
      && fs.readFileSync(path.join(t.home, '.codex', 'config.toml'), 'utf8').includes(`localhost:${otlp}`), { timeoutMs: 30_000 })
    if (agents.codex) {
      const login = spawnSync(IS_WIN ? `"${agents.codex.bin}"` : agents.codex.bin, ['login', '--with-api-key'], { env, shell: IS_WIN, input: process.env.OPENAI_API_KEY + '\n', encoding: 'utf8' })
      if (login.status !== 0) throw new Error(`codex login exited ${login.status}: ${login.stderr}`)
    }
    for (const agent of Object.keys(agents)) {
      const source = agent === 'claude' ? 'claude_code' : 'codex'
      await step(`standalone: ${agent} → one session with workspace/tokens/cost/model/outcome`, async () => {
        const repo = makeGitRepo(t.home, `${agent}-standalone-sandbox`)
        const status = runAgentCli(agent, repo, { ...env, ...(agent === 'codex' ? { CODEX_API_KEY: process.env.OPENAI_API_KEY } : {}) })
        assertEqual(status, 0, `${agent} exited 0`)
        assert(fs.existsSync(path.join(repo, 'hello.txt')), `${agent} created hello.txt`)
        const forRepo = async () => ((await getJson(`${base}/api/summary`))?.sessions ?? []).filter(s => s.source === source && samePath(s.workspace, repo))
        // OTEL arrives within seconds; the transcript is picked up by the next log scan.
        await waitFor(`${agent}: OTEL and transcript both ingested`, async () => {
          const spansSeen = (await getJson(`${base}/api/summary`))?.sessions?.some(s => s.source === source && s.dataSource === 'otel' && samePath(s.workspace, repo))
          const transcript = fs.readdirSync(t.home, { recursive: true }).some(f => String(f).endsWith('.jsonl') && String(f).includes(agent === 'claude' ? '.claude' : '.codex'))
          return spansSeen && transcript
        }, { timeoutMs: 120_000, intervalMs: 3000 })
        await sleep(40_000) // at least one more log scan, so a duplicate transcript card would be listed by now
        const cards = await forRepo()
        assertEqual(cards.length, 1, `${agent}: one session for the repo (got ${JSON.stringify(cards.map(c => ({ id: c.sessionId, ds: c.dataSource })))})`)
        const card = cards[0]
        assert(card.inputTokens > 0 && card.outputTokens > 0, `${agent}: tokens (${card.inputTokens}/${card.outputTokens})`)
        assert(card.model, `${agent}: model set`)
        const cost = (await mcpCall(`http://127.0.0.1:${mcp}/mcp`, 'get_recent_sessions', { limit: 50, agent: source })).find(x => x.sessionId === card.sessionId)?.cost_usd
        assert(cost > 0, `${agent}: cost > 0 (got ${cost})`)
        git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', `${agent} change`)
        const endTime = new Date(Date.now() - 5 * 60_000).toISOString() // past the active-session grace window
        const out = await postJson(`${base}/api/git-outcome`, { sessionId: card.sessionId, workspace: card.workspace, filesChanged: card.filesChanged, endTime })
        assert(out?.outcome && ['committed', 'merged'].includes(out.outcome.overall), `${agent}: outcome committed/merged (got ${JSON.stringify(out?.outcome)})`)
      })
    }
  } finally {
    await srv.stop()
    fs.mkdirSync(captureDir, { recursive: true })
    for (const [from, to] of [[path.join(t.home, '.claude', 'projects'), 'claude-projects'], [path.join(t.home, '.codex', 'sessions'), 'codex-sessions'], [path.join(t.home, '.traceroost', 'spans.json'), 'otel-spans.json']]) {
      try { fs.cpSync(from, path.join(captureDir, to), { recursive: true }) } catch { /* not there */ }
    }
    rmrf(t.home)
  }
  return summary()
}

const standaloneFailures = await standaloneStage()
process.exit((r.status ?? 1) !== 0 || standaloneFailures > 0 ? 1 : 0)
