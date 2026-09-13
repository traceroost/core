import * as assert from 'assert'
import * as path from 'path'
import type * as vscode from 'vscode'
import { SCHEMA_SQL } from '../../database/schema'
import { DatabaseWriter } from '../../database/writer'
import { migrateGlobalStateToSqlite } from '../../database/migration'
import type { Span } from '../../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  export(): Uint8Array
  close(): void
}

async function openDb(): Promise<SqlDb> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

function makeStorageUri(): vscode.Uri {
  return { scheme: 'file', path: '/tmp/traceroost-migration-test', fsPath: '/tmp/traceroost-migration-test' } as unknown as vscode.Uri
}

function makeMockContext(spans: Span[] = [], migrationVersion = 0): vscode.ExtensionContext {
  const state: Record<string, unknown> = {
    'traceRoost.spans': spans,
    'traceRoost.dbMigrationVersion': migrationVersion,
  }
  return {
    globalState: {
      get: (key: string, defaultVal?: unknown) => state[key] ?? defaultVal,
      update: async (key: string, val: unknown) => { state[key] = val },
      keys: () => Object.keys(state),
      setKeysForSync: () => {},
    },
  } as unknown as vscode.ExtensionContext
}

function makeSpan(traceId: string): Span {
  return {
    traceId,
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    name: 'invoke_agent',
    startTime: '1700000000000000000',
    endTime: '1700000005000000000',
    attributes: [
      { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
    ],
  }
}

function countRows(db: SqlDb, table: string): number {
  return (db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] as number) ?? 0
}

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('migrateGlobalStateToSqlite', () => {
  test('migration with empty globalState is a no-op', async () => {
    const db = await openDb()
    const ctx = makeMockContext([])
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    await migrateGlobalStateToSqlite(ctx, w, () => {})
    assert.strictEqual(countRows(db, 'sessions'), 0)
    assert.strictEqual(ctx.globalState.get('traceRoost.dbMigrationVersion'), 1)
    db.close()
  })

  test('migration with spans writes sessions to SQLite', async () => {
    const db = await openDb()
    const ctx = makeMockContext([makeSpan('trace-1'), makeSpan('trace-1')])
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    await migrateGlobalStateToSqlite(ctx, w, () => {})
    assert.ok(countRows(db, 'sessions') >= 1, 'expected at least 1 session row')
    db.close()
  })

  test('migration clears globalState after success', async () => {
    const db = await openDb()
    const ctx = makeMockContext([makeSpan('trace-2')])
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    await migrateGlobalStateToSqlite(ctx, w, () => {})
    assert.deepStrictEqual(ctx.globalState.get('traceRoost.spans'), [])
    db.close()
  })

  test('migration is idempotent — second run with version flag does nothing', async () => {
    const db = await openDb()
    const ctx = makeMockContext([makeSpan('trace-3')], 1)  // already migrated
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    await migrateGlobalStateToSqlite(ctx, w, () => {})
    assert.strictEqual(countRows(db, 'sessions'), 0, 'should not write when already migrated')
    db.close()
  })
})
