import type { Span } from './types'

/**
 * Default cap on in-memory/persisted spans for the standalone server.
 * Keeps spans.json well under V8's ~512MB max string length so
 * JSON.stringify(spans) never throws RangeError: Invalid string length.
 */
export const DEFAULT_MAX_SPANS = 50_000

// Only prune once the array drifts this far past the cap, so a steady stream
// of ingestion doesn't trigger an O(n) splice on every single span.
const PRUNE_BUFFER = 1_000

/**
 * Drops the oldest spans in place once `spans` exceeds `maxSpans` by more
 * than the prune buffer. Returns the number of spans dropped (0 if none); `onEvicted` gets them
 * (the standalone server moves its trace-manifest horizon past them — src/traceHorizon.ts).
 */
export function pruneSpans(spans: Span[], maxSpans: number = DEFAULT_MAX_SPANS, onEvicted?: (evicted: Span[]) => void): number {
  if (spans.length <= maxSpans + PRUNE_BUFFER) return 0
  const dropped = spans.length - maxSpans
  const evicted = spans.splice(0, dropped)
  onEvicted?.(evicted)
  return dropped
}
