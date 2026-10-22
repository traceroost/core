/**
 * Owned or attached — and the states that are neither.
 *
 * The shell must never be vague about which collector is writing the data dir, because the two
 * modes have opposite obligations. In owned mode Quit stops and flushes the collector, and the
 * tray offers Start/Stop/Restart. In attached mode Quit exits only the window and tray, those
 * controls are unavailable, and nothing the shell does may stop the other process — someone
 * installed that service on purpose.
 *
 * The decision follows from the handshake's verdict and one fact that is easy to lose sight of: a
 * *live* lock holder means the shell cannot own a collector even if it wanted to, because
 * `dataDirLock.ts` would refuse the second writer. So "attach" and "start my own" are not two
 * options to choose between — which one is available is a property of the data dir, and the only
 * genuine user choice is whether to take ownership *from* an existing collector, which is an
 * explicit handoff and not something this function does.
 */

import type { CollectorState } from './collector'
import { type AttachVerdict, type CollectorIdentity, meansDataDirIsFree } from './handshake'

export type ShellMode =
  /** Nothing holds the data dir: start and supervise our own collector. */
  | { mode: 'own' }
  /** A validated collector holds it: use its dashboard, touch nothing. */
  | { mode: 'attach'; identity: CollectorIdentity }
  /** A collector holds it and looks right, but its version is unknown. Attaching needs an
   *  explicit user act, so the tray asks instead of deciding. */
  | { mode: 'confirm-attach'; identity: CollectorIdentity; question: string }
  /** Transient: a collector is mid-startup. Re-run the handshake shortly. */
  | { mode: 'wait'; detail: string; retryInMs: number }
  /** A collector holds the dir but cannot be attached to or taken over. The shell runs with no
   *  collection and says exactly why — the one thing it must not do is start a second writer. */
  | { mode: 'blocked'; detail: string; identity?: Partial<CollectorIdentity> }

/** How long to wait before re-running the handshake on a transient verdict. */
export const WAIT_RETRY_MS = 1_500

export function resolveMode(verdict: AttachVerdict): ShellMode {
  if (verdict.ok) {
    return verdict.needsConfirmation
      ? {
          mode: 'confirm-attach',
          identity: verdict.identity,
          question:
            `A TraceRoost collector is already running on this data directory ` +
            `(${verdict.identity.service ? 'the background service' : `pid ${verdict.identity.pid}`}, ` +
            `started ${verdict.identity.startedAt}), but it does not report its version — it predates ` +
            `the field. Use it?`,
        }
      : { mode: 'attach', identity: verdict.identity }
  }
  if (meansDataDirIsFree(verdict.reason)) {
    return { mode: 'own' }
  }
  if (verdict.reason === 'starting' || verdict.reason === 'ports-unbound') {
    return { mode: 'wait', detail: verdict.detail, retryInMs: WAIT_RETRY_MS }
  }
  return { mode: 'blocked', detail: verdict.detail, identity: verdict.identity }
}

/** What the tray's status line says, per mode. Collection state in owned mode comes from the
 *  supervisor instead (see trayMenu.ts) — this covers the modes where there is nothing of ours
 *  running to report on. */
export function describeMode(resolved: ShellMode): string {
  switch (resolved.mode) {
    case 'own': return 'Starting collection…'
    case 'attach': return resolved.identity.service
      ? 'Attached to the background service'
      : `Attached to the collector running as pid ${resolved.identity.pid}`
    case 'confirm-attach': return 'A collector is running — confirm to use it'
    case 'wait': return 'Waiting for a collector that is starting up…'
    case 'blocked': return 'Not collecting — needs attention'
  }
}

/**
 * True when the verdict's lock holder is the collector this shell already owns and runs. A
 * re-check (sleep/wake) of an owned collector finds its own child's lock — alive, ports bound — and
 * `resolveMode` would read that as "attach"; the shell still owns it, so it must stay in owned mode
 * (Start/Stop/Restart, and a Quit that says it stops collection, which it does).
 */
export function isOwnCollector(verdict: AttachVerdict, owned: CollectorState): boolean {
  return verdict.ok && owned.status === 'running' && verdict.identity.pid === owned.pid
}
