/**
 * SQLite persistence for the cohort turnover report (AL 06). One row per repository. Recompute
 * is skipped when `HEAD` has not moved since the stored row was computed. Only counts and a
 * rate are stored.
 */

import type { TurnoverReport } from '../turnover'

interface WriteableDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

export class TurnoverRepository {
  constructor(private readonly db: WriteableDb, private readonly repoRoot: string) {}

  private row(): { headSha: string; report: TurnoverReport } | null {
    const escaped = this.repoRoot.replace(/'/g, "''")
    const rows = this.db.exec(`SELECT head_sha, report_json FROM cohort_turnover WHERE repo_root = '${escaped}'`)
    if (!rows[0] || rows[0].values.length === 0) return null
    try {
      return { headSha: String(rows[0].values[0][0]), report: JSON.parse(String(rows[0].values[0][1])) as TurnoverReport }
    } catch {
      return null
    }
  }

  storedHeadSha(): string | null {
    return this.row()?.headSha ?? null
  }

  load(): TurnoverReport | null {
    return this.row()?.report ?? null
  }

  save(report: TurnoverReport): void {
    if (!report.headSha) return
    this.db.run(
      `INSERT OR REPLACE INTO cohort_turnover (repo_root, head_sha, report_json, computed_at) VALUES (?, ?, ?, ?)`,
      [this.repoRoot, report.headSha, JSON.stringify(report), Date.now()],
    )
  }
}
