/**
 * Small persisted record of how forwarding is going (AL 04) — read by `org status`, the Org
 * panel's state dot, and `getOrgStatus()`. Kept separate from the queue file so a queue
 * rewrite and a status update never contend.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { QueueStats } from '../org/status'
import { withFileLock } from './fileLock'

/** Something the developer has to act on, shown until it is resolved — persisted, so a host with
 *  no toast (the standalone server) can show it in its dashboard, and so it survives a restart.
 *  `relink`: the credential was rejected for good and the machine unlinked (cleared by the next
 *  link). `upgrade`: the cloud answered 426 — this TraceRoost version is too old to send (cleared
 *  by a send that succeeds, or once the running version differs from `version`). */
export interface ForwardNotice {
  kind: 'relink' | 'upgrade'
  message: string
  at: string
  /** The client version the notice was raised for (`upgrade`). */
  version?: string
}

export interface PersistedState {
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastError: string | null
  /** Set when a 401 refresh failed or a 429 asked us to wait — cleared on the next success. */
  paused: boolean
  pausedUntil: number | null
  notice: ForwardNotice | null
}

const EMPTY: PersistedState = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  paused: false,
  pausedUntil: null,
  notice: null,
}

export function forwardStatePath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.traceroost', 'forward-state.json')
}

export function readForwardState(baseHome?: string): PersistedState {
  try {
    return { ...EMPTY, ...(JSON.parse(fs.readFileSync(forwardStatePath(baseHome), 'utf-8')) as Partial<PersistedState>) }
  } catch {
    return { ...EMPTY }
  }
}

/** Merges `patch` into the file — under the same cross-process lock the queue and ledgers use
 *  (every host on the machine writes this file), and replaced atomically (tmp + rename), so two
 *  hosts can't lose each other's fields and a reader never sees a torn file. */
export function writeForwardState(patch: Partial<PersistedState>, baseHome?: string): void {
  const file = forwardStatePath(baseHome)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    withFileLock(file, () => {
      const next = { ...readForwardState(baseHome), ...patch }
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, file)
    })
  } catch {
    /* non-fatal — status display only */
  }
}

/** Drops everything — `keepNotice` re-writes only the developer-facing notice (an unlink keeps
 *  saying why until the machine is linked again). */
export function clearForwardState(baseHome?: string, keepNotice?: ForwardNotice): void {
  try {
    fs.rmSync(forwardStatePath(baseHome), { force: true })
  } catch {
    /* already gone */
  }
  if (keepNotice) writeForwardState({ notice: keepNotice }, baseHome)
}

/** The notice to show now, if any (an `upgrade` notice raised for another version is stale). */
export function currentForwardNotice(baseHome?: string, version?: string): ForwardNotice | null {
  const n = readForwardState(baseHome).notice
  if (!n || typeof n !== 'object' || typeof n.message !== 'string') return null
  if (n.kind === 'upgrade' && version && n.version && n.version !== version) return null
  return n
}

export function clearForwardNotice(baseHome?: string): void {
  if (readForwardState(baseHome).notice) writeForwardState({ notice: null }, baseHome)
}

/** Assembles the `QueueStats` the Org panel and CLI render. `stuck`, if given, is folded straight
 *  through — see `currentQueueStats.ts`, the one real caller, for how it's computed. */
export function queueStats(depth: number, baseHome?: string, stuck?: { stuckCount: number; stuckError: string | null }): QueueStats {
  const s = readForwardState(baseHome)
  return {
    depth,
    lastSuccessAt: s.lastSuccessAt,
    lastErrorAt: s.lastErrorAt,
    lastError: s.lastError,
    paused: s.paused && (s.pausedUntil === null || s.pausedUntil > Date.now()),
    stuckCount: stuck?.stuckCount ?? 0,
    stuckError: stuck?.stuckError ?? null,
  }
}
