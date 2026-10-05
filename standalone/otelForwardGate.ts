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
  /** Fingerprint last forwarded, if any. */
  forwarded?: string
}

function fingerprint(card: OtelGateCard): string {
  return `${card.durationMs}|${card.inputTokens}|${card.outputTokens}|${card.totalToolCalls}`
}

export class OtelForwardGate {
  private readonly entries = new Map<string, GateEntry>()

  constructor(private readonly idleMs: number) {}

  /** True when `card` should be forwarded now: idle for `idleMs` in a shape not yet forwarded. */
  shouldForward(card: OtelGateCard, now: number): boolean {
    const content = fingerprint(card)
    const prev = this.entries.get(card.traceId)
    if (!prev || prev.content !== content) {
      this.entries.set(card.traceId, { content, seenAt: now, forwarded: prev?.forwarded })
      return false
    }
    if (now - prev.seenAt < this.idleMs) return false
    if (prev.forwarded === content) return false
    prev.forwarded = content
    return true
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
