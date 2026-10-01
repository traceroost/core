/**
 * Storage for plan-limit readings, hits and per-window rollups (schema.ts's limit_* tables).
 * Same sql.js `WriteableDb` shape as the other repositories, so both the extension's
 * traceroost.db and the standalone server's outcomes-cache.db can back it.
 */

import type { LimitHit, LimitProvider, LimitReading, LimitReadingSource, LimitWindowKind } from './limitReadings'

interface WriteableDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

export interface StoredReading extends LimitReading {
  accountHash: string
}

export interface WindowRollup {
  provider: LimitProvider
  accountHash: string
  windowKind: LimitWindowKind
  /** Epoch ms — the window's reset time. */
  windowEnd: number
  peakPct: number
  hit: boolean
  coverage: 'full' | 'partial'
}

/** How long rollups outlive trace retention. */
export const ROLLUP_RETENTION_DAYS = 365

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export class LimitRepository {
  constructor(private readonly db: WriteableDb) {}

  /** Idempotent: a reading already stored (same provider/account/window/time/source) is ignored. */
  insertReadings(readings: LimitReading[], accountHash = ''): number {
    let n = 0
    for (const r of readings) {
      this.db.run(
        `INSERT OR IGNORE INTO limit_readings
           (provider, account_hash, window_kind, used_pct, resets_at, observed_at, source, session_id, plan_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.provider, accountHash, r.windowKind, r.usedPct, r.resetsAt ?? null, r.observedAt, r.source, r.sessionId ?? null, r.planType ?? null],
      )
      n++
    }
    return n
  }

  insertHits(hits: LimitHit[]): void {
    for (const h of hits) {
      this.db.run(
        `INSERT OR IGNORE INTO limit_hits (provider, session_id, window_kind, hit_at, resets_at) VALUES (?, ?, ?, ?, ?)`,
        [h.provider, h.sessionId, h.windowKind, h.hitAt, h.resetsAt ?? null],
      )
    }
  }

  /** Readings observed at or after `sinceMs`, oldest first. */
  readingsSince(sinceMs: number): StoredReading[] {
    const rows = this.db.exec(
      `SELECT provider, account_hash, window_kind, used_pct, resets_at, observed_at, source, session_id, plan_type
       FROM limit_readings WHERE observed_at >= ${Math.floor(sinceMs)} ORDER BY observed_at ASC`,
    )
    return (rows[0]?.values ?? []).map(v => ({
      provider: v[0] as LimitProvider,
      accountHash: String(v[1] ?? ''),
      windowKind: v[2] as LimitWindowKind,
      usedPct: Number(v[3]),
      resetsAt: num(v[4]),
      observedAt: Number(v[5]),
      source: v[6] as LimitReadingSource,
      sessionId: typeof v[7] === 'string' ? v[7] : undefined,
      planType: typeof v[8] === 'string' ? v[8] : undefined,
    }))
  }

  hitsSince(sinceMs: number): LimitHit[] {
    const rows = this.db.exec(
      `SELECT provider, session_id, window_kind, hit_at, resets_at FROM limit_hits
       WHERE hit_at >= ${Math.floor(sinceMs)} ORDER BY hit_at ASC`,
    )
    return (rows[0]?.values ?? []).map(v => ({
      provider: v[0] as LimitProvider,
      sessionId: String(v[1]),
      windowKind: v[2] as LimitWindowKind,
      hitAt: Number(v[3]),
      resetsAt: num(v[4]),
    }))
  }

  /** The earliest stored reading for a provider, or undefined — "history starts" in the charts. */
  firstReadingAt(provider: LimitProvider): number | undefined {
    const rows = this.db.exec(`SELECT MIN(observed_at) FROM limit_readings WHERE provider = '${provider === 'claude' ? 'claude' : 'codex'}'`)
    return num(rows[0]?.values[0]?.[0])
  }

  upsertRollups(rollups: WindowRollup[]): void {
    for (const r of rollups) {
      this.db.run(
        `INSERT OR REPLACE INTO limit_window_rollups (provider, account_hash, window_kind, window_end, peak_pct, hit, coverage)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [r.provider, r.accountHash, r.windowKind, r.windowEnd, r.peakPct, r.hit ? 1 : 0, r.coverage],
      )
    }
  }

  rollups(windowKind: LimitWindowKind, sinceMs: number): WindowRollup[] {
    const kind = windowKind.replace(/[^a-z_]/g, '')
    const rows = this.db.exec(
      `SELECT provider, account_hash, window_kind, window_end, peak_pct, hit, coverage FROM limit_window_rollups
       WHERE window_kind = '${kind}' AND window_end >= ${Math.floor(sinceMs)} ORDER BY window_end ASC`,
    )
    return (rows[0]?.values ?? []).map(v => ({
      provider: v[0] as LimitProvider,
      accountHash: String(v[1] ?? ''),
      windowKind: v[2] as LimitWindowKind,
      windowEnd: Number(v[3]),
      peakPct: Number(v[4]),
      hit: Number(v[5]) === 1,
      coverage: v[6] === 'full' ? 'full' : 'partial',
    }))
  }

  /** Readings and hits follow trace retention; rollups are kept ROLLUP_RETENTION_DAYS. */
  deleteOlderThan(retentionDays: number, now = Date.now()): void {
    const cutoff = now - retentionDays * 86_400_000
    const rollupCutoff = now - Math.max(retentionDays, ROLLUP_RETENTION_DAYS) * 86_400_000
    this.db.run('DELETE FROM limit_readings WHERE observed_at < ?', [cutoff])
    this.db.run('DELETE FROM limit_hits WHERE hit_at < ?', [cutoff])
    this.db.run('DELETE FROM limit_window_rollups WHERE window_end < ?', [rollupCutoff])
  }
}
