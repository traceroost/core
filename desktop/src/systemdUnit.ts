/**
 * The `traceroost service install` systemd **user** unit, as seen from the desktop app.
 *
 * The unit (`~/.config/systemd/user/traceroost.service`, written by standalone/service/linux.ts)
 * is a supported way to run the collector, and the app must never replace or disable it. What the
 * app does need to know about it is narrow: whether it is going to start a collector, so the app
 * waits for that collector and attaches to it instead of racing it for the data dir.
 *
 * The race this prevents is a login. The systemd user manager starts enabled units as the session
 * comes up and the desktop starts autostart entries at about the same time, so with both enabled
 * the app can find the data dir still free, take it, and leave the service to fail on the lock
 * (and be restarted by `Restart=on-failure`, and fail again). Neither is a second *writer* — the
 * lock sees to that — but it is the wrong owner: the user installed the service to collect, and
 * the app is only meant to be a window onto it.
 *
 * So, when the handshake says the data dir is free:
 *
 *   unit enabled, and activating/active      → wait for it; the handshake then attaches
 *   unit enabled, inactive, app started at login → wait a while for systemd to get to it
 *   unit enabled, inactive, started by hand  → own: the user stopped the service (the documented
 *                                              handoff), so the dir is the app's to take
 *   unit failed                              → own, and say why in the log
 *   no unit, or systemd unavailable          → own
 *
 * The app reads unit state with `systemctl --user show`, which only reads.
 */

import { execFile } from 'child_process'

export const UNIT_NAME = 'traceroost.service'

/** How long, after a login launch, the app waits for an enabled-but-not-yet-started unit before
 *  deciding it is not coming. Generous: on a slow login the user manager can be busy for a while. */
export const LOGIN_GRACE_MS = 60_000

export interface UnitState {
  /** `LoadState`: `loaded`, `not-found`, `masked`, … */
  load: string
  /** `UnitFileState`: `enabled`, `disabled`, `static`, … (empty when not found). */
  unitFile: string
  /** `ActiveState`: `active`, `activating`, `inactive`, `failed`, `deactivating`, … */
  active: string
}

/** Parses `systemctl --user show <unit> --property=LoadState,UnitFileState,ActiveState`. */
export function parseShowOutput(stdout: string): UnitState | undefined {
  const fields = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const load = fields.get('LoadState')
  const active = fields.get('ActiveState')
  if (load === undefined || active === undefined) return undefined
  return { load, unitFile: fields.get('UnitFileState') ?? '', active }
}

export function isEnabled(unit: UnitState): boolean {
  // `enabled-runtime` is `systemctl --runtime enable`; it starts the unit this boot just the same.
  return unit.load === 'loaded' && (unit.unitFile === 'enabled' || unit.unitFile === 'enabled-runtime')
}

export type FreeDirDecision =
  | { action: 'own'; reason: string }
  | { action: 'wait'; reason: string }

/**
 * What to do when the handshake finds the data dir free. `sinceStartMs` is how long the app has
 * been running; it bounds the login grace period.
 */
export function decideWhenDirIsFree(unit: UnitState | undefined, opts: {
  launchedAtLogin: boolean
  sinceStartMs: number
}): FreeDirDecision {
  if (!unit || unit.load !== 'loaded') return { action: 'own', reason: 'no background service is installed' }
  if (unit.active === 'activating' || unit.active === 'reloading') {
    return { action: 'wait', reason: 'the background service is starting' }
  }
  if (unit.active === 'active') {
    // Active but the lock is free: between the process starting and it taking the lock, or a
    // service configured with a different data dir. The handshake's own wait/blocked verdicts
    // cover the second case once a lock appears; until then, waiting is the safe answer, and it
    // is bounded the same way as the login grace so a misconfigured unit cannot wedge the app.
    return opts.sinceStartMs < LOGIN_GRACE_MS
      ? { action: 'wait', reason: 'the background service is running but has not claimed the data directory yet' }
      : { action: 'own', reason: `the background service is running but never claimed this data directory (is it configured with a different one?)` }
  }
  if (unit.active === 'failed') {
    return { action: 'own', reason: 'the background service is installed but failed — see `systemctl --user status traceroost`' }
  }
  if (!isEnabled(unit)) return { action: 'own', reason: 'the background service is installed but not enabled' }
  if (opts.launchedAtLogin && opts.sinceStartMs < LOGIN_GRACE_MS) {
    return { action: 'wait', reason: 'opened at login — giving the background service time to start' }
  }
  return {
    action: 'own',
    reason: opts.launchedAtLogin
      ? 'the background service is enabled but did not start within a minute of login'
      : 'the background service is enabled but stopped — taking over the data directory',
  }
}

/** Reads the unit's state. Resolves undefined on any failure: no systemd, no user manager (a
 *  container, WSL without systemd), or no `systemctl` on PATH. */
export function readUnitState(timeoutMs = 3_000): Promise<UnitState | undefined> {
  return new Promise(resolve => {
    execFile('systemctl', ['--user', 'show', UNIT_NAME, '--property=LoadState,UnitFileState,ActiveState'],
      { timeout: timeoutMs },
      (err, stdout) => resolve(err ? undefined : parseShowOutput(String(stdout))))
  })
}
