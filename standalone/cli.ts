#!/usr/bin/env node
// TraceRoost standalone server — run with: npx traceroost@latest  |  bunx traceroost@latest  |  node standalone/cli.js
// (use the @latest tag — a bare `npx traceroost` re-runs npx's cached copy without checking npm for a newer release)
// `traceroost service <install|uninstall|start|stop|restart|status|logs>` manages running this
// as an OS-native background service instead — see standalone/service/index.ts.
// `traceroost org <link|status|leave> [--device]` links this machine to an org (Pro, AL 01).
// `traceroost find <repo hash | trace/session id>` resolves a cloud dashboard hash-handoff
// locally (traces-table.tsx's HashHandoff) and prints what it finds, ending with a `vscode://`
// deep link into the interactive view — doesn't start the server. `traceroost trace --id <id>`
// and `traceroost patterns --repo <hash|name>` run either half of `find` directly.
// Any other bare word is an unknown subcommand: print usage and exit non-zero rather than
// silently starting the server. `--help`/`-h` prints the usage. No arguments (or other flags
// only) starts the server.

const USAGE = `Usage:
  traceroost                                   start the server (UI, OTLP receiver, MCP)
  traceroost --explain-payload [--last|--all|--session <id>|--since <date>] [--dry-run]
  traceroost service <install|uninstall|start|stop|restart|status|logs|update>
  traceroost org <link|status|leave> [--device]
  traceroost find <repo hash | trace/session id> [--reporter <email>]
  traceroost trace --id <sessionId>
  traceroost patterns --repo <hash|name>
  traceroost advise <--list|--apply <id>> [--repo <path>]
  traceroost cluster --repo <hash> --id <id>
  traceroost cohort --repo <hash|name> --merged <YYYY-MM> [--window 30|90]`

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE)
    return
  }
  if (args[0] === 'service') {
    const { runServiceCli } = await import('./service/index.js')
    process.exitCode = await runServiceCli(args.slice(1))
    return
  }
  if (args[0] === 'org') {
    const { runOrgCli } = await import('./cloud/org-cli.js')
    process.exitCode = await runOrgCli(args.slice(1))
    return
  }
  if (args[0] === 'advise' || args[0] === 'cluster') {
    const { runAdviseCli } = await import('./cloud/adviseCli.js')
    process.exitCode = await runAdviseCli(args[0] === 'cluster' ? args : args.slice(1))
    return
  }
  if (args[0] === 'cohort') {
    const { runCohortCli } = await import('./cloud/cohortCli.js')
    process.exitCode = await runCohortCli(args.slice(1))
    return
  }
  if (args[0] === 'find') {
    const { runFindCli } = await import('./cloud/findCli.js')
    process.exitCode = await runFindCli(args.slice(1))
    return
  }
  if (args[0] === 'trace') {
    const { runTraceCli } = await import('./cloud/traceCli.js')
    process.exitCode = await runTraceCli(args.slice(1))
    return
  }
  if (args[0] === 'patterns') {
    const { runPatternsCli } = await import('./cloud/patternsCli.js')
    process.exitCode = await runPatternsCli(args.slice(1))
    return
  }
  if (args[0] !== undefined && !args[0].startsWith('-')) {
    console.error(`Unknown command: ${args[0]}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  const { parseExplainFlags, runExplainPayload } = await import('./cloud/explainPayload.js')
  const explain = parseExplainFlags(args)
  if (explain) {
    process.exitCode = await runExplainPayload(explain)
    return
  }
  await import('./server.js')
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
