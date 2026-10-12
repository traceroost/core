/**
 * When to forward an OTEL-built trace card to TraceRoost Cloud from the standalone server.
 *
 * An OTEL trace is *live* for as long as the agent keeps emitting spans for it, and forwarding
 * every growth step of a still-running turn would rebuild its payload (git subprocesses) on every
 * tick for nothing. So a card is forwarded once its content has sat unchanged for `idleMs` — and,
 * unlike the previous forward-once set (`otelAttempted`), forwarded *again* whenever its content
 * changes after that and settles once more: a turn that keeps growing after its first idle window
 * (a long tool run, a permission prompt) reaches the cloud at its final shape, as it does from the
 * editor host's content-change path (src/sessionForwarder.ts). `forwardOnContentChange` itself
 * still drops a send whose rollup hash didn't change, so a re-forward of identical content costs
 * one payload build, never a network send.
 */

export interface OtelGateCard {
  traceId: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  totalToolCalls: number
}

interface GateEntry {
  /** Content fingerprint last seen, and when it was first seen in this shape. */
  content: string
  seenAt: number
  /** Fingerprint last forwarded, if any — set only once that forward resolved (`settle`). */
  forwarded?: string
  /** Fingerprint of a forward still in flight — not offered again meanwhile. */
  pending?: string
}

function fingerprint(card: OtelGateCard): string {
  return `${card.durationMs}|${card.inputTokens}|${card.outputTokens}|${card.totalToolCalls}`
}

export class OtelForwardGate {
  private readonly entries = new Map<string, GateEntry>()

  constructor(private readonly idleMs: number) {}

  /** True when `card` should be forwarded now: idle for `idleMs` in a shape not yet forwarded
   *  (nor being forwarded). The caller reports how that went with `settle` — only a forward that
   *  resolved marks the shape forwarded; a failed one is offered again on a later tick. */
  shouldForward(card: OtelGateCard, now: number): boolean {
    const content = fingerprint(card)
    const prev = this.entries.get(card.traceId)
    if (!prev || prev.content !== content) {
      this.entries.set(card.traceId, { content, seenAt: now, forwarded: prev?.forwarded, pending: prev?.pending })
      return false
    }
    if (now - prev.seenAt < this.idleMs) return false
    if (prev.forwarded === content || prev.pending === content) return false
    prev.pending = content
    return true
  }

  /** The forward `shouldForward` offered for `card` finished: `ok` marks that shape forwarded;
   *  otherwise it is offered again on a later tick. */
  settle(card: OtelGateCard, ok: boolean): void {
    const entry = this.entries.get(card.traceId)
    if (!entry) return
    const content = fingerprint(card)
    if (entry.pending === content) entry.pending = undefined
    if (ok) entry.forwarded = content
  }

  /** Drops every trace not in `liveTraceIds` — called on the retention tick so a months-long
   *  service doesn't keep an entry per trace it ever saw. */
  prune(liveTraceIds: ReadonlySet<string>): number {
    let removed = 0
    for (const id of this.entries.keys()) {
      if (!liveTraceIds.has(id)) { this.entries.delete(id); removed++ }
    }
    return removed
  }

  get size(): number { return this.entries.size }
}
