/**
 * Test fixture only (spawned as a real, separate OS process by fileLock.concurrency.test.ts) --
 * not part of the extension. Enqueues one session rollup into `~/.traceroost/forward-queue.jsonl`
 * under whatever HOME the parent test points it at, so several instances of this script running
 * at once exercise the exact multi-host race `fileLock.ts` closes: several processes calling
 * `ForwardQueue.enqueue()` on the same shared file at the same time.
 *
 * Usage: `node concurrentEnqueueWorker.js <sessionId>` with `HOME` already set by the caller.
 */
import { ForwardQueue } from '../../../../cloud/forward/queue'

const sessionId = process.argv[2]
if (!sessionId) {
  console.error('usage: concurrentEnqueueWorker.js <sessionId>')
  process.exit(1)
}

new ForwardQueue().enqueue({
  schema_version: '1',
  session: {
    session_id: sessionId,
    agent: 'other',
    started_at: '2026-01-01T00:00:00.000Z',
    duration_ms: 1000,
    data_source: 'log',
  },
})
