#!/usr/bin/env node
// AgentLens standalone server — run with: npx agentlens-dashboard@latest  |  bunx agentlens-dashboard@latest  |  node standalone/cli.js
// (use the @latest tag — a bare `npx agentlens-dashboard` re-runs npx's cached copy without checking npm for a newer release)
//
// Subcommands:
//   agentlens service <install|uninstall|start|stop|restart|status|logs>  — run as an OS background service
//   agentlens team <link|status|leave> [--device]                          — AgentLens Pro machine link (AL 01)
// With no subcommand, starts the dashboard server.

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === 'service') {
    const { runServiceCli } = await import('./service/index.js')
    process.exitCode = await runServiceCli(args.slice(1))
    return
  }
  if (args[0] === 'team') {
    const { runTeamCli } = await import('./team-cli.js')
    process.exitCode = await runTeamCli(args.slice(1))
    return
  }
  if (args[0] === 'advise' || args[0] === 'cluster') {
    const { runAdviseCli } = await import('./adviseCli.js')
    process.exitCode = await runAdviseCli(args[0] === 'cluster' ? args : args.slice(1))
    return
  }
  const { parseExplainFlags, runExplainPayload } = await import('./explainPayload.js')
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
