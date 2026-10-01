/**
 * The CLI's one seam to TraceRoost Cloud (org link + upload) — the `standalone/cli.ts` counterpart
 * of src/cloudBridge.ts. cli.ts dispatches cloud subcommands, and passes the cloud step of a local
 * command, only through `cliCloud` here; `standalone/local/**` never imports a cloud module.
 *
 * - `standalone/cloud/cliBridge.ts` — the full edition's implementation.
 * - `standalone/cliCloud.core.ts` — the core edition's: every cloud subcommand prints "not
 *   available in the TraceRoost core edition" and exits 1, and local commands get no cloud step
 *   (a cloud repo_hash simply doesn't resolve). `node esbuild.js --edition=core` resolves
 *   `./cloud/cliBridge` to it, so nothing under `standalone/cloud/` is bundled.
 */

import { cliBridge } from './cloud/cliBridge'
import type { RepoHashResolver } from './local/repoResolve'
import type { AfterApplyHook } from './local/adviseCli'

export interface CliCloud {
  /** `traceroost org <link|status|leave|verify>`. */
  runOrgCli(args: string[]): Promise<number>
  /** `traceroost cluster --repo <hash> --id <id>`. */
  runClusterCli(args: string[]): Promise<number>
  /** `traceroost --explain-payload …` — null when `args` isn't an explain-payload invocation (so
   *  the caller starts the server instead). */
  maybeRunExplainPayload(args: string[]): Promise<number> | null
  /** Resolves a cloud repo_hash for `find`/`patterns`/`cohort`; undefined in the core edition. */
  readonly resolveRepoHash?: RepoHashResolver
  /** The ledger + SuggestionEvent step after `advise --apply`; undefined in the core edition. */
  readonly afterAdviseApply?: AfterApplyHook
}

export const cliCloud: CliCloud = cliBridge
