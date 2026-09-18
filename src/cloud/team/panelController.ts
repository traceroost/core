/**
 * Transport-agnostic handler for the Team panel's messages (AL 01).
 *
 * Both hosts route `team*` webview messages here: the VS Code `DashboardPanel` and the
 * standalone server. It owns no state — every call reads the credential fresh — so an unlinked
 * install answers `getTeamStatus` without a single network request.
 */

import { getTeamStatus, type QueueStats } from './status'
import { linkInteractive, linkViaDevice, leave, refreshOrgNameIfStale } from './link'
import { getQueueStats } from '../forward/currentQueueStats'
import { syncForwardSchedulerToLinkState, drainForwardQueueSoon } from '../forward/scheduler'
import { maybeEnqueueSession } from './enqueueSession'
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
   *  successful link, and on demand via "Reconcile now", to queue anything not yet confirmed
   *  delivered (see `reconcileLocalSessions` below). Absent hosts just skip reconciliation;
   *  nothing else in the panel depends on it. */
  allLocalSessions?: () => SessionSummaryCard[]
  /** Live forwarding-queue stats (AL 04). Absent until that lands. */
  queueStats?: () => QueueStats | undefined
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
 * instead of from zero), and again on demand via the panel's "Reconcile now" button, as a
 * standing way to answer "did everything actually make it?" without waiting for a coincidental
 * restart.
 *
 * Cheap to call anytime `allLocalSessions` is available, including automatically: `maybeEnqueueSession`
 * checks the delivery ledger before doing any real work, so a session already confirmed sent costs
 * one file read here, not a rebuilt payload or a re-transmission. Runs after credentials are
 * already saved when called from a link, so every payload is built (and every hash salted) with
 * whichever team is *currently* linked.
 */
async function reconcileLocalSessions(deps: TeamPanelDeps, reportProgress = false): Promise<number> {
  const sessions = deps.allLocalSessions?.()
  if (!sessions || sessions.length === 0) return 0
  let queued = 0
  const total = sessions.length
  for (let i = 0; i < sessions.length; i++) {
    const res = await maybeEnqueueSession(sessions[i], deps.log)
    if (res.enqueued) queued++
    // An install with a lot of local history can take a real, visible amount of time here — each
    // session is a delivery-ledger read plus, for anything not yet sent, a payload build. Report
    // progress only for the on-demand "Reconcile now" click (`teamReconcile` below); the
    // link-time call is fire-and-forget and nothing is listening for it.
    if (reportProgress) {
      deps.post({ type: 'teamReconcileProgress', done: i + 1, total })
      // Without this, the progress message above can sit unsent: when `maybeEnqueueSession`
      // short-circuits on an already-delivered session, it resolves via microtasks only (no real
      // async I/O), so a tight `for await` loop over a long history never actually returns
      // control to the event loop — and posting to the webview is IPC, which needs that to flush.
      // The result was every "Checking… (n/total)" update arriving in one burst right at the end,
      // indistinguishable from a hang. `setImmediate` forces one real event-loop tick per session
      // so the webview sees progress as it happens.
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  if (queued > 0) {
    deps.log?.(`[TraceRoost] reconcile: queued ${queued} local session(s) not yet confirmed delivered`)
    drainForwardQueueSoon()
  }
  return queued
}

function pushStatus(deps: TeamPanelDeps): void {
  const stats = deps.queueStats?.() ?? getQueueStats()
  deps.post({ type: 'teamStatus', status: getTeamStatus(stats) })
  // Opportunistic, cheap self-heal for a team name that never resolved at link time (see
  // refreshOrgNameIfStale) — a no-op once it has ever succeeded. Re-pushes status only when it
  // actually changed something, so the panel corrects itself without the user doing anything.
  void refreshOrgNameIfStale(deps.log).then((changed) => {
    if (!changed) return
    const freshStats = deps.queueStats?.() ?? getQueueStats()
    deps.post({ type: 'teamStatus', status: getTeamStatus(freshStats) })
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
