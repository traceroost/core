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
import type { LinkWatcherOptions } from './cloud/org/linkWatcher'
import type { SuggestionLedger } from './cloud/org/instructionTelemetry'
import type { ReconciliationService } from './reconcile/reconciliationService'
import type { SessionSummaryCard } from './summarizers/summarizerTypes'

export type Edition = 'full' | 'core'
export type { OrgMessage, OrgPanelDeps, SuggestionLedger }

export interface EnqueueResult {
  enqueued: boolean
  reason?: 'not-linked' | 'unkeyed' | 'duplicate' | 'already-delivered' | 'lower-rank' | 'error'
}

export interface ForwardSchedulerHandle {
  /** Re-evaluate whether the timer should be running (call after link / leave). */
  syncToLinkState(): void
  /** Drain soon, ignoring the interval (call after something was enqueued). */
  drainSoon(): void
  dispose(): void
}

/** What a host's local store answers for the trace manifest (stable trace identity, feature 11 —
 *  see src/cloud/forward/traceManifest.ts). Times are epoch ms; key/count windows are inclusive
 *  [fromMs, toMs], like DatabaseReader.listTraceKeys. */
export interface TraceManifestSource {
  /** True only for the process that owns writes to the store (the standalone server's data-dir
   *  lock, the extension window that owns the database) — only it may send a manifest. */
  isWriter(): boolean
  /** False until the store is complete — the startup history load has finished. A manifest built
   *  from a half-loaded store would retire every trace not read yet. */
  isReady(): boolean
  /** Start of the oldest trace still held (localHorizon), or null with none. */
  localHorizonMs(): number | null
  /** The wire keys (session_id) of the traces that started in the window. */
  listTraceKeys(fromMs: number, toMs: number): string[]
  /** Every trace held that started in the window — not-yet-keyed ones included — so 0
   *  means the store positively holds none there. */
  countTraces(fromMs: number, toMs: number): number
}

export interface ForwardSchedulerOptions {
  notify?: (message: string, kind: 'info' | 'warning') => void
  log?: (msg: string) => void
  onDrainStart?: () => void
  onDrainComplete?: () => void
  recordSent?: (count: number, at: number) => void
  /** The local store the trace manifest is built from. Without it, no manifest is sent. */
  traceManifest?: TraceManifestSource
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
  /** Names this host's own trace store (the extension's global storage, the standalone server's
   *  data dir) — its cloud host id lives there (src/cloud/org/hostIdentity.ts). Call once at
   *  startup, before anything is enqueued. Writes nothing; a no-op in the core edition. */
  setHostStore(storeDir: string): void
  /** Drops every queued trace rollup and every trace delivery record, for a host whose trace store
   *  was just rebuilt (src/database/traceStore.ts): what it held was keyed by ids no longer
   *  minted, and the re-read history is queued again under its new keys. A no-op in the core
   *  edition. */
  dropQueuedTraces(): void
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
  /** Notices a link or leave made outside this process (the CLI, another server or window) and
   *  catches up: starts/stops the timers and queues every trace not yet sent (linkWatcher.ts). */
  startLinkWatcher(opts: LinkWatcherOptions): { dispose(): void }

  // ── Org panel (webview) ───────────────────────────────────────────────────
  /** Handles every `org*` / `getOrgStatus` webview message (panelController.ts). */
  handleOrgMessage(msg: OrgMessage, deps: OrgPanelDeps): Promise<void>
  /** The exact wire bytes `--explain-payload` prints, for the panel's preview. */
  buildPayloadPreview(sessions: SessionSummaryCard[]): Promise<string[]>

  // ── Repository identity ───────────────────────────────────────────────────
  /** The git root for `workspace`, plus the org-salted repo hash TraceRoost Cloud shows for it
   *  (unlinked/core installs salt with 'unlinked-preview'; null for a shallow clone). Null when not
   *  a usable repo. */
  describeRepo(workspace: string): Promise<{ root: string; hash: string | null } | null>
  /** Cloud `repo_hash` → local clone root, for the dashboard's hash hand-off deep links. Always
   *  null in the core edition. Never a network call. */
  resolveRepoHash(repoHashHex: string, candidateWorkspaces: string[]): Promise<string | null>
}

export const cloud: CloudBridge = cloudBridge
