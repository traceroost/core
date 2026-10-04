/**
 * The full edition's `CloudBridge` (src/cloudBridge.ts) — a thin wrapper over `src/cloud/**`, and
 * the only module outside `src/cloud/` that non-cloud code reaches it through. The core edition's
 * build swaps this file for `src/cloudBridge.core.ts`; keep the two in step with the interface.
 */

import type { CloudBridge } from '../cloudBridge'
import { linkInteractive, leave } from './org/link'
import { startLinkWatcher } from './org/linkWatcher'
import { getOrgStatus } from './org/status'
import { SENT, NEVER_SENT } from './org/privacy'
import { getQueueStats } from './forward/currentQueueStats'
import { maybeEnqueueSession } from './org/enqueueSession'
import { maybeEnqueueInstructionTelemetry, EMPTY_LEDGER } from './org/instructionTelemetry'
import { isLinked, loadCredentials } from './org/credentials'
import { orgEndpoint } from './org/config'
import { startForwardScheduler, drainForwardQueueSoon } from './forward/scheduler'
import { startPricingSync } from './org/pricingSync'
import { resolveRepoHash } from './org/resolveRepoHash'
import { handleOrgMessage } from './org/panelController'
import { buildPayloadPreviewTexts } from './org/payloadPreview'
import { deriveRepoKey, repoHash } from '../repoKey'
import { maybeForwardOnContentChange } from './org/contentChangeForward'
import { setHostStore } from './org/hostIdentity'
import { ForwardQueue } from './forward/queue'
import { DeliveryLedger } from './forward/deliveryLedger'

export const cloudBridge: CloudBridge = {
  edition: 'full',

  isLinked,
  orgStatus: (withQueue) => getOrgStatus(withQueue ? getQueueStats() : undefined),
  privacy: { sent: SENT, neverSent: NEVER_SENT },
  link: (opts) => linkInteractive(opts),
  leave: () => leave(),
  orgViewUrl: () => {
    // Deep-links straight into the org's own dashboard, not the bare marketing root — `[org]`'s
    // route in `cloud` accepts either a slug or a raw org id (see currentOrg() there), so this
    // works even though only the id, never a slug, is ever stored locally.
    const creds = loadCredentials()
    return creds ? `${creds.endpoint}/${creds.orgId}` : orgEndpoint()
  },

  setHostStore,
  dropQueuedTraces: () => {
    const queue = new ForwardQueue()
    queue.remove(queue.list().filter(item => item.key.startsWith('session:')).map(item => item.key))
    new DeliveryLedger().forget(key => key.includes(':session:'))
  },
  enqueueSession: (card, log, revision) => maybeEnqueueSession(card, log, undefined, revision),
  forwardOnContentChange: (reconciliation, card, log) => maybeForwardOnContentChange(reconciliation, card, log),
  enqueueInstructionTelemetry: (workspace, sessions, ledger) =>
    maybeEnqueueInstructionTelemetry(workspace, sessions, ledger ?? EMPTY_LEDGER),
  startForwardScheduler: (opts) => startForwardScheduler(opts),
  drainUploadsSoon: drainForwardQueueSoon,
  startPricingSync: (opts) => startPricingSync(opts),
  startLinkWatcher: (opts) => startLinkWatcher(opts),

  handleOrgMessage,
  buildPayloadPreview: (sessions) => buildPayloadPreviewTexts(sessions),

  describeRepo: async (workspace) => {
    // `hash` is the same one traceroost-cloud shows in its own Repo column. Unlinked installs get
    // the same 'unlinked-preview' salt buildPayloadForCard's own preview path already uses, so the
    // value is still stable and distinguishes repos from each other locally.
    const orgId = loadCredentials()?.orgId ?? 'unlinked-preview'
    const rk = await deriveRepoKey(workspace, orgId)
    return rk.ok ? { root: rk.ctx.root, hash: repoHash(rk.ctx) } : null
  },
  resolveRepoHash,
}
