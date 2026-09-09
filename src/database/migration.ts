import * as vscode from 'vscode'
import { summarizeSpans } from '../spanSummarizer'
import { DatabaseWriter } from './writer'
import type { Span } from '../types'

const MIGRATION_VERSION_KEY = 'traceRoost.dbMigrationVersion'
const SPANS_KEY = 'traceRoost.spans'
const CURRENT_VERSION = 1

/**
 * One-time migration: copies spans from globalState into SQLite, then clears
 * globalState. Idempotent — guarded by a version flag so it only runs once.
 * If the writer throws mid-way, globalState is left intact so the next
 * activation can retry.
 */
export async function migrateGlobalStateToSqlite(
  context: vscode.ExtensionContext,
  writer: DatabaseWriter,
  log: (msg: string) => void,
): Promise<void> {
  const migratedVersion = context.globalState.get<number>(MIGRATION_VERSION_KEY, 0)
  if (migratedVersion >= CURRENT_VERSION) {
    return
  }

  const spans = context.globalState.get<Span[]>(SPANS_KEY, [])
  if (spans.length === 0) {
    await context.globalState.update(MIGRATION_VERSION_KEY, CURRENT_VERSION)
    return
  }

  log(`TraceRoost migration: migrating ${spans.length} spans from globalState to SQLite…`)

  const { sessions } = summarizeSpans(spans)
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? ''

  for (const card of sessions) {
    writer.enqueue(card, workspace)
  }

  try {
    await writer.drain()
  } catch (err) {
    log(`TraceRoost migration: write error — globalState NOT cleared: ${err}`)
    return
  }

  await context.globalState.update(SPANS_KEY, [])
  await context.globalState.update(MIGRATION_VERSION_KEY, CURRENT_VERSION)
  log(`TraceRoost migration: migrated ${sessions.length} sessions; globalState cleared.`)
}
