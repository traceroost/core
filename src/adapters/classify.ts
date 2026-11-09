/**
 * Sorts what an agent wrote into known / known-ignored / unknown against its adapter's `known.ts`,
 * and reads the agent version it carries. LogReader hands each file it reads here (through its
 * `observe` option); OtlpIngest each log record and span. Only closed-vocabulary names and counts
 * come out — never a value from a record (see the privacy invariants in health.ts).
 */

import * as crypto from 'crypto'
import type { AdapterKey, Classification, KnownOtlp, KnownRecords, OtlpRecordView } from './types'
import { ANTIGRAVITY_RECORDS, ANTIGRAVITY_SCHEMA, ANTIGRAVITY_SCHEMA_VERSIONS } from './antigravity/known'
import { CLAUDE_OTLP, CLAUDE_RECORDS } from './claude/known'
import { CODEX_OTLP, CODEX_RECORDS } from './codex/known'
import { COPILOT_RECORDS } from './copilot/known'
import { COPILOT_OTLP, COPILOT_VSCODE_RECORDS, COPILOT_VSCODE_SNAPSHOT } from './copilotVscode/known'
import { CURSOR_RECORDS } from './cursor/known'
import { OPENCODE_RECORDS, OPENCODE_SCHEMA } from './opencode/known'
import { adapterForLogKey } from './registry'
import { fingerprint, type Fingerprint } from './fingerprint'

/** The vocabulary each LogReader agent key's records are classified against. */
export const RECORDS_BY_LOG_KEY: Readonly<Record<string, KnownRecords>> = {
  claude:              CLAUDE_RECORDS,
  codex:               CODEX_RECORDS,
  copilot:             COPILOT_RECORDS,
  copilot_vscode:      COPILOT_VSCODE_RECORDS,
  copilot_vscode_json: COPILOT_VSCODE_SNAPSHOT,
  opencode:            OPENCODE_RECORDS,
  cursor:              CURSOR_RECORDS,
  antigravity:         ANTIGRAVITY_RECORDS,
}

export const OTLP_BY_ADAPTER: Readonly<Partial<Record<AdapterKey, KnownOtlp>>> = {
  claude:         CLAUDE_OTLP,
  codex:          CODEX_OTLP,
  copilot:        COPILOT_OTLP,
  copilot_vscode: COPILOT_OTLP,
}

/** The value at a dotted key path, undefined when any step is missing. */
export function atPath(record: unknown, dotted: string): unknown {
  let cur: unknown = record
  for (const k of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

export function classifyRecord(known: KnownRecords, record: unknown): Classification {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return { cls: 'unknown', name: '(not an object)' }
  const name = known.nameOf(record as Record<string, unknown>)
  if (name === null) return { cls: 'unknown', name: '(no type)' }
  const required = known.consumed[name]
  if (required) {
    const missing = required.find(p => atPath(record, p) === undefined || atPath(record, p) === null)
    return missing ? { cls: 'unknown', name: `${name} missing ${missing}` } : { cls: 'known', name }
  }
  return known.ignored.includes(name) ? { cls: 'ignored', name } : { cls: 'unknown', name }
}

/** What one read of one file (or database) held, by class. Replaces that file's previous
 *  observation in adapter health — LogReader always hands over the whole file. */
export interface FileObservation {
  adapter: AdapterKey
  /** The agent version the file records, or 'unknown' when it records none. */
  version: string
  known: number
  ignored: number
  unknown: number
  /** Unknown record name → count. */
  unknownNames: Record<string, number>
  /** The structural fingerprint (fingerprint.ts) of the first unknown record of each name — key
   *  names and value types only; the record itself is not kept. */
  unknownFingerprints: Record<string, Fingerprint>
  /** Turns a complete read of the file produced — for Claude Code and Codex, only those carrying
   *  token usage (LogReader sets it after parsing). Absent when the read wasn't complete or the
   *  source has no files to count (OpenCode, OTLP). */
  turns?: number
}

/** An unknown name that means data TraceRoost relies on was lost, not just something it skips:
 *  a record it reads that came without a field it needs (`assistant missing message.usage`, an
 *  OpenCode table or column), or a line that didn't parse. */
export function isDamageName(name: string): boolean {
  return name === '(unparseable)' || / missing( |$)/.test(name)
}

/** Classifies the records of one file. `records[i]` undefined (a line that didn't parse) counts
 *  as unknown `(unparseable)` only when it isn't the file's last line — the last may still be
 *  being written. */
export function observeRecords(logKey: string, records: readonly unknown[]): FileObservation | null {
  const adapter = adapterForLogKey(logKey)
  const known = RECORDS_BY_LOG_KEY[logKey]
  if (!adapter || !known) return null
  const obs: FileObservation = { adapter: adapter.key, version: 'unknown', known: 0, ignored: 0, unknown: 0, unknownNames: {}, unknownFingerprints: {} }
  let version: string | null = null
  records.forEach((record, i) => {
    if (record === undefined) {
      if (i === records.length - 1) return
      obs.unknown++
      obs.unknownNames['(unparseable)'] = (obs.unknownNames['(unparseable)'] ?? 0) + 1
      return
    }
    const c = classifyRecord(known, record)
    obs[c.cls]++
    if (c.cls === 'unknown') {
      obs.unknownNames[c.name] = (obs.unknownNames[c.name] ?? 0) + 1
      if (!(c.name in obs.unknownFingerprints)) obs.unknownFingerprints[c.name] = fingerprint(record, known)
    }
    // The last version in the file: a resumed session records the newer agent.
    if (known.versionOf && record && typeof record === 'object') version = known.versionOf(record as Record<string, unknown>) ?? version
  })
  if (version) obs.version = version
  return obs
}

/** A minimal view of a sql.js database: `exec` as LogReader's OpenCodeSqlFactory provides it. */
export interface SqlExec {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
}

/** Classifies an OpenCode database: a missing table or column the reader needs, then message
 *  roles and part types, grouped in SQL so no row content is read. */
export function observeOpenCodeDb(db: SqlExec): FileObservation {
  const obs: FileObservation = { adapter: 'opencode', version: 'unknown', known: 0, ignored: 0, unknown: 0, unknownNames: {}, unknownFingerprints: {} }
  const columns = new Map<string, Set<string>>()
  for (const [table, needed] of Object.entries(OPENCODE_SCHEMA)) {
    const have = new Set<string>()
    try { for (const row of db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []) have.add(String(row[1])) } catch { /* treated as absent */ }
    columns.set(table, have)
    if (have.size === 0) { addUnknown(obs, `table ${table} missing`); continue }
    for (const col of needed) if (!have.has(col)) addUnknown(obs, `${table}.${col} missing`)
  }
  const grouped = (sql: string, table: 'message' | 'part', field: 'role' | 'type') => {
    let rows: unknown[][] = []
    try { rows = db.exec(sql)[0]?.values ?? [] } catch { return }
    for (const [value, count] of rows) {
      const c = classifyRecord(OPENCODE_RECORDS, { table, [field]: typeof value === 'string' ? value : undefined })
      const n = Number(count) || 0
      obs[c.cls] += n
      if (c.cls === 'unknown') obs.unknownNames[c.name] = (obs.unknownNames[c.name] ?? 0) + n
    }
  }
  if (columns.get('message')?.has('data')) grouped(`SELECT json_extract(data,'$.role'), COUNT(*) FROM message GROUP BY 1`, 'message', 'role')
  if (columns.get('part')?.has('data')) grouped(`SELECT json_extract(data,'$.type'), COUNT(*) FROM part GROUP BY 1`, 'part', 'type')
  if (columns.get('session')?.has('version')) {
    try {
      const v = db.exec(`SELECT version FROM session WHERE version IS NOT NULL AND version != '' ORDER BY time_created DESC LIMIT 1`)[0]?.values?.[0]?.[0]
      if (typeof v === 'string' && v) obs.version = v
    } catch { /* leave unknown */ }
  }
  return obs
}

/** The Antigravity conversation database's schema fingerprint: sha256 over every
 *  `sqlite_master.sql` row (ordered by type, name), each followed by a newline, then
 *  `PRAGMA user_version` and a newline — agentsview's antigravity_version.go recipe, so the known
 *  fingerprints it published apply. Null when the schema can't be read. */
export function antigravitySchemaFingerprint(db: SqlExec): string | null {
  try {
    const rows = db.exec(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name`)[0]?.values ?? []
    const userVersion = db.exec(`PRAGMA user_version`)[0]?.values?.[0]?.[0]
    const h = crypto.createHash('sha256')
    for (const [sql] of rows) h.update(`${String(sql)}\n`)
    h.update(`${Number(userVersion ?? 0)}\n`)
    return h.digest('hex')
  } catch {
    return null
  }
}

/** The agy version a conversation database's schema fingerprint stands for: a known fingerprint's
 *  version range, else `agy-schema:<first 12 hex>` (a schema no evidence covers yet — adapter
 *  health shows it as an unverified version), else 'unknown'. */
export function antigravitySchemaVersion(db: SqlExec): string {
  const fp = antigravitySchemaFingerprint(db)
  if (!fp) return 'unknown'
  return ANTIGRAVITY_SCHEMA_VERSIONS[fp] ?? `agy-schema:${fp.slice(0, 12)}`
}

/** Classifies one Antigravity conversation: its transcript lines (when it has a transcript), then,
 *  when it has a database, a missing table or column the reader needs (damage, like OpenCode's)
 *  and the schema fingerprint as the version. Never reads a row's content. */
export function observeAntigravity(records: readonly unknown[] | null, db: SqlExec | null): FileObservation {
  const obs: FileObservation = records ? observeRecords('antigravity', records) ?? emptyObs('antigravity') : emptyObs('antigravity')
  if (db) {
    for (const [table, needed] of Object.entries(ANTIGRAVITY_SCHEMA)) {
      const have = new Set<string>()
      try { for (const row of db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []) have.add(String(row[1])) } catch { /* treated as absent */ }
      if (have.size === 0) { addUnknown(obs, `table ${table} missing`); continue }
      for (const col of needed) if (!have.has(col)) addUnknown(obs, `${table}.${col} missing`)
    }
    obs.version = antigravitySchemaVersion(db)
  }
  return obs
}

function emptyObs(adapter: AdapterKey): FileObservation {
  return { adapter, version: 'unknown', known: 0, ignored: 0, unknown: 0, unknownNames: {}, unknownFingerprints: {} }
}

function addUnknown(obs: FileObservation, name: string): void {
  obs.unknown++
  obs.unknownNames[name] = (obs.unknownNames[name] ?? 0) + 1
}

/** Which agent an OTLP log record or span came from, or null for one no adapter claims (another
 *  OTel emitter sharing the port). */
export function otlpAdapterOf(v: OtlpRecordView): AdapterKey | null {
  const service = v.serviceName.toLowerCase()
  if (service === 'claude-code' || v.name.startsWith('claude_code.')) return 'claude'
  if (service.startsWith('codex') || v.name.startsWith('codex.')) return 'codex'
  if (service.includes('copilot') || v.genAiOperation) return service.includes('cli') ? 'copilot' : 'copilot_vscode'
  return null
}

/** Classifies an OTLP record. Codex trace spans are named after its internal Rust spans, so
 *  only its log events are checked; a Codex span is always known. */
export function classifyOtlp(adapter: AdapterKey, v: OtlpRecordView, kind: 'log' | 'span'): Classification {
  const known = OTLP_BY_ADAPTER[adapter]
  if (!known) return { cls: 'unknown', name: v.name || '(no name)' }
  if (adapter === 'codex' && kind === 'span') return { cls: 'known', name: v.name }
  const name = adapter === 'copilot' || adapter === 'copilot_vscode' ? (v.genAiOperation || v.name) : v.name
  if (!name) return { cls: 'unknown', name: '(no name)' }
  if (known.consumed.includes(name)) return { cls: 'known', name }
  if (known.ignored.includes(name)) return { cls: 'ignored', name }
  return { cls: 'unknown', name }
}
