/**
 * Batches reconciliation results into cloud forwards — the standalone counterpart of the
 * `pendingRevisions` + flush timer in src/extension.ts.
 *
 * Reconciliation reports one changed session at a time — thousands of them from the startup pass
 * over a long history, where every session's first check counts as a change. Forwarding each as it
 * arrived meant one full session listing (`buildSessionSummary().sessions.find`) and one enqueue
 * (payload build, git subprocesses) per result: O(n²) over the history. Results are now collected
 * for `batchMs`, looked up against one listing per burst, and skipped outright when no org is
 * linked. The highest revision reported for a session within a burst wins.
 */

export interface RevisionForwardBatcherDeps<Card extends { sessionId: string }> {
  /** One listing per burst. */
  listCards(): Card[]
  /** Forward `card` under `revision` (cloud.enqueueSession); best-effort. */
  enqueue(card: Card, revision: number): void
  /** Nothing is collected while unlinked (the enqueue would be a no-op anyway). */
  isLinked(): boolean
  batchMs: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void
}

export interface RevisionForwardBatcher {
  /** The reconciliation subscriber. */
  onResult(r: { sessionId: string; changed: boolean; revision: number | null }): void
  /** Forwards what's pending now (tests; dispose). */
  flush(): void
  dispose(): void
  readonly pendingCount: number
}

export function createRevisionForwardBatcher<Card extends { sessionId: string }>(deps: RevisionForwardBatcherDeps<Card>): RevisionForwardBatcher {
  const pending = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? (t => clearTimeout(t))

  const flush = () => {
    timer = undefined
    if (pending.size === 0) return
    const batch = [...pending]
    pending.clear()
    const cards = new Map<string, Card>()
    for (const c of deps.listCards()) if (!cards.has(c.sessionId)) cards.set(c.sessionId, c)
    for (const [sessionId, revision] of batch) {
      const card = cards.get(sessionId)
      if (card) deps.enqueue(card, revision)
    }
  }

  return {
    onResult(r) {
      if (!r.changed || r.revision === null || !deps.isLinked()) return
      pending.set(r.sessionId, Math.max(r.revision, pending.get(r.sessionId) ?? 0))
      timer ??= setTimer(flush, deps.batchMs)
    },
    flush() {
      if (timer) clearTimer(timer)
      flush()
    },
    dispose() {
      if (timer) clearTimer(timer)
      timer = undefined
      pending.clear()
    },
    get pendingCount() { return pending.size },
  }
}
