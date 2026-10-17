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

/** Whether this build is the full edition. A literal `process.env.TRACEROOST_EDITION` check
 *  (esbuild.js defines it); unit tests run against the sources, i.e. the full edition. */
export function isCloudEdition(): boolean {
  return process.env.TRACEROOST_EDITION !== 'core'
}

/** The usage text. `cloud` is false in the core edition, which leaves out the commands it can't
 *  run and the cloud-only parts of local ones (a cloud repo hash, `find --reporter`). */
export function usageText(cloud: boolean): string {
  return [
    'Usage:',
    '  traceroost                                   start the server (UI, OTLP receiver, MCP)',
    '  traceroost --version                         print the version',
    '  traceroost --help                            print this help',
    cloud && '  traceroost --explain-payload [--last|--all|--session <id>|--since <date>] [--dry-run]',
    '  traceroost service <install|uninstall|start|stop|restart|status|logs|update>',
    cloud && '  traceroost org <link|status|verify|leave> [--device]',
    `  ${commandUsage('find', cloud)}`,
    '  traceroost trace --id <sessionId>',
    `  ${commandUsage('patterns', cloud)}`,
    '  traceroost advise <--list|--apply <id>> [--repo <path>]',
    cloud && '  traceroost cluster --repo <hash> --id <id>',
    `  ${commandUsage('cohort', cloud)}`,
  ].filter(Boolean).join('\n')
}

/** The flags that make a flag-only invocation `--explain-payload` rather than a server start —
 *  the cloud seam's maybeRunExplainPayload handles both editions (core: "not available"). */
const EXPLAIN_FLAGS = ['--explain-payload', '--dry-run']

export type TopLevelAction = 'server' | 'help' | 'version' | 'explain' | 'unknown-flag' | 'subcommand'

/** What an argument list means once no subcommand matched. Only an empty list starts the server —
 *  an unknown or mistyped flag must not, since starting the server may also set agents up (or ask to). */
export function topLevelAction(args: string[]): TopLevelAction {
  const first = args[0]
  if (first === undefined) return 'server'
  if (first === '--help' || first === '-h') return 'help'
  if (first === '--version' || first === '-v') return 'version'
  if (!first.startsWith('-')) return 'subcommand'
  if (args.some(a => EXPLAIN_FLAGS.includes(a))) return 'explain'
  return 'unknown-flag'
}
