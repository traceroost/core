/**
 * The core edition's `CloudBridge` (src/cloudBridge.ts): TraceRoost with no Pro code built in.
 *
 * `node esbuild.js --edition=core` resolves `src/cloud/bridge.ts` to this file, so nothing under
 * `src/cloud/` is bundled. Everything here is inert — never linked, nothing queued, nothing sent,
 * no timers — and anything that would have linked or uploaded answers "not available in this
 * edition" instead. Must not import runtime code from any `cloud/` directory (type-only imports
 * are erased; esbuild.js fails a core build that tries to load a cloud module).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { CloudBridge } from './cloudBridge'
import { NOT_AVAILABLE_IN_CORE } from './edition'
import { deriveRepoKey, repoHash } from './repoKey'

const execFileAsync = promisify(execFile)

const inertTimer = { syncToLinkState() {}, drainSoon() {}, dispose() {} }

export const cloudBridge: CloudBridge = {
  edition: 'core',

  isLinked: () => false,
  orgStatus: () => ({ linked: false }),
  privacy: { sent: [], neverSent: [] },
  link: async () => { throw new Error(NOT_AVAILABLE_IN_CORE) },
  leave: async () => ({ serverRevoked: false }),
  orgViewUrl: () => '',

  enqueueSession: async () => ({ enqueued: false, reason: 'not-linked' }),
  forwardOnContentChange: async () => ({ enqueued: false, reason: 'not-linked' }),
  enqueueInstructionTelemetry: async () => false,
  startForwardScheduler: () => inertTimer,
  drainUploadsSoon: () => {},
  startPricingSync: () => inertTimer,

  // The core webview never sends org messages (its Org panel is a stub that renders nothing), but
  // a stray one — an old page, a hand-made request to the standalone server — still gets a reply
  // rather than hanging a caller waiting on one.
  handleOrgMessage: async (msg, deps) => {
    if (msg.type === 'getOrgStatus') return // no org status to report — the stub panel never asks
    deps.post({ type: 'orgActionResult', ok: false, error: NOT_AVAILABLE_IN_CORE })
    deps.post({ type: 'orgError', error: NOT_AVAILABLE_IN_CORE })
  },
  buildPayloadPreview: async () => [],

  // Same hash an unlinked full-edition install shows (src/cloud/bridge.ts): the 'unlinked-preview'
  // salt, since core never has an org to salt with. Only ever displayed locally, never sent.
  describeRepo: async (workspace) => {
    const rk = await deriveRepoKey(workspace, 'unlinked-preview')
    if (rk.ok) return { root: rk.ctx.root, hash: repoHash(rk.ctx) }
    if (rk.reason === 'not-a-repo') return null
    // Not keyable (e.g. a shallow clone has no root commit) — still show the repo's name.
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: workspace, timeout: 5000 })
      const root = stdout.trim()
      return root ? { root, hash: null } : null
    } catch {
      return null
    }
  },
  resolveRepoHash: async () => null,
}
