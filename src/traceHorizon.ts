/**
 * The evidence horizon of a host's trace store: the earliest instant from which the store still
 * holds *every* trace it ever held, from every source. The trace manifest
 * (src/cloud/forward/traceManifest.ts) states which keys a host holds for a day, and the cloud
 * retires the host's rows that aren't listed — so a day must never be listed once some source's
 * evidence for it is gone. Three things move the horizon forward:
 *
 * - **per source, from the cards** (traceIdentity.ts's localHorizonOf): the latest of each
 *   source's oldest card — sources age out independently (Claude Code deletes transcripts after
 *   30 days, Codex keeps them; retention);
 * - **a source that vanished entirely**: one seen before with no card left now (every transcript
 *   of an agent no longer used aged out) — nothing before its newest recorded card is claimed;
 * - **a recorded floor** for evidence the host knows it dropped: "Clear all data" (nothing before
 *   the clear), OTEL span eviction (nothing before the newest evicted span's start), spans.json
 *   moved aside (nothing before the move).
 *
 * Persisted per host store (`trace-horizon.json` in the extension's global storage or the
 * standalone data dir) and only ever moves forward. Local-only module (MIT): the core edition
 * bundles it; it sends nothing anywhere.
 */

import * as fs from 'fs'
import * as path from 'path'
import { writeFileAtomic } from './fsAtomic'
import type { SourceExtent } from './traceIdentity'

const DAY_MS = 86_400_000
/** Beyond the manifest's 60-day window a recorded source can't matter any more. */
const FORGET_AFTER_MS = 61 * DAY_MS

interface HorizonState {
  /** Nothing before this (epoch ms) is claimed complete. */
  floorMs: number
  /** Each source ever seen → the newest settled card start recorded for it. */
  sources: Record<string, number>
}

export const TRACE_HORIZON_FILE = 'trace-horizon.json'

export class TraceHorizon {
  private state: HorizonState = { floorMs: 0, sources: {} }
  /** In-memory only — evidence missing just for this process's lifetime (a log file that failed
   *  to parse in the last historical pass). */
  private transientFloorMs = 0

  /** `dir` null keeps the record in memory only (tests, a host with no store dir). */
  constructor(private readonly dir: string | null, private readonly now: () => number = Date.now) {
    this.load()
  }

  /** Merges the file in (the record only moves forward) — another window of the same store may
   *  have written it since. */
  private load(): void {
    if (!this.dir) return
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, TRACE_HORIZON_FILE), 'utf-8')) as Partial<HorizonState>
      if (typeof raw.floorMs === 'number' && Number.isFinite(raw.floorMs) && raw.floorMs > this.state.floorMs) this.state.floorMs = raw.floorMs
      if (raw.sources && typeof raw.sources === 'object') {
        for (const [k, v] of Object.entries(raw.sources)) {
          if (typeof v === 'number' && Number.isFinite(v) && v > (this.state.sources[k] ?? 0)) this.state.sources[k] = v
        }
      }
    } catch { /* none yet, or unreadable — keep what is in memory */ }
  }

  get floorMs(): number {
    return Math.max(this.state.floorMs, this.transientFloorMs)
  }

  /** Evidence before `ms` is gone for good (a clear, an eviction) — never claim it again. */
  raiseFloor(ms: number): void {
    this.load()
    if (!Number.isFinite(ms) || ms <= this.state.floorMs) return
    this.state.floorMs = ms
    this.save()
  }

  /** Evidence before `ms` is missing for now (not persisted). */
  raiseTransientFloor(ms: number): void {
    if (Number.isFinite(ms) && ms > this.transientFloorMs) this.transientFloorMs = ms
  }

  resetTransientFloor(): void {
    this.transientFloorMs = 0
  }

  /** The manifest window's lower bound given what each source holds now, or null when nothing is
   *  held. Records each present source's newest card, so a source that later vanishes still
   *  bounds the window. */
  horizonMs(extents: ReadonlyMap<string, SourceExtent>): number | null {
    if (extents.size === 0) return null
    this.load()
    let horizon = this.floorMs
    let changed = false
    for (const [source, e] of extents) {
      if (e.oldestMs > horizon) horizon = e.oldestMs
      if ((this.state.sources[source] ?? 0) < e.newestMs) {
        this.state.sources[source] = e.newestMs
        changed = true
      }
    }
    const forgetBefore = this.now() - FORGET_AFTER_MS
    for (const [source, newest] of Object.entries(this.state.sources)) {
      if (extents.has(source)) continue
      if (newest < forgetBefore) {
        delete this.state.sources[source]
        changed = true
        continue
      }
      // Every card of this source is gone: nothing up to its newest one can be claimed.
      if (newest + 1 > horizon) horizon = newest + 1
    }
    if (changed) this.save()
    return horizon
  }

  private save(): void {
    if (!this.dir) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      writeFileAtomic(path.join(this.dir, TRACE_HORIZON_FILE), JSON.stringify(this.state) + '\n', { mode: 0o600 })
    } catch { /* non-fatal: the in-memory record still holds for this process */ }
  }
}

/** An OTLP `startTimeUnixNano` string as epoch ms (0 when unreadable). */
export function nanoStringToMs(nanos: string | undefined): number {
  if (!nanos) return 0
  const n = Number(nanos)
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1e6) : 0
}

/** The floor an eviction of `spans` implies: just past the newest evicted span's start. A trace
 *  that started after that kept every span (each of its spans starts after the trace does, so
 *  later than any evicted one); a trace that started before it may have lost some. 0 for none. */
export function evictionFloorMs(spans: Iterable<{ startTime: string }>): number {
  let max = 0
  for (const s of spans) {
    const ms = nanoStringToMs(s.startTime)
    if (ms > max) max = ms
  }
  return max > 0 ? max + 1 : 0
}
