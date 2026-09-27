/**
 * The core edition's `CliCloud` (standalone/cliCloud.ts): no TraceRoost Pro code is built in, so
 * every cloud subcommand says so and exits 1. Local commands still run in full — they just get no
 * cloud step (a 64-hex cloud repo_hash resolves to nothing; a repo name works as always). Must not
 * import runtime code from any `cloud/` directory.
 */

import type { CliCloud } from './cliCloud'

const MESSAGE = 'not available in the TraceRoost core edition'

async function notAvailable(what: string): Promise<number> {
  console.error(`traceroost ${what}: ${MESSAGE}.`)
  return 1
}

export const cliBridge: CliCloud = {
  runOrgCli: () => notAvailable('org'),
  runClusterCli: () => notAvailable('cluster'),
  maybeRunExplainPayload: (args) =>
    args.includes('--explain-payload') || args.includes('--dry-run') ? notAvailable('--explain-payload') : null,
}
