import * as assert from 'assert'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, stripAntigravityEnvelope, antigravityToolFiles, ANTIGRAVITY_PLACEHOLDER_MODEL, type OpenCodeSqlFactory, type LogSessionResult } from '../logReader'
import { derivedTraceKey, SOURCE_RANK_FULL_TRANSCRIPT, SOURCE_RANK_PARTIAL } from '../traceIdentity'
import { calcSessionCostUsd, lookupRates } from '../pricing'
import { encodeProto, type EncodeField } from '../adapters/antigravity/proto'
import { antigravitySchemaFingerprint, type FileObservation } from '../adapters/classify'
import { sessionRollupPayload, type SessionRollupInput } from '../cloud/forward/buildSessionRollup'
import { validateRollupPayload } from '../cloud/forward/validate'
import type { RepoKeyContext } from '../repoKey'

// SYNTHETIC throughout: no real agy capture exists. Shapes follow agentsview's Antigravity CLI
// parser and tests (third-party evidence) — see src/adapters/antigravity/known.ts.

type SqlDb = { run(sql: string, params?: unknown[]): void; exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>; export(): Uint8Array; close(): void }
type SqlJs = { Database: new (data?: Uint8Array) => SqlDb }

async function loadSqlJs(): Promise<SqlJs> {
  const dir = path.dirname(require.resolve('sql.js'))
  const init = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<SqlJs>
  return init({ locateFile: (f: string) => path.join(dir, f) })
}

/** agy 1.0.7–1.0.10's DDL, byte-for-byte as agentsview recorded it from a real database. */
const AGY_DDL = [
  'CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))',
  'CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))',
  'CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))',
  'CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`))',
  'CREATE TABLE `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE INDEX `idx_steps_status` ON `steps`(`status`)',
  'CREATE INDEX `idx_steps_step_type` ON `steps`(`step_type`)',
]

const ID = 'c0ffee00-0000-4000-8000-000000000001'
const T0 = Date.parse('2026-11-01T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

function gen(usage: Array<[number, number]>, steps: number[], model?: { f19?: string; f21?: string }): Uint8Array {
  const chat: EncodeField[] = [[4, usage]]
  if (model?.f19) chat.push([19, model.f19])
  if (model?.f21) chat.push([21, model.f21])
  return encodeProto([[1, chat], [2, { packed: steps }]])
}
const executor = (last: number, name: string) => encodeProto([[3, last], [10, [[1, [[28, name]]]]]])

interface Conv {
  transcript?: Array<Record<string, unknown>>
  steps?: Record<number, number>
  gens?: Array<[number, Uint8Array]>
  executors?: Array<[number, Uint8Array]>
  history?: Array<Record<string, unknown>>
  lastConversations?: Record<string, string>
}

function writeConversation(sql: SqlJs, root: string, id: string, c: Conv): void {
  if (c.transcript) {
    const dir = path.join(root, 'brain', id, '.system_generated', 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), c.transcript.map(l => JSON.stringify(l)).join('\n') + '\n')
  }
  if (c.steps || c.gens) {
    const db = new sql.Database()
    for (const stmt of AGY_DDL) db.run(stmt)
    db.run('PRAGMA user_version = 1')
    for (const [idx, type] of Object.entries(c.steps ?? {})) db.run('INSERT INTO steps (idx, step_type) VALUES (?, ?)', [Number(idx), type])
    for (const [idx, data] of c.gens ?? []) db.run('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)', [idx, data, data.length])
    for (const [idx, data] of c.executors ?? []) db.run('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)', [idx, data])
    fs.mkdirSync(path.join(root, 'conversations'), { recursive: true })
    fs.writeFileSync(path.join(root, 'conversations', `${id}.db`), Buffer.from(db.export()))
    db.close()
  }
  if (c.history) fs.writeFileSync(path.join(root, 'history.jsonl'), c.history.map(h => JSON.stringify(h)).join('\n') + '\n')
  if (c.lastConversations) {
    fs.mkdirSync(path.join(root, 'cache'), { recursive: true })
    fs.writeFileSync(path.join(root, 'cache', 'last_conversations.json'), JSON.stringify(c.lastConversations))
  }
}

const ENVELOPE = '<USER_REQUEST>\nAdd a greeting helper\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-01T11:00:00+01:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting Model Selection from None to Gemini 3.7 Flash (High).\n</USER_SETTINGS_CHANGE>'

/** A two-prompt conversation with tokens for both turns. */
function fullConversation(): Conv {
  return {
    transcript: [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(T0), content: ENVELOPE },
      { step_index: 1, source: 'SYSTEM', type: 'CONVERSATION_HISTORY', status: 'DONE', created_at: iso(T0 + 1000) },
      // Out of step order on purpose — agy doesn't guarantee line order.
      { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(T0 + 6000), content: 'Done: greet() added.', thinking: 'Write it now.', tool_calls: [{ name: 'write_to_file', args: { TargetFile: '/w/demo/src/greet.ts' } }] },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(T0 + 3000), tool_calls: [{ name: 'view_file', args: { AbsolutePathURI: 'file:///w/demo/src/greet.ts' } }, { name: 'grep_search', args: { SearchPath: '/w/demo/src', Query: 'greet' } }] },
      { step_index: 3, source: 'SYSTEM', type: 'VIEW_FILE', status: 'DONE', created_at: iso(T0 + 4000) },
      { step_index: 5, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(T0 + 300_000), content: 'Now run the tests' },
      { step_index: 6, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(T0 + 302_000), tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm test', Cwd: '/w/demo' } }] },
      { step_index: 7, source: 'SYSTEM', type: 'RUN_COMMAND', status: 'DONE', created_at: iso(T0 + 310_000) },
      { step_index: 8, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(T0 + 312_000), content: 'All tests pass.' },
    ],
    steps: { 0: 14, 1: 21, 2: 15, 3: 17, 4: 15, 5: 14, 6: 15, 7: 17, 8: 15 },
    gens: [
      [1, gen([[1, 1020], [2, 2400], [3, 180]], [2], { f19: 'gemini-3.7-flash-exp-b' })],
      [2, gen([[1, 1020], [2, 300], [3, 220], [5, 2400]], [4], { f19: 'gemini-3.7-flash' })],
      // A failed/retried attempt: all-zero usage is skipped.
      [3, gen([[1, 1020], [2, 0], [3, 0]], [6], { f19: 'gemini-3.7-flash' })],
      [4, gen([[1, 1020], [2, 500], [3, 300], [5, 3000]], [6, 7], { f19: 'gemini-3.7-flash' })],
      [5, gen([[1, 1020], [2, 120], [3, 60], [5, 3500]], [8], { f21: 'Gemini 3.7 Flash (High)' })],
    ],
    executors: [[1, executor(4, 'gemini-3.7-flash-high')], [2, executor(8, 'gemini-3.7-flash-medium')]],
    history: [
      { display: 'Add a greeting helper', timestamp: T0, workspace: '/w/demo', conversationId: ID },
      { display: 'Now run the tests', timestamp: T0 + 300_400, workspace: '/w/demo', conversationId: ID },
    ],
  }
}

/** What a scan reads of Antigravity alone (scan() would also read this machine's other agents). */
function scanAgy(r: LogReader): LogSessionResult[] {
  return r.collectFileMeta().filter(m => m.agentKey === 'antigravity').flatMap(m => r.parseFile(m.filePath, m.agentKey))
}

suite('LogReader — Antigravity CLI (synthetic)', () => {
  let sql: SqlJs
  let root: string
  let prevEnv: string | undefined
  suiteSetup(async () => { sql = await loadSqlJs() })
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-agy-'))
    prevEnv = process.env['ANTIGRAVITY_CLI_DIR']
    process.env['ANTIGRAVITY_CLI_DIR'] = root
  })
  teardown(() => {
    if (prevEnv === undefined) delete process.env['ANTIGRAVITY_CLI_DIR']
    else process.env['ANTIGRAVITY_CLI_DIR'] = prevEnv
    fs.rmSync(root, { recursive: true, force: true })
  })

  const reader = (observe?: (f: string, o: FileObservation) => void) => new LogReader({ sqlFactory: sql as unknown as OpenCodeSqlFactory, observe })
  const byStart = (rs: LogSessionResult[]) => [...rs].sort((a, b) => a.card.startTime.localeCompare(b.card.startTime))

  test('one trace per prompt: keys, prompts, times, tokens, models, files and tools', () => {
    writeConversation(sql, root, ID, fullConversation())
    const [t1, t2] = byStart(scanAgy(reader()))
    assert.ok(t1 && t2)

    assert.strictEqual(t1.card.sessionId, derivedTraceKey('antigravity', ID, 'step:0'))
    assert.strictEqual(t2.card.sessionId, derivedTraceKey('antigravity', ID, 'step:5'))
    for (const r of [t1, t2]) {
      assert.strictEqual(r.card.source, 'antigravity')
      assert.strictEqual(r.card.conversationId, ID)
      assert.strictEqual(r.card.derived, true)
      assert.strictEqual(r.card.sourceRank, SOURCE_RANK_FULL_TRANSCRIPT)
      assert.strictEqual(r.workspace, '/w/demo')
    }
    assert.strictEqual(t1.card.userRequest, 'Add a greeting helper')
    assert.strictEqual(t1.card.startTime, iso(T0))
    assert.strictEqual(t1.card.durationMs, 6000)

    // Turn 1: generations 1 and 2 (uncached 2700, output 400 — thinking already in it, cache read 2400).
    assert.strictEqual(t1.card.turns, 2)
    assert.strictEqual(t1.card.inputTokens, 2700 + 2400)
    assert.strictEqual(t1.card.outputTokens, 400)
    assert.strictEqual(t1.card.cacheReadTokens, 2400)
    assert.strictEqual(t1.card.cacheCreateTokens, 0)
    // -exp-b stripped, matched to the covering executor's effort-qualified name.
    assert.strictEqual(t1.card.model, 'gemini-3.7-flash-high')
    // Turn 2: the zero-usage generation is skipped; 4 resolves against the second executor, 5 keeps
    // its display name.
    assert.strictEqual(t2.card.turns, 2)
    assert.strictEqual(t2.card.inputTokens, 620 + 6500)
    assert.strictEqual(t2.card.outputTokens, 360)
    assert.deepStrictEqual([...(t2.card.models ?? [])].sort(), ['Gemini 3.7 Flash (High)', 'gemini-3.7-flash-medium'])

    assert.deepStrictEqual(t1.card.filesRead, ['/w/demo/src/greet.ts'])
    assert.deepStrictEqual(t1.card.filesChanged, ['/w/demo/src/greet.ts'])
    assert.deepStrictEqual(t1.card.filesWritten, ['/w/demo/src/greet.ts'])
    assert.deepStrictEqual(t1.card.filesSearched, ['/w/demo/src'])
    assert.deepStrictEqual(t1.card.toolCounts, { view_file: 1, grep_search: 1, write_to_file: 1 })
    assert.deepStrictEqual(t2.card.toolCounts, { run_command: 1 })

    const tools = t1.card.timeline.filter(e => e.type === 'tool')
    assert.strictEqual(tools.length, 3)
    for (const e of tools) { assert.strictEqual(e.isError, false); assert.strictEqual(e.durationMs, 0); assert.strictEqual(e.resultSummary, undefined) }
    const llm = t1.card.timeline.filter(e => e.type === 'llm')
    assert.deepStrictEqual(llm.map(e => [e.inputTokens, e.outputTokens, e.cacheReadTokens]), [[2400, 180, 0], [2700, 220, 2400]])
    assert.strictEqual(llm[1].responseText, 'Done: greet() added.')
    assert.strictEqual(llm[1].thinking, 'Write it now.')
    // The timeline is in time order even though the transcript lines weren't.
    const times = t1.card.timeline.map(e => Date.parse(e.timestamp))
    assert.deepStrictEqual(times, [...times].sort((a, b) => a - b))

    // Priced at the Gemini rate whatever effort was picked.
    assert.ok(calcSessionCostUsd(t1.card) > 0)
    assert.ok(calcSessionCostUsd(t2.card) > 0)
  })

  test('without the conversation database: no tokens, an unpriced placeholder model, partial rank', () => {
    const c = fullConversation()
    writeConversation(sql, root, ID, { transcript: c.transcript, history: c.history })
    const rs = byStart(scanAgy(reader()))
    assert.strictEqual(rs.length, 2)
    for (const { card } of rs) {
      assert.strictEqual(card.inputTokens + card.outputTokens + card.cacheReadTokens, 0)
      assert.strictEqual(card.model, ANTIGRAVITY_PLACEHOLDER_MODEL)
      assert.strictEqual(lookupRates(card.model), null, 'the placeholder must match no rate, so cost reads unknown')
      assert.strictEqual(card.sourceRank, SOURCE_RANK_PARTIAL)
    }
    // LLM calls fall back to the planner steps; tools and files still come from the transcript.
    assert.strictEqual(rs[0].card.turns, 2)
    assert.deepStrictEqual(rs[0].card.filesChanged, ['/w/demo/src/greet.ts'])
  })

  test('the same without sql.js: the transcript alone still reads', () => {
    writeConversation(sql, root, ID, fullConversation())
    const rs = scanAgy(new LogReader())
    assert.strictEqual(rs.length, 2)
    for (const { card } of rs) assert.strictEqual(card.sourceRank, SOURCE_RANK_PARTIAL)
  })

  test('a prompt the transcript has not caught up with opens a turn from the database, its text from history', () => {
    const c = fullConversation()
    c.steps = { ...c.steps, 9: 14 }
    c.history = [...c.history!, { display: 'And commit it', timestamp: T0 + 600_000, workspace: '/w/demo', conversationId: ID }]
    writeConversation(sql, root, ID, c)
    const rs = byStart(scanAgy(reader()))
    assert.strictEqual(rs.length, 3)
    const t3 = rs[2]
    assert.strictEqual(t3.card.sessionId, derivedTraceKey('antigravity', ID, 'step:9'))
    assert.strictEqual(t3.card.userRequest, 'And commit it')
    assert.strictEqual(t3.card.startTime, iso(T0 + 600_000))
    assert.strictEqual(t3.card.sourceRank, SOURCE_RANK_PARTIAL)
  })

  test('workspace: last_conversations.json wins over history; older rows match by text within 60 s', () => {
    const c = fullConversation()
    writeConversation(sql, root, ID, { ...c, lastConversations: { '/w/newer': ID } })
    assert.ok(scanAgy(reader()).every(r => r.workspace === '/w/newer'))

    fs.rmSync(path.join(root, 'cache'), { recursive: true })
    // History rows from before agy recorded a conversationId: matched by prompt text, ±60 s, only
    // when unambiguous. A relative path is never a workspace.
    fs.writeFileSync(path.join(root, 'history.jsonl'), [
      { display: 'Now run the tests', timestamp: T0 + 330_000, workspace: '/w/legacy' },
      { display: 'Add a greeting helper', timestamp: T0 + 10_000, workspace: 'relative/dir' },
    ].map(h => JSON.stringify(h)).join('\n') + '\n')
    const rs = byStart(scanAgy(reader()))
    assert.ok(rs.length > 0 && rs.every(r => r.workspace === '/w/legacy'), JSON.stringify(rs.map(r => r.workspace)))
    // Without history the prompt is the transcript's, envelope removed.
    assert.strictEqual(rs[0].card.userRequest, 'Add a greeting helper')
  })

  test('an unchanged conversation is not read again; a new step re-reads only what changed', () => {
    writeConversation(sql, root, ID, fullConversation())
    const r = reader()
    assert.strictEqual(scanAgy(r).length, 2)
    assert.strictEqual(scanAgy(r).length, 0)
    const t = path.join(root, 'brain', ID, '.system_generated', 'logs', 'transcript.jsonl')
    fs.appendFileSync(t, JSON.stringify({ step_index: 9, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(T0 + 320_000), content: 'Committed.' }) + '\n')
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(t, later, later)
    const changed = scanAgy(r)
    assert.deepStrictEqual(changed.map(x => x.card.sessionId), [derivedTraceKey('antigravity', ID, 'step:5')])
  })

  test('the periodic scan reads Antigravity conversations too, once', () => {
    writeConversation(sql, root, ID, fullConversation())
    const r = reader() as unknown as { _scanAntigravity(): LogSessionResult[] }
    assert.strictEqual(r._scanAntigravity().length, 2)
    assert.strictEqual(r._scanAntigravity().length, 0)
  })

  test('collectFileMeta lists one entry per conversation, and parseFile reads it', () => {
    writeConversation(sql, root, ID, fullConversation())
    writeConversation(sql, root, 'd00d0000-0000-4000-8000-000000000002', { steps: { 0: 14, 1: 15 }, gens: [[1, gen([[1, 1020], [2, 10], [3, 5]], [1], { f19: 'gemini-3.7-flash' })]] })
    // Ignored: encrypted streams, implicit conversations, third-party decodes.
    fs.writeFileSync(path.join(root, 'conversations', 'e0000000-0000-4000-8000-000000000003.pb'), 'x')
    fs.writeFileSync(path.join(root, 'conversations', `${ID}.trajectory.json`), '{}')
    fs.mkdirSync(path.join(root, 'implicit'))
    fs.writeFileSync(path.join(root, 'implicit', 'f0000000-0000-4000-8000-000000000004.pb'), 'x')
    const r = reader()
    const meta = r.collectFileMeta().filter(m => m.agentKey === 'antigravity')
    assert.strictEqual(meta.length, 2)
    assert.ok(meta.some(m => m.filePath.endsWith('transcript.jsonl')))
    assert.ok(meta.some(m => m.filePath.endsWith('d00d0000-0000-4000-8000-000000000002.db')))
    const all = meta.flatMap(m => r.parseFile(m.filePath, m.agentKey))
    assert.strictEqual(all.length, 3)
    // A database-only conversation still yields its turn with tokens, no prompt text.
    const dbOnly = all.find(x => x.card.conversationId === 'd00d0000-0000-4000-8000-000000000002')!
    assert.strictEqual(dbOnly.card.outputTokens, 5)
    assert.strictEqual(dbOnly.card.userRequest, '')
  })

  test('adapter health: transcript records classified, schema fingerprint as the version', () => {
    writeConversation(sql, root, ID, fullConversation())
    const seen: FileObservation[] = []
    scanAgy(reader((_f, o) => seen.push(o)))
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].adapter, 'antigravity')
    assert.strictEqual(seen[0].version, '1.0.7–1.0.10')
    assert.deepStrictEqual(seen[0].unknownNames, {})
    assert.strictEqual(seen[0].known, 6)     // 2 USER_INPUT + 4 PLANNER_RESPONSE
    assert.strictEqual(seen[0].ignored, 3)   // CONVERSATION_HISTORY, VIEW_FILE, RUN_COMMAND
    assert.strictEqual(seen[0].turns, 2)
  })

  test('the known DDL hashes to the published fingerprint; any other schema is labelled by its own', () => {
    const db = new sql.Database()
    for (const stmt of AGY_DDL) db.run(stmt)
    db.run('PRAGMA user_version = 1')
    assert.strictEqual(antigravitySchemaFingerprint(db), '1ca98426f561fe73223c8620a238405030fdb3014444d970e1300a6009f72f43')
    db.close()

    const moved = new sql.Database()
    moved.run('CREATE TABLE `steps` (`idx` integer,`step_type` integer,PRIMARY KEY (`idx`))')
    moved.run('PRAGMA user_version = 2')
    fs.mkdirSync(path.join(root, 'conversations'), { recursive: true })
    fs.writeFileSync(path.join(root, 'conversations', `${ID}.db`), Buffer.from(moved.export()))
    const fp = antigravitySchemaFingerprint(moved)!
    moved.close()
    const seen: FileObservation[] = []
    scanAgy(reader((_f, o) => seen.push(o)))
    assert.strictEqual(seen[0].version, `agy-schema:${fp.slice(0, 12)}`)
    // The tables the reader needs are reported missing — damage, not silence.
    assert.ok(seen[0].unknownNames['table gen_metadata missing'])
    assert.ok(seen[0].unknownNames['table executor_metadata missing'])
  })

  test('privacy: an Antigravity trace builds a rollup with agent antigravity and no prompt, text or path', () => {
    const c = fullConversation()
    c.history = c.history!.map(h => ({ ...h, display: `${String(h['display'])} SECRET_PROMPT_7c1` }))
    for (const l of c.transcript!) if (l['type'] === 'PLANNER_RESPONSE') { l['content'] = 'SECRET_ANSWER_7c1'; l['thinking'] = 'SECRET_THOUGHT_7c1' }
    writeConversation(sql, root, ID, c)
    const ctx: RepoKeyContext = { root: '/w/demo', key: crypto.createHash('sha256').update('k').digest() }
    for (const { card } of scanAgy(reader())) {
      const payload = sessionRollupPayload(card as unknown as SessionRollupInput, { repoKey: ctx, branch: 'main', outcome: 'unknown', hostId: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f' })
      assert.strictEqual(payload.session?.agent, 'antigravity')
      assert.deepStrictEqual(validateRollupPayload(payload), [])
      const s = JSON.stringify(payload)
      for (const leak of ['SECRET_PROMPT_7c1', 'SECRET_ANSWER_7c1', 'SECRET_THOUGHT_7c1', '/w/demo', 'greet.ts', 'pnpm test']) {
        assert.ok(!s.includes(leak), `${leak} leaked into the rollup: ${s}`)
      }
    }
  })
})

suite('Antigravity helpers', () => {
  test('stripAntigravityEnvelope removes exactly the full envelope', () => {
    assert.strictEqual(stripAntigravityEnvelope(ENVELOPE), 'Add a greeting helper')
    // Without the optional settings block, CRLF framing.
    assert.strictEqual(stripAntigravityEnvelope('<USER_REQUEST>\r\n  two\n  lines\r\n</USER_REQUEST>\r\n<ADDITIONAL_METADATA>t</ADDITIONAL_METADATA>\r\n'), '  two\n  lines')
    // Incomplete envelope, trailing text, an empty request, literal tags: kept as written.
    for (const keep of [
      '<USER_REQUEST>\nhi\n</USER_REQUEST>',
      '<USER_REQUEST>hi</USER_REQUEST><ADDITIONAL_METADATA>m</ADDITIONAL_METADATA> and more',
      '<USER_REQUEST>\n \n</USER_REQUEST>\n<ADDITIONAL_METADATA>m</ADDITIONAL_METADATA>',
      'Explain what <USER_REQUEST> means',
    ]) assert.strictEqual(stripAntigravityEnvelope(keep), keep)
  })

  test('antigravityToolFiles maps the observed tool names and argument keys', () => {
    assert.deepStrictEqual(antigravityToolFiles('view_file', { AbsolutePath: '/a/b.ts' }), { read: '/a/b.ts' })
    assert.deepStrictEqual(antigravityToolFiles('view_file', { AbsolutePathURI: 'file:///a/b%20c.ts' }), { read: '/a/b c.ts' })
    assert.deepStrictEqual(antigravityToolFiles('write_to_file', { TargetFile: '/a/n.ts' }), { changed: '/a/n.ts', written: '/a/n.ts' })
    assert.deepStrictEqual(antigravityToolFiles('replace_file_content', { file_path: '/a/e.ts' }), { changed: '/a/e.ts' })
    assert.deepStrictEqual(antigravityToolFiles('multi_replace_file_content', { path: '/a/m.ts' }), { changed: '/a/m.ts' })
    assert.deepStrictEqual(antigravityToolFiles('grep_search', { SearchPath: '/a' }), { searched: '/a' })
    assert.deepStrictEqual(antigravityToolFiles('list_dir', { DirectoryPath: '/a' }), {})
    assert.deepStrictEqual(antigravityToolFiles('run_command', { CommandLine: 'ls' }), {})
  })
})
