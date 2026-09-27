// Zero-dependency leaf module (deliberately no imports) — utils.ts and state.ts both need
// formatTraceIdHash, and utils.ts already imports from state.ts, so the function lives here
// to avoid a state.ts <-> utils.ts import cycle.

// Display-only hex hash for a trace's Trace ID. The raw id backing a trace varies wildly in
// shape depending on source and lifecycle stage — a real OTEL span hex, a 'synth-<slice>'
// placeholder for an in-progress Claude trace with no root span yet, a 'codex-<traceId>'
// fallback, or a log-derived UUID/filename for log-only traces — so showing it as-is to the
// user is inconsistent ("sometimes a hash, sometimes 'synth-...'"). This normalizes any of
// those into a uniform 64-bit hex string for display/copy. It is NEVER used for lookups,
// correlation, or DB keys — those all still key off the raw traceId/sessionId untouched.
export function formatTraceIdHash(id: string): string {
  let h1 = 0xdeadbeef ^ id.length
  let h2 = 0x41c6ce57 ^ id.length
  for (let i = 0; i < id.length; i++) {
    const ch = id.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}
