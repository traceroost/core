/**
 * The "store is complete" gate a host's trace manifest waits on (TraceManifestSource.isReady):
 * true only once a historical log pass has *completed* for the store as it is now. A pass that
 * failed (the log directories couldn't be listed, the write-back failed) leaves the gate shut and
 * is retried with backoff — a manifest built from a half-loaded store would retire every trace not
 * read yet. "Clear all data" shuts the gate (`invalidate`) and a pass that started before it never
 * opens it. Shared by the extension host and the standalone server. Local-only module (MIT).
 */

export type HistoryPassOutcome = 'done' | 'busy'

export interface HistoryReadinessOptions {
  /** Runs one historical pass. Resolves 'busy' when another is in flight (it is tried again
   *  shortly); rejects when it could not complete. */
  run: () => Promise<HistoryPassOutcome>
  log?: (msg: string) => void
  retryBaseMs?: number
  retryMaxMs?: number
  /** Retry after a 'busy' pass. */
  busyRetryMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class HistoryReadiness {
  private ready = false
  private generation = 0
  private retryDelayMs: number
  private timer: unknown = null
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly opts: HistoryReadinessOptions) {
    this.retryDelayMs = opts.retryBaseMs ?? 30_000
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return t
    })
    this.clearTimer = opts.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  isReady(): boolean {
    return this.ready
  }

  /** Mark ready without a pass (a host with nothing to read). */
  markReady(): void {
    this.ready = true
  }

  /** The store was emptied ("clear all data"): not ready until the next completed pass, and a
   *  pass already in flight doesn't count. */
  invalidate(): void {
    this.ready = false
    this.generation++
  }

  /** Runs a pass; opens the gate when it completes for the current store, or schedules a retry. */
  async load(): Promise<void> {
    this.cancelRetry()
    const generation = this.generation
    let outcome: HistoryPassOutcome
    try {
      outcome = await this.opts.run()
    } catch (e) {
      this.opts.log?.(`[TraceRoost] Reading local trace logs failed (${e instanceof Error ? e.message : String(e)}) — retrying in ${Math.round(this.retryDelayMs / 1000)} s.`)
      this.schedule(this.retryDelayMs)
      this.retryDelayMs = Math.min(this.opts.retryMaxMs ?? 10 * 60_000, this.retryDelayMs * 2)
      return
    }
    if (outcome === 'busy') {
      this.schedule(this.opts.busyRetryMs ?? 1_000)
      return
    }
    this.retryDelayMs = this.opts.retryBaseMs ?? 30_000
    if (generation === this.generation) this.ready = true
  }

  dispose(): void {
    this.cancelRetry()
  }

  private schedule(ms: number): void {
    this.cancelRetry()
    this.timer = this.setTimer(() => { this.timer = null; void this.load() }, ms)
  }

  private cancelRetry(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }
}
