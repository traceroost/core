/**
 * Per-key debounce with a maximum wait (live reconciliation's contract: "Debounce
 * growing-trace updates for three seconds, with a maximum 30-second enqueue delay under
 * continuous activity"). Used to coalesce a burst of live `onUpdate`/log-scan ticks for the same
 * session into one content-hash check instead of one per tick -- each check rebuilds the payload
 * via real `git` subprocesses (see payloadPreview.ts's `buildPayloadForCard`), so an undebounced
 * per-tick check would spawn several subprocesses per tool call during an active session.
 */
export class KeyedDebouncer {
  private readonly pending = new Map<string, { firstAt: number; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly quietMs: number, private readonly maxWaitMs: number) {}

  /** Schedules `run` for `key`, resetting the quiet timer on every call but never pushing the
   *  actual run more than `maxWaitMs` past the first call in the current burst. */
  schedule(key: string, run: () => void): void {
    const now = Date.now()
    const existing = this.pending.get(key)
    if (existing) clearTimeout(existing.timer)
    const firstAt = existing?.firstAt ?? now
    const remainingToMax = firstAt + this.maxWaitMs - now
    const delay = Math.max(0, Math.min(this.quietMs, remainingToMax))
    const timer = setTimeout(() => {
      this.pending.delete(key)
      run()
    }, delay)
    timer.unref?.()
    this.pending.set(key, { firstAt, timer })
  }

  dispose(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }
}
