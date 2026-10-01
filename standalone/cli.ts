#!/usr/bin/env node
// AgentLens standalone server — run with: npx agentlens-dashboard@latest  |  bunx agentlens-dashboard@latest  |  node standalone/cli.js
// (use the @latest tag — a bare `npx agentlens-dashboard` re-runs npx's cached copy without checking npm for a newer release)
// `agentlens service <install|uninstall|start|stop|restart|status|logs>` manages running this
// as an OS-native background service instead — see standalone/service/index.ts.

import { printMovedNotice } from './movedNotice'

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === 'service') {
    printMovedNotice()
    const { runServiceCli } = await import('./service/index.js')
    process.exitCode = await runServiceCli(args.slice(1))
    return
  }
  await import('./server.js')
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
