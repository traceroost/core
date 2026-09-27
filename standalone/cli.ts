#!/usr/bin/env node
// TraceRoost standalone server — run with: npx traceroost@latest  |  bunx traceroost@latest  |  node standalone/cli.js
// (use the @latest tag — a bare `npx traceroost` re-runs npx's cached copy without checking npm for a newer release)
// `traceroost service <install|uninstall|start|stop|restart|status|logs>` manages running this
// as an OS-native background service instead — see standalone/service/index.ts.
// `traceroost org <link|status|leave> [--device]` links this machine to an org (Pro, AL 01) —
// full edition only; the core edition prints "not available" and exits 1 (see cliCloud.ts).
// `traceroost find <repo hash | trace/session id>` resolves a cloud dashboard hash-handoff
// locally (traces-table.tsx's HashHandoff) and prints what it finds, ending with a `vscode://`
// deep link into the interactive view — doesn't start the server. `traceroost trace --id <id>`
// and `traceroost patterns --repo <hash|name>` run either half of `find` directly.
// Any other bare word is an unknown subcommand: print usage and exit non-zero rather than
// silently starting the server. `--help`/`-h` prints the usage. No arguments (or other flags
// only) starts the server.

// TraceRoost Pro (org link + upload) subcommands and the cloud step of local ones come only
// through this seam — see cliCloud.ts. The core edition's build swaps in inert stubs. Loaded
// lazily, like every subcommand, so plain `traceroost` doesn't initialize the cloud CLI modules.
const loadCloud = async () => (await import('./cliCloud.js')).cliCloud

// A literal `process.env.TRACEROOST_EDITION` check (esbuild.js defines it), so the core build's
// usage text doesn't advertise commands it can't run.
const PRO = process.env.TRACEROOST_EDITION !== 'core'

const USAGE = [
  'Usage:',
  '  traceroost                                   start the server (UI, OTLP receiver, MCP)',
  PRO && '  traceroost --explain-payload [--last|--all|--session <id>|--since <date>] [--dry-run]',
  '  traceroost service <install|uninstall|start|stop|restart|status|logs|update>',
  PRO && '  traceroost org <link|status|leave> [--device]',
  '  traceroost find <repo hash | trace/session id> [--reporter <email>]',
  '  traceroost trace --id <sessionId>',
  '  traceroost patterns --repo <hash|name>',
  '  traceroost advise <--list|--apply <id>> [--repo <path>]',
  PRO && '  traceroost cluster --repo <hash> --id <id>',
  '  traceroost cohort --repo <hash|name> --merged <YYYY-MM> [--window 30|90]',
].filter(Boolean).join('\n')

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
    process.exitCode = await (await loadCloud()).runOrgCli(args.slice(1))
    return
  }
  // Local analysis (free, standalone/local/) — the one cloud step some of them have (resolving a
  // cloud repo_hash, recording an applied suggestion for org telemetry) is passed in from
  // cliCloud.ts, never imported by the local modules themselves.
  if (args[0] === 'advise') {
    const { runAdviseCli } = await import('./local/adviseCli.js')
    process.exitCode = await runAdviseCli(args.slice(1), (await loadCloud()).afterAdviseApply)
    return
  }
  if (args[0] === 'cluster') {
    process.exitCode = await (await loadCloud()).runClusterCli(args.slice(1))
    return
  }
  if (args[0] === 'cohort') {
    const { runCohortCli } = await import('./local/cohortCli.js')
    process.exitCode = await runCohortCli(args.slice(1), (await loadCloud()).resolveRepoHash)
    return
  }
  if (args[0] === 'find') {
    const { runFindCli } = await import('./local/findCli.js')
    process.exitCode = await runFindCli(args.slice(1), (await loadCloud()).resolveRepoHash)
    return
  }
  if (args[0] === 'trace') {
    const { runTraceCli } = await import('./local/traceCli.js')
    process.exitCode = await runTraceCli(args.slice(1))
    return
  }
  if (args[0] === 'patterns') {
    const { runPatternsCli } = await import('./local/patternsCli.js')
    process.exitCode = await runPatternsCli(args.slice(1), undefined, (await loadCloud()).resolveRepoHash)
    return
  }
  if (args[0] !== undefined && !args[0].startsWith('-')) {
    console.error(`Unknown command: ${args[0]}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  const explain = (await loadCloud()).maybeRunExplainPayload(args)
  if (explain) {
    process.exitCode = await explain
    return
  }
  await import('./server.js')
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
