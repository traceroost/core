/**
 * Restart backoff for the owned collector.
 *
 * The requirement this exists to satisfy: "Restart uses bounded backoff and presents persistent
 * failure rather than looping forever." A supervisor that restarts a crashing child immediately
 * and indefinitely is worse than no supervisor at all — it burns CPU, fills the log with the same
 * stack a thousand times, and hides the failure from the one person who could fix it. So the delay
 * grows, and after a fixed number of consecutive failures the supervisor stops and says so.
 *
 * Kept separate from collector.ts, and pure, so the schedule is a table that can be asserted
 * against rather than a set of timers that have to be waited out.
 */

/** Delay before the nth consecutive restart (n = 1 for the first retry). Doubles from 1s to a 30s
 *  ceiling: fast enough that a one-off port collision clears without the user noticing, slow
 *  enough that a genuinely broken collector is not respawned hundreds of times while they are away. */
export const BASE_DELAY_MS = 1_000
export const MAX_DELAY_MS = 30_000

/** Consecutive failures after which the supervisor gives up and reports 'failed'. A manual Start
 *  or Restart from the tray resets the count — the user asking again is the signal that something
 *  changed. */
export const MAX_CONSECUTIVE_FAILURES = 5

export function restartDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures < 1) return 0
  return Math.min(BASE_DELAY_MS * 2 ** (consecutiveFailures - 1), MAX_DELAY_MS)
}

export function shouldKeepRestarting(consecutiveFailures: number): boolean {
  return consecutiveFailures < MAX_CONSECUTIVE_FAILURES
}

/**
 * How long a child must stay up before its restart counter resets.
 *
 * Without this, a collector that starts, serves for an hour and then crashes would be treated as
 * the fifth failure of a crash loop that began yesterday. Anything that ran this long was a
 * working collector, and its exit is a fresh problem, not a continuing one.
 */
export const HEALTHY_UPTIME_MS = 60_000

export function countsAsCrashLoop(uptimeMs: number): boolean {
  return uptimeMs < HEALTHY_UPTIME_MS
}
