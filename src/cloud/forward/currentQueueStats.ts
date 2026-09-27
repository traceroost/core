import { ForwardQueue, STUCK_ATTEMPTS_THRESHOLD } from './queue'
import { queueStats } from './forwardState'
import type { QueueStats } from '../org/status'

/** The forwarding-queue stats the Org panel, the tab-bar dot and `org status` render.
 *  Reads local files only. */
export function getQueueStats(baseHome?: string): QueueStats {
  const items = new ForwardQueue(baseHome).list()
  const stuck = items.filter(it => it.attempts >= STUCK_ATTEMPTS_THRESHOLD)
  return queueStats(items.length, baseHome, {
    stuckCount: stuck.length,
    stuckError: stuck.length > 0 ? stuck[stuck.length - 1].lastError : null,
  })
}
