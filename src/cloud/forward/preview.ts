/**
 * `stableStringify` is shared by `--explain-payload` (the CLI) and the Team panel's
 * "Show the exact payload" button — so the two never disagree about what a forward looks like.
 */

/** Deterministic key ordering, so a developer diffing two runs to convince themselves nothing
 *  varies sees a clean diff. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, (v as Record<string, unknown>)[k]]))
      }
      return v
    },
    2,
  )
}
