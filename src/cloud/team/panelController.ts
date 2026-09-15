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
import { syncForwardSchedulerToLinkState } from '../forward/scheduler'
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
      const text = deps.buildPayloadPreview
        ? await deps.buildPayloadPreview(session)
        : 'The exact-payload preview arrives with the rollup builder in the next TraceRoost update.\n' +
          'Until then: nothing is sent, so there is nothing to preview.'
      deps.post({ type: 'teamPayloadPreview', preview: { text, sessionLabel: label } })
      return
    }

    case 'teamLink': {
      try {
        await linkInteractive({
          onUrl: (url) => deps.post({ type: 'teamLinkUrl', url }),
          openUrl: (url) => deps.openExternal(url),
        })
        syncForwardSchedulerToLinkState()
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
