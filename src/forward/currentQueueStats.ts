import { ForwardQueue } from './queue'
import { queueStats } from './forwardState'
import type { QueueStats } from '../team/status'

/** The forwarding-queue stats the Team panel, the tab-bar dot and `team status` render.
 *  Reads local files only. */
export function getQueueStats(baseHome?: string): QueueStats {
  return queueStats(new ForwardQueue(baseHome).depth(), baseHome)
}
