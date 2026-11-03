/**
 * The structural fingerprint of a record: its key names and value types, never its values —
 * `{"type":"string","payload":{"tokens":"number"}}`. What "Report this" puts in an issue body and
 * what the CI fingerprint diff compares between captures.
 *
 * Only the record's top level and the paths its adapter's `known.ts` declares structural are
 * descended into; below any other key an object is `"object"`, so a free-form subtree (a tool's
 * input, a message's text blocks) never contributes its keys. A key that looks like a path, URL or
 * e-mail address is written `"<key>"`.
 */

import type { KnownRecords } from './types'

export type Fingerprint = string | { [key: string]: Fingerprint } | Fingerprint[]

const KEY_LOOKS_PRIVATE = /[\\/@:]|^\.|^~|\s/

export function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

export function fingerprint(record: unknown, known: Pick<KnownRecords, 'structural'>): Fingerprint {
  const structural = new Set(known.structural)
  const walk = (v: unknown, at: string, top: boolean): Fingerprint => {
    if (v === null || typeof v !== 'object') return typeOf(v)
    if (!top && !structural.has(at)) return Array.isArray(v) ? 'array' : 'object'
    if (Array.isArray(v)) return 'array'
    const out: Record<string, Fingerprint> = {}
    for (const key of Object.keys(v).sort()) {
      const safe = KEY_LOOKS_PRIVATE.test(key) || key.length > 64 ? '<key>' : key
      const child = at ? `${at}.${key}` : key
      out[safe] = walk((v as Record<string, unknown>)[key], child, false)
    }
    return out
  }
  return walk(record, '', true)
}

/** The difference between two fingerprints as readable lines (`+ payload.info.reasoning: number`,
 *  `- payload.message`, `~ timestamp: string → number`), empty when they match. */
export function diffFingerprints(before: Fingerprint, after: Fingerprint, at = ''): string[] {
  const label = at || '(record)'
  const isObj = (f: Fingerprint): f is Record<string, Fingerprint> => typeof f === 'object' && !Array.isArray(f)
  if (isObj(before) && isObj(after)) {
    const out: string[] = []
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const path = at ? `${at}.${key}` : key
      if (!(key in after)) out.push(`- ${path}`)
      else if (!(key in before)) out.push(`+ ${path}: ${describe(after[key])}`)
      else out.push(...diffFingerprints(before[key], after[key], path))
    }
    return out
  }
  return describe(before) === describe(after) ? [] : [`~ ${label}: ${describe(before)} → ${describe(after)}`]
}

function describe(f: Fingerprint): string {
  return typeof f === 'string' ? f : 'object'
}
