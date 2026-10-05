/**
 * Fetches the linked org's own pricing table from the cloud service (AL 01: only ever called
 * after `loadCredentials()` finds a real credential — an unlinked install never touches the
 * network, same invariant as every other file in `src/cloud/org/`).
 *
 * Every failure degrades to "use core's local RATES table", never to a broken cost display —
 * same resilience philosophy as `sender.ts`'s drain, just for a read instead of a delivery:
 * offline, a 401 even after a refresh, 5xx, a malformed response, or simply never having linked
 * all leave `lookupRates()` (`src/pricing.ts`) exactly as it behaves today. The service only
 * lists models it has a real rate for, so a model missing from its table keeps core's own rate.
 *
 * Cost calculation itself (`calcTokenCostUsd`'s formula, tiered pricing, normalizeCostKey) is
 * untouched by this file — it only ever supplies `lookupRates()` an optional map to check first.
 */

import * as fs from 'fs'
import * as path from 'path'
import { loadCredentials } from './credentials'
import { traceroostDir } from './credentials'
import { ratesUrl } from './config'
import { clientVersion } from './oauthClient'
import { fetchWithFreshToken } from './tokenRefresh'
import { setCloudRateOverrides, type ModelRates } from '../../pricing'

function cachePath(baseHome?: string): string {
  return path.join(traceroostDir(baseHome), 'team-rates.json')
}

/** Loads whatever was cached from the last successful fetch (if any) into `pricing.ts`'s
 *  override map immediately — so a restart has cloud pricing without waiting on a fresh network
 *  round trip, and an offline moment after that doesn't blank out costs that were working a
 *  minute ago. Safe to call on every startup, linked or not — an unlinked install simply has no
 *  cache file (`fetchAndCacheRates` is the only writer, and it's AL 01-gated), so this is a
 *  local-only read, not a network call. */
function loadCachedRatesIntoPricing(baseHome?: string): void {
  try {
    const raw = fs.readFileSync(cachePath(baseHome), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, ModelRates>
    setCloudRateOverrides(parsed)
  } catch {
    /* no cache yet, or it's corrupt — pricing.ts already falls back to local RATES either way */
  }
}

/** One fetch attempt. Never throws — every failure mode just means "keep using whatever
 *  lookupRates() already had" (the previous cache, or local RATES if there never was one). */
export async function fetchAndCacheRates(baseHome?: string): Promise<void> {
  // AL 01 — `fetchWithFreshToken` checks the credential first and returns null before any request
  // on an unlinked install. It also refreshes an expired access token first (and once more on a
  // 401): this runs hourly, so without that every sync after the token's one-hour lifetime on an
  // idle machine used to 401 and silently keep a stale table.
  let res: Response | null
  try {
    res = await fetchWithFreshToken(async (creds) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      try {
        return await fetch(ratesUrl(creds.endpoint), {
          headers: {
            Authorization: `Bearer ${creds.accessToken}`,
            'User-Agent': `traceroost-client/${clientVersion()}`,
          },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
    })
  } catch {
    return // offline / DNS / dropped connection — keep whatever was already cached
  }
  if (!res || !res.ok) return // unlinked, or 401-after-refresh/403/5xx — keep the cached table

  let body: { rates?: Record<string, ModelRates> }
  try {
    body = (await res.json()) as { rates?: Record<string, ModelRates> }
  } catch {
    return // malformed response — keep whatever was already cached
  }
  if (!body.rates || typeof body.rates !== 'object') return

  setCloudRateOverrides(body.rates)

  try {
    const dir = path.dirname(cachePath(baseHome))
    fs.mkdirSync(dir, { recursive: true })
    const file = cachePath(baseHome)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(body.rates, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {
    /* cache write failed — the in-memory override from setCloudRateOverrides above still applies
     * for the rest of this process; just won't survive a restart until the next successful fetch */
  }
}

// ── Scheduling ────────────────────────────────────────────────────────────────
//
// A dedicated, longer-interval timer rather than piggybacking on the forward-queue's 5-minute
// drain cadence (scheduler.ts) — an org's pricing table changes rarely (a lead editing a rate, or
// a central refresh), so refreshing it every 5 minutes would just be unnecessary network chatter.
// Same shape as scheduler.ts otherwise: a process-wide handle, no timer while unlinked, unreffed
// so it never keeps the process alive on its own.

export interface PricingSyncHandle {
  syncToLinkState(): void
  dispose(): void
}

export function startPricingSync(opts: { intervalMs?: number; baseHome?: string; onSync?: () => void } = {}): PricingSyncHandle {
  const intervalMs = opts.intervalMs ?? 60 * 60_000 // hourly — see comment above
  let timer: ReturnType<typeof setInterval> | undefined

  loadCachedRatesIntoPricing(opts.baseHome)

  const fetchAndNotify = () => fetchAndCacheRates(opts.baseHome).then(() => opts.onSync?.())

  const start = () => {
    if (timer) return
    timer = setInterval(() => { void fetchAndNotify() }, intervalMs)
    timer.unref?.()
    void fetchAndNotify()
  }
  const stop = () => {
    if (timer) { clearInterval(timer); timer = undefined }
  }

  if (loadCredentials()) start()

  const handle: PricingSyncHandle = {
    syncToLinkState() {
      if (loadCredentials()) start()
      else {
        stop()
        setCloudRateOverrides({}) // leaving an org stops trusting its rates too
        opts.onSync?.()
      }
    },
    dispose() {
      stop()
      if (activeHandle === handle) activeHandle = undefined
    },
  }
  activeHandle = handle
  return handle
}

// A process-wide handle so surfaces that aren't wired to the host (the Org panel controller) can
// nudge this scheduler after a link/leave without threading it through every constructor — same
// pattern as scheduler.ts's activeScheduler/syncForwardSchedulerToLinkState.
let activeHandle: PricingSyncHandle | undefined

export function syncPricingToLinkState(): void {
  activeHandle?.syncToLinkState()
}
