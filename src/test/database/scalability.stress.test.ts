/**
 * Stress test for .staged-issues/scalability.md — replaces "at some point this might be slow"
 * with real numbers at a realistic multi-year DB size, per that doc's Acceptance criteria. Its own
 * Notes section is explicit that risks #2 (incremental TraceRoostDb.save()) and #3 (DB-level
 * pagination for the main Sessions list) should NOT be built speculatively — only if this test
 * shows they matter. Risk #1 (LogReader.fileState persistence, see logReader.fileState.test.ts)
 * and risk #5 (a spanStore.ts-style safety valve, see sessionRepository.test.ts) are fixed
 * unconditionally and aren't gated on these numbers.
 */
import * as assert from 'assert'
import * as path from 'path'
import type * as vscode from 'vscode'
import { SCHEMA_SQL } from '../../database/schema'
import { DatabaseWriter } from '../../database/writer'
import { DatabaseReader } from '../../database/reader'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  export(): Uint8Array
  close(): void
}

async function openInMemoryDb(): Promise<SqlDb> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

function makeStorageUri(): vscode.Uri {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('vscode').Uri.file('/tmp/traceroost-scalability-stress')
}

function makeCard(i: number, startMs: number): SessionSummaryCard {
  return {
    sessionId: `sess-${i}`,
    traceId: `trace-${i}`,
    source: (['claude_code', 'codex', 'copilot', 'opencode'] as const)[i % 4],
    dataSource: 'otel',
    workspace: `/home/dev/repos/project-${i % 12}`,
    userRequest: `Realistic-length prompt text for session ${i} — fix the thing, add the feature, refactor the module, roughly a sentence or two of natural language the way a real prompt reads.`,
    model: 'claude-sonnet-5',
    turns: 3 + (i % 8),
    inputTokens: 1000 + (i % 5000),
    outputTokens: 200 + (i % 2000),
    cacheReadTokens: 500 + (i % 3000),
    cacheCreateTokens: 100 + (i % 1000),
    cacheHitRate: 0.4 + (i % 60) / 100,
    durationMs: 5000 + (i % 60000),
    startTime: new Date(startMs).toISOString(),
    filesRead: [`src/file${i % 20}.ts`, `src/other${i % 15}.ts`],
    filesSearched: [`src/*${i % 7}*`],
    filesChanged: [`src/file${i % 20}.ts`],
    filesWritten: [],
    filesChangedNote: undefined,
    toolCounts: { Bash: i % 5, Read: i % 10, Edit: i % 4 },
    totalToolCalls: (i % 5) + (i % 10) + (i % 4),
    totalLlmCalls: 2 + (i % 6),
    errors: i % 20 === 0 ? 1 : 0,
    outcome: 'text_response',
    timeline: Array.from({ length: 5 }, (_, j) => ({
      type: (j % 2 === 0 ? 'llm' : 'tool') as 'llm' | 'tool',
      spanId: `sess-${i}-span-${j}`,
      label: j % 2 === 0 ? 'LLM' : 'Bash',
      durationMs: 100 + j * 10,
      isError: false,
      timestamp: new Date(startMs + j * 1000).toISOString(),
    })),
    backgroundSpans: [],
    loopSignals: [],
  }
}

suite('Scalability stress test (synthetic multi-year DB)', () => {
  // ~2 years at ~10 sessions/day — the order of magnitude scalability.md's Acceptance asks for.
  const SESSION_COUNT = 2 * 365 * 10 // 7,300

  test('seeds a realistic multi-year DB and measures save() and listSessions() payload cost', async function () {
    this.timeout(120_000)

    const db = await openInMemoryDb()
    const writer = new DatabaseWriter(db, makeStorageUri(), () => { /* silent */ })

    const now = Date.now()
    const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000
    for (let i = 0; i < SESSION_COUNT; i++) {
      const startMs = now - twoYearsMs + Math.floor((i / SESSION_COUNT) * twoYearsMs)
      writer.enqueue(makeCard(i, startMs), `/home/dev/repos/project-${i % 12}`)
    }
    await writer.drain()

    const countResult = db.exec("SELECT COUNT(*) FROM sessions WHERE session_id NOT LIKE 'synth-%'")
    const seededCount = countResult[0]?.values[0]?.[0] as number
    assert.strictEqual(seededCount, SESSION_COUNT, 'sanity check: every seeded session landed')

    // ── Risk #2: TraceRoostDb.save() cost (full export() → fs.writeFileSync) ──────────────────
    const exportStart = performance.now()
    const exported = db.export()
    const exportMs = performance.now() - exportStart

    // ── Risk #3: webview payload — the full unfiltered listSessions() result, as posted whole
    // to the webview by `repository?.listSessions()` in extension.ts today ──────────────────────
    const reader = new DatabaseReader(db, makeStorageUri())
    const listStart = performance.now()
    const sessions = reader.listSessions()
    const listMs = performance.now() - listStart
    const serializeStart = performance.now()
    const payloadJson = JSON.stringify(sessions)
    const serializeMs = performance.now() - serializeStart

    const dbSizeMb = exported.byteLength / (1024 * 1024)
    const payloadSizeMb = Buffer.byteLength(payloadJson, 'utf-8') / (1024 * 1024)

    // eslint-disable-next-line no-console
    console.log(
      `[scalability-stress] ${SESSION_COUNT} sessions (~2yr @ 10/day):\n` +
      `  DB export() (save cost):   ${exportMs.toFixed(1)} ms, ${dbSizeMb.toFixed(2)} MB\n` +
      `  listSessions() query:      ${listMs.toFixed(1)} ms, ${sessions.length} rows\n` +
      `  JSON.stringify() payload:  ${serializeMs.toFixed(1)} ms, ${payloadSizeMb.toFixed(2)} MB`
    )

    // Regression guard, not a tight perf budget: these thresholds are generous multiples of what
    // was actually measured in the environment this test was written in (sub-second for both, at
    // this size) — they exist to catch a future change that makes either operation dramatically
    // worse, not to assert a specific number. See the doc's own Acceptance: this test's job is to
    // produce real numbers, not to pre-judge them.
    assert.ok(exportMs < 10_000, `db.export() took ${exportMs.toFixed(0)}ms for ${SESSION_COUNT} sessions — investigate before shipping if this regresses badly`)
    assert.ok(listMs < 10_000, `listSessions() took ${listMs.toFixed(0)}ms for ${SESSION_COUNT} sessions — investigate before shipping if this regresses badly`)
    assert.ok(dbSizeMb < 500, `DB export size (${dbSizeMb.toFixed(1)}MB) is approaching V8's string-length ceiling — the spanStore.ts-style safety valve (sessionRepository cap) needs a lower ceiling`)

    db.close()
  })
})
