#!/usr/bin/env node
// Runs every scripts/configure-*.ps1 for real — under PowerShell 7 (`pwsh`) everywhere, and also
// under Windows PowerShell 5.1 (`powershell.exe`) on Windows, since that is the shell a Windows
// user gets by default when they follow README → "Configure agents" — with a throwaway
// USERPROFILE, and asserts the exact files/settings each writes:
//
//   - with no args, with -Port, with -Token and -HostName (the Docker/LAN form)
//   - a fresh profile and one with unrelated pre-existing settings (which must survive)
//   - a second run changes nothing (idempotent)
//   - an invalid token is refused without touching anything
//   - what the scripts write is readable by TraceRoost's own auto-config (src/autoConfigNode.ts,
//     compiled by `pnpm run compile-tests`), which must then find nothing left to change
//
// configure-copilot.ps1 sets *user environment variables* (HKCU\Environment), which only exist on
// Windows — .NET silently ignores the User target elsewhere — so it runs on Windows only, and the
// runner's previous values are restored afterwards.
//
//   node tests/e2e/configure-scripts.mjs [--shell pwsh|powershell]...

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  REPO_ROOT, IS_WIN, assert, assertEqual, makeTempHome, stepRunner, SkipError, notice, log,
} from './lib.mjs'

const require = createRequire(import.meta.url)
const SCRIPTS = path.join(REPO_ROOT, 'scripts')

function availableShells() {
  const requested = process.argv.flatMap((a, i, all) => (a === '--shell' ? [all[i + 1]] : []))
  const candidates = requested.length > 0 ? requested : (IS_WIN ? ['pwsh', 'powershell'] : ['pwsh'])
  return candidates.filter(sh => {
    const r = spawnSync(sh, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' })
    if (r.status === 0) { log(`${sh}: PowerShell ${r.stdout.trim()}`); return true }
    notice(`${sh} not found — skipping its configure-script runs`)
    return false
  })
}

/** Runs one script under `shell` with the temp home; returns { status, out }. */
function ps(shell, home, script, args = [], extraEnv = {}) {
  const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    env: { ...home.env, TRACEROOST_PORT: '', TRACEROOST_TOKEN: '', TRACEROOST_HOST: '', ...extraEnv },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { status: r.status, out }
}

function mustRun(shell, home, script, args, extraEnv) {
  const r = ps(shell, home, script, args, extraEnv)
  if (r.status !== 0) throw new Error(`${shell} ${script} ${args.join(' ')} exited ${r.status}:\n${r.out}`)
  return r.out
}

const readRaw = (p) => fs.readFileSync(p, 'utf8')

/** A settings file must be plain UTF-8: Node's JSON.parse (Claude Code, and TraceRoost's own
 *  auto-config) rejects a leading byte-order mark. */
function assertNoBom(file) {
  const buf = fs.readFileSync(file)
  assert(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${path.basename(file)} must not start with a UTF-8 byte-order mark`)
}

const CLAUDE_ENV = (endpoint) => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  OTEL_LOG_TOOL_DETAILS: '1',
  OTEL_LOG_TOOL_CONTENT: '1',
  OTEL_LOG_USER_PROMPTS: '1',
})

const codexBlock = (endpoint, token) => {
  const headers = token ? `, headers = { "Authorization" = "Bearer ${token}" }` : ''
  return [
    '[otel]',
    'log_user_prompt = true',
    `exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "json"${headers} } }`,
    `trace_exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "json"${headers} } }`,
  ]
}

/** TraceRoost's own auto-config, compiled from src/autoConfigNode.ts by `pnpm run compile-tests`. */
function loadAutoConfig() {
  const compiled = path.join(REPO_ROOT, 'out', 'test', 'autoConfigNode.js')
  if (!fs.existsSync(compiled)) return null
  return require(compiled)
}

/** Runs TraceRoost's auto-config for `port` with `home` as the home directory, in a child process
 *  (os.homedir() is read per call, but keeping this process's env untouched is simpler). */
function autoConfigSays(home, fn, port) {
  const compiled = path.join(REPO_ROOT, 'out', 'test', 'autoConfigNode.js')
  const code = `require(${JSON.stringify(compiled)}).${fn}(${port}).then(r => { process.stdout.write(JSON.stringify(r)) })`
  const out = execFileSync(process.execPath, ['-e', code], { env: home.env, encoding: 'utf8' })
  return JSON.parse(out)
}

async function main() {
  const shells = availableShells()
  if (shells.length === 0) {
    notice('no PowerShell available — nothing to run')
    process.exit(process.env.CI ? 1 : 0)
  }
  const autoConfig = loadAutoConfig()
  if (!autoConfig) notice('out/test/autoConfigNode.js missing (run `pnpm run compile-tests`) — skipping the auto-config cross-checks')

  const { step, summary } = stepRunner()

  await step('scripts/*.ps1 are ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI)', () => {
    // A UTF-8 em dash is E2 80 94; read as Windows-1252 the 0x94 is a curly quote, which PowerShell
    // treats as a string delimiter, so a dash inside a string broke parsing of the whole script.
    for (const f of fs.readdirSync(SCRIPTS).filter(f => f.endsWith('.ps1'))) {
      const buf = fs.readFileSync(path.join(SCRIPTS, f))
      const bad = buf.findIndex(b => b > 0x7f)
      assert(bad < 0, `${f} has a non-ASCII byte at offset ${bad} (line ${buf.subarray(0, bad).toString('latin1').split('\n').length})`)
    }
  })

  for (const shell of shells) {
    // ── configure-claude.ps1 ───────────────────────────────────────────────
    await step(`${shell}: configure-claude.ps1 on a fresh profile (default port)`, () => {
      const home = makeTempHome('ps-claude')
      try {
        mustRun(shell, home, 'configure-claude.ps1')
        const file = path.join(home.home, '.claude', 'settings.json')
        assertNoBom(file)
        const settings = JSON.parse(readRaw(file))
        assertEqual(JSON.stringify(settings.env), JSON.stringify(CLAUDE_ENV('http://localhost:4318')), 'env block')
        assertEqual(Object.keys(settings).join(','), 'env', 'no keys besides env on a fresh profile')
        if (autoConfig) {
          const r = autoConfigSays(home, 'autoConfigureClaudeCode', 4318)
          assert(!r.error, `TraceRoost's auto-config can't read what the script wrote: ${r.error}`)
          assertEqual(r.changed, false, "TraceRoost's auto-config agrees nothing is left to change")
        }
      } finally { home.cleanup() }
    })

    await step(`${shell}: configure-claude.ps1 keeps unrelated settings, is idempotent, honors -Port/-Token/-HostName`, () => {
      const home = makeTempHome('ps-claude2')
      try {
        const file = path.join(home.home, '.claude', 'settings.json')
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const before = {
          model: 'opus',
          permissions: { allow: ['Bash(ls:*)'], deny: ['Read(./.env)', 'Bash(rm:*)'] },
          env: { MY_VAR: 'keep me', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:1' },
          statusLine: { type: 'command', command: 'echo "hi"' },
          includeCoAuthoredBy: false,
          cleanupPeriodDays: 30,
        }
        fs.writeFileSync(file, JSON.stringify(before, null, 2) + '\n')
        const args = ['-Port', '4555', '-Token', 'tok_abc.123', '-HostName', '192.168.1.20']
        mustRun(shell, home, 'configure-claude.ps1', args)
        assertNoBom(file)
        const first = readRaw(file)
        const after = JSON.parse(first)
        assertEqual(after.model, 'opus', 'model kept')
        assertEqual(JSON.stringify(after.permissions), JSON.stringify(before.permissions), 'permissions kept (including one-element arrays)')
        assertEqual(JSON.stringify(after.statusLine), JSON.stringify(before.statusLine), 'statusLine kept')
        assertEqual(after.includeCoAuthoredBy, false, 'boolean kept')
        assertEqual(after.cleanupPeriodDays, 30, 'number kept')
        assertEqual(after.env.MY_VAR, 'keep me', 'unrelated env var kept')
        const expected = { ...CLAUDE_ENV('http://192.168.1.20:4555'), OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer tok_abc.123' }
        for (const [k, v] of Object.entries(expected)) assertEqual(after.env[k], v, `env.${k}`)
        mustRun(shell, home, 'configure-claude.ps1', args)
        assertEqual(readRaw(file), first, 'second run leaves settings.json byte-for-byte unchanged')
        // Same values via the environment-variable defaults the scripts document.
        mustRun(shell, home, 'configure-claude.ps1', [], { TRACEROOST_PORT: '4555', TRACEROOST_TOKEN: 'tok_abc.123', TRACEROOST_HOST: '192.168.1.20' })
        assertEqual(readRaw(file), first, 'TRACEROOST_PORT/TOKEN/HOST env defaults give the same result as the flags')
      } finally { home.cleanup() }
    })

    await step(`${shell}: configure-claude.ps1 refuses a bad token and a malformed file without writing`, () => {
      const home = makeTempHome('ps-claude3')
      try {
        const bad = ps(shell, home, 'configure-claude.ps1', ['-Token', 'has space;rm'])
        assertEqual(bad.status, 1, 'invalid token exits 1')
        assert(!fs.existsSync(path.join(home.home, '.claude', 'settings.json')), 'nothing written for an invalid token')
        const file = path.join(home.home, '.claude', 'settings.json')
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, '{ "model": "opus", ')
        const r = ps(shell, home, 'configure-claude.ps1')
        assertEqual(r.status, 1, 'malformed settings.json exits 1')
        assertEqual(readRaw(file), '{ "model": "opus", ', 'malformed settings.json left untouched')
      } finally { home.cleanup() }
    })

    // ── configure-codex.ps1 ────────────────────────────────────────────────
    await step(`${shell}: configure-codex.ps1 on a fresh profile, then idempotent`, () => {
      const home = makeTempHome('ps-codex')
      try {
        mustRun(shell, home, 'configure-codex.ps1', ['-Port', '4777'])
        const file = path.join(home.home, '.codex', 'config.toml')
        assertNoBom(file)
        const first = readRaw(file)
        const lines = first.split(/\r?\n/).filter(l => l.trim() !== '')
        assertEqual(lines.join('\n'), codexBlock('http://localhost:4777').join('\n'), 'config.toml contents')
        const again = ps(shell, home, 'configure-codex.ps1', ['-Port', '4777'])
        assertEqual(again.status, 0, 're-run exits 0')
        assert(/already exists/i.test(again.out), 're-run reports the existing [otel] section')
        assertEqual(readRaw(file), first, 're-run leaves config.toml unchanged')
        if (autoConfig) {
          const r = autoConfigSays(home, 'autoConfigureCodex', 4777)
          assert(!r.error, `TraceRoost's auto-config can't read what the script wrote: ${r.error}`)
          assertEqual(r.changed, false, "TraceRoost's auto-config agrees nothing is left to change")
        }
      } finally { home.cleanup() }
    })

    await step(`${shell}: configure-codex.ps1 appends to an existing config, keeping comments and tables; -Token adds headers`, () => {
      const home = makeTempHome('ps-codex2')
      try {
        const file = path.join(home.home, '.codex', 'config.toml')
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const existing = [
          '# my codex config — keep this comment',
          'model = "gpt-5-codex"',
          'approval_policy = "on-request"  # trailing comment',
          '',
          '[mcp_servers.docs]',
          'command = "npx"',
          'args = ["-y", "docs-mcp"]',
          '',
        ].join('\n')
        fs.writeFileSync(file, existing)
        mustRun(shell, home, 'configure-codex.ps1', ['-Port', '4888', '-Token', 'tok-1', '-HostName', 'host.docker.internal'])
        const after = readRaw(file)
        assert(after.startsWith(existing), 'existing content (comments, tables) is kept verbatim at the top')
        const added = after.slice(existing.length).split(/\r?\n/).filter(l => l.trim() !== '')
        assertEqual(added.join('\n'), codexBlock('http://host.docker.internal:4888', 'tok-1').join('\n'), 'appended [otel] block')
        mustRun(shell, home, 'configure-codex.ps1', ['-Port', '4888', '-Token', 'tok-1', '-HostName', 'host.docker.internal'])
        assertEqual(readRaw(file), after, 'second run leaves config.toml unchanged')
      } finally { home.cleanup() }
    })

    // ── configure-agents.ps1 ───────────────────────────────────────────────
    for (const agent of ['claude', 'codex']) {
      await step(`${shell}: configure-agents.ps1 -Agent ${agent} writes the same as configure-${agent}.ps1`, () => {
        const a = makeTempHome('ps-agents-a'); const b = makeTempHome('ps-agents-b')
        try {
          const rel = agent === 'claude' ? path.join('.claude', 'settings.json') : path.join('.codex', 'config.toml')
          const args = ['-Port', '4999', '-Token', 'abc', '-HostName', '10.0.0.5']
          mustRun(shell, a, 'configure-agents.ps1', ['-Agent', agent, ...args])
          mustRun(shell, b, `configure-${agent}.ps1`, args)
          if (agent === 'claude') assertNoBom(path.join(a.home, rel))
          assertEqual(readRaw(path.join(a.home, rel)), readRaw(path.join(b.home, rel)), `${rel} identical`)
          const before = readRaw(path.join(a.home, rel))
          mustRun(shell, a, 'configure-agents.ps1', ['-Agent', agent, ...args])
          assertEqual(readRaw(path.join(a.home, rel)), before, 'idempotent')
        } finally { a.cleanup(); b.cleanup() }
      })
    }

    await step(`${shell}: configure-agents.ps1 rejects an unknown -Agent and a bad token`, () => {
      const home = makeTempHome('ps-agents3')
      try {
        assert(ps(shell, home, 'configure-agents.ps1', ['-Agent', 'cursor']).status !== 0, 'unknown agent fails')
        assertEqual(ps(shell, home, 'configure-agents.ps1', ['-Token', 'a b']).status, 1, 'bad token exits 1')
        assert(!fs.existsSync(path.join(home.home, '.claude')) && !fs.existsSync(path.join(home.home, '.codex')), 'nothing written')
      } finally { home.cleanup() }
    })

    // ── configure-copilot.ps1 / -Agent all (user environment variables: Windows only) ─────
    const COPILOT_VARS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'OTEL_EXPORTER_OTLP_HEADERS']
    const userEnv = (name) => {
      const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `[Console]::Out.Write([Environment]::GetEnvironmentVariable('${name}', 'User'))`], { encoding: 'utf8' })
      return r.stdout
    }
    const setUserEnv = (name, value) => {
      const v = value ? `'${value.replace(/'/g, "''")}'` : '$null'
      spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `[Environment]::SetEnvironmentVariable('${name}', ${v}, 'User')`])
    }
    for (const [label, script, args] of [
      ['configure-copilot.ps1', 'configure-copilot.ps1', ['-Port', '4666', '-Token', 'tok9', '-HostName', 'lan-box']],
      ['configure-agents.ps1 -Agent all', 'configure-agents.ps1', ['-Agent', 'all', '-Port', '4666', '-Token', 'tok9', '-HostName', 'lan-box']],
    ]) {
      await step(`${shell}: ${label} sets the Copilot CLI user environment variables`, () => {
        if (!IS_WIN) throw new SkipError('user-scoped environment variables exist only on Windows (.NET ignores the User target elsewhere)')
        const saved = Object.fromEntries(COPILOT_VARS.map(n => [n, userEnv(n)]))
        const home = makeTempHome('ps-copilot')
        try {
          for (const n of COPILOT_VARS) setUserEnv(n, '')
          mustRun(shell, home, script, args)
          assertEqual(userEnv('OTEL_EXPORTER_OTLP_ENDPOINT'), 'http://lan-box:4666', 'endpoint')
          assertEqual(userEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'), 'true', 'capture content')
          assertEqual(userEnv('OTEL_EXPORTER_OTLP_HEADERS'), 'Authorization=Bearer tok9', 'auth header')
          // Re-run with a different port updates the endpoint in place.
          mustRun(shell, home, script, args.map(a => (a === '4666' ? '4667' : a)))
          assertEqual(userEnv('OTEL_EXPORTER_OTLP_ENDPOINT'), 'http://lan-box:4667', 'endpoint updated on re-run')
          if (script === 'configure-agents.ps1') {
            assert(fs.existsSync(path.join(home.home, '.claude', 'settings.json')), '-Agent all also configured Claude')
            assert(fs.existsSync(path.join(home.home, '.codex', 'config.toml')), '-Agent all also configured Codex')
          }
        } finally {
          for (const n of COPILOT_VARS) setUserEnv(n, saved[n])
          home.cleanup()
        }
      })
    }
  }

  const failed = summary()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
