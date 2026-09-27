/**
 * Transport-agnostic handler for the Org panel's messages (AL 01).
 *
 * Both hosts route `org*` webview messages here: the VS Code `DashboardPanel` and the
 * standalone server. It owns no state — every call reads the credential fresh — so an unlinked
 * install answers `getOrgStatus` without a single network request.
 */

import { getOrgStatus, type QueueStats, type TraceSendStats } from './status'
import { linkInteractive, linkViaDevice, leave, refreshOrgNameIfStale } from './link'
import { getQueueStats } from '../forward/currentQueueStats'
import { syncForwardSchedulerToLinkState, drainForwardQueueSoon, checkForwardQueueNow, isForwardQueueDraining } from '../forward/scheduler'
import { syncPricingToLinkState } from './pricingSync'
import { maybeEnqueueSession } from './enqueueSession'
import { createPayloadBuildCache } from './payloadPreview'
import { isOrgEnvironment } from './config'
import { saveSelectedEnvironment } from './environmentSelection'
import { isLinked } from './credentials'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

export interface OrgMessage {
  type: string
  [k: string]: unknown
}

export interface OrgPanelDeps {
  /** Send a message back to the webview. */
  post: (msg: Record<string, unknown>) => void
  /** Open a URL in the user's browser (VS Code: `env.openExternal`; standalone: system opener). */
  openExternal: (url: string) => void | Promise<void>
  /** Recent local sessions, newest first — used to build the `--explain-payload` preview. */
  recentSessions: () => SessionSummaryCard[]
  /** Every local session this install knows about, regardless of age — used right after a
   *  successful link, and on demand via "Check for unsent traces", to queue anything not yet confirmed
   *  delivered (see `reconcileLocalSessions` below). Absent hosts just skip reconciliation;
   *  nothing else in the panel depends on it. */
  allLocalSessions?: () => SessionSummaryCard[]
  /** Live forwarding-queue stats (AL 04). Absent until that lands. */
  queueStats?: () => QueueStats | undefined
  /** Local transport transparency stats — "hashed traces sent" over a few windows, read straight
   *  from this machine's own SQLite DB. Absent on a host without one. */
  traceSendStats?: () => TraceSendStats | undefined
  /**
   * Builds the exact wire bytes for several sessions at once, as `--explain-payload` prints them
   * (AL 03) — batched (see `buildPayloadPreviewTexts`) so the panel's example-payload button
   * shares one `PayloadBuildCache` across every session shown instead of re-running the same
   * `git` subprocesses from scratch per click. Absent in builds before AL 03 — the panel then
   * shows an honest "not yet available" note rather than a fake sample.
   */
  buildPayloadPreview?: (sessions: SessionSummaryCard[]) => string[] | Promise<string[]>
  /** Called when the user clicks "Open Team View". */
  onOpenOrgView?: () => void
  /** Diagnostic logging — output channel (VS Code) or stdout (standalone). Optional; failures
   *  this would report are all retried automatically, so it's not load-bearing, just visibility. */
  log?: (m: string) => void
}

/** How many recent sessions `orgExplainPayload` builds an example payload for — see the cap's
 *  reasoning at that case's own comment. */
const MAX_PAYLOAD_PREVIEW_SESSIONS = 5

/**
 * Queues every local session not yet confirmed delivered — right after a link (so a newly linked
 * org, or one re-linked after switching from another, starts from this machine's actual history
 * instead of from zero), and again on demand via the panel's "Check for unsent traces" button, as a
 * standing way to answer "did everything actually make it?" without waiting for a coincidental
 * restart.
 *
 * Cheap to call anytime `allLocalSessions` is available, including automatically: `maybeEnqueueSession`
 * checks the delivery ledger before doing any real work, so a session already confirmed sent costs
 * one file read here, not a rebuilt payload or a re-transmission. Runs after credentials are
 * already saved when called from a link, so every payload is built (and every hash salted) with
 * whichever org is *currently* linked.
 */
// How many sessions' `maybeEnqueueSession` calls run at once. Matches the shape of
// `gitOutcome.ts`'s `MAX_CONCURRENT_SESSION_CLASSIFICATIONS` — bounded so total concurrent `git`
// subprocess load stays predictable, not unbounded fan-out over a large backlog.
const RECONCILE_CONCURRENCY = 6

/** Runs `worker` over `sessions` with up to `RECONCILE_CONCURRENCY` in flight at once, rather than
 *  one at a time. Progress (when `onProgress` is given) is reported after each *completion*, in
 *  whichever order they land — no longer tied to array order the way the old serial loop was. */
async function runReconcilePool(
  sessions: SessionSummaryCard[],
  worker: (session: SessionSummaryCard) => Promise<{ enqueued: boolean }>,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const total = sessions.length
  let nextIndex = 0
  let done = 0
  let queued = 0

  async function runOne(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= total) return
      const res = await worker(sessions[i])
      if (res.enqueued) queued++
      done++
      if (onProgress) {
        onProgress(done, total)
        // Without this, a progress update can sit unsent: when `worker` short-circuits on an
        // already-delivered session, it resolves via microtasks only (no real async I/O), so a
        // burst of already-delivered sessions completing back-to-back never actually returns
        // control to the event loop — and posting to the webview is IPC, which needs that to
        // flush. `setImmediate` forces one real event-loop tick per completion so the webview
        // sees progress as it happens instead of one burst at the end.
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
  }

  const workerCount = Math.min(RECONCILE_CONCURRENCY, total)
  await Promise.all(Array.from({ length: workerCount }, runOne))
  return queued
}

async function reconcileLocalSessions(deps: OrgPanelDeps, reportProgress = false): Promise<number> {
  const sessions = deps.allLocalSessions?.()
  if (!sessions || sessions.length === 0) return 0
  // Scoped to this one reconcile pass — memoizes the per-workspace git work (repo key, branch,
  // outcome classification) that would otherwise be recomputed once per session instead of once
  // per distinct repo a developer's sessions cluster in. See payloadPreview.ts's
  // createPayloadBuildCache and .staged-issues/reconcile-gap-and-latency.md.
  const cache = createPayloadBuildCache()
  const queued = await runReconcilePool(
    sessions,
    (session) => maybeEnqueueSession(session, deps.log, cache),
    // Report progress only for the on-demand "Check for unsent traces" click (`orgReconcile`
    // below); the link-time call is fire-and-forget and nothing is listening for it.
    reportProgress ? (done, total) => deps.post({ type: 'orgReconcileProgress', done, total }) : undefined,
  )
  if (queued > 0) {
    deps.log?.(`[TraceRoost] reconcile: queued ${queued} local session(s) not yet confirmed delivered`)
  }
  // Always nudge the scheduler, not just when new sessions were found — the on-demand button's
  // whole point is "try to get things moving right now," and a backlog stuck retrying on its own
  // backoff schedule (queue.ts's stuckItems) is exactly the case where clicking it should visibly
  // do something, not silently no-op just because nothing *new* needed queuing.
  if (reportProgress) {
    // The on-demand click: force past backoff entirely and wait for it, so the `pushStatus` call
    // right after `orgReconcile` returns reflects what actually just happened, not the pre-drain
    // state. Without `force`, a backlog that failed identically many times (an old server bug the
    // developer just fixed and redeployed) could sit backed off for up to an hour with the panel
    // still reading "degraded" the whole time and no way to confirm the fix short of waiting.
    await checkForwardQueueNow()
  } else {
    // The link-time call: fire-and-forget, backoff-respecting — nothing has had a chance to fail
    // yet, so there's nothing to force past.
    drainForwardQueueSoon()
  }
  return queued
}

function pushStatus(deps: OrgPanelDeps): void {
  const stats = deps.queueStats?.() ?? getQueueStats()
  const sendStats = deps.traceSendStats?.()
  deps.post({ type: 'orgStatus', status: getOrgStatus(stats, sendStats, isForwardQueueDraining()) })
  // Opportunistic, cheap self-heal for an org name that never resolved at link time (see
  // refreshOrgNameIfStale) — a no-op once it has ever succeeded. Re-pushes status only when it
  // actually changed something, so the panel corrects itself without the user doing anything.
  void refreshOrgNameIfStale(deps.log).then((changed) => {
    if (!changed) return
    const freshStats = deps.queueStats?.() ?? getQueueStats()
    deps.post({ type: 'orgStatus', status: getOrgStatus(freshStats, sendStats, isForwardQueueDraining()) })
  })
}

export async function handleOrgMessage(msg: OrgMessage, deps: OrgPanelDeps): Promise<void> {
  switch (msg.type) {
    case 'getOrgStatus':
      pushStatus(deps)
      return

    case 'orgExplainPayload': {
      // Capped, not just "the one most recent session" — showing a handful at once lets the
      // shared PayloadBuildCache in buildPayloadPreviewTexts pay the real `git` cost once per
      // workspace instead of once per click, which is what made this slow (see that function's
      // doc comment). Uncapped would just mean a bigger batch of `git` subprocesses on the first
      // never-cached workspace, not a proportionally worse wait — 5 keeps it visibly instant
      // either way without needing every session on screen at once.
      const sessions = deps.recentSessions().slice(0, MAX_PAYLOAD_PREVIEW_SESSIONS)
      if (sessions.length === 0) {
        deps.post({ type: 'orgPayloadPreview', previews: [{ text: 'No recorded session yet — run an agent session, then check back.', sessionLabel: 'none' }] })
        return
      }
      const labels = sessions.map((s) => `${s.source} · ${new Date(s.startTime).toLocaleString()}`)
      try {
        const texts = deps.buildPayloadPreview
          ? await deps.buildPayloadPreview(sessions)
          : sessions.map(() =>
              'The example-payload preview arrives with the trace builder in the next TraceRoost update.\n' +
              'Until then: nothing is sent, so there is nothing to preview.')
        deps.post({ type: 'orgPayloadPreview', previews: sessions.map((_, i) => ({ text: texts[i], sessionLabel: labels[i] })) })
      } catch (err) {
        // Without this, a thrown error here left the webview's "Building it…" state showing
        // forever — nothing else ever clears it (see App.tsx's `orgPayloadPreview` handler). One
        // failure fails the whole batch (Promise.all inside buildPayloadPreviewTexts) rather than
        // reporting which of several sessions it was — rare enough, and simple enough, not to be
        // worth partial-result plumbing for.
        deps.post({ type: 'orgPayloadPreview', previews: [{ text: `Could not build the payload preview: ${(err as Error).message}`, sessionLabel: `${sessions.length} trace(s)` }] })
      }
      return
    }

    case 'orgLink': {
      try {
        await linkInteractive({
          onUrl: (url) => deps.post({ type: 'orgLinkUrl', url }),
          openUrl: (url) => deps.openExternal(url),
        })
        syncForwardSchedulerToLinkState()
        syncPricingToLinkState()
        void reconcileLocalSessions(deps)
        deps.post({ type: 'orgActionResult', action: 'link', ok: true })
      } catch (err) {
        deps.post({ type: 'orgActionResult', action: 'link', ok: false, error: (err as Error).message })
      }
      pushStatus(deps)
      return
    }

    case 'orgLinkDevice': {
      try {
        await linkViaDevice({
          onPrompt: (info) => deps.post({ type: 'orgDevicePrompt', ...info }),
        })
        syncForwardSchedulerToLinkState()
        syncPricingToLinkState()
        void reconcileLocalSessions(deps)
        deps.post({ type: 'orgActionResult', action: 'link', ok: true })
      } catch (err) {
        deps.post({ type: 'orgActionResult', action: 'link', ok: false, error: (err as Error).message })
      }
      pushStatus(deps)
      return
    }

    case 'orgLeave': {
      const res = await leave()
      syncForwardSchedulerToLinkState()
      syncPricingToLinkState()
      deps.post({ type: 'orgActionResult', action: 'leave', ok: true, serverRevoked: res.serverRevoked })
      pushStatus(deps)
      return
    }

    case 'orgOpenView':
      deps.onOpenOrgView?.()
      return

    case 'orgReconcile': {
      try {
        const queued = await reconcileLocalSessions(deps, /* reportProgress */ true)
        deps.post({ type: 'orgReconcileResult', queued })
      } catch (err) {
        // Without this, a thrown error here (or from the unbounded `allLocalSessions` read) left
        // the "Checking…" button disabled forever — nothing else ever clears `orgReconcileBusy`.
        deps.post({ type: 'orgReconcileResult', queued: 0, error: (err as Error).message })
      }
      pushStatus(deps)
      return
    }

    case 'orgSetEnvironment': {
      // Only meaningful pre-link — a linked machine's endpoint comes from its credential, not
      // this selection (see `resolveOrgEnvironment` in config.ts). Ignore rather than error:
      // the panel shouldn't be showing an enabled picker in this state, but a stale message from
      // a webview that hasn't re-rendered yet shouldn't corrupt anything either.
      const env = msg.environment
      if (!isLinked() && typeof env === 'string' && isOrgEnvironment(env)) {
        saveSelectedEnvironment(env)
      }
      pushStatus(deps)
      return
    }
  }
}
