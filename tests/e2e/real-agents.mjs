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
import { REPO_ROOT, IS_WIN, notice, log } from './lib.mjs'

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

const runner = path.join(REPO_ROOT, 'tests', 'e2e', 'vscode', 'run.mjs')
const args = [runner, '--suites', 'realAgents', '--agents-config', agentsConfig, '--label', 'real-agents']
const cmd = process.platform === 'linux' && !process.env.DISPLAY ? 'xvfb-run' : process.execPath
const r = spawnSync(cmd, cmd === 'xvfb-run' ? ['-a', process.execPath, ...args] : args, { stdio: 'inherit', cwd: REPO_ROOT })
cleanup()
process.exit(r.status ?? 1)
