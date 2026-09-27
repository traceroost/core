/**
 * A per-database counter of writes to the `sessions` table, so a reader can tell cheaply whether a
 * previous `listSessions()` result is still current (see SessionRepository's memo). Every code path
 * that inserts, replaces or deletes `sessions` rows calls `bumpSessionsVersion` on the same db
 * object it wrote to — today DatabaseWriter and runRetention. Keyed by the db object itself, so a
 * read-only snapshot (a different object, never written) keeps its own, never-changing version.
 */
const versions = new WeakMap<object, number>()

export function bumpSessionsVersion(db: object): void {
  versions.set(db, (versions.get(db) ?? 0) + 1)
}

export function sessionsVersion(db: object): number {
  return versions.get(db) ?? 0
}
