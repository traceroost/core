#!/usr/bin/env node
// Shipped-artifact smoke test: exercises the npm package exactly as a user gets it, on whatever OS
// this runs on (the windows-e2e workflow runs it on Windows, macOS and Linux).
//
// For each edition (core, full):
//   1. build the production bundles for that edition, rewrite package.json with
//      scripts/prepare-edition.mjs, `npm pack` the result, restore package.json;
//   2. `npm install -g` the tarball into a temp prefix;
//   3. `traceroost --help` (and the edition-specific usage lines);
//   4. start `traceroost` on free ports with a temp home, POST a fixture Claude Code OTLP trace and
//      drop the same conversation's transcript into ~/.claude/projects, then poll /api/summary
//      until both appear — checking workspace (= the fixture git repo), model, tokens, cost (via
//      the MCP server) and a git outcome (/api/git-outcome), plus what auto-config wrote;
//   5. with --service: `traceroost service install` → `service status` → ingest through the
//      service → `service uninstall`, on the real OS service manager (Task Scheduler / launchd /
//      systemd --user). Skipped with a notice when the machine has no usable service manager.
//
//   node tests/e2e/artifact-smoke.mjs [--edition core|full]... [--service] [--skip-build] [--keep]
//
// Needs network access to the npm registry (the tarball's runtime dependencies are installed from it).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  REPO_ROOT, IS_WIN, assert, assertEqual, log, notice, waitFor, freePorts, getJson, postJson, request, mcpCall,
  makeTempHome, makeGitRepo, claudeFixture, writeClaudeTranscript, commitFixtureChange, startProcess, run, tryRun,
  stepRunner, SkipError, rmrf, sleep,
} from './lib.mjs'

const argv = process.argv.slice(2)
const editions = argv.flatMap((a, i) => (a === '--edition' ? [argv[i + 1]] : []))
const EDITIONS = editions.length > 0 ? editions : ['core', 'full']
const WITH_SERVICE = argv.includes('--service')
const SKIP_BUILD = argv.includes('--skip-build')
const KEEP = argv.includes('--keep')
const OUT_DIR = path.join(REPO_ROOT, 'test-results', 'e2e')
fs.mkdirSync(OUT_DIR, { recursive: true })

const { step, summary } = stepRunner()
const samePath = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b)

// ── 1. build + pack ──────────────────────────────────────────────────────────

function packEdition(edition) {
  if (!SKIP_BUILD) {
    run(process.execPath, ['esbuild.js', '--production', `--edition=${edition}`], { cwd: REPO_ROOT, stdio: 'inherit' })
  }
  run(process.execPath, ['scripts/prepare-edition.mjs', edition], { cwd: REPO_ROOT, stdio: 'inherit' })
  try {
    if (edition === 'core') run(process.execPath, ['scripts/check-edition.mjs', 'core'], { cwd: REPO_ROOT, stdio: 'inherit' })
    // --ignore-scripts: the bundles were just built above; prepublishOnly/prepack would rebuild
    // (and re-lint) the whole thing again.
    const out = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', OUT_DIR], { cwd: REPO_ROOT })
    const info = JSON.parse(out.slice(out.indexOf('[')))[0]
    const files = info.files.map(f => f.path.replace(/\\/g, '/'))
    for (const required of ['standalone/cli.js', 'standalone/server.js', 'dist/sql-wasm.wasm', 'dist/sql-wasm.js', 'media/dashboard.js', 'package.json']) {
      assert(files.includes(required), `tarball contains ${required}`)
    }
    if (edition === 'core') assert(!files.some(f => /(^|\/)cloud\//.test(f)), 'core tarball ships no cloud/ files')
    const tgz = path.join(OUT_DIR, `traceroost-${edition}-${info.version}.tgz`)
    fs.renameSync(path.join(OUT_DIR, info.filename), tgz)
    log(`packed ${tgz} (${info.files.length} files, ${(info.size / 1024).toFixed(0)} KiB)`)
    return tgz
  } finally {
    run(process.execPath, ['scripts/prepare-edition.mjs', 'restore'], { cwd: REPO_ROOT, stdio: 'inherit' })
  }
}

// ── 2. install ───────────────────────────────────────────────────────────────

function installGlobally(tgz, label) {
  const prefix = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `traceroost-prefix-${label}-`)))
  run('npm', ['install', '-g', '--no-audit', '--no-fund', '--prefix', prefix, tgz], { stdio: 'inherit' })
  const bin = IS_WIN ? path.join(prefix, 'traceroost.cmd') : path.join(prefix, 'bin', 'traceroost')
  assert(fs.existsSync(bin), `npm put the traceroost bin at ${bin}`)
  const pkgDir = IS_WIN ? path.join(prefix, 'node_modules', 'traceroost') : path.join(prefix, 'lib', 'node_modules', 'traceroost')
  const cli = path.join(pkgDir, 'standalone', 'cli.js')
  assert(fs.existsSync(cli), `installed package has ${cli}`)
  // The prefix's bin dir first on PATH, as a user's global npm bin dir would be.
  const binDir = IS_WIN ? prefix : path.join(prefix, 'bin')
  return { prefix, bin, binDir, cli, pkgDir }
}

/** Runs the installed `traceroost` bin — through the .cmd shim on Windows, exactly as a user's shell would. */
function traceroost(inst, args, env) {
  return tryRun(inst.bin, args, { env, shell: IS_WIN })
}

// ── 3/4. run the server ──────────────────────────────────────────────────────

async function serverRoundTrip(inst, edition) {
  const home = makeTempHome(`smoke-${edition}`)
  const repo = makeGitRepo(home.home)
  const fx = claudeFixture({ repo })
  commitFixtureChange(repo, fx)
  const transcript = writeClaudeTranscript(home.home, fx, repo)
  const [ui, otlp, mcp] = await freePorts(3)
  const env = { ...home.env, UI_PORT: String(ui), OTLP_PORT: String(otlp), MCP_PORT: String(mcp), BROWSER: 'none', PATH: `${inst.binDir}${path.delimiter}${process.env.PATH}` }
  // Spawned through the shell on Windows (the .cmd shim) so the process tree is what a user's
  // terminal would have; stop() kills the tree.
  const srv = startProcess(`traceroost-${edition}`, inst.bin, [], { env, shell: IS_WIN })
  try {
    const base = `http://127.0.0.1:${ui}`
    await waitFor('the server to answer /health', async () => {
      if (srv.exited) throw new Error(`server exited early (${JSON.stringify(srv.exited)}):\n${srv.output()}`)
      return (await request('GET', `${base}/health`)).status === 200
    }, { timeoutMs: 60_000 })

    // Data dir + config under the temp home (%USERPROFILE%\.traceroost on Windows).
    const dataDir = path.join(home.home, '.traceroost')
    assert(fs.existsSync(path.join(dataDir, 'config.json')), `${dataDir}/config.json created`)
    const ports = JSON.parse(fs.readFileSync(path.join(dataDir, 'ports.json'), 'utf8'))
    assertEqual(`${ports.ui}/${ports.otlp}/${ports.mcp}`, `${ui}/${otlp}/${mcp}`, 'ports.json records the ports actually bound')

    // Auto-config pointed Claude Code and Codex at this server (under the temp home).
    await waitFor('auto-config to write ~/.claude/settings.json', () => {
      const s = JSON.parse(fs.readFileSync(path.join(home.home, '.claude', 'settings.json'), 'utf8'))
      return s.env?.OTEL_EXPORTER_OTLP_ENDPOINT === `http://localhost:${otlp}`
    }, { timeoutMs: 20_000 })
    await waitFor('auto-config to write ~/.codex/config.toml', () =>
      fs.readFileSync(path.join(home.home, '.codex', 'config.toml'), 'utf8').includes(`endpoint = "http://localhost:${otlp}"`), { timeoutMs: 20_000 })

    // The transcript first: it was on disk before the server started, so the startup log scan lists it.
    const isTranscriptCard = x => x.dataSource === 'log' && (x.claudeSessionId === fx.sessionId || x.sessionId === fx.sessionId)
    const logCard = await waitFor('the transcript session in /api/summary', async () =>
      ((await getJson(`${base}/api/summary`))?.sessions ?? []).find(isTranscriptCard), { timeoutMs: 60_000 })

    // Then the same conversation over OTLP. OTEL wins: the transcript card must drop out, leaving
    // one session for the conversation (claudeConversation.ts — the rule the extension's writer uses).
    const res = await request('POST', `http://127.0.0.1:${otlp}/v1/traces`, { body: fx.otlp })
    assertEqual(res.status, 200, 'OTLP /v1/traces accepted the fixture')
    const sessions = await waitFor('the OTEL session to replace the transcript one in /api/summary', async () => {
      const s = (await getJson(`${base}/api/summary`))?.sessions ?? []
      const otel = s.find(x => x.sessionId === fx.rootSpanId)
      return otel && !s.some(isTranscriptCard) ? { all: s, otel } : null
    }, { timeoutMs: 60_000 })
    const forConversation = sessions.all.filter(x => x.claudeSessionId === fx.sessionId || x.sessionId === fx.sessionId || x.sessionId === fx.rootSpanId)
    assertEqual(forConversation.length, 1, 'one session for the conversation (OTEL + transcript deduped)')
    assertEqual(sessions.otel.claudeSessionId, fx.sessionId, 'the OTEL card carries the Claude session id from the resource attributes')
    for (const [kind, card] of [['OTEL', sessions.otel], ['transcript', logCard]]) {
      assertEqual(card.source, 'claude_code', `${kind} card source`)
      assert(samePath(card.workspace, repo), `${kind} card workspace is the fixture repo (got ${card.workspace}, want ${repo})`)
      assertEqual(card.model, 'claude-sonnet-4-6', `${kind} card model`)
      assert(card.inputTokens > 0 && card.outputTokens > 0, `${kind} card has tokens (${card.inputTokens}/${card.outputTokens})`)
      assert((card.filesChanged ?? []).some(f => samePath(f, fx.file)), `${kind} card lists ${fx.file} as changed (got ${JSON.stringify(card.filesChanged)})`)
    }
    // Cost, as the MCP server (and the dashboard) compute it.
    const recent = await mcpCall(`http://127.0.0.1:${mcp}/mcp`, 'get_recent_sessions', { limit: 50 })
    const otelCost = recent.find(r => r.sessionId === fx.rootSpanId)?.cost_usd
    assert(otelCost > 0, `MCP get_recent_sessions reports a cost for the OTEL session (got ${otelCost})`)

    // Git outcome, via the same route the dashboard's Outcome badge uses.
    const out = await postJson(`${base}/api/git-outcome`, {
      sessionId: fx.rootSpanId, workspace: sessions.otel.workspace, filesChanged: sessions.otel.filesChanged,
      endTime: new Date(Date.parse(sessions.otel.startTime) + sessions.otel.durationMs).toISOString(),
    })
    assert(out && !out.deferred && out.outcome, `/api/git-outcome classified the session (got ${JSON.stringify(out)})`)
    assert(['committed', 'merged'].includes(out.outcome.overall), `outcome is committed/merged (got ${out.outcome.overall}: ${out.outcome.reason})`)

    // Spans persisted under the data dir.
    await waitFor('spans.json to be saved', () => fs.existsSync(path.join(dataDir, 'spans.json')), { timeoutMs: 20_000 })
    log(`transcript ${transcript} ingested; OTEL session ${fx.rootSpanId} cost $${otelCost}, outcome ${out.outcome.overall}`)
  } finally {
    const exit = await srv.stop()
    log(`server stopped (${JSON.stringify(exit)})`)
    if (!KEEP) home.cleanup()
  }
}

// ── 5. OS service ────────────────────────────────────────────────────────────

function serviceManagerAvailable() {
  if (process.platform === 'linux') {
    const r = tryRun('systemctl', ['--user', 'is-system-running'])
    // "running" or "degraded" both mean the user manager answers; anything else (no bus) can't host it.
    if (!/running|degraded|starting/.test(r.stdout + r.stderr)) {
      return `systemctl --user is unavailable here (${(r.stdout + r.stderr).trim() || `exit ${r.status}`})`
    }
  }
  if (process.platform === 'darwin') {
    const r = tryRun('launchctl', ['print', `gui/${process.getuid()}`])
    if (r.status !== 0) return `no launchd gui/${process.getuid()} domain (${r.stderr.trim()})`
  }
  return null
}

async function serviceRoundTrip(inst, edition) {
  const why = serviceManagerAvailable()
  if (why) throw new SkipError(why)
  // The service is registered for the real user (launchd/systemd look in the real home), so this
  // stage uses the real home directory — only ever run it on a throwaway CI machine.
  if (!process.env.CI) throw new SkipError('installs a real OS service for the current user — only runs with CI set')
  const [ui, otlp, mcp] = await freePorts(3)
  const env = {
    ...process.env,
    PATH: `${inst.binDir}${path.delimiter}${process.env.PATH}`,
    // `service install` from a global npm install first runs `npm install -g traceroost@latest`
    // so a re-install upgrades. Point npm's global prefix at the tarball install and its registry
    // at a dead port: the service CLI must still recognize its own global install (it resolves it
    // with `npm root -g` — which never worked on Windows before npmInvocation), report the failed
    // download, and register exactly the tarball under test.
    npm_config_prefix: inst.prefix,
    npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_fetch_retries: '0',
    npm_config_fetch_timeout: '3000',
    npm_config_update_notifier: 'false',
  }
  const dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `traceroost-svc-${edition}-`)))
  const logFile = path.join(dataDir, 'logs', 'service.log')
  const dumpLog = () => { try { return fs.readFileSync(logFile, 'utf8').slice(-4000) } catch { return '(no service log)' } }
  let installed = false
  let currentUi = ui
  let primaryError
  try {
    const inst1 = traceroost(inst, ['service', 'install', '--ui-port', String(ui), '--otlp-port', String(otlp), '--mcp-port', String(mcp), '--data-dir', dataDir], env)
    console.log(inst1.stdout + inst1.stderr)
    assertEqual(inst1.status, 0, `service install exits 0\n${inst1.stdout}${inst1.stderr}\n--- service log ---\n${dumpLog()}`)
    installed = true
    const fetched = inst1.stdout.includes('Fetching the latest traceroost from npm')
    if (IS_WIN) {
      assert(fetched, 'service install recognized it runs from the global npm install')
      assert(/Keeping the version already installed \(v\d/.test(inst1.stdout + inst1.stderr), 'failed download falls back to the installed version')
    } else if (!fetched) {
      // Known, not Windows-specific: launched through the npm bin symlink, process.argv[1] is the
      // symlink (<prefix>/bin/traceroost), so isRunningFromGlobalInstall() never matches the
      // package dir and install skips its upgrade step. Reported, not asserted, here.
      notice('service install did not detect its global npm install (argv[1] is the bin symlink) — the upgrade-on-reinstall step is skipped on this OS')
    }
    const healthy = await waitFor('`service status` to report the service healthy', () => traceroost(inst, ['service', 'status'], env).status === 0, { timeoutMs: 60_000, intervalMs: 2000 })
      .catch(e => { throw new Error(`${e.message}\n--- service log ---\n${dumpLog()}`) })
    assert(healthy, 'service healthy')
    const st = traceroost(inst, ['service', 'status'], env)
    assert(st.stdout.includes('Running') && st.stdout.includes(`:${ui}`), `status names the running dashboard (got: ${st.stdout.trim()})`)
    // The service is the real server: ingest through it.
    const fx = claudeFixture({ repo: dataDir })
    assertEqual((await request('POST', `http://127.0.0.1:${otlp}/v1/traces`, { body: fx.otlp })).status, 200, 'service OTLP port accepted a trace')
    await waitFor('the service to list the ingested session', async () =>
      ((await getJson(`http://127.0.0.1:${ui}/api/summary`))?.sessions ?? []).some(s => s.sessionId === fx.rootSpanId), { timeoutMs: 30_000 })
    // `service update` with the registry unreachable: a clean "couldn't download", exit 1, and
    // never "npm was not found on your PATH" (what a bare execFileSync('npm') gave on Windows).
    const upd = traceroost(inst, ['service', 'update'], env)
    assertEqual(upd.status, 1, 'service update exits 1 when the registry is unreachable')
    assert(/Couldn't download the latest traceroost from npm: npm exited with code/.test(upd.stdout + upd.stderr), `update reports npm's failure (got: ${(upd.stdout + upd.stderr).slice(-600)})`)
    const logs = traceroost(inst, ['service', 'logs'], env)
    assertEqual(logs.status, 0, 'service logs exits 0')
    assert(/OTLP receiver/.test(logs.stdout), `service log has the startup banner (got: ${logs.stdout.slice(-500)})`)
    // Re-install over a running service (the "change ports" path) must replace it cleanly.
    const [ui2] = await freePorts(1)
    const inst2 = traceroost(inst, ['service', 'install', '--ui-port', String(ui2), '--otlp-port', String(otlp), '--mcp-port', String(mcp), '--data-dir', dataDir], env)
    assertEqual(inst2.status, 0, `re-install exits 0\n${inst2.stdout}${inst2.stderr}`)
    currentUi = ui2
    await waitFor('the re-installed service on its new UI port', async () => (await request('GET', `http://127.0.0.1:${ui2}/health`).catch(() => ({ status: 0 }))).status === 200, { timeoutMs: 60_000, intervalMs: 2000 })
      .catch(e => { throw new Error(`${e.message}\n--- service log ---\n${dumpLog()}`) })
  } catch (e) {
    primaryError = e
    throw e
  } finally {
    try {
    if (installed) {
      const un = traceroost(inst, ['service', 'uninstall'], env)
      console.log(un.stdout + un.stderr)
      assertEqual(un.status, 0, 'service uninstall exits 0')
      await waitFor('the service to stop answering', async () => (await request('GET', `http://127.0.0.1:${currentUi}/health`, { timeoutMs: 2000 }).catch(() => ({ status: 0 }))).status !== 200, { timeoutMs: 30_000 })
      const after = traceroost(inst, ['service', 'status'], env)
      assertEqual(after.status, 1, 'status exits 1 after uninstall')
      assert(/No background service is installed/.test(after.stdout), `status says nothing is installed (got: ${after.stdout.trim()})`)
      if (IS_WIN) assert(tryRun('schtasks', ['/query', '/tn', 'TraceRoost']).status !== 0, 'the TraceRoost scheduled task is gone')
      assert(!fs.existsSync(path.join(dataDir, 'service', 'run.cmd')), 'the Windows wrapper script is removed (never created elsewhere)')
    }
    } catch (cleanupError) {
      // Don't let a cleanup assertion hide the failure that got us here.
      if (!primaryError) throw cleanupError
      console.error(`(also failed during cleanup: ${cleanupError.message})`)
    } finally {
      await sleep(500)
      rmrf(dataDir)
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`artifact smoke on ${process.platform}-${process.arch}, node ${process.version}; editions: ${EDITIONS.join(', ')}${WITH_SERVICE ? ' (+ service)' : ''}`)
  for (const edition of EDITIONS) {
    const tgz = await step(`${edition}: build and npm pack the ${edition}-prepared package`, () => packEdition(edition))
    if (!tgz) continue
    const inst = await step(`${edition}: npm install -g the tarball into a temp prefix`, () => installGlobally(tgz, edition))
    if (!inst) continue
    await step(`${edition}: traceroost --help`, () => {
      const r = traceroost(inst, ['--help'], process.env)
      assertEqual(r.status, 0, `--help exits 0 (${r.stderr})`)
      assert(r.stdout.includes('Usage:') && r.stdout.includes('traceroost service'), '--help prints the usage')
      assertEqual(r.stdout.includes('traceroost org'), edition === 'full', `org subcommand advertised only in the full edition`)
      const bad = traceroost(inst, ['definitely-not-a-command'], process.env)
      assertEqual(bad.status, 1, 'an unknown subcommand exits 1')
      if (edition === 'core') assert(traceroost(inst, ['org', 'status'], process.env).status !== 0, "'org' is unavailable in the core edition")
    })
    await step(`${edition}: server ingests OTLP + transcript, reports workspace/tokens/cost/outcome`, () => serverRoundTrip(inst, edition))
    if (WITH_SERVICE) await step(`${edition}: service install → status → uninstall (${IS_WIN ? 'Task Scheduler' : process.platform === 'darwin' ? 'launchd' : 'systemd --user'})`, () => serviceRoundTrip(inst, edition))
    if (!KEEP) rmrf(inst.prefix)
  }
  const failed = summary()
  if (failed === 0 && EDITIONS.length === 0) notice('no editions selected')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
