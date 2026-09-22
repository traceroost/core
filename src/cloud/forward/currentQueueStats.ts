import { ForwardQueue } from './queue'
import { queueStats } from './forwardState'
import type { QueueStats } from '../org/status'

/** The forwarding-queue stats the Org panel, the tab-bar dot and `org status` render.
 *  Reads local files only. */
export function getQueueStats(baseHome?: string): QueueStats {
  return queueStats(new ForwardQueue(baseHome).depth(), baseHome)
}
