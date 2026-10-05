/**
 * The Claude OTEL → transcript join decisions (claudeTurnJoin.ts), kept in the `claude_join` table
 * (schema.ts) so a decision outlives the process: the standalone server reloads its span window
 * on every start, and re-deciding an interaction against a transcript that has grown since could
 * flip its turn between the transcript turn's key and the claude:interaction fallback key — two
 * cloud rows for one turn. Shared by the editor's traceroost.db and the standalone server's
 * outcomes-cache.db. Opaque ids and keys only.
 */

import type { ClaudeJoinResult, ClaudeJoinStore } from '../claudeTurnJoin'

interface Db {
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

type Decided = ClaudeJoinResult & { status: 'joined' | 'derived' }

export class ClaudeJoinRepository implements ClaudeJoinStore {
  /** `onWrite` runs after each new decision is stored — a host's coalesced save. */
  constructor(private readonly db: Db, private readonly onWrite: () => void = () => { /* none */ }) {}

  get(interactionId: string): Decided | undefined {
    try {
      const row = this.db.exec('SELECT turn_key, status, derived FROM claude_join WHERE interaction_id = ?', [interactionId])[0]?.values[0]
      if (!row) return undefined
      const key = String(row[0])
      return row[1] === 'joined' ? { status: 'joined', key, derived: Number(row[2]) === 1 } : { status: 'derived', key }
    } catch {
      return undefined
    }
  }

  ownerOf(turnKey: string): string | undefined {
    try {
      const row = this.db.exec("SELECT interaction_id FROM claude_join WHERE turn_key = ? AND status = 'joined' LIMIT 1", [turnKey])[0]?.values[0]
      return row ? String(row[0]) : undefined
    } catch {
      return undefined
    }
  }

  put(interactionId: string, result: Decided): void {
    try {
      this.db.run(
        'INSERT OR REPLACE INTO claude_join (interaction_id, turn_key, status, derived, decided_at) VALUES (?, ?, ?, ?, ?)',
        [interactionId, result.key, result.status, result.status === 'joined' && result.derived ? 1 : 0, Date.now()],
      )
      this.onWrite()
    } catch { /* non-fatal: the decision still holds for this process */ }
  }

  /** Drops decisions made before `cutoffMs` — trace retention. */
  prune(cutoffMs: number): void {
    try { this.db.run('DELETE FROM claude_join WHERE decided_at < ?', [cutoffMs]) } catch { /* table absent */ }
  }
}
