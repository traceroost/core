#!/usr/bin/env node
// Captures what each real agent writes to disk, for the adapter contract fixtures
// (src/test/fixtures/agents) and the fingerprint diff (fingerprint-diff.mjs). Unlike
// real-agents.mjs there is no TraceRoost in the loop: each agent runs headless, once, with a tiny
// fixed prompt in a sandbox git repo under a throwaway home, and its log files are copied out.
//
//   node tests/e2e/capture-agents.mjs [--only <agent>] [--out test-results/agent-capture]
//
// Each agent is gated on its own secret; a missing key or CLI skips only that agent, with a notice:
//   claude    ANTHROPIC_API_KEY      claude -p … --permission-mode acceptEdits --model haiku
//   codex     OPENAI_API_KEY         codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -m gpt-5-mini
//   opencode  ANTHROPIC_API_KEY      opencode run --model anthropic/claude-haiku-4-5
//   cursor    CURSOR_API_KEY         cursor-agent -p --force --output-format json
//   copilot   COPILOT_GITHUB_TOKEN   copilot -p … --allow-all-tools   (a token with the Copilot Requests permission)
// The CLIs come from the workflow (`npm install -g <pkg>@<version>`, Cursor's install script).
// Copilot Chat in VS Code has no headless mode and is captured by hand (runbooks/AGENT_FORMAT_BREAK.md).
//
// Output (the layout captures-to-fixtures.mjs reads):
//   <out>/claude-projects/  codex-sessions/  opencode/opencode.db  cursor-projects/  copilot-session-state/
//   <out>/versions.json     { "<agent>": "<--version output>" }
// Exit 1 when an agent that had its key and CLI failed to run or wrote nothing.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { IS_WIN, REPO_ROOT, log, notice, makeTempHome, makeGitRepo, rmrf } from './lib.mjs'

const argv = process.argv.slice(2)
const flag = n => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined)
const only = flag('only')
const outDir = path.resolve(flag('out') ?? path.join(REPO_ROOT, 'test-results', 'agent-capture'))

const PROMPT = 'Create a file named hello.txt in the current directory containing exactly the text: hello from traceroost capture. Then read it back. Do not create or modify any other file.'

/** The last lines an agent printed (stderr, else stdout), for a failed run's log. */
function failureTail(res, home) {
  const text = (res.stderr || '').trim() || (res.stdout || '').trim()
  return text.split('\n').slice(-12).map(l => l
    .split(home).join('<HOME>')
    .replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '<REDACTED>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/g, '$1<REDACTED>')
    .slice(0, 300))
}

function npmBin(name) {
  const r = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8', shell: IS_WIN })
  if (r.status !== 0) return undefined
  const bin = IS_WIN ? path.join(r.stdout.trim(), `${name}.cmd`) : path.join(r.stdout.trim(), 'bin', name)
  return fs.existsSync(bin) ? bin : undefined
}
function pathBin(name) {
  for (const dir of [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')]) {
    const p = path.join(dir, IS_WIN ? `${name}.exe` : name)
    if (dir && fs.existsSync(p)) return p
  }
  return undefined
}

// key → how to run it and where it writes, relative to the home dir.
const AGENTS = {
  claude:   { secret: 'ANTHROPIC_API_KEY',    bin: () => npmBin('claude'),   args: ['-p', '--permission-mode', 'acceptEdits', '--model', process.env.E2E_CLAUDE_MODEL || 'haiku', '--max-turns', '6', '--max-budget-usd', '0.50', '--output-format', 'json', PROMPT], data: [['.claude/projects', 'claude-projects']] },
  codex:    { secret: 'OPENAI_API_KEY',       bin: () => npmBin('codex'),    args: ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-m', process.env.E2E_CODEX_MODEL || 'gpt-5-mini', PROMPT], data: [['.codex/sessions', 'codex-sessions']],
              env: e => ({ CODEX_API_KEY: e.OPENAI_API_KEY }) },
  opencode: { secret: 'ANTHROPIC_API_KEY',    bin: () => npmBin('opencode'), args: ['run', '--model', process.env.E2E_OPENCODE_MODEL || 'anthropic/claude-haiku-4-5', PROMPT], data: [['.local/share/opencode/opencode.db', 'opencode/opencode.db']] },
  cursor:   { secret: 'CURSOR_API_KEY',       bin: () => pathBin('cursor-agent'), args: ['-p', '--force', '--output-format', 'json', PROMPT], data: [['.cursor/projects', 'cursor-projects']] },
  copilot:  { secret: 'COPILOT_GITHUB_TOKEN', bin: () => npmBin('copilot'),  args: ['-p', PROMPT, '--allow-all-tools'], data: [['.copilot/session-state', 'copilot-session-state']] },
}

const versions = {}
let failures = 0
let ran = 0
fs.mkdirSync(outDir, { recursive: true })

for (const [key, a] of Object.entries(AGENTS)) {
  if (only && only !== key) continue
  if (!process.env[a.secret]) { notice(`${key}: ${a.secret} is not set — skipped`); continue }
  const bin = a.bin()
  if (!bin) { notice(`${key}: CLI not installed — skipped`); continue }
  const v = spawnSync(IS_WIN ? `"${bin}"` : bin, ['--version'], { encoding: 'utf8', shell: IS_WIN })
  versions[key] = (v.stdout || v.stderr || '').trim().split('\n')[0]
  log(`${key} ${versions[key]} at ${bin}`)

  const t = makeTempHome(`capture-${key}`)
  try {
    const repo = makeGitRepo(t.home, `${key}-sandbox`)
    const env = { ...t.env, XDG_DATA_HOME: path.join(t.home, '.local', 'share'), XDG_CONFIG_HOME: path.join(t.home, '.config'), ...(a.env?.(process.env) ?? {}) }
    if (key === 'codex') {
      const login = spawnSync(IS_WIN ? `"${bin}"` : bin, ['login', '--with-api-key'], { env, shell: IS_WIN, input: process.env.OPENAI_API_KEY + '\n', encoding: 'utf8' })
      if (login.status !== 0) throw new Error(`codex login exited ${login.status}: ${login.stderr}`)
    }
    const quoted = IS_WIN ? a.args.map(x => `"${x.replace(/"/g, '\\"')}"`) : a.args
    log(`$ ${key} ${a.args.slice(0, -1).join(' ')} <prompt>`)
    const res = spawnSync(IS_WIN ? `"${bin}"` : bin, quoted, { cwd: repo, env, shell: IS_WIN, encoding: 'utf8', timeout: 5 * 60_000, input: '' })
    // Not echoed on success: the output can quote the prompt and file contents, which is fine, but
    // also the agent's own diagnostics, which can carry the runner's paths. On failure its last
    // lines are the only way to tell a rejected key or an unavailable model from a format change,
    // so they're shown with the throwaway home and anything token-shaped replaced.
    log(`${key} exited ${res.status}${res.error ? ` (${res.error.message})` : ''}`)
    if (res.status !== 0) for (const line of failureTail(res, t.home)) log(`  ${key}| ${line}`)
    ran++
    let copied = 0
    for (const [from, to] of a.data) {
      const src = path.join(t.home, from)
      if (!fs.existsSync(src)) continue
      fs.cpSync(src, path.join(outDir, to), { recursive: true })
      copied++
    }
    if (res.status !== 0 || copied === 0) {
      failures++
      console.error(`::error::${key}: ${res.status !== 0 ? `exited ${res.status}` : 'ran but wrote no log files where TraceRoost reads them'}`)
    }
  } catch (err) {
    failures++
    console.error(`::error::${key}: ${err.message}`)
  } finally {
    rmrf(t.home)
  }
}

fs.writeFileSync(path.join(outDir, 'versions.json'), JSON.stringify(versions, null, 2) + '\n')
if (ran === 0) notice('Agent capture: no agent had both its CLI and its secret — nothing captured.')
log(`captured ${ran - failures} of ${ran} agent(s) into ${outDir}`)
process.exit(failures > 0 ? 1 : 0)
