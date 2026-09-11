import type { WireAttribution } from './schema'

/** Attribution enum passthrough with a safe default. Kept in its own module so both the commit
 *  and turnover builders can use it without a circular import through `buildCommitRecords`. */
export function toWireAttribution(a: string): WireAttribution {
  return a === 'certain' || a === 'probable' ? a : 'unknown'
}
