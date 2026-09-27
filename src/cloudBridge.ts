/**
 * The one seam between the free, local product and TraceRoost Cloud (org link + upload, `src/cloud/`).
 *
 * Nothing outside a `cloud/` directory imports runtime code from one — it asks `cloud` here
 * instead. Two implementations satisfy `CloudBridge`:
 *
 * - `src/cloud/bridge.ts` — the real one, a thin wrapper over `src/cloud/**`. The default, and the
 *   only one tests and `pnpm run compile`/`package` ever see.
 * - `src/cloudBridge.core.ts` — inert: never linked, every send a no-op, every org message
 *   answered with "not available in this edition". The core edition's build
 *   (`node esbuild.js --edition=core`) resolves `./cloud/bridge` to that file instead, so no
 *   module under `src/cloud/` is bundled at all — enforced at build time (esbuild.js refuses to
 *   load a cloud module in a core build) and again afterwards by `scripts/check-edition.mjs`.
 *
 * Type-only imports from `src/cloud/` below are erased at compile time and never reach a bundle.
 */

import { cloudBridge } from './cloud/bridge'
import type { OrgMessage, OrgPanelDeps } from './cloud/org/panelController'
import type { SuggestionLedger } from './cloud/org/instructionTelemetry'
import type { ReconciliationService } from './reconcile/reconciliationService'
import type { SessionSummaryCard } from './summarizers/summarizerTypes'

export type Edition = 'full' | 'core'
export type { OrgMessage, OrgPanelDeps, SuggestionLedger }

export interface EnqueueResult {
  enqueued: boolean
  reason?: 'not-linked' | 'duplicate' | 'already-delivered' | 'error'
}

export interface ForwardSchedulerHandle {
  /** Re-evaluate whether the timer should be running (call after link / leave). */
  syncToLinkState(): void
  /** Drain soon, ignoring the interval (call after something was enqueued). */
  drainSoon(): void
  dispose(): void
}

export interface ForwardSchedulerOptions {
  notify?: (message: string, kind: 'info' | 'warning') => void
  log?: (msg: string) => void
  onDrainStart?: () => void
  onDrainComplete?: () => void
  recordSent?: (count: number, at: number) => void
}

/** The few fields the VS Code "Org Link Status" command shows. */
export interface OrgStatusSummary {
  linked: boolean
  orgName?: string
  role?: string
  queueDepth?: number
  lastRollupAt?: string | null
}

export interface CloudBridge {
  readonly edition: Edition

  // ── Link state ────────────────────────────────────────────────────────────
  /** Local disk only — never a network call. Always false in the core edition. */
  isLinked(): boolean
  /** Local-only status for the command palette; `withQueue` adds forwarding-queue depth. */
  orgStatus(withQueue?: boolean): OrgStatusSummary
  /** The consent list shown before linking (privacy.ts). Empty in the core edition. */
  readonly privacy: { sent: readonly string[]; neverSent: readonly string[] }
  link(opts: { openUrl: (url: string) => void }): Promise<{ orgName: string; role: string }>
  leave(): Promise<{ serverRevoked: boolean }>
  /** The linked org's own dashboard URL (or the service root when unlinked). */
  orgViewUrl(): string

  // ── Upload ────────────────────────────────────────────────────────────────
  /** Session close → forwarding queue. A no-op unless linked. */
  enqueueSession(card: SessionSummaryCard, log?: (m: string) => void, revision?: number): Promise<EnqueueResult>
  /** Re-forward a live session whenever its rollup content changes (staged feature 10). */
  forwardOnContentChange(reconciliation: ReconciliationService, card: SessionSummaryCard, log?: (m: string) => void): Promise<EnqueueResult>
  /** Instruction-file telemetry (AL 08) for `workspace`. Resolves true when something was queued. */
  enqueueInstructionTelemetry(workspace: string, sessions: SessionSummaryCard[], ledger?: SuggestionLedger): Promise<boolean>
  /** Starts the forwarding timer (it only ever runs while linked). */
  startForwardScheduler(opts: ForwardSchedulerOptions): ForwardSchedulerHandle
  drainUploadsSoon(): void
  /** Starts the linked org's rate-table sync (only ever runs while linked). */
  startPricingSync(opts: { onSync?: () => void }): { dispose(): void }

  // ── Org panel (webview) ───────────────────────────────────────────────────
  /** Handles every `org*` / `getOrgStatus` webview message (panelController.ts). */
  handleOrgMessage(msg: OrgMessage, deps: OrgPanelDeps): Promise<void>
  /** The exact wire bytes `--explain-payload` prints, for the panel's preview. */
  buildPayloadPreview(sessions: SessionSummaryCard[]): Promise<string[]>

  // ── Repository identity ───────────────────────────────────────────────────
  /** The git root for `workspace`, plus the org-salted repo hash TraceRoost Cloud shows for it
   *  (null in the core edition, which has no use for one). Null when not a usable repo. */
  describeRepo(workspace: string): Promise<{ root: string; hash: string | null } | null>
  /** Cloud `repo_hash` → local clone root, for the dashboard's hash hand-off deep links. Always
   *  null in the core edition. Never a network call. */
  resolveRepoHash(repoHashHex: string, candidateWorkspaces: string[]): Promise<string | null>
}

export const cloud: CloudBridge = cloudBridge
