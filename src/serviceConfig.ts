/**
 * Pure logic for running the standalone server as an OS-native background service
 * (macOS launchd / Linux systemd --user / Windows Scheduled Task). Kept dependency-free
 * (no fs/child_process side effects beyond the two explicit read/write functions) so the
 * service-definition generators are unit-testable without shelling out to a real OS service
 * manager — see .staged-issues/01-background-service-mode.md for the full design.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

export interface ServiceConfig {
  uiPort: number
  otlpPort: number
  mcpPort: number
  bindHost: string
  dataDir: string
  /** Bearer token guarding the UI/OTLP/MCP servers. Empty until `ensureAuthToken` generates
   *  and persists one on first run — kept out of `defaultServiceConfig` so that function stays
   *  pure and deterministic for tests. */
  authToken: string
  /** Stable per-machine identifier for TraceRoost Cloud (AL 02). A UUID generated once, at first
   *  run, and persisted here beside the auth token — present from schema version 1 even before
   *  anything reads it, so a later org link never needs a schema change plus a backfill.
   *  Empty until `ensureInstallId` generates one, same rationale as `authToken`. It is NOT sent
   *  in the rollup body — the service derives the install from the bearer token — but it keys
   *  the client's own forwarding queue and `--explain-payload` output. */
  installId: string
}

// `baseHome` defaults to the real home directory in production; tests pass a temp directory
// so these never touch the developer's actual ~/.traceroost.

export function defaultDataDir(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.traceroost')
}

export function defaultServiceConfig(baseHome?: string): ServiceConfig {
  return {
    uiPort: 3000,
    otlpPort: 4318,
    mcpPort: 4316,
    bindHost: '127.0.0.1',
    dataDir: defaultDataDir(baseHome),
    authToken: '',
    installId: '',
  }
}

/** The service config file always lives under the default data dir, even if its own
 *  `dataDir` field points somewhere else — this avoids a chicken-and-egg problem where
 *  finding the config requires already knowing the (possibly-customized) data directory. */
export function serviceConfigPath(baseHome?: string): string {
  return path.join(defaultDataDir(baseHome), 'config.json')
}

export function readServiceConfig(baseHome?: string): ServiceConfig {
  const defaults = defaultServiceConfig(baseHome)
  try {
    const raw = fs.readFileSync(serviceConfigPath(baseHome), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ServiceConfig>
    return { ...defaults, ...parsed }
  } catch {
    return defaults
  }
}

export function writeServiceConfig(config: ServiceConfig, baseHome?: string): void {
  const configPath = serviceConfigPath(baseHome)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  // Holds the bearer token — owner-only. `mode` only applies when the file is created, so an
  // existing (pre-0600) file is tightened too; chmod is a harmless no-op on Windows.
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  try { fs.chmodSync(configPath, 0o600) } catch { /* best effort */ }
}

/** Generates a fresh bearer token for the UI/OTLP/MCP servers. */
export function generateAuthToken(): string {
  return crypto.randomBytes(24).toString('hex')
}

/** Returns `config` unchanged if it already has an auth token; otherwise generates one,
 *  persists it to disk immediately (so a restart reuses the same token instead of
 *  invalidating every open browser tab / configured agent), and returns the updated config.
 *  Called once at server startup — not from `readServiceConfig` itself — so that function can
 *  stay a pure read with no side effects. */
export function ensureAuthToken(config: ServiceConfig, baseHome?: string): ServiceConfig {
  if (config.authToken) return config
  const withToken = { ...config, authToken: generateAuthToken() }
  writeServiceConfig(withToken, baseHome)
  return withToken
}

/** Returns `config` unchanged if it already carries an `installId`; otherwise generates a UUID,
 *  persists it, and returns the updated config. Independent of `ensureAuthToken` so an install
 *  that predates this field picks one up on its next startup. */
export function ensureInstallId(config: ServiceConfig, baseHome?: string): ServiceConfig {
  if (config.installId) return config
  const withId = { ...config, installId: crypto.randomUUID() }
  writeServiceConfig(withId, baseHome)
  return withId
}

export function serviceLogPath(config: ServiceConfig): string {
  return path.join(config.dataDir, 'logs', 'service.log')
}

// ── Service process record ───────────────────────────────────────────────────
//
// On Windows the Scheduled Task runs a wrapper .cmd, and node is that cmd.exe's child — `schtasks
// /end` terminates only the cmd.exe, so the server kept running (and holding its ports) after
// `service stop` / `uninstall` / a port-changing reinstall. A server started as the service
// records its pid here so the Windows service manager can end the server itself. Lives beside
// config.json (always under the default data dir, like it) so a `--data-dir` change between
// installs can't hide the old instance's record.

export interface ServiceProcessRecord {
  pid: number
  /** Executable name of the process (e.g. `node.exe`), checked before killing a recorded pid so a
   *  reused pid belonging to something else is never touched. */
  image: string
}

export function servicePidPath(baseHome?: string): string {
  return path.join(defaultDataDir(baseHome), 'service.pid')
}

export function writeServiceProcessRecord(record: ServiceProcessRecord, baseHome?: string): void {
  const p = servicePidPath(baseHome)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(record) + '\n', 'utf-8')
}

export function readServiceProcessRecord(baseHome?: string): ServiceProcessRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(servicePidPath(baseHome), 'utf-8')) as Partial<ServiceProcessRecord>
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.image === 'string' && parsed.image) {
      return { pid: parsed.pid, image: parsed.image }
    }
  } catch { /* none recorded */ }
  return undefined
}

/** Removes the record — only if it still names `pid` (a newer instance may have replaced it). */
export function clearServiceProcessRecord(pid: number, baseHome?: string): void {
  if (readServiceProcessRecord(baseHome)?.pid !== pid) return
  try { fs.rmSync(servicePidPath(baseHome), { force: true }) } catch { /* best effort */ }
}

/** True when `tasklist /FO CSV /NH` output for one pid shows a process with executable `image`
 *  (case-insensitive) — the pid-reuse guard before `taskkill`. */
export function tasklistShowsImage(tasklistCsv: string, pid: number, image: string): boolean {
  return tasklistCsv.split(/\r?\n/).some(line => {
    const cols = line.split('","').map(c => c.replace(/^"|"$/g, ''))
    return cols.length >= 2 && cols[0].toLowerCase() === image.toLowerCase() && Number(cols[1]) === pid
  })
}

/** Reads `name`/`version` out of the nearest `package.json` relative to `fromDir`, trying a
 *  couple of candidate depths since callers sit at different distances from the package root
 *  (e.g. `standalone/` vs. `standalone/service/`). Returns `{}` if neither candidate parses —
 *  callers decide how to degrade (e.g. fall back to `'unknown'`) rather than throwing, since a
 *  missing `package.json` (a stripped-down Docker image, say) shouldn't crash the process just to
 *  report its own version. */
export function readPackageManifest(fromDir: string): { name?: string; version?: string } {
  for (const rel of [['..', 'package.json'], ['..', '..', 'package.json']]) {
    try {
      const raw = fs.readFileSync(path.join(fromDir, ...rel), 'utf-8')
      const manifest = JSON.parse(raw) as { name?: string; version?: string }
      return { name: manifest.name, version: manifest.version }
    } catch {
      // try the next candidate depth
    }
  }
  return {}
}

// ── CLI flag parsing ─────────────────────────────────────────────────────────

const FLAG_TO_KEY: Record<string, keyof ServiceConfig> = {
  '--ui-port':   'uiPort',
  '--otlp-port': 'otlpPort',
  '--mcp-port':  'mcpPort',
  '--bind-host': 'bindHost',
  '--data-dir':  'dataDir',
}

/** Parses `--ui-port 3000 --data-dir /custom/path` style flags on top of the defaults. */
export function parseServiceInstallFlags(args: string[]): ServiceConfig {
  const config = defaultServiceConfig()
  for (let i = 0; i < args.length; i++) {
    const key = FLAG_TO_KEY[args[i]]
    if (!key) { continue }
    const value = args[i + 1]
    if (value === undefined) { continue }
    i++
    if (key === 'bindHost' || key === 'dataDir' || key === 'authToken' || key === 'installId') {
      config[key] = value
    } else {
      const n = parseInt(value, 10)
      if (!Number.isNaN(n)) { config[key] = n }
    }
  }
  return config
}

// ── npx-vs-global-install detection ──────────────────────────────────────────

/** True when the current process was launched via `npx`/`bunx` rather than a real
 *  global install — npx runs from an ephemeral cache with no stable path a service
 *  definition can point at, so `service install` needs to bootstrap a global install
 *  first (see runServiceCli in standalone/service/index.ts). */
export function isRunningFromNpx(userAgent: string | undefined, scriptPath: string): boolean {
  if (userAgent && /\bnpx\//.test(userAgent)) { return true }
  return /[\\/]_npx[\\/]/.test(scriptPath) || /[\\/]\.npm[\\/]_npx[\\/]/.test(scriptPath)
}

// ── npx-bootstrap re-exec guard ──────────────────────────────────────────────
//
// `child_process.execFileSync` inherits the parent's environment by default. Without this,
// re-invoking `traceroost service install` after the global-install bootstrap would still carry
// the original npm_config_user_agent (containing "npx/...") into the child — isRunningFromNpx
// would see that stale value and bootstrap again, forever, even though the child is by then
// correctly running from the global install. childEnvForReexec strips it (so the child's own
// npx check gets an honest read) and stamps a marker; shouldBlockRepeatedBootstrap checks that
// marker so any *other* undiscovered path to the same failure mode fails loudly instead of
// looping.

export const REEXEC_GUARD_ENV = 'TRACEROOST_SERVICE_BOOTSTRAPPED'

export function shouldBlockRepeatedBootstrap(env: NodeJS.ProcessEnv): boolean {
  return env[REEXEC_GUARD_ENV] === '1'
}

export function childEnvForReexec(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parentEnv }
  delete env.npm_config_user_agent
  env[REEXEC_GUARD_ENV] = '1'
  return env
}

// ── `service install` / `service update` npm-fetch messaging ────────────────
//
// `service install` and `service update` shell out to `npm install -g traceroost@latest`
// so the background service always lands on the newest published version rather than pinning
// whatever copy happened to launch it. When that download can't happen (offline, npm registry
// unreachable, npm missing, a permissions error) the service still starts on whatever version is
// already installed — these pure helpers build the warning so that path is loud instead of silent.

/** How to run `npm <args>` with `child_process.execFileSync` on `platform`. On Windows npm is
 *  `npm.cmd`, a batch file: CreateProcess never finds a bare `npm` (it only tries .com/.exe), so
 *  `execFileSync('npm', …)` failed with ENOENT there — `service update` always reported "npm was
 *  not found on your PATH", and `service install` never recognized (or refreshed) the global
 *  install. Node also refuses to spawn a .cmd without a shell (CVE-2024-27980), so it goes
 *  through the shell on Windows; every caller passes only fixed, shell-safe arguments
 *  (`root -g`, `install -g <package>@latest`). */
export function npmInvocation(args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[]; shell: boolean } {
  if (args.some(a => !/^[A-Za-z0-9@._\/:=-]+$/.test(a))) {
    throw new Error(`npm argument is not shell-safe: ${JSON.stringify(args)}`)
  }
  return platform === 'win32' ? { file: 'npm.cmd', args, shell: true } : { file: 'npm', args, shell: false }
}

/** Condenses whatever `child_process` threw when `npm install -g` failed into one short clause
 *  for the "couldn't download" warning. */
export function describeNpmFailure(err: unknown): string {
  const e = (err ?? {}) as { code?: string; status?: number; message?: string }
  if (e.code === 'ENOENT') { return 'npm was not found on your PATH' }
  if (typeof e.status === 'number') { return `npm exited with code ${e.status} — see its output above` }
  if (e.code) { return `npm could not be run (${e.code})` }
  return e.message ? e.message.split('\n')[0] : 'unknown error'
}

/** Condenses whatever `child_process` threw when the OS service manager (launchctl / systemctl /
 *  schtasks) failed during `service install` into one short clause. `tool` names the command so
 *  the message reads naturally on every platform. Captured stderr (when the caller passed it
 *  through) is preferred over a bare exit code — it's what actually explains the failure. */
export function describeServiceManagerFailure(err: unknown, tool = 'the service manager'): string {
  const e = (err ?? {}) as { code?: string; status?: number; message?: string; stderr?: unknown }
  const stderr = typeof e.stderr === 'string' ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString() : ''
  const firstStderrLine = stderr.split('\n').map(l => l.trim()).find(Boolean)
  if (e.code === 'ENOENT') { return `${tool} command was not found on your PATH` }
  if (firstStderrLine) { return firstStderrLine }
  if (typeof e.status === 'number') { return `${tool} exited with code ${e.status}` }
  if (e.code) { return `${tool} could not be run (${e.code})` }
  return e.message ? e.message.split('\n')[0] : 'unknown error'
}

/** Warning shown when the latest package can't be fetched. `fallbackVersion` is the
 *  version already on disk that the service will run instead (undefined if there is none). Not
 *  fatal on its own — callers that truly have nothing to fall back on report that separately. */
export function couldNotDownloadMessage(reason: string, fallbackVersion: string | undefined, packageName = 'traceroost'): string {
  const head = `[TraceRoost] Couldn't download the latest ${packageName} from npm: ${reason}.`
  const tail = fallbackVersion
    ? `Keeping the version already installed (v${fallbackVersion}) — run \`traceroost service update\` later to retry.`
    : 'Nothing is installed to fall back on.'
  return `${head}\n[TraceRoost] ${tail}`
}

// ── Service-definition generators (pure string builders) ────────────────────

export interface ServiceProgram {
  nodePath: string
  cliPath: string
  config: ServiceConfig
}

const LAUNCHD_LABEL = 'com.traceroost.server'

export function launchdLabel(): string {
  return LAUNCHD_LABEL
}

/** XML-escapes a value for a plist `<string>` — a path or bind host containing `&` or `<`
 *  would otherwise produce a plist launchd refuses to load (or, worse, one that parses into
 *  different keys than intended). */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function generateLaunchdPlist({ nodePath, cliPath, config }: ServiceProgram): string {
  const logPath = xmlEscape(serviceLogPath(config))
  const envEntry = (key: string, value: string) => `    <key>${key}</key>\n    <string>${xmlEscape(value)}</string>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(cliPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${envEntry('UI_PORT', String(config.uiPort))}
${envEntry('OTLP_PORT', String(config.otlpPort))}
${envEntry('MCP_PORT', String(config.mcpPort))}
${envEntry('BIND_HOST', config.bindHost)}
${envEntry('DATA_DIR', config.dataDir)}
${envEntry('TRACEROOST_SERVICE', '1')}
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`
}

export const SYSTEMD_UNIT_NAME = 'traceroost.service'

/** A unit file is line-oriented — a value containing a newline would start a new directive,
 *  and there is no escape for that in every setting we write, so refuse it outright. */
function assertSingleLine(value: string, what: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`${what} contains a line break or NUL, which can't be written to a service definition: ${JSON.stringify(value)}`)
  }
}

/** Escapes systemd specifiers (`%h`, `%u`, …) — systemd expands them in ExecStart, Environment
 *  and StandardOutput values, so a literal `%` must be written `%%` (systemd.unit(5)). */
function systemdEscapeSpecifiers(value: string): string {
  return value.replace(/%/g, '%%')
}

/** Double-quotes one word for a setting systemd splits into words and unquotes (ExecStart
 *  arguments, Environment assignments): backslash and `"` are C-escaped inside the quotes, and
 *  specifiers are escaped (systemd.syntax(7)). `$` is additionally doubled for ExecStart, where
 *  `$VAR`/`${VAR}` would otherwise be substituted from the environment (systemd.service(5)). */
function systemdQuote(value: string, what: string, { execArg = false } = {}): string {
  assertSingleLine(value, what)
  let escaped = systemdEscapeSpecifiers(value.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
  if (execArg) { escaped = escaped.replace(/\$/g, '$$$$') }
  return `"${escaped}"`
}

/** A `StandardOutput=append:<path>` value is taken verbatim (no unquoting), with specifiers
 *  expanded — so only `%` needs escaping; spaces are fine as-is. */
function systemdPath(value: string, what: string): string {
  assertSingleLine(value, what)
  return systemdEscapeSpecifiers(value)
}

export function generateSystemdUnit({ nodePath, cliPath, config }: ServiceProgram): string {
  const logPath = systemdPath(serviceLogPath(config), 'log path')
  const env = (key: string, value: string) => `Environment=${systemdQuote(`${key}=${value}`, key)}`
  return `[Unit]
Description=TraceRoost background service
After=network.target

[Service]
Type=simple
ExecStart=${systemdQuote(nodePath, 'node path', { execArg: true })} ${systemdQuote(cliPath, 'cli path', { execArg: true })}
Restart=on-failure
${env('UI_PORT', String(config.uiPort))}
${env('OTLP_PORT', String(config.otlpPort))}
${env('MCP_PORT', String(config.mcpPort))}
${env('BIND_HOST', config.bindHost)}
${env('DATA_DIR', config.dataDir)}
${env('TRACEROOST_SERVICE', '1')}
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`
}

export const WINDOWS_TASK_NAME = 'TraceRoost'

/** Windows Scheduled Tasks have no simple way to set per-task environment variables,
 *  so the task points at this wrapper .cmd instead of node.exe directly — it sets the
 *  env vars for the child process only (never touches the user's persistent environment
 *  the way `setx` would) and appends output to the same log file macOS/Linux use. */
/** Makes a value safe inside a double-quoted token in a .cmd file (`set "K=v"`, `"path"`): `%`
 *  is doubled so cmd doesn't expand `%VAR%` from it (the batch-file escape; `&`, `^`, `<`, `>`
 *  and `|` are already literal inside the quotes). A `"` would end the quoting early and a line
 *  break would start a new command — neither has an escape here, and neither can occur in a real
 *  Windows path, so both are refused. */
function cmdQuoted(value: string, what: string): string {
  if (/["\r\n\0]/.test(value)) {
    throw new Error(`${what} contains a double quote or line break, which can't be written to the service wrapper script: ${JSON.stringify(value)}`)
  }
  return value.replace(/%/g, '%%')
}

export function generateWindowsWrapperScript({ nodePath, cliPath, config }: ServiceProgram): string {
  const logPath = cmdQuoted(serviceLogPath(config), 'log path')
  return `@echo off
set "UI_PORT=${config.uiPort}"
set "OTLP_PORT=${config.otlpPort}"
set "MCP_PORT=${config.mcpPort}"
set "BIND_HOST=${cmdQuoted(config.bindHost, 'bind host')}"
set "DATA_DIR=${cmdQuoted(config.dataDir, 'data dir')}"
set "TRACEROOST_SERVICE=1"
"${cmdQuoted(nodePath, 'node path')}" "${cmdQuoted(cliPath, 'cli path')}" >> "${logPath}" 2>&1
`
}
