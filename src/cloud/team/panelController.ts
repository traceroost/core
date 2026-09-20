/**
 * Transport-agnostic handler for the Team panel's messages (AL 01).
 *
 * Both hosts route `team*` webview messages here: the VS Code `DashboardPanel` and the
 * standalone server. It owns no state — every call reads the credential fresh — so an unlinked
 * install answers `getTeamStatus` without a single network request.
 */

import { getTeamStatus, type QueueStats, type TraceSendStats } from './status'
import { linkInteractive, linkViaDevice, leave, refreshOrgNameIfStale } from './link'
import { getQueueStats } from '../forward/currentQueueStats'
import { syncForwardSchedulerToLinkState, drainForwardQueueSoon } from '../forward/scheduler'
import { syncPricingToLinkState } from './pricingSync'
import { maybeEnqueueSession } from './enqueueSession'
import { createPayloadBuildCache } from './payloadPreview'
import { isTeamEnvironment } from './config'
import { saveSelectedEnvironment } from './environmentSelection'
import { isLinked } from './credentials'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

export interface TeamMessage {
  type: string
  [k: string]: unknown
}

export interface TeamPanelDeps {
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
   * Builds the exact wire bytes for a session, as `--explain-payload` prints them (AL 03).
   * Absent in builds before AL 03 — the panel then shows an honest "not yet available" note
   * rather than a fake sample.
   */
  buildPayloadPreview?: (session: SessionSummaryCard) => string | Promise<string>
  /** Called when the user clicks "Open team view". */
  onOpenTeamView?: () => void
  /** Diagnostic logging — output channel (VS Code) or stdout (standalone). Optional; failures
   *  this would report are all retried automatically, so it's not load-bearing, just visibility. */
  log?: (m: string) => void
}

/**
 * Queues every local session not yet confirmed delivered — right after a link (so a newly linked
 * team, or one re-linked after switching from another, starts from this machine's actual history
 * instead of from zero), and again on demand via the panel's "Check for unsent traces" button, as a
 * standing way to answer "did everything actually make it?" without waiting for a coincidental
 * restart.
 *
 * Cheap to call anytime `allLocalSessions` is available, including automatically: `maybeEnqueueSession`
 * checks the delivery ledger before doing any real work, so a session already confirmed sent costs
 * one file read here, not a rebuilt payload or a re-transmission. Runs after credentials are
 * already saved when called from a link, so every payload is built (and every hash salted) with
 * whichever team is *currently* linked.
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

async function reconcileLocalSessions(deps: TeamPanelDeps, reportProgress = false): Promise<number> {
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
    // Report progress only for the on-demand "Check for unsent traces" click (`teamReconcile`
    // below); the link-time call is fire-and-forget and nothing is listening for it.
    reportProgress ? (done, total) => deps.post({ type: 'teamReconcileProgress', done, total }) : undefined,
  )
  if (queued > 0) {
    deps.log?.(`[TraceRoost] reconcile: queued ${queued} local session(s) not yet confirmed delivered`)
    drainForwardQueueSoon()
  }
  return queued
}

function pushStatus(deps: TeamPanelDeps): void {
  const stats = deps.queueStats?.() ?? getQueueStats()
  const sendStats = deps.traceSendStats?.()
  deps.post({ type: 'teamStatus', status: getTeamStatus(stats, sendStats) })
  // Opportunistic, cheap self-heal for a team name that never resolved at link time (see
  // refreshOrgNameIfStale) — a no-op once it has ever succeeded. Re-pushes status only when it
  // actually changed something, so the panel corrects itself without the user doing anything.
  void refreshOrgNameIfStale(deps.log).then((changed) => {
    if (!changed) return
    const freshStats = deps.queueStats?.() ?? getQueueStats()
    deps.post({ type: 'teamStatus', status: getTeamStatus(freshStats, sendStats) })
  })
}

export async function handleTeamMessage(msg: TeamMessage, deps: TeamPanelDeps): Promise<void> {
  switch (msg.type) {
    case 'getTeamStatus':
      pushStatus(deps)
      return

    case 'teamExplainPayload': {
      const [session] = deps.recentSessions()
      if (!session) {
        deps.post({ type: 'teamPayloadPreview', preview: { text: 'No recorded session yet — run an agent session, then check back.', sessionLabel: 'none' } })
        return
      }
      const label = `${session.source} · ${new Date(session.startTime).toLocaleString()}`
      try {
        const text = deps.buildPayloadPreview
          ? await deps.buildPayloadPreview(session)
          : 'The exact-payload preview arrives with the trace builder in the next TraceRoost update.\n' +
            'Until then: nothing is sent, so there is nothing to preview.'
        deps.post({ type: 'teamPayloadPreview', preview: { text, sessionLabel: label } })
      } catch (err) {
        // Without this, a thrown error here left the webview's "Building it…" state showing
        // forever — nothing else ever clears it (see App.tsx's `teamPayloadPreview` handler).
        deps.post({ type: 'teamPayloadPreview', preview: { text: `Could not build the payload preview: ${(err as Error).message}`, sessionLabel: label } })
      }
      return
    }

    case 'teamLink': {
      try {
        await linkInteractive({
          onUrl: (url) => deps.post({ type: 'teamLinkUrl', url }),
          openUrl: (url) => deps.openExternal(url),
        })
        syncForwardSchedulerToLinkState()
        syncPricingToLinkState()
        void reconcileLocalSessions(deps)
        deps.post({ type: 'teamActionResult', action: 'link', ok: true })
      } catch (err) {
        deps.post({ type: 'teamActionResult', action: 'link', ok: false, error: (err as Error).message })
      }
      pushStatus(deps)
      return
    }

    case 'teamLinkDevice': {
      try {
        await linkViaDevice({
          onPrompt: (info) => deps.post({ type: 'teamDevicePrompt', ...info }),
        })
        syncForwardSchedulerToLinkState()
        syncPricingToLinkState()
        void reconcileLocalSessions(deps)
        deps.post({ type: 'teamActionResult', action: 'link', ok: true })
      } catch (err) {
        deps.post({ type: 'teamActionResult', action: 'link', ok: false, error: (err as Error).message })
      }
      pushStatus(deps)
      return
    }

    case 'teamLeave': {
      const res = await leave()
      syncForwardSchedulerToLinkState()
      syncPricingToLinkState()
      deps.post({ type: 'teamActionResult', action: 'leave', ok: true, serverRevoked: res.serverRevoked })
      pushStatus(deps)
      return
    }

    case 'teamOpenView':
      deps.onOpenTeamView?.()
      return

    case 'teamReconcile': {
      try {
        const queued = await reconcileLocalSessions(deps, /* reportProgress */ true)
        deps.post({ type: 'teamReconcileResult', queued })
      } catch (err) {
        // Without this, a thrown error here (or from the unbounded `allLocalSessions` read) left
        // the "Checking…" button disabled forever — nothing else ever clears `teamReconcileBusy`.
        deps.post({ type: 'teamReconcileResult', queued: 0, error: (err as Error).message })
      }
      pushStatus(deps)
      return
    }

    case 'teamSetEnvironment': {
      // Only meaningful pre-link — a linked machine's endpoint comes from its credential, not
      // this selection (see `resolveTeamEnvironment` in config.ts). Ignore rather than error:
      // the panel shouldn't be showing an enabled picker in this state, but a stale message from
      // a webview that hasn't re-rendered yet shouldn't corrupt anything either.
      const env = msg.environment
      if (!isLinked() && typeof env === 'string' && isTeamEnvironment(env)) {
        saveSelectedEnvironment(env)
      }
      pushStatus(deps)
      return
    }
  }
}
