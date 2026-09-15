/**
 * SQLite-backed cache for the survival index's per-file blame (AL 06).
 *
 * A file's blame is only re-run when its blob sha (content) has changed since the last time it
 * was cached — so a new commit only pays the blame cost for the files it actually touched,
 * instead of every file in the tree. Only aggregate counts keyed by commit sha are stored, never
 * blame output or file content.
 */

import type { FileBlameCache } from '../cloud/turnover/survival'

interface WriteableDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

export class FileBlameRepository implements FileBlameCache {
  constructor(private readonly db: WriteableDb, private readonly repoRoot: string) {}

  get(filePath: string): { blobSha: string; origins: Record<string, number> } | undefined {
    const escapedRoot = this.repoRoot.replace(/'/g, "''")
    const escapedPath = filePath.replace(/'/g, "''")
    const rows = this.db.exec(
      `SELECT blob_sha, origins_json FROM file_blame WHERE repo_root = '${escapedRoot}' AND file_path = '${escapedPath}'`,
    )
    if (!rows[0] || rows[0].values.length === 0) return undefined
    const [blobSha, originsJson] = rows[0].values[0]
    try {
      return { blobSha: String(blobSha), origins: JSON.parse(String(originsJson)) as Record<string, number> }
    } catch {
      return undefined
    }
  }

  put(filePath: string, blobSha: string, origins: Record<string, number>): void {
    this.db.run(
      `INSERT OR REPLACE INTO file_blame (repo_root, file_path, blob_sha, origins_json, computed_at) VALUES (?, ?, ?, ?, ?)`,
      [this.repoRoot, filePath, blobSha, JSON.stringify(origins), Date.now()],
    )
  }

  /** Drops cached rows for files no longer present at HEAD (renamed/deleted) — keeps the table
   *  from growing forever across a repo's history. */
  pruneExcept(filePaths: string[]): void {
    const escapedRoot = this.repoRoot.replace(/'/g, "''")
    if (filePaths.length === 0) {
      this.db.run(`DELETE FROM file_blame WHERE repo_root = '${escapedRoot}'`)
      return
    }
    const placeholders = filePaths.map(() => '?').join(',')
    this.db.run(
      `DELETE FROM file_blame WHERE repo_root = ? AND file_path NOT IN (${placeholders})`,
      [this.repoRoot, ...filePaths],
    )
  }
}
