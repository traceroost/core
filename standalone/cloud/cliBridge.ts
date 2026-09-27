/**
 * The full edition's `CliCloud` (standalone/cliCloud.ts). The core edition's build swaps this file
 * for `standalone/cliCloud.core.ts`; keep the two in step with the interface.
 */

import type { CliCloud } from '../cliCloud'
import { runOrgCli } from './org-cli'
import { runClusterCli } from './clusterCli'
import { parseExplainFlags, runExplainPayload } from './explainPayload'
import { recordAppliedAndEmit } from './adviseTelemetry'
import { resolveRepoHash } from '../../src/cloud/org/resolveRepoHash'

export const cliBridge: CliCloud = {
  runOrgCli,
  runClusterCli,
  maybeRunExplainPayload: (args) => {
    const explain = parseExplainFlags(args)
    return explain ? runExplainPayload(explain) : null
  },
  resolveRepoHash,
  afterAdviseApply: recordAppliedAndEmit,
}
