#!/usr/bin/env node
// TraceRoost standalone server — run with: npx traceroost@latest  |  bunx traceroost@latest  |  node standalone/cli.js
// (use the @latest tag — a bare `npx traceroost` re-runs npx's cached copy without checking npm for a newer release)
// `traceroost service <install|uninstall|start|stop|restart|status|logs|update>` manages running this
// as an OS-native background service instead — see standalone/service/index.ts.
// `traceroost org <link|status|verify|leave> [--device]` links this machine to an org (Cloud, AL 01) —
// full edition only; the core edition prints "not available" and exits 1 (see cliCloud.ts).
// `traceroost find <repo hash | trace/session id>` resolves a cloud dashboard hash-handoff
// locally (traces-table.tsx's HashHandoff) and prints what it finds, ending with a `vscode://`
// deep link into the interactive view — doesn't start the server. `traceroost trace --id <id>`
// and `traceroost patterns --repo <hash|name>` run either half of `find` directly.
// Any other bare word is an unknown subcommand, and any other flag an unknown option: print usage
// and exit non-zero rather than silently starting the server (which also auto-configures agents).
// `--help`/`-h` prints the usage, `--version`/`-v` the version. Only no arguments at all starts
// the server (see cliArgs.ts).

import { topLevelAction, usageText } from './cliArgs'

// TraceRoost Cloud (org link + upload) subcommands and the cloud step of local ones come only
// through this seam — see cliCloud.ts. The core edition's build swaps in inert stubs. Loaded
// lazily, like every subcommand, so plain `traceroost` doesn't initialize the cloud CLI modules.
const loadCloud = async () => (await import('./cliCloud.js')).cliCloud

// A literal `process.env.TRACEROOST_EDITION` check (esbuild.js defines it), so the core build's
// usage text doesn't advertise commands it can't run.
const CLOUD = process.env.TRACEROOST_EDITION !== 'core'
const USAGE = usageText(CLOUD)

async function main() {
  const args = process.argv.slice(2)
  const action = topLevelAction(args)
  if (action === 'help') {
    console.log(USAGE)
    return
  }
  if (action === 'version') {
    const { readPackageManifest } = await import('../src/serviceConfig.js')
    console.log(readPackageManifest(__dirname).version ?? 'unknown')
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
  if (action === 'subcommand') {
    console.error(`Unknown command: ${args[0]}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  if (action === 'explain') {
    const explain = (await loadCloud()).maybeRunExplainPayload(args)
    if (explain) {
      process.exitCode = await explain
      return
    }
  }
  if (action !== 'server') {
    console.error(`Unknown option: ${args[0]}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  await import('./server.js')
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
