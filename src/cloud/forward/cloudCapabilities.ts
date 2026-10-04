/**
 * What the linked TraceRoost Cloud accepts beyond schema version 1 (stable trace identity, feature
 * 11) — so the order the two sides ship in can't lose data.
 *
 * Cloud validates every rollup against its published schema with `additionalProperties: false`
 * and drops a 400'd record for good, and a cloud that predates the trace manifest 404s its route.
 * So nothing version-2 goes out until this machine has seen the linked cloud's own published
 * schema (`GET /api/ingest/schema`, unauthenticated, the same document the ingest routes enforce)
 * list it: `session.source_rank` for the rank, `$defs/trace_manifest` for the manifest. An older
 * cloud, an unreachable one, or one never asked yet all read as "not supported" — exactly how
 * this client behaved before either existed.
 *
 * Cached per link (endpoint + install) in `~/.traceroost/cloud-capabilities.json` and re-checked
 * daily (every few hours while unsupported, so a cloud deploy is picked up the same day). A
 * re-link mints a new install id, so it re-checks at once. Only the forwarding scheduler of a
 * host that sends manifests probes; everything else just reads the cache.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ingestSchemaUrl } from '../org/config'
import { clientVersion } from '../org/oauthClient'

export interface CloudCapabilities {
  endpoint: string
  installId: string
  checkedAt: number
  /** `session.source_rank` is in the cloud's rollup schema. */
  sourceRank: boolean
  /** `$defs/trace_manifest` is in the cloud's schema (POST /api/ingest/manifest exists). */
  traceManifest: boolean
}

export const RECHECK_SUPPORTED_MS = 24 * 60 * 60_000
export const RECHECK_UNSUPPORTED_MS = 6 * 60 * 60_000
/** After a probe that couldn't reach the cloud at all — the cached answer (if any) stands. */
const PROBE_FAILURE_RETRY_MS = 30 * 60_000

export function capabilitiesPath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.traceroost', 'cloud-capabilities.json')
}

/** The cached answer for this link, or null when there is none (never probed, or a different
 *  endpoint/install — a re-link). */
export function readCapabilities(link: { endpoint: string; installId?: string }, baseHome?: string): CloudCapabilities | null {
  if (!link.installId) return null
  try {
    const c = JSON.parse(fs.readFileSync(capabilitiesPath(baseHome), 'utf-8')) as Partial<CloudCapabilities>
    if (c.endpoint !== link.endpoint || c.installId !== link.installId || typeof c.checkedAt !== 'number') return null
    return { endpoint: c.endpoint, installId: c.installId, checkedAt: c.checkedAt, sourceRank: c.sourceRank === true, traceManifest: c.traceManifest === true }
  } catch {
    return null
  }
}

export function writeCapabilities(caps: CloudCapabilities, baseHome?: string): void {
  const file = capabilitiesPath(baseHome)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(caps, null, 2) + '\n', { mode: 0o600 })
  } catch {
    /* non-fatal — the next run probes again */
  }
}

/** Whether a rollup built or sent now may carry `session.source_rank`. Local disk only. */
export function cloudAcceptsSourceRank(link: { endpoint: string; installId?: string } | null, baseHome?: string): boolean {
  return link ? readCapabilities(link, baseHome)?.sourceRank === true : false
}

/** Reads what a published schema document says this cloud accepts. */
export function capabilitiesFromSchema(schema: unknown): { sourceRank: boolean; traceManifest: boolean } {
  const defs = (schema as { $defs?: Record<string, { properties?: Record<string, unknown> }> } | null)?.$defs
  return {
    sourceRank: defs?.session?.properties?.source_rank !== undefined,
    traceManifest: defs?.trace_manifest !== undefined,
  }
}

// Per process: when the last probe failed to reach the cloud, so an offline machine doesn't
// retry it on every tick.
const lastProbeFailure = new Map<string, number>()

/**
 * The capabilities for this link, probing the cloud when the cache is missing or due. A 404 or a
 * schema without the version-2 parts caches "not supported"; a network failure or other status
 * leaves the cached answer (or "not supported" when there is none) and retries later.
 */
export async function refreshCapabilities(
  link: { endpoint: string; installId?: string },
  deps: { now?: () => number; baseHome?: string; force?: boolean } = {},
): Promise<CloudCapabilities | null> {
  if (!link.installId) return null
  const now = (deps.now ?? Date.now)()
  const cached = readCapabilities(link, deps.baseHome)
  if (cached && !deps.force) {
    const age = now - cached.checkedAt
    if (age >= 0 && age < (cached.sourceRank && cached.traceManifest ? RECHECK_SUPPORTED_MS : RECHECK_UNSUPPORTED_MS)) return cached
  }
  const failureKey = `${link.endpoint} ${link.installId}`
  const failedAt = lastProbeFailure.get(failureKey)
  if (!deps.force && failedAt !== undefined && now - failedAt < PROBE_FAILURE_RETRY_MS) return cached

  let found: { sourceRank: boolean; traceManifest: boolean } | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await fetch(ingestSchemaUrl(link.endpoint), {
        headers: { Accept: 'application/json', 'User-Agent': `traceroost-client/${clientVersion()}` },
        signal: controller.signal,
      })
      if (res.status === 404) found = { sourceRank: false, traceManifest: false }
      else if (res.status === 200) found = capabilitiesFromSchema(await res.json())
    } finally {
      clearTimeout(timer)
    }
  } catch {
    found = null
  }
  if (!found) {
    lastProbeFailure.set(failureKey, now)
    return cached
  }
  lastProbeFailure.delete(failureKey)
  const caps: CloudCapabilities = { endpoint: link.endpoint, installId: link.installId, checkedAt: now, ...found }
  writeCapabilities(caps, deps.baseHome)
  return caps
}

/** Records that the manifest route just 404'd (a cloud rolled back, or a re-link to an older
 *  deploy): neither version-2 part is sent again until the next successful probe says so. */
export function markUnsupported(link: { endpoint: string; installId?: string }, now: number, baseHome?: string): void {
  if (!link.installId) return
  writeCapabilities({ endpoint: link.endpoint, installId: link.installId, checkedAt: now, sourceRank: false, traceManifest: false }, baseHome)
}

/** Test-only. */
export function resetCapabilityProbeState(): void {
  lastProbeFailure.clear()
}
