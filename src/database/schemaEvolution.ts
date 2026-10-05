/**
 * Schema evolution for the SQLite stores: the editor's traceroost.db (db.ts) and the standalone
 * server's outcomes-cache.db (standalone/db/outcomesDb.ts). Both run `CREATE TABLE IF NOT EXISTS`
 * schemas, which never add a column to a table that already exists — so a column added to a table
 * that survives a trace-store rebuild (traceStore.ts keeps everything that isn't trace data) has to
 * be added here, or the next `INSERT INTO <table> (..., new_column)` fails on every existing store.
 */

export interface SchemaDb {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns?: string[]; values: unknown[][] }>
}

/** A column a store written before it existed must gain on open. `ddl` is everything after the
 *  column name (`TEXT`, `INTEGER NOT NULL DEFAULT 0`, …). SQLite's ALTER TABLE ADD COLUMN takes a
 *  constant default only, so a NOT NULL column needs a DEFAULT. */
export interface ColumnMigration {
  table: string
  column: string
  ddl: string
}

/** The columns `table` has right now (empty when the table doesn't exist). */
export function tableColumns(db: SchemaDb, table: string): string[] {
  return (db.exec(`PRAGMA table_info(${quoteIdent(table)})`)[0]?.values ?? []).map(r => String(r[1]))
}

/**
 * Adds `column` to `table` unless the table already has it. Returns true when the column was
 * added, false when it was already there — or when the table doesn't exist yet, in which case the
 * caller's schema creates it with the column in place.
 */
export function ensureColumn(db: SchemaDb, table: string, column: string, ddl: string): boolean {
  const cols = tableColumns(db, table)
  if (cols.length === 0 || cols.includes(column)) return false
  db.run(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(column)} ${ddl}`)
  return true
}

/** ensureColumn() for every entry; returns the ones that were actually added. */
export function ensureColumns(db: SchemaDb, migrations: readonly ColumnMigration[]): ColumnMigration[] {
  return migrations.filter(m => ensureColumn(db, m.table, m.column, m.ddl))
}

/**
 * A warning when the store on disk was written by a newer build than this one (its `PRAGMA
 * user_version` is above the version this build stamps), null otherwise. The older build keeps
 * running — a downgrade is usually deliberate — but it may miss columns or keys the newer one
 * relies on, so the log should say so rather than let it fail somewhere unrelated later.
 */
export function storeDowngradeWarning(db: SchemaDb, currentVersion: number, storeName = 'local trace store'): string | null {
  const onDisk = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0)
  if (!(onDisk > currentVersion)) return null
  return `The ${storeName} was written by a newer TraceRoost (store version ${onDisk}; this build writes ${currentVersion}). ` +
    'Running anyway — if traces look wrong, upgrade back, or clear the store and let it rebuild.'
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
