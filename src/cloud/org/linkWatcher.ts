/**
 * Notices a link (or leave) made outside this process and catches up.
 *
 * The Org panel already reconciles right after it links (panelController.ts). But a machine can be
 * linked without this process doing it — `traceroost org link` from a terminal, or another server
 * or VS Code window sharing `~/.traceroost` — and then nothing here noticed: the forwarding
 * scheduler never started (it only starts while linked) and the existing history was never queued,
 * so the cloud showed only traces created after the link until a coincidental restart re-read
 * everything.
 *
 * This watches the credential file and, when the linked install changes, does what the panel's own
 * link does: start or stop the scheduler and pricing sync, then queue every local trace not yet
 * delivered. Local only: it stats one file and touches no network while unlinked.
 */

import * as fs from 'fs'
import { credentialsPath, loadCredentials } from './credentials'
import { syncForwardSchedulerToLinkState, drainForwardQueueSoon } from '../forward/scheduler'
import { syncPricingToLinkState } from './pricingSync'
import { queueUnsentSessions } from './reconcileUnsent'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

export interface LinkWatcherOptions {
  /** Every trace this host holds, regardless of age. */
  allLocalSessions: () => SessionSummaryCard[]
  /** Only one process per data dir should queue the history (each VS Code window runs the
   *  extension; the standalone has its data-dir lock). Default: always. */
  isWriter?: () => boolean
  /** False while the host is still loading its store. A link seen then is retried on the next
   *  check rather than reconciled against a half-loaded list. Default: always ready. */
  isReady?: () => boolean
  log?: (m: string) => void
  /** Called whenever the link state changes, so the host can refresh its Org panel (a link made
   *  in a terminal should show as linked without reopening it). */
  onLinkStateChange?: () => void
  /** How often the credential file is stat'ed. */
  intervalMs?: number
}

export interface LinkWatcher {
  /** Re-reads the credential now (tests, and hosts that just changed it). */
  checkNow(): Promise<void>
  dispose(): void
}

/** One link: a re-link (even to the same org) writes a new `linkedAt`. A token refresh rewrites the
 *  file but keeps `linkedAt`, so it isn't mistaken for a new link. */
function currentLinkKey(): string | null {
  const creds = loadCredentials()
  return creds ? `${creds.orgId}|${creds.linkedAt ?? ''}` : null
}

let activeWatcher: { markSeen(): void } | undefined

/** The panel calls this right after its own link, since it reconciles itself: the watcher then
 *  treats the new credential as already handled instead of queuing the history a second time. */
export function markLinkStateSeen(): void {
  activeWatcher?.markSeen()
}

export function startLinkWatcher(opts: LinkWatcherOptions): LinkWatcher {
  const intervalMs = opts.intervalMs ?? 5_000
  const file = credentialsPath()
  // Whatever is linked at startup is the host's startup pass's job (it queues its history as it
  // loads), so only a *change* from here on counts.
  let seenKey = currentLinkKey()
  let running = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const check = async (): Promise<void> => {
    if (running) return
    const key = currentLinkKey()
    if (key === seenKey) return
    running = true
    try {
      syncForwardSchedulerToLinkState()
      syncPricingToLinkState()
      opts.onLinkStateChange?.()
      if (key === null) { seenKey = null; return }
      if (opts.isWriter && !opts.isWriter()) { seenKey = key; return }
      // Not marked seen, and retried on a timer: watchFile only fires again if the file changes.
      if (opts.isReady && !opts.isReady()) {
        retryTimer = setTimeout(() => { void check() }, intervalMs)
        retryTimer.unref?.()
        return
      }
      seenKey = key
      opts.log?.('[TraceRoost] This machine was linked outside this process — queuing traces not yet sent')
      await queueUnsentSessions(opts.allLocalSessions(), opts.log)
      drainForwardQueueSoon()
    } catch (err) {
      opts.log?.(`[TraceRoost] Could not catch up after a link: ${(err as Error).message}`)
    } finally {
      running = false
    }
  }

  // watchFile polls with stat, so it also works while the file doesn't exist yet (unlinked) and
  // across the atomic rename credentials are saved with.
  const listener = () => { void check() }
  fs.watchFile(file, { interval: intervalMs, persistent: false }, listener)

  const watcher = {
    markSeen() { seenKey = currentLinkKey() },
  }
  activeWatcher = watcher
  return {
    checkNow: check,
    dispose() {
      fs.unwatchFile(file, listener)
      if (retryTimer) clearTimeout(retryTimer)
      if (activeWatcher === watcher) activeWatcher = undefined
    },
  }
}
