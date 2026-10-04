#!/usr/bin/env node
// Launches a real, isolated VS Code and runs the extension-host integration suites
// (src/test/integration/*.itest.ts, compiled by `pnpm run compile-tests`) against the TraceRoost
// extension — either the dev build in this checkout, or a packaged VSIX installed into a fresh
// --extensions-dir with the VS Code CLI (`code --install-extension`).
//
//   node tests/e2e/vscode/run.mjs                              # dev build (run `node esbuild.js` first)
//   node tests/e2e/vscode/run.mjs --vsix traceroost-core.vsix  # installed VSIX
//     [--edition core|full]    which edition the build/VSIX is (default: full for dev, core for a VSIX)
//     [--suites extension,realAgents]
//     [--vscode-version 1.118.0]   (or VSCODE_TEST_VERSION; default below — the engines.vscode floor)
//     [--agents-config file.json]  realAgents suite: which agent CLIs to drive (see real-agents.mjs)
//
// Isolation: temp HOME/USERPROFILE/APPDATA/LOCALAPPDATA (a fixture Claude Code transcript is
// dropped under its ~/.claude/projects first), temp --user-data-dir (settings.json pins free OTLP
// and MCP ports) and --extensions-dir, and a fixture git repo. Linux needs a display: run under
// `xvfb-run -a`. VS Code's logs are copied to test-results/e2e/vscode-<label>/ for upload.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  REPO_ROOT, IS_WIN, log, freePorts, makeTempHome, makeGitRepo, claudeFixture, writeClaudeTranscript,
  commitFixtureChange, FIXTURE_MODEL,
} from '../lib.mjs'

const require = createRequire(import.meta.url)
const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron')

// The oldest VS Code package.json's engines.vscode allows — pinned so a new VS Code release can't
// change what this suite runs against without a commit. Bump together with engines.vscode.
const DEFAULT_VSCODE_VERSION = '1.118.0'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback }
const vsix = opt('vsix') ? path.resolve(opt('vsix')) : undefined
const edition = opt('edition', vsix ? 'core' : 'full')
const suites = opt('suites', 'extension')
const vscodeVersion = opt('vscode-version', process.env.VSCODE_TEST_VERSION || DEFAULT_VSCODE_VERSION)
const agentsConfig = opt('agents-config')
const label = opt('label', `${vsix ? 'vsix' : 'dev'}-${edition}-${suites.replace(/,/g, '+')}`)

function vsixExtensionId(file) {
  // A VSIX is a zip whose extension/package.json names it; read the id from the manifest we packed
  // rather than assuming (release VSIXes carry the vsce-identity.json marketplace id).
  const manifestPath = path.join(path.dirname(file), `${path.basename(file, '.vsix')}.manifest.json`)
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return `${m.publisher}.${m.name}`
  }
  throw new Error(`no ${manifestPath} next to the VSIX (tests/e2e/package-vsix.mjs writes one)`)
}

async function main() {
  const compiledEntry = path.join(REPO_ROOT, 'out', 'test', 'test', 'integration', 'index.js')
  if (!fs.existsSync(compiledEntry)) throw new Error(`${compiledEntry} missing — run \`pnpm run compile-tests\``)
  if (!vsix && !fs.existsSync(path.join(REPO_ROOT, 'dist', 'extension.js'))) throw new Error('dist/extension.js missing — run `node esbuild.js`')

  log(`VS Code ${vscodeVersion} on ${process.platform}-${process.arch}; ${vsix ? `VSIX ${vsix}` : 'dev build'} (${edition}); suites: ${suites}`)
  const cachePath = path.join(REPO_ROOT, '.vscode-test')
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: vscodeVersion, cachePath })

  const t = makeTempHome(`vscode-${label}`)
  const userDataDir = path.join(t.home, 'vscode-user-data')
  const extensionsDir = path.join(t.home, 'vscode-extensions')
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true })
  fs.mkdirSync(extensionsDir, { recursive: true })

  const repo = makeGitRepo(t.home)
  const fixture = claudeFixture({ repo })
  commitFixtureChange(repo, fixture)
  writeClaudeTranscript(t.home, fixture, repo)

  const [otlpPort, mcpPort] = await freePorts(2)
  fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
    'traceRoost.otlpPort': otlpPort,
    'traceRoost.mcpPort': mcpPort,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'workbench.startupEditor': 'none',
    'workbench.enableExperiments': false,
    'security.workspace.trust.enabled': false,
    'git.enabled': false,
  }, null, 2))

  let extensionId = 'traceroost.traceroost'
  let extensionDevelopmentPath = REPO_ROOT
  if (vsix) {
    extensionId = vsixExtensionId(vsix)
    // The dev-path slot gets an empty harness extension, so the only TraceRoost in this VS Code is
    // the one installed from the VSIX.
    extensionDevelopmentPath = path.join(REPO_ROOT, 'tests', 'e2e', 'vscode', 'harness')
    const cli = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath)
    // code.cmd on Windows is a batch file: Node only spawns those through a shell (quote everything).
    const code = (...args) => execFileSync(IS_WIN ? `"${cli}"` : cli, IS_WIN ? args.map(a => `"${a}"`) : args, { encoding: 'utf8', shell: IS_WIN, env: t.env })
    const where = ['--extensions-dir', extensionsDir, '--user-data-dir', userDataDir]
    log(`installing ${path.basename(vsix)} with ${cli}`)
    log(code('--install-extension', vsix, '--force', ...where).trim())
    const listed = code('--list-extensions', '--show-versions', ...where)
    log(`installed: ${listed.trim()}`)
    if (!listed.toLowerCase().includes(extensionId.toLowerCase())) throw new Error(`${extensionId} not listed after --install-extension`)
  }

  const captureDir = path.join(REPO_ROOT, 'test-results', 'e2e', `capture-${label}`)
  const config = {
    extensionId, edition, userDataDir, home: t.home, repo, otlpPort, mcpPort, captureDir,
    fixture: { sessionId: fixture.sessionId, rootSpanId: fixture.rootSpanId, turnKey: fixture.turnKey, file: fixture.file, otlp: fixture.otlp, model: FIXTURE_MODEL },
    agents: agentsConfig ? JSON.parse(fs.readFileSync(agentsConfig, 'utf8')) : undefined,
  }
  const configPath = path.join(t.home, 'it-config.json')
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

  let code = 1
  try {
    code = await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath: compiledEntry,
      launchArgs: [
        '--user-data-dir', userDataDir,
        '--extensions-dir', extensionsDir,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-telemetry',
        // Secrets in memory, not the OS keychain: with HOME pointed at the temp home macOS has no
        // login keychain there, and VS Code's startup secret read (Settings Sync / auth) blocked the
        // window before the tests ever ran. Also keeps the runner's real keychain out of it.
        '--use-inmemory-secretstorage',
        // No folder: the extension's "current workspace" fallback is then empty, so a session's
        // workspace can only come from the session itself (the fixture repo).
      ],
      extensionTestsEnv: {
        ...t.env,
        TRACEROOST_IT_CONFIG: configPath,
        TRACEROOST_IT_SUITES: suites,
        // Don't let a developer's shell leak an OTEL endpoint into agents spawned by the tests.
        OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
      },
    })
  } catch (e) {
    console.error(`VS Code test run failed: ${e.message ?? e}`)
    code = typeof e.code === 'number' ? e.code : 1
  } finally {
    const dest = path.join(REPO_ROOT, 'test-results', 'e2e', `vscode-${label}`)
    try {
      fs.mkdirSync(dest, { recursive: true })
      fs.cpSync(path.join(userDataDir, 'logs'), path.join(dest, 'logs'), { recursive: true })
      fs.copyFileSync(configPath, path.join(dest, 'it-config.json'))
      log(`VS Code logs copied to ${dest}`)
    } catch (e) { log(`could not copy logs: ${e.message}`) }
    if (!process.env.KEEP_E2E_TEMP) t.cleanup()
  }
  process.exit(code)
}

main().catch(e => { console.error(e); process.exit(1) })
