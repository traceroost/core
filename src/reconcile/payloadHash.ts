/**
 * Canonical content hash of a session's built `SessionRollup` (staged feature 10's generalization
 * of the trace-revision mechanism beyond git outcome alone). Used to detect any change to the
 * allowlisted, cloud-forwarded projection -- duration, tokens, tool calls, model mix, outcome,
 * etc. -- so a growing or corrected trace gets re-forwarded without needing a per-field diff.
 *
 * Excludes `revision` (self-referential: changing this hash is what allocates a new one) and
 * deep-sorts object keys and array entries, so field order or a builder's own non-semantic array
 * ordering (see buildSessionRollup.ts's `perModelCalls`/`wireFileHashes`) never looks like a
 * content change on its own -- matching the staged feature's "exclude ... array ordering from
 * change detection."
 */

import * as crypto from 'crypto'
import type { SessionRollup } from '../cloud/forward/schema'

export function hashSessionRollup(rollup: SessionRollup): string {
  const { revision: _revision, ...rest } = rollup
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(rest))).digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map(canonicalize)
    return [...mapped].sort((a, b) => {
      const sa = JSON.stringify(a)
      const sb = JSON.stringify(b)
      return sa < sb ? -1 : sa > sb ? 1 : 0
    })
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key])
    return out
  }
  return value
}
