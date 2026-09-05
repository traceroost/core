/**
 * Small persisted record of how forwarding is going (AL 04) — read by `team status`, the Team
 * panel's state dot, and `getTeamStatus()`. Kept separate from the queue file so a queue
 * rewrite and a status update never contend.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { QueueStats } from '../team/status'

interface PersistedState {
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastError: string | null
  /** Set when a 401 refresh failed or a 429 asked us to wait — cleared on the next success. */
  paused: boolean
  pausedUntil: number | null
}

const EMPTY: PersistedState = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  paused: false,
  pausedUntil: null,
}

export function forwardStatePath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.agentlens', 'forward-state.json')
}

export function readForwardState(baseHome?: string): PersistedState {
  try {
    return { ...EMPTY, ...(JSON.parse(fs.readFileSync(forwardStatePath(baseHome), 'utf-8')) as Partial<PersistedState>) }
  } catch {
    return { ...EMPTY }
  }
}

export function writeForwardState(patch: Partial<PersistedState>, baseHome?: string): void {
  const next = { ...readForwardState(baseHome), ...patch }
  const file = forwardStatePath(baseHome)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  } catch {
    /* non-fatal — status display only */
  }
}

export function clearForwardState(baseHome?: string): void {
  try {
    fs.rmSync(forwardStatePath(baseHome), { force: true })
  } catch {
    /* already gone */
  }
}

/** Assembles the `QueueStats` the Team panel and CLI render. */
export function queueStats(depth: number, baseHome?: string): QueueStats {
  const s = readForwardState(baseHome)
  return {
    depth,
    lastSuccessAt: s.lastSuccessAt,
    lastErrorAt: s.lastErrorAt,
    lastError: s.lastError,
    paused: s.paused && (s.pausedUntil === null || s.pausedUntil > Date.now()),
  }
}
