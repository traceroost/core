/**
 * The trace manifest (stable trace identity, feature 11 step 5): the reconciliation safety net
 * for traces whose key changed, or that were merged away, after they were sent.
 *
 * Every so often a linked install tells the cloud which trace keys it still holds for a settled
 * window — `POST /api/ingest/manifest`, one chunk per UTC day — and the cloud retires the rows
 * *this install* sent in that window whose key isn't listed (cloud: src/lib/ingest/manifest.ts).
 * A chunk carries only the window bounds and opaque UUIDs that already travelled as
 * `session.session_id` (`TraceManifestChunk`, `$defs/trace_manifest`); it gives the cloud no way
 * to ask for anything.
 *
 * Because a manifest *removes* rows, everything here leans towards not sending:
 *
 * - only to a cloud seen to accept it (cloudCapabilities.ts) — an older one behaves as before;
 * - only by the process that owns writes to the local store (`TraceManifestSource.isWriter`), and
 *   only once that store has finished its startup load (`isReady`) — a half-loaded store would
 *   list too few keys;
 * - only by one TraceRoost host per machine: the extension and the standalone server share one
 *   credential (one install) but not one store, so each would retire the other's traces. A small
 *   lease in `~/.traceroost` picks the sender, and while a second host is seen asking for it,
 *   neither sends;
 * - only once the forwarding queue holds no session rollups — a key not delivered yet would gate
 *   the chunk (`missing_keys`) and spend rate budget for nothing;
 * - the window is [max(localHorizon, now − 60 d), now − 10 min]: nothing older than the oldest
 *   trace still held, nothing still settling. Computed right before sending, never queued;
 * - an empty chunk is sent (with `confirm_empty`) only when the store positively holds no trace
 *   in it at all, legacy rows included, inside the horizon — otherwise it is skipped;
 * - a day holding more than `MANIFEST_MAX_KEYS` keys is split into shorter windows, never
 *   truncated (a truncated list would retire the rest).
 *
 * Cadence: a full sweep of every day in the window on startup and on (re-)link, then on each
 * forwarding tick only the days whose key set changed since their last successful chunk (a small
 * per-link record, `~/.traceroost/trace-manifest.json`: day → hash of its sorted keys + result).
 * At most `MANIFEST_HOURLY_BUDGET` chunks an hour (the cloud allows 300); a 429 pauses for its
 * Retry-After, a 5xx or network failure backs off, a `missing_keys` gate re-sends that day only
 * once the queue has drained again, with growing backoff. One log line per run that sent
 * anything — counts only, never a key.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { TraceManifestSource } from '../../cloudBridge'
import { loadCredentials } from '../org/credentials'
import { manifestUrl, type OrgCredentials } from '../org/config'
import { clientVersion, TokenRefreshError } from '../org/oauthClient'
import { refreshCredentials, accessTokenExpiring } from '../org/tokenRefresh'
import { ForwardQueue } from './queue'
import { withFileLock } from './fileLock'
import { refreshCapabilities, markUnsupported } from './cloudCapabilities'
import { SCHEMA_VERSION_RANKED, SEND_TRACE_MANIFEST, type TraceManifestChunk } from './schema'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

/** The cloud clamps every window to [now − 60 d, now − 10 min]; the client asks for no more. */
export const MANIFEST_SETTLE_MS = 10 * MINUTE_MS
export const MANIFEST_MAX_AGE_MS = 60 * DAY_MS
export const MANIFEST_MAX_KEYS = 5000
/** Chunks per hour per install — well under the cloud's 300, so a full sweep (≤ 61) plus a
 *  restart or two in the same hour never meets a 429. */
export const MANIFEST_HOURLY_BUDGET = 120
/** A full sweep skips a day confirmed with the same key set this recently (restarts in a row). */
const SWEEP_SKIP_CONFIRMED_WITHIN_MS = HOUR_MS
const GATED_RETRY_BASE_MS = 5 * MINUTE_MS
const GATED_RETRY_MAX_MS = 6 * HOUR_MS
const FAILURE_BACKOFF_BASE_MS = 5 * MINUTE_MS
const FAILURE_BACKOFF_MAX_MS = HOUR_MS
/** A sender lease (or a second host's claim on it) not renewed for this long has lapsed. The
 *  forwarding timer ticks every 5 minutes. */
export const LEASE_TTL_MS = 30 * MINUTE_MS
/** How many times a day's window may be halved to fit `MANIFEST_MAX_KEYS`. */
const MAX_SPLIT_DEPTH = 8

// ── Window math ────────────────────────────────────────────────────────────────

/** One UTC day of the manifest window, [fromMs, toMs) — clipped to the window at both ends. */
export interface ManifestDay {
  day: string
  fromMs: number
  toMs: number
}

/** The days a manifest covers now, newest first: [max(horizon, now − 60 d), now − settle], split
 *  at UTC midnights. Empty with no horizon (nothing held) or nothing settled yet. */
export function manifestDays(horizonMs: number | null, nowMs: number): ManifestDay[] {
  if (horizonMs === null || !Number.isFinite(horizonMs)) return []
  const to = nowMs - MANIFEST_SETTLE_MS
  const from = Math.max(horizonMs, nowMs - MANIFEST_MAX_AGE_MS)
  if (to <= from) return []
  const days: ManifestDay[] = []
  for (let dayStart = Math.floor(from / DAY_MS) * DAY_MS; dayStart < to; dayStart += DAY_MS) {
    days.push({
      day: new Date(dayStart).toISOString().slice(0, 10),
      fromMs: Math.max(from, dayStart),
      toMs: Math.min(to, dayStart + DAY_MS),
    })
  }
  return days.reverse()
}

/** The exact request body for one window. Keys sorted (stable bytes for a stable set). */
export function buildManifestChunk(fromMs: number, toMs: number, keys: readonly string[], confirmEmpty = false): TraceManifestChunk {
  return {
    schema_version: SCHEMA_VERSION_RANKED,
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    keys: [...keys].sort(),
    ...(confirmEmpty && keys.length === 0 ? { confirm_empty: true as const } : {}),
  }
}

export interface DayPlan {
  /** sha256 of the day's sorted keys (and whether it is a confirmed-empty day). */
  hash: string
  chunks: TraceManifestChunk[]
}

/** What to send for `day`, or null when nothing should be (an empty day that isn't positively
 *  empty inside the horizon). Window bounds handed to the source are inclusive, so [from, to)
 *  asks for [from, to − 1]. */
export function planManifestDay(source: Pick<TraceManifestSource, 'listTraceKeys' | 'countTraces'>, day: ManifestDay, horizonMs: number): DayPlan | null {
  const chunks: TraceManifestChunk[] = []
  const allKeys: string[] = []
  const plan = (fromMs: number, toMs: number, depth: number): void => {
    const keys = source.listTraceKeys(fromMs, toMs - 1)
    if (keys.length === 0) {
      if (fromMs >= horizonMs && source.countTraces(fromMs, toMs - 1) === 0) chunks.push(buildManifestChunk(fromMs, toMs, [], true))
      return
    }
    if (keys.length <= MANIFEST_MAX_KEYS) {
      chunks.push(buildManifestChunk(fromMs, toMs, keys))
      allKeys.push(...keys)
      return
    }
    // Never truncate — a partial list would retire the rest. Past the split limit, skip it.
    const mid = Math.floor((fromMs + toMs) / 2)
    if (depth >= MAX_SPLIT_DEPTH || mid <= fromMs) return
    plan(fromMs, mid, depth + 1)
    plan(mid, toMs, depth + 1)
  }
  plan(day.fromMs, day.toMs, 0)
  if (chunks.length === 0) return null
  const confirmed = chunks.some(c => c.confirm_empty)
  const hash = crypto.createHash('sha256').update([...allKeys].sort().join('\n') + (confirmed ? '\n#empty' : '')).digest('hex')
  return { hash, chunks }
}

// ── Per-link record ──────────────────────────────────────────────────────────

interface DayRecord {
  hash: string
  /** ok: the cloud reconciled it (or it retired nothing on purpose for a reason a re-send won't
   *  change); gated: `missing_keys`, re-send after the queue drains; rejected: a 400/413 for this
   *  exact key set — not re-sent until the set changes. */
  status: 'ok' | 'gated' | 'rejected'
  at: number
  attempts: number
}

interface ManifestState {
  endpoint: string
  installId: string
  days: Record<string, DayRecord>
  /** When each chunk in the last hour was sent — the hourly budget. */
  sends: number[]
  pausedUntil: number | null
  failures: number
  nextAttemptAt: number | null
}

export function manifestStatePath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.traceroost', 'trace-manifest.json')
}

function readState(creds: { endpoint: string; installId: string }, baseHome?: string): ManifestState {
  const fresh: ManifestState = { endpoint: creds.endpoint, installId: creds.installId, days: {}, sends: [], pausedUntil: null, failures: 0, nextAttemptAt: null }
  try {
    const s = JSON.parse(fs.readFileSync(manifestStatePath(baseHome), 'utf-8')) as Partial<ManifestState>
    // A different link (a re-link mints a new install) starts over: a full sweep for it.
    if (s.endpoint !== creds.endpoint || s.installId !== creds.installId) return fresh
    return { ...fresh, ...s, days: s.days ?? {}, sends: Array.isArray(s.sends) ? s.sends : [] }
  } catch {
    return fresh
  }
}

function writeState(state: ManifestState, nowMs: number, baseHome?: string): void {
  // Days that left the window can't be sent again — drop them.
  const oldest = new Date(nowMs - MANIFEST_MAX_AGE_MS - DAY_MS).toISOString().slice(0, 10)
  for (const day of Object.keys(state.days)) if (day < oldest) delete state.days[day]
  state.sends = state.sends.filter(t => nowMs - t < HOUR_MS)
  const file = manifestStatePath(baseHome)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {
    /* non-fatal — the next run re-sends what it can't tell was sent */
  }
}

// ── One sender per machine ───────────────────────────────────────────────────

interface SenderLease {
  holder: string
  pid: number
  hostname: string
  at: number
  /** The last time another host asked for the lease while this one held it. */
  contendedAt?: number
}

export function senderLeasePath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.traceroost', 'trace-manifest-sender.json')
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 'ours' — this host is the machine's manifest sender; 'other' — another live host is;
 * 'contended' — this host holds the lease but another one asked for it recently, so the two
 * stores disagree on what this install holds and neither may send.
 */
export function claimSenderLease(holder: string, nowMs: number, baseHome?: string): 'ours' | 'other' | 'contended' {
  const file = senderLeasePath(baseHome)
  return withFileLock(file, () => {
    let lease: SenderLease | null = null
    try { lease = JSON.parse(fs.readFileSync(file, 'utf-8')) as SenderLease } catch { /* none yet */ }
    const lapsed = !lease || nowMs - lease.at >= LEASE_TTL_MS ||
      (lease.hostname === os.hostname() && lease.pid !== process.pid && !pidAlive(lease.pid))
    let result: 'ours' | 'other' | 'contended'
    let next: SenderLease
    if (lease && !lapsed && lease.holder !== holder) {
      next = { ...lease, contendedAt: nowMs }
      result = 'other'
    } else {
      const contendedAt = lease && lease.holder === holder ? lease.contendedAt : undefined
      next = { holder, pid: process.pid, hostname: os.hostname(), at: nowMs, ...(contendedAt !== undefined ? { contendedAt } : {}) }
      result = contendedAt !== undefined && nowMs - contendedAt < LEASE_TTL_MS ? 'contended' : 'ours'
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(next) + '\n', { mode: 0o600 })
    } catch {
      return 'other' // can't record the lease — don't send on a guess
    }
    return result
  })
}

// ── Sending ──────────────────────────────────────────────────────────────────

export interface ManifestSyncResult {
  /** Why nothing was attempted, when nothing was. */
  skipped?: 'disabled' | 'not-linked' | 'not-writer' | 'not-ready' | 'queue-not-drained' | 'paused' | 'unsupported' | 'other-host' | 'contended' | 'nothing-held'
  /** Why the run ended early, when it did. */
  stopped?: 'rate-limited' | 'budget' | 'failed' | 'auth' | 'revoked' | 'unsupported' | 'interrupted'
  chunks: number
  retired: number
  gated: number
}

export interface ManifestSyncDeps {
  now?: () => number
  baseHome?: string
  log?: (msg: string) => void
  /** Re-send every day in the window, not only the changed ones (startup, (re-)link). */
  fullSweep?: boolean
  /** Identifies this host's claim on the per-machine sender lease. */
  holderId: string
  /** One-time log lines already printed by this host. */
  loggedOnce?: Set<string>
}

function gatedRetryDue(rec: DayRecord, nowMs: number): boolean {
  const wait = Math.min(GATED_RETRY_MAX_MS, GATED_RETRY_BASE_MS * 2 ** Math.max(0, rec.attempts - 1))
  return nowMs - rec.at >= wait
}

/** One manifest run for the linked install: decides what's due, sends it, records the results. */
export async function syncTraceManifest(source: TraceManifestSource, deps: ManifestSyncDeps): Promise<ManifestSyncResult> {
  const result: ManifestSyncResult = { chunks: 0, retired: 0, gated: 0 }
  const now = deps.now ?? Date.now
  const once = (key: string, msg: string) => {
    if (deps.loggedOnce?.has(key)) return
    deps.loggedOnce?.add(key)
    deps.log?.(msg)
  }
  if (!SEND_TRACE_MANIFEST) return { ...result, skipped: 'disabled' }
  let creds = loadCredentials()
  if (!creds || !creds.installId) return { ...result, skipped: 'not-linked' }
  const link = { endpoint: creds.endpoint, installId: creds.installId }
  if (!source.isWriter()) return { ...result, skipped: 'not-writer' }
  if (!source.isReady()) return { ...result, skipped: 'not-ready' }
  if (new ForwardQueue(deps.baseHome).list().some(it => it.key.startsWith('session:'))) return { ...result, skipped: 'queue-not-drained' }

  const state = readState(link, deps.baseHome)
  if ((state.pausedUntil !== null && state.pausedUntil > now()) || (state.nextAttemptAt !== null && state.nextAttemptAt > now())) {
    return { ...result, skipped: 'paused' }
  }

  const caps = await refreshCapabilities(link, { now, baseHome: deps.baseHome })
  if (!caps?.traceManifest) return { ...result, skipped: 'unsupported' }

  const lease = claimSenderLease(deps.holderId, now(), deps.baseHome)
  if (lease === 'other') {
    once('other-host', '[TraceRoost] Trace manifest: another TraceRoost host on this machine sends it for this link — this one doesn\'t.')
    return { ...result, skipped: 'other-host' }
  }
  if (lease === 'contended') {
    once('contended', '[TraceRoost] Trace manifest paused: two TraceRoost hosts (the editor extension and the background service) share this machine\'s link but not their trace history. Run one of them to resume.')
    return { ...result, skipped: 'contended' }
  }

  const horizon = source.localHorizonMs()
  const days = manifestDays(horizon, now())
  if (horizon === null || days.length === 0) return { ...result, skipped: 'nothing-held' }

  let refreshed = false
  if (accessTokenExpiring(creds, now)) {
    try { creds = await refreshCredentials(creds, now); refreshed = true } catch (err) {
      if (err instanceof TokenRefreshError && err.permanent) return { ...result, stopped: 'auth' }
    }
  }

  const finish = (stopped?: ManifestSyncResult['stopped']): ManifestSyncResult => {
    writeState(state, now(), deps.baseHome)
    if (result.chunks > 0) {
      deps.log?.(`[TraceRoost] Trace manifest${deps.fullSweep ? ' (full sweep)' : ''}: sent ${result.chunks} chunk(s), retired ${result.retired} trace(s), ${result.gated} gated${stopped ? ` — stopped (${stopped})` : ''}`)
    }
    return stopped ? { ...result, stopped } : result
  }

  for (const day of days) {
    // Re-checked per day: the requests below yield, and the store may be cleared (and re-read)
    // or change hands in the meantime.
    if (!source.isWriter() || !source.isReady()) return finish('interrupted')
    const plan = planManifestDay(source, day, horizon)
    if (!plan) continue
    const rec = state.days[day.day]
    const nowMs = now()
    let due: boolean
    if (!rec || rec.hash !== plan.hash) due = true
    else if (rec.status === 'gated') due = gatedRetryDue(rec, nowMs)
    else if (rec.status === 'rejected') due = false
    else due = deps.fullSweep === true && nowMs - rec.at >= SWEEP_SKIP_CONFIRMED_WITHIN_MS
    if (!due) continue

    state.sends = state.sends.filter(t => nowMs - t < HOUR_MS)
    if (state.sends.length + plan.chunks.length > MANIFEST_HOURLY_BUDGET) return finish('budget')

    let dayStatus: DayRecord['status'] = 'ok'
    for (const chunk of plan.chunks) {
      let res: Response
      try {
        res = await postManifest(creds, chunk)
        if (res.status === 401 && !refreshed) {
          refreshed = true
          try { creds = await refreshCredentials(creds, now) } catch { return finish('auth') }
          res = await postManifest(creds, chunk)
        }
      } catch {
        res = new Response(null, { status: 599 })
      }
      state.sends.push(now())

      if (res.status === 200) {
        result.chunks++
        state.failures = 0
        state.nextAttemptAt = null
        let body: { retired?: unknown; gated?: unknown } = {}
        try { body = (await res.json()) as typeof body } catch { /* counts unknown */ }
        if (typeof body.retired === 'number') result.retired += body.retired
        if (body.gated === 'missing_keys') {
          result.gated++
          dayStatus = 'gated'
        } else if (body.gated === 'empty_unconfirmed') {
          result.gated++
          once('empty-unconfirmed', '[TraceRoost] Trace manifest: the cloud held back an empty chunk as unconfirmed.')
        }
        continue
      }
      if (res.status === 401) return finish('auth')
      if (res.status === 403) return finish('revoked') // the drain clears the credential
      if (res.status === 404) {
        markUnsupported(link, now(), deps.baseHome)
        return finish('unsupported')
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 3600
        state.pausedUntil = now() + retryAfter * 1000
        return finish('rate-limited')
      }
      if (res.status === 400 || res.status === 413) {
        once(`rejected-${res.status}`, `[TraceRoost] Trace manifest: the cloud rejected a chunk (HTTP ${res.status}); that day is skipped until its traces change.`)
        dayStatus = 'rejected'
        continue
      }
      // 5xx, network failure, anything else: back off and stop this run.
      state.failures++
      state.nextAttemptAt = now() + Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** (state.failures - 1))
      return finish('failed')
    }
    state.days[day.day] = {
      hash: plan.hash,
      status: dayStatus,
      at: now(),
      attempts: dayStatus === 'gated' && rec?.status === 'gated' && rec.hash === plan.hash ? rec.attempts + 1 : 1,
    }
  }
  state.pausedUntil = null
  return finish()
}

async function postManifest(creds: OrgCredentials, chunk: TraceManifestChunk): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    return await fetch(manifestUrl(creds.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.accessToken}`,
        'User-Agent': `traceroost-client/${clientVersion()}`,
      },
      body: JSON.stringify(chunk),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Per host: remembers which link it has fully swept, so the first run in a process — and the
 *  first after a (re-)link — re-sends every day, and later runs only the changed ones. */
export class TraceManifestSender {
  private sweptInstall: string | undefined
  private running = false
  private readonly holderId = crypto.randomBytes(8).toString('hex')
  private readonly loggedOnce = new Set<string>()

  constructor(private readonly source: TraceManifestSource, private readonly opts: { log?: (msg: string) => void; baseHome?: string; now?: () => number } = {}) {}

  async run(): Promise<ManifestSyncResult | null> {
    if (this.running) return null
    this.running = true
    try {
      const installId = loadCredentials()?.installId
      const fullSweep = installId !== undefined && installId !== this.sweptInstall
      const res = await syncTraceManifest(this.source, {
        ...this.opts, fullSweep, holderId: this.holderId, loggedOnce: this.loggedOnce,
      })
      // Swept once every due day was handled; a run stopped early (budget, 429, failure) or
      // skipped outright stays a full sweep next time.
      if (fullSweep && !res.skipped && !res.stopped) this.sweptInstall = installId
      if (res.skipped === 'nothing-held') this.sweptInstall = installId
      return res
    } catch (err) {
      this.opts.log?.(`[TraceRoost] Trace manifest error: ${(err as Error).message}`)
      return null
    } finally {
      this.running = false
    }
  }
}

/** The newest non-empty chunk as it would be sent now (else the newest empty one, or null) — for
 *  `--explain-payload`, built by the same code as the real send. */
export function previewManifestChunk(source: Pick<TraceManifestSource, 'localHorizonMs' | 'listTraceKeys' | 'countTraces'>, nowMs: number = Date.now()): TraceManifestChunk | null {
  const horizon = source.localHorizonMs()
  if (horizon === null) return null
  let fallback: TraceManifestChunk | null = null
  for (const day of manifestDays(horizon, nowMs)) {
    const plan = planManifestDay(source, day, horizon)
    const withKeys = plan?.chunks.find(c => c.keys.length > 0)
    if (withKeys) return withKeys
    fallback ??= plan?.chunks[0] ?? null
  }
  return fallback
}
