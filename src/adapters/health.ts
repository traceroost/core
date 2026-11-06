/**
 * Adapter health: per agent and agent version, how many records TraceRoost read, skipped on
 * purpose and didn't recognize, and when each source (local files, OTLP) last delivered. Fed by
 * LogReader's `observe` option and OtlpIngest; read by Settings → Agents, the agent banner on the
 * Traces tab, and `traceroost doctor`.
 *
 * Privacy: what is kept is closed-vocabulary names (record types, event names, key names), counts,
 * structural fingerprints (fingerprint.ts — key names and value types) and times. Files are keyed
 * by a hash of their path, never the path. Nothing here is sent anywhere; "Report this"
 * (report.ts) only opens a browser on a body the user reads first.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { writeFileAtomic } from '../fsAtomic'
import type { FileObservation } from './classify'
import { classifyOtlp, otlpAdapterOf } from './classify'
import type { Fingerprint } from './fingerprint'
import { buildAgentReport, type AgentReport } from './report'
import { ADAPTERS, type AgentAdapter } from './registry'
import type { AdapterKey, OtlpRecordView, SourceKind, SupportLevel } from './types'

export type AgentStatus = 'ok' | 'unrecognized' | 'no-data' | 'not-verified'

export interface VersionHealth {
  version: string
  known: number
  ignored: number
  unknown: number
  unknownNames: Record<string, number>
  /** One structural fingerprint per unknown name. */
  fingerprints: Record<string, Fingerprint>
  /** Past the banner threshold (see bannerWorthy). */
  banner: boolean
}

export interface AgentHealthRow {
  key: AdapterKey
  label: string
  support: SupportLevel
  sources: readonly SourceKind[]
  lastVerifiedVersion: string | null
  /** The newest agent version seen, 'unknown' when its data records none, null with no data. */
  versionSeen: string | null
  /** Epoch ms each source last delivered data, null when never. */
  lastFilesMs: number | null
  lastOtlpMs: number | null
  status: AgentStatus
  /** Newest first. */
  versions: VersionHealth[]
}

/** Banner threshold: 5 unknown records, or 1% of the version's records when that's fewer. */
export function bannerWorthy(v: Pick<VersionHealth, 'known' | 'ignored' | 'unknown'>): boolean {
  const total = v.known + v.ignored + v.unknown
  return v.unknown > 0 && v.unknown >= Math.min(5, Math.max(1, Math.ceil(total * 0.01)))
}

/** Orders agent versions numerically part by part ('2.1.10' > '2.1.9'); 'unknown' sorts first. */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0
  if (a === 'unknown') return -1
  if (b === 'unknown') return 1
  const pa = a.split(/[.+-]/), pb = b.split(/[.+-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? ''
    const nx = /^\d+$/.test(x) ? Number(x) : NaN, ny = /^\d+$/.test(y) ? Number(y) : NaN
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) { if (nx !== ny) return nx - ny; continue }
    // '1.0.0' is newer than '1.0.0-alpha': a missing part outranks a pre-release tag.
    if (x === '' || y === '') return x === '' ? 1 : -1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

interface Counts {
  adapter: AdapterKey
  version: string
  known: number
  ignored: number
  unknown: number
  unknownNames: Record<string, number>
  unknownFingerprints: Record<string, Fingerprint>
  seenMs: number
}

/** What `export` writes and `import` reads back (a JSON sidecar in the data directory). */
export interface AdapterHealthSnapshot {
  v: 1
  files: Record<string, Counts>
  otlp: Record<string, Counts>
}

const MAX_FILES = 20_000
const MAX_NAMES = 50

export class AdapterHealth {
  // hash(file path) → that file's last observation. LRU by insertion order.
  private files = new Map<string, Counts>()
  // `${adapter}\0${version}` → OTLP counts since the collector started (or the snapshot).
  private otlp = new Map<string, Counts>()
  private version = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** Bumped on every change, so a host can skip re-sending an unchanged table. */
  get revision(): number { return this.version }

  /** `dataMs`: when the agent last wrote the file (its mtime) — what "Last data" shows. */
  observeFile(filePath: string, obs: FileObservation, dataMs: number = this.now()): void {
    const key = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 24)
    this.files.delete(key)
    this.files.set(key, { ...obs, unknownNames: capNames(obs.unknownNames), seenMs: dataMs })
    if (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value as string)
    this.version++
  }

  /** One OTLP log record or span. Records no adapter claims are not counted. */
  observeOtlp(view: OtlpRecordView, kind: 'log' | 'span', fingerprint?: () => Fingerprint): void {
    const adapter = otlpAdapterOf(view)
    if (!adapter) return
    const c = classifyOtlp(adapter, view, kind)
    const version = view.serviceVersion || 'unknown'
    const key = `${adapter}\0${version}`
    let counts = this.otlp.get(key)
    if (!counts) {
      counts = { adapter, version, known: 0, ignored: 0, unknown: 0, unknownNames: {}, unknownFingerprints: {}, seenMs: 0 }
      this.otlp.set(key, counts)
    }
    counts[c.cls]++
    counts.seenMs = this.now()
    if (c.cls === 'unknown' && (c.name in counts.unknownNames || Object.keys(counts.unknownNames).length < MAX_NAMES)) {
      counts.unknownNames[c.name] = (counts.unknownNames[c.name] ?? 0) + 1
      if (fingerprint && !(c.name in counts.unknownFingerprints)) counts.unknownFingerprints[c.name] = fingerprint()
    }
    this.version++
  }

  rows(): AgentHealthRow[] {
    // One pass over the entries (there can be thousands of files), grouped by agent.
    const byAdapter = new Map<AdapterKey, Array<[Counts, 'files' | 'otlp']>>()
    const group = (c: Counts, source: 'files' | 'otlp') => {
      const list = byAdapter.get(c.adapter)
      if (list) list.push([c, source]); else byAdapter.set(c.adapter, [[c, source]])
    }
    for (const c of this.files.values()) group(c, 'files')
    for (const c of this.otlp.values()) group(c, 'otlp')
    return ADAPTERS.map(a => this.row(a, byAdapter.get(a.key) ?? []))
  }

  private row(a: AgentAdapter, entries: Array<[Counts, 'files' | 'otlp']>): AgentHealthRow {
    const byVersion = new Map<string, VersionHealth>()
    let lastFilesMs: number | null = null, lastOtlpMs: number | null = null
    const add = (c: Counts, source: 'files' | 'otlp') => {
      if (source === 'files') lastFilesMs = Math.max(lastFilesMs ?? 0, c.seenMs)
      else lastOtlpMs = Math.max(lastOtlpMs ?? 0, c.seenMs)
      let v = byVersion.get(c.version)
      if (!v) { v = { version: c.version, known: 0, ignored: 0, unknown: 0, unknownNames: {}, fingerprints: {}, banner: false }; byVersion.set(c.version, v) }
      v.known += c.known; v.ignored += c.ignored; v.unknown += c.unknown
      for (const [n, k] of Object.entries(c.unknownNames)) v.unknownNames[n] = (v.unknownNames[n] ?? 0) + k
      for (const [n, f] of Object.entries(c.unknownFingerprints)) if (!(n in v.fingerprints)) v.fingerprints[n] = f
    }
    for (const [c, source] of entries) add(c, source)
    const versions = [...byVersion.values()].sort((x, y) => compareVersions(y.version, x.version))
    for (const v of versions) v.banner = bannerWorthy(v)
    const versionSeen = versions[0]?.version ?? null
    let status: AgentStatus
    if (versions.length === 0) status = 'no-data'
    else if (versions.some(v => v.unknown > 0)) status = 'unrecognized'
    else if (a.lastVerifiedVersion === null || versionSeen === 'unknown' || compareVersions(versionSeen!, a.lastVerifiedVersion) > 0) status = 'not-verified'
    else status = 'ok'
    return {
      key: a.key, label: a.label, support: a.support, sources: a.sources, lastVerifiedVersion: a.lastVerifiedVersion,
      versionSeen, lastFilesMs, lastOtlpMs, status, versions,
    }
  }

  export(): AdapterHealthSnapshot {
    return { v: 1, files: Object.fromEntries(this.files), otlp: Object.fromEntries(this.otlp) }
  }

  /** Restores a snapshot from `export` — before the first scan, so a file the reader skips as
   *  unchanged keeps the counts it had. Anything malformed is dropped. */
  import(snapshot: unknown): void {
    const s = snapshot as Partial<AdapterHealthSnapshot> | null
    if (!s || s.v !== 1) return
    const valid = (c: unknown): c is Counts => {
      const x = c as Counts
      return !!x && typeof x === 'object' && ADAPTERS.some(a => a.key === x.adapter) && typeof x.version === 'string'
        && [x.known, x.ignored, x.unknown, x.seenMs].every(n => typeof n === 'number')
        && !!x.unknownNames && typeof x.unknownNames === 'object'
    }
    for (const [k, c] of Object.entries(s.files ?? {})) if (valid(c) && !this.files.has(k)) this.files.set(k, { ...c, unknownFingerprints: c.unknownFingerprints ?? {} })
    for (const [k, c] of Object.entries(s.otlp ?? {})) if (valid(c) && !this.otlp.has(k)) this.otlp.set(k, { ...c, unknownFingerprints: c.unknownFingerprints ?? {} })
    this.version++
  }
}

function capNames(names: Record<string, number>): Record<string, number> {
  const entries = Object.entries(names)
  return entries.length <= MAX_NAMES ? names : Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_NAMES))
}

let shared: AdapterHealth | undefined
/** The process's one health table — the hosts' LogReader and OTLP ingest both feed it. */
export function adapterHealth(): AdapterHealth {
  return (shared ??= new AdapterHealth())
}

/** What the dashboard receives: the table, with the "Report this" issue (report.ts) built here
 *  for every version that has unknown records, so the webview shows exactly what would be filed. */
export interface AdapterHealthMessage {
  type: 'adapterHealth'
  rows: Array<AgentHealthRow & { versions: Array<VersionHealth & { report?: AgentReport }> }>
}

export function adapterHealthMessage(health: AdapterHealth, traceroostVersion: string): AdapterHealthMessage {
  const env = { traceroostVersion, os: `${process.platform} ${process.arch}` }
  return {
    type: 'adapterHealth',
    rows: health.rows().map(row => ({
      ...row,
      versions: row.versions.map(v => {
        const report = v.unknown > 0 ? buildAgentReport(row, v.version, env) : null
        return report ? { ...v, report } : v
      }),
    })),
  }
}

export const ADAPTER_HEALTH_FILENAME = 'adapter-health.json'

/** Loads the persisted table into `health` (missing or unreadable: starts empty). */
export function restoreAdapterHealth(health: AdapterHealth, dir: string): void {
  try { health.import(JSON.parse(fs.readFileSync(path.join(dir, ADAPTER_HEALTH_FILENAME), 'utf8'))) } catch { /* start empty */ }
}

/** Writes the table beside the host's other state; a failure only costs counts until next read. */
export function persistAdapterHealth(health: AdapterHealth, dir: string): void {
  try { writeFileAtomic(path.join(dir, ADAPTER_HEALTH_FILENAME), JSON.stringify(health.export())) } catch { /* advisory */ }
}
