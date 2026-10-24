/**
 * Pure pieces of standalone/cli.ts's top-level dispatch, split out for testing: the usage text
 * (per edition) and what a flag-led (or empty) argument list means. Subcommands (`service`,
 * `find`, …) are dispatched in cli.ts itself before any of this applies.
 */

/** One local subcommand's usage line (without the leading "Usage: "). `cloud` is false in the
 *  core edition, which leaves out the cloud-only parts (a cloud repo hash, `find --reporter`).
 *  The subcommands print this on bad arguments, so it always matches the top-level `--help`. */
export function commandUsage(command: 'find' | 'patterns' | 'cohort', cloud: boolean): string {
  switch (command) {
    case 'find':
      return cloud
        ? 'traceroost find <repo hash | trace/session id> [--reporter <email>]'
        : 'traceroost find <trace/session id | repo name>'
    case 'patterns':
      return cloud ? 'traceroost patterns --repo <hash|name>' : 'traceroost patterns --repo <name>'
    case 'cohort':
      return cloud
        ? 'traceroost cohort --repo <hash|name> --merged <YYYY-MM> [--window 30|90]'
        : 'traceroost cohort --repo <name> --merged <YYYY-MM> [--window 30|90]'
  }
}

/** `traceroost agents` (standalone/agentsCli.ts), which prints it on bad arguments too. */
export const AGENTS_USAGE = 'traceroost agents <setup|remove> [--otlp-port <port>]'

/** Whether this build is the full edition. A literal `process.env.TRACEROOST_EDITION` check
 *  (esbuild.js defines it); unit tests run against the sources, i.e. the full edition. */
export function isCloudEdition(): boolean {
  return process.env.TRACEROOST_EDITION !== 'core'
}

/** One entry of the usage text: the command line, then a one-line description under it. */
interface UsageEntry { usage: string; description: string; cloud?: true }

function commandEntries(cloud: boolean): UsageEntry[] {
  const entries: UsageEntry[] = [
    { usage: 'traceroost [--ui-port <port>] [--otlp-port <port>] [--data-dir <path>] [--no-open] …',
      description: 'Start TraceRoost here — see "Bare run" below.' },
    { usage: 'traceroost service <install|uninstall|start|stop|restart|status|logs|update>',
      description: 'Run TraceRoost as a background service that starts at login; `install` also updates it.' },
    { usage: AGENTS_USAGE,
      description: 'Set up Claude Code, Codex and Copilot to send traces here, or remove only what TraceRoost added.' },
    { usage: commandUsage('find', cloud),
      description: 'Look up a trace or repository and print what this machine recorded for it.' },
    { usage: 'traceroost trace --id <sessionId>',
      description: 'Print one recorded trace: its prompt, agent, duration, turns, errors and files changed.' },
    { usage: commandUsage('patterns', cloud),
      description: "Print a repository's most-touched files and the loop/waste signals seen in its traces." },
    { usage: 'traceroost advise <--list|--apply <id>> [--repo <path>]',
      description: "List Advisor suggestions for a repository's instruction file, or append one (--apply)." },
    { usage: commandUsage('cohort', cloud),
      description: "Show how much AI-written code merged in a month still stands (turnover), and the commits behind it." },
    { usage: 'traceroost cluster --repo <hash> --id <id>', cloud: true,
      description: 'Match a Cloud "Repeat work" cluster against the traces recorded on this machine.' },
    { usage: 'traceroost org <link|status|verify|leave> [--device|--browser]', cloud: true,
      description: 'Link this machine to a TraceRoost Cloud org, check it, or unlink it (`leave`).' },
    { usage: 'traceroost --explain-payload [--last|--all|--session <id>|--since <date>] [--dry-run]', cloud: true,
      description: 'Print exactly what would be sent to TraceRoost Cloud for a trace, without sending it.' },
    { usage: 'traceroost help | --help | -h', description: 'Print this help.' },
    { usage: 'traceroost --version | -v', description: 'Print the version.' },
  ]
  return entries.filter(e => cloud || !e.cloud)
}

/** The bare run's flags, each the same as an environment variable it honours (flags win). */
export const SERVER_FLAGS: Record<string, { env: string; value: 'port' | 'path' | 'none'; help: string }> = {
  '--ui-port':   { env: 'UI_PORT',   value: 'port', help: 'dashboard port (default 3000)' },
  '--otlp-port': { env: 'OTLP_PORT', value: 'port', help: 'OTLP receiver port your agents send live traces to (default 4318)' },
  '--mcp-port':  { env: 'MCP_PORT',  value: 'port', help: 'MCP server port (default 4316)' },
  '--data-dir':  { env: 'DATA_DIR',  value: 'path', help: 'where traces are stored (default ~/.traceroost)' },
  '--no-open':   { env: 'TRACEROOST_NO_OPEN', value: 'none', help: "don't open the dashboard in a browser" },
}

/** Every environment variable a bare run honours, for the help's Environment footer. Keep in step
 *  with README's "Native process" table. */
const ENVIRONMENT: Array<[string, string]> = [
  ['UI_PORT, OTLP_PORT, MCP_PORT', 'ports, as --ui-port / --otlp-port / --mcp-port (default 3000, 4318, 4316)'],
  ['DATA_DIR', 'data directory, as --data-dir (default ~/.traceroost)'],
  ['BIND_HOST', 'interface to listen on (default 127.0.0.1; a non-loopback address requires the access token)'],
  ['TRACEROOST_NO_OPEN=1', "don't open the dashboard in a browser, as --no-open"],
  ['TRACEROOST_NO_AUTOCONFIG=1', "never change any agent's settings, and don't ask"],
  ['TRACEROOST_NO_UPDATE_CHECK=1', 'skip the check for a newer version on npm'],
  ['TRACEROOST_MAX_SPANS', 'cap on stored spans (default 50000)'],
  ['TRACEROOST_BUDGET_CAP_USD', 'per-trace dollar cap for the Budget Overrun signal (off unless set)'],
  ['TRACEROOST_LOG_LEVEL=debug', 'more detail in the log, e.g. one line per OTLP payload'],
]

/** The usage text. `cloud` is false in the core edition, which leaves out the commands it can't
 *  run and the cloud-only parts of local ones (a cloud repo hash, `find --reporter`). */
export function usageText(cloud: boolean): string {
  const flagWidth = Math.max(...Object.keys(SERVER_FLAGS).map(f => f.length + (SERVER_FLAGS[f].value === 'none' ? 0 : SERVER_FLAGS[f].value.length + 3)))
  const envWidth = Math.max(...ENVIRONMENT.map(([name]) => name.length))
  return [
    'Usage: traceroost [command] [options]',
    '',
    'Commands:',
    ...commandEntries(cloud).flatMap(e => [`  ${e.usage}`, `      ${e.description}`]),
    '',
    'Bare run: `traceroost` with no command starts the dashboard (and opens it in your browser), the',
    'OTLP receiver your agents send live traces to, and the MCP server. Past history appears right',
    "away from your agents' log files. It asks before it changes any agent's settings — here in",
    'the terminal, or in the dashboard when there is no terminal. Options:',
    ...Object.entries(SERVER_FLAGS).map(([flag, f]) => {
      const left = f.value === 'none' ? flag : `${flag} <${f.value}>`
      return `  ${left.padEnd(flagWidth)}  ${f.help}`
    }),
    '',
    'Environment (bare run; a flag wins over its variable):',
    ...ENVIRONMENT.map(([name, help]) => `  ${name.padEnd(envWidth)}  ${help}`),
  ].join('\n')
}

/** The flags that make a flag-only invocation `--explain-payload` rather than a server start —
 *  the cloud seam's maybeRunExplainPayload handles both editions (core: "not available"). */
const EXPLAIN_FLAGS = ['--explain-payload', '--dry-run']

export type TopLevelAction = 'server' | 'help' | 'version' | 'explain' | 'unknown-flag' | 'subcommand'

/** What an argument list means once no subcommand matched. Only an empty list, or one made only of
 *  the bare run's own flags (SERVER_FLAGS), starts the server — an unknown or mistyped flag must
 *  not, since starting the server may also set agents up (or ask to). */
export function topLevelAction(args: string[]): TopLevelAction {
  const first = args[0]
  if (first === undefined) return 'server'
  if (first === '--help' || first === '-h' || first === 'help') return 'help'
  if (first === '--version' || first === '-v') return 'version'
  if (!first.startsWith('-')) return 'subcommand'
  if (args.some(a => EXPLAIN_FLAGS.includes(a))) return 'explain'
  if (parseServerFlags(args).ok) return 'server'
  return 'unknown-flag'
}

export type ServerFlagsResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; error: string }

/** Turns the bare run's flags into the environment variables the server already reads, so the two
 *  stay one mechanism: `--ui-port 3100` is `UI_PORT=3100`. Anything not in SERVER_FLAGS, a missing
 *  value, or a port outside 1–65535 is an error — never a partial start. */
export function parseServerFlags(args: string[]): ServerFlagsResult {
  const env: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    const spec = SERVER_FLAGS[flag]
    if (!spec) return { ok: false, error: `Unknown option: ${flag}` }
    if (spec.value === 'none') { env[spec.env] = '1'; continue }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `${flag} needs a value` }
    i++
    if (spec.value === 'port') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: `${flag} must be a port number (1–65535), got ${value}` }
      env[spec.env] = String(n)
    } else {
      env[spec.env] = value
    }
  }
  return { ok: true, env }
}
