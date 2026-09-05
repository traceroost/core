/**
 * Rendering helpers shared by `--explain-payload` (the CLI) and the Team panel's
 * "Show the exact payload" button — so the two never disagree about what a forward looks like.
 */

import { SENT, NEVER_SENT } from '../team/privacy'
import type { RollupPayload } from './schema'

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

/** The full block the panel shows: the promise, then the exact bytes. */
export function renderPayloadPreview(payload: RollupPayload, opts: { linked: boolean }): string {
  const lines: string[] = []
  if (!opts.linked) {
    lines.push('This machine is NOT linked. Nothing is being sent.')
    lines.push('Hashes below use a placeholder org salt — a real team would produce different ones.')
    lines.push('')
  }
  lines.push('Sent:       ' + SENT.join('; '))
  lines.push('Never sent: ' + NEVER_SENT.join('; '))
  lines.push('')
  lines.push(stableStringify(payload))
  return lines.join('\n')
}
