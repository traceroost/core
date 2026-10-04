import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, type OpenCodeSqlFactory } from '../logReader'
import { derivedTraceKey } from '../traceIdentity'

// Coverage for LogReader paths the per-agent suites don't reach: the Copilot CLI events.jsonl
// parser, on-disk discovery (collectFileMeta) including the Windows %APPDATA% candidates, the
// legacy Copilot Chat <uuid>.json snapshot format, and OpenCode's WAL merge + part-table parsing.

function writeJsonl(filePath: string, lines: Array<Record<string, unknown> | string>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n')
}

const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_DATA_DIR'] as const

/** Points every agent-log location LogReader probes at `home`, optionally pretending to be another OS. */
function withFakeHome<T>(home: string, platform: NodeJS.Platform, extraEnv: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!
  for (const k of ENV_KEYS) delete process.env[k]
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  Object.assign(process.env, extraEnv)
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', platformDesc)
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

suite('LogReader — Copilot CLI (events.jsonl)', () => {
  let tmp: string
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-copilot-cli-')) })
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('builds a card from a full session: tokens from shutdown modelMetrics, tools, files, prompt', () => {
    const sessionId = '0f6c2b8e-1111-4c3e-9e0a-1234567890ab'
    const eventsFile = path.join(tmp, sessionId, 'events.jsonl')
    writeJsonl(eventsFile, [
      { type: 'session.start', timestamp: '2026-09-01T10:00:00.000Z', data: { selectedModel: 'claude-sonnet-4.5', context: { cwd: '/work/app' } } },
      { type: 'user.message', timestamp: '2026-09-01T10:00:01.000Z', data: {
        transformedContent: '<current_datetime>2026-09-01</current_datetime>\n<system_reminder>\nbe careful\n</system_reminder>\nFix the login bug\nsecond line',
      } },
      '{ this line is not json',
      { type: 'assistant.message', timestamp: '2026-09-01T10:00:05.000Z', data: {
        outputTokens: 120,
        toolRequests: [
          { name: 'edit', arguments: { path: '/work/app/src/login.ts' } },
          { name: 'create', arguments: { file_path: '/work/app/src/new.ts' } },
          { name: 'view', arguments: { path: '/work/app/README.md' } },
          { name: '' },
        ],
      } },
      // A later message only sets model when present, and a zero-token message is not a turn.
      { type: 'assistant.message', timestamp: '2026-09-01T10:00:09.000Z', data: { outputTokens: 0, model: 'gpt-5' } },
      { type: 'assistant.message', timestamp: '2026-09-01T10:00:10.000Z', data: { outputTokens: 30 } },
      { type: 'session.shutdown', timestamp: '2026-09-01T10:05:00.000Z', data: {
        currentTokens: 987654,  // context-window size at shutdown — must NOT be used as input
        modelMetrics: {
          'claude-sonnet-4.5': { usage: { inputTokens: 1000, cacheReadTokens: 400, cacheWriteTokens: 50 } },
          'gpt-5':             { usage: { inputTokens: 200 } },
          'broken':            {},
        },
      } },
    ])

    const results = new LogReader().parseFile(eventsFile, 'copilot')
    assert.strictEqual(results.length, 1)
    const { card, workspace } = results[0]
    // One prompt → one trace; the format has no turn id, so the key is derived from the session
    // (directory name) plus the prompt event's timestamp.
    assert.strictEqual(card.sessionId, derivedTraceKey('copilot', sessionId, '2026-09-01T10:00:01.000Z'))
    assert.strictEqual(card.conversationId, sessionId)
    assert.strictEqual(card.derived, true)
    assert.strictEqual(card.source, 'copilot')
    assert.strictEqual(card.dataSource, 'log')
    assert.strictEqual(workspace, '/work/app')
    assert.strictEqual(card.model, 'gpt-5')
    assert.strictEqual(card.userRequest, 'Fix the login bug')
    assert.strictEqual(card.turns, 2)
    assert.strictEqual(card.outputTokens, 150)
    assert.strictEqual(card.cacheReadTokens, 400)
    assert.strictEqual(card.cacheCreateTokens, 50)
    assert.strictEqual(card.inputTokens, 1000 + 200 + 400 + 50)
    assert.strictEqual(card.totalToolCalls, 3, 'nameless tool requests are ignored')
    assert.deepStrictEqual(card.toolCounts, { edit: 1, create: 1, view: 1 })
    assert.deepStrictEqual(card.filesChanged.sort(), ['/work/app/src/login.ts', '/work/app/src/new.ts'])
    // The turn runs from its prompt to its last reply — not from session.start, and not to the
    // session.shutdown that only says when the CLI was quit.
    assert.strictEqual(card.startTime, '2026-09-01T10:00:01.000Z')
    assert.strictEqual(card.durationMs, 9_000)
    assert.strictEqual(card.outcome, 'tool_calls')
  })

  test('an in-progress session (no shutdown yet) still yields a card with zero input tokens', () => {
    const eventsFile = path.join(tmp, 'sess-live', 'events.jsonl')
    writeJsonl(eventsFile, [
      { type: 'session.start', timestamp: '2026-09-01T10:00:00.000Z', data: {} },
      { type: 'user.message', timestamp: '2026-09-01T10:00:01.000Z', data: { transformedContent: 'hello' } },
      { type: 'assistant.message', timestamp: '2026-09-01T10:00:02.000Z', data: { outputTokens: 7 } },
    ])
    const [r] = new LogReader().parseFile(eventsFile, 'copilot')
    assert.strictEqual(r.card.model, 'copilot', 'falls back to the agent name when no model is recorded')
    assert.strictEqual(r.card.inputTokens, 0)
    assert.strictEqual(r.card.outputTokens, 7)
    assert.strictEqual(r.card.outcome, 'text_response')
    assert.strictEqual(r.workspace, '')
  })

  test('uses data.startTime when no event carries a timestamp', () => {
    const eventsFile = path.join(tmp, 'sess-start', 'events.jsonl')
    writeJsonl(eventsFile, [{ type: 'session.start', data: { startTime: '2026-09-02T08:00:00.000Z' } }])
    const [r] = new LogReader().parseFile(eventsFile, 'copilot')
    assert.strictEqual(r.card.startTime, '2026-09-02T08:00:00.000Z')
  })

  test('a file with no timestamps at all, only garbage, or only injected tags yields no card / empty prompt', () => {
    const noTs = path.join(tmp, 'a', 'events.jsonl')
    writeJsonl(noTs, [{ type: 'assistant.message', data: { outputTokens: 5 } }, 'not json'])
    assert.deepStrictEqual(new LogReader().parseFile(noTs, 'copilot'), [])

    const tagsOnly = path.join(tmp, 'b', 'events.jsonl')
    writeJsonl(tagsOnly, [
      { type: 'user.message', timestamp: '2026-09-01T10:00:00.000Z', data: { transformedContent: '<attachments>\nfoo\n</attachments>' } },
    ])
    const [r] = new LogReader().parseFile(tagsOnly, 'copilot')
    assert.strictEqual(r.card.userRequest, '')
  })

  test('an unchanged file is not re-parsed; a missing file yields nothing', () => {
    const eventsFile = path.join(tmp, 'c', 'events.jsonl')
    writeJsonl(eventsFile, [{ type: 'session.start', timestamp: '2026-09-01T10:00:00.000Z', data: {} }])
    const reader = new LogReader()
    assert.strictEqual(reader.parseFile(eventsFile, 'copilot').length, 1)
    assert.strictEqual(reader.parseFile(eventsFile, 'copilot').length, 0)
    assert.deepStrictEqual(reader.parseFile(path.join(tmp, 'nope', 'events.jsonl'), 'copilot'), [])
    assert.deepStrictEqual(reader.parseFile(eventsFile, 'opencode'), [], 'opencode is DB-scanned, not per-file')
    assert.deepStrictEqual(reader.parseFile(eventsFile, 'unknown-agent'), [])
  })
})

suite('LogReader — Copilot Chat legacy <uuid>.json snapshots', () => {
  let tmp: string
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-copilot-json-')) })
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  function writeSnapshot(data: Record<string, unknown>, folder?: string): string {
    const chatDir = path.join(tmp, 'hash1', 'chatSessions')
    fs.mkdirSync(chatDir, { recursive: true })
    if (folder !== undefined) fs.writeFileSync(path.join(tmp, 'hash1', 'workspace.json'), JSON.stringify({ folder }))
    const f = path.join(chatDir, 'legacy-session.json')
    fs.writeFileSync(f, JSON.stringify(data))
    return f
  }

  test('reads model, prompt (from parts), tool invocations and workspace', () => {
    const f = writeSnapshot({
      creationDate: Date.parse('2026-01-01T00:00:00.000Z'),
      lastMessageDate: Date.parse('2026-01-01T00:02:00.000Z'),
      requests: [
        { modelId: 'copilot/gpt-4.1', message: { parts: [{ text: '<context>x</context>' }, { text: '  Rename the helper  ' }] },
          response: [{ kind: 'toolInvocationSerialized', toolId: 'copilot_readFile' }, { kind: 'markdownContent' },
            { kind: 'toolInvocationSerialized', toolId: 'copilot_readFile' }, { kind: 'toolInvocationSerialized' }] },
        { message: { text: 'second prompt is ignored' }, response: 'not-an-array' },
      ],
    }, 'file:///home/me/my%20project')
    // One trace per request; these carry no requestId or timestamp, so keys are derived from the
    // chat id plus the request's position, and both start at the chat's creation.
    const [r, second] = new LogReader().parseFile(f, 'copilot_vscode_json')
    assert.strictEqual(r.card.sessionId, derivedTraceKey('copilot', 'legacy-session', '#0'))
    assert.strictEqual(r.card.conversationId, 'legacy-session')
    assert.strictEqual(r.card.model, 'gpt-4.1', 'copilot/ prefix is stripped')
    assert.strictEqual(r.card.userRequest, 'Rename the helper', 'parts starting with < are injected context, skipped')
    assert.strictEqual(r.card.turns, 1)
    assert.strictEqual(r.card.totalToolCalls, 3)
    assert.deepStrictEqual(r.card.toolCounts, { copilot_readFile: 2, unknown: 1 })
    assert.strictEqual(r.workspace, '/home/me/my project', 'folder URI is percent-decoded')
    assert.strictEqual(second.card.sessionId, derivedTraceKey('copilot', 'legacy-session', '#1'))
    assert.strictEqual(second.card.userRequest, 'second prompt is ignored')
    assert.strictEqual(second.card.durationMs, 120_000, 'the last request ends at lastMessageDate')
  })

  test('inputState.selectedModel wins over per-request modelId; snapshot sessionId wins over file name', () => {
    const f = writeSnapshot({
      sessionId: 'inner-id',
      creationDate: 1_700_000_000_000,
      inputState: { selectedModel: { id: 'copilot/claude-sonnet-4', metadata: { family: 'claude-sonnet-4' } } },
      requests: [{ modelId: 'copilot/gpt-4o', message: { text: 'hi' } }],
    })
    const [r] = new LogReader().parseFile(f, 'copilot_vscode_json')
    assert.strictEqual(r.card.conversationId, 'inner-id')
    assert.strictEqual(r.card.sessionId, derivedTraceKey('copilot', 'inner-id', '#0'))
    assert.strictEqual(r.card.model, 'claude-sonnet-4')
    assert.strictEqual(r.workspace, '', 'no workspace.json → empty workspace')
    assert.strictEqual(r.card.durationMs, 0, 'missing lastMessageDate falls back to creationDate')
  })

  test('a Windows drive-letter folder URI drops the leading slash on win32', () => {
    const f = writeSnapshot({ creationDate: 1_700_000_000_000, requests: [{ message: { text: 'x' } }] }, 'file:///c%3A/Users/Dev/repo')
    const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const [r] = new LogReader().parseFile(f, 'copilot_vscode_json')
      assert.strictEqual(r.workspace, 'c:/Users/Dev/repo')
    } finally {
      Object.defineProperty(process, 'platform', platformDesc)
    }
  })

  test('malformed, empty or undated snapshots yield nothing', () => {
    const reader = new LogReader()
    const chatDir = path.join(tmp, 'h', 'chatSessions')
    fs.mkdirSync(chatDir, { recursive: true })
    const cases: Array<[string, string]> = [
      ['bad.json', '{not json'],
      ['nodate.json', JSON.stringify({ requests: [{}] })],
      ['norequests.json', JSON.stringify({ creationDate: 1, requests: [] })],
    ]
    for (const [name, body] of cases) {
      const f = path.join(chatDir, name)
      fs.writeFileSync(f, body)
      assert.deepStrictEqual(reader.parseFile(f, 'copilot_vscode_json'), [], name)
    }
  })
})

suite('LogReader — log discovery (collectFileMeta / getWatchDirs)', () => {
  let home: string
  setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-home-')) })
  teardown(() => { fs.rmSync(home, { recursive: true, force: true }) })

  function touch(p: string, mtimeSec: number, body = '{}\n') {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
    fs.utimesSync(p, mtimeSec, mtimeSec)
  }

  test('finds every agent\'s logs under a Linux home, newest first, preferring .jsonl over a .json sibling', () => {
    const xdg = path.join(home, '.config')
    const claude = path.join(home, '.claude', 'projects', '-work-app', 'c1.jsonl')
    const codex = path.join(home, '.codex', 'sessions', '2026', '09', 'rollout-1.jsonl')
    const copilot = path.join(home, '.copilot', 'session-state', 'cp-1', 'events.jsonl')
    const chatDir = path.join(xdg, 'Code', 'User', 'workspaceStorage', 'abc', 'chatSessions')
    const vsJsonl = path.join(chatDir, 'both.jsonl')
    const vsJsonShadowed = path.join(chatDir, 'both.json')
    const vsJsonOnly = path.join(chatDir, 'old.json')
    const opencode = path.join(home, '.local', 'share', 'opencode', 'opencode.db')
    const cursor = path.join(home, '.cursor', 'projects', 'p', 'agent-transcripts', 'cu-1', 'cu-1.jsonl')
    touch(claude, 1_000)
    touch(codex, 6_000)
    touch(copilot, 3_000)
    touch(vsJsonl, 4_000)
    touch(vsJsonShadowed, 9_000)
    touch(vsJsonOnly, 5_000)
    touch(opencode, 2_000, '')
    touch(cursor, 7_000)
    // Noise that must be ignored: a non-jsonl file, a session dir without events.jsonl.
    touch(path.join(home, '.claude', 'projects', '-work-app', 'notes.txt'), 8_000)
    fs.mkdirSync(path.join(home, '.copilot', 'session-state', 'empty-session'), { recursive: true })

    const { meta, watch } = withFakeHome(home, 'linux', { XDG_CONFIG_HOME: xdg }, () => {
      const reader = new LogReader()
      return { meta: reader.collectFileMeta(), watch: reader.getWatchDirs() }
    })

    assert.deepStrictEqual(meta.map(m => [path.relative(home, m.filePath), m.agentKey]), [
      [path.relative(home, cursor), 'cursor'],
      [path.relative(home, codex), 'codex'],
      [path.relative(home, vsJsonOnly), 'copilot_vscode_json'],
      [path.relative(home, vsJsonl), 'copilot_vscode'],
      [path.relative(home, copilot), 'copilot'],
      [path.relative(home, opencode), 'opencode'],
      [path.relative(home, claude), 'claude'],
    ])
    assert.ok(!meta.some(m => m.filePath === vsJsonShadowed), '.json is skipped when a .jsonl for the same session exists')
    for (const dir of [path.join(home, '.claude', 'projects'), path.join(home, '.codex', 'sessions'),
      path.join(home, '.copilot', 'session-state'), path.join(xdg, 'Code', 'User', 'workspaceStorage')]) {
      assert.ok(watch.includes(dir), `watches ${dir}`)
    }
  })

  test('honours comma-separated CLAUDE_CONFIG_DIR / CODEX_HOME / OPENCODE_DATA_DIR overrides', () => {
    const c1 = path.join(home, 'claudeA')
    const c2 = path.join(home, 'claudeB', 'projects')  // already ends in projects — used as-is
    touch(path.join(c1, 'projects', 'p', 'a.jsonl'), 1_000)
    touch(path.join(c2, 'p', 'b.jsonl'), 2_000)
    touch(path.join(home, 'codexHome', 'sessions', 'x.jsonl'), 3_000)
    touch(path.join(home, 'oc', 'opencode.db'), 4_000, '')
    const meta = withFakeHome(home, 'linux', {
      CLAUDE_CONFIG_DIR: ` ${c1} ,, ${c2}`,
      CODEX_HOME: path.join(home, 'codexHome'),
      OPENCODE_DATA_DIR: path.join(home, 'oc'),
    }, () => new LogReader().collectFileMeta())
    assert.deepStrictEqual(meta.map(m => m.agentKey), ['opencode', 'codex', 'claude', 'claude'])
  })

  test('on Windows, probes %APPDATA% / %LOCALAPPDATA% locations for every agent', () => {
    const appData = path.join(home, 'AppData', 'Roaming')
    const localAppData = path.join(home, 'AppData', 'Local')
    touch(path.join(appData, 'Claude', 'projects', 'C--repo', 'w1.jsonl'), 1_000)
    touch(path.join(localAppData, 'Codex', 'sessions', 'w2.jsonl'), 2_000)
    touch(path.join(appData, 'Codex', 'sessions', 'w3.jsonl'), 3_000)
    touch(path.join(appData, 'copilot', 'session-state', 's1', 'events.jsonl'), 4_000)
    touch(path.join(appData, 'Code', 'User', 'workspaceStorage', 'h', 'chatSessions', 'w5.jsonl'), 5_000)
    touch(path.join(appData, 'opencode', 'opencode.db'), 6_000, '')
    touch(path.join(appData, 'Cursor', 'projects', 'p', 'agent-transcripts', 'w7', 'w7.jsonl'), 7_000)

    const meta = withFakeHome(home, 'win32', { APPDATA: appData, LOCALAPPDATA: localAppData },
      () => new LogReader().collectFileMeta())
    assert.deepStrictEqual(meta.map(m => [path.basename(m.filePath), m.agentKey]), [
      ['w7.jsonl', 'cursor'],
      ['opencode.db', 'opencode'],
      ['w5.jsonl', 'copilot_vscode'],
      ['events.jsonl', 'copilot'],
      ['w3.jsonl', 'codex'],
      ['w2.jsonl', 'codex'],
      ['w1.jsonl', 'claude'],
    ])
  })

  test('an empty home yields no files and no watch dirs', () => {
    const { meta, watch } = withFakeHome(home, 'linux', {}, () => {
      const r = new LogReader()
      return { meta: r.collectFileMeta(), watch: r.getWatchDirs() }
    })
    assert.deepStrictEqual(meta, [])
    assert.deepStrictEqual(watch, [])
  })

  test('scan() parses every discovered agent and only re-reads changed files', () => {
    const copilot = path.join(home, '.copilot', 'session-state', 'cp-scan', 'events.jsonl')
    writeJsonl(copilot, [{ type: 'session.start', timestamp: '2026-09-01T10:00:00.000Z', data: {} }])
    const chatDir = path.join(home, '.config', 'Code', 'User', 'workspaceStorage', 'h', 'chatSessions')
    fs.mkdirSync(chatDir, { recursive: true })
    fs.writeFileSync(path.join(chatDir, 'old-snap.json'), JSON.stringify({ creationDate: 1_700_000_000_000, requests: [{ message: { text: 'hi' } }] }))
    const { first, second } = withFakeHome(home, 'linux', {}, () => {
      const reader = new LogReader()
      return { first: reader.scan(), second: reader.scan() }
    })
    // One trace per turn, grouped under the session/chat it came from.
    assert.deepStrictEqual(first.map(r => r.card.conversationId).sort(), ['cp-scan', 'old-snap'])
    assert.deepStrictEqual(second, [])
  })
})

// ── OpenCode: WAL merge + part table ──────────────────────────────────────────

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  export(): Uint8Array
  close(): void
}

const OC_SCHEMA = `
  CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL DEFAULT '',
    directory TEXT NOT NULL DEFAULT '', model TEXT, time_created INTEGER NOT NULL DEFAULT 0,
    time_updated INTEGER NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
  CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL, time_created INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
`

function addSession(db: SqlDb, id: string, title: string) {
  db.run(`INSERT INTO session (id, title, directory, model, time_created, tokens_input, tokens_output)
          VALUES (?, ?, '/oc/proj', ?, 1704067200000, 100, 10)`,
  [id, title, JSON.stringify({ id: 'claude-sonnet-4-6' })])
}

const PAGE = 4096
const SALT1 = 0x11223344
const SALT2 = 0x55667788

/** SQLite's WAL checksum over `buf` (8-byte aligned), continuing from `seed`. Native byte
 *  order for magic 0x377f0682 is little-endian. */
function walChecksum(buf: Buffer, seed: [number, number]): [number, number] {
  let [s0, s1] = seed
  for (let i = 0; i < buf.length; i += 8) {
    s0 = (s0 + buf.readUInt32LE(i) + s1) >>> 0
    s1 = (s1 + buf.readUInt32LE(i + 4) + s0) >>> 0
  }
  return [s0, s1]
}

/** A SQLite WAL file whose frames carry every page of `db`, with valid cumulative checksums.
 *  `commit` marks the last frame as a commit frame (non-zero db-size field); `salt` lets a test
 *  fake a stale WAL generation; `badChecksum` corrupts the first frame's stored checksum. */
function buildWal(frames: Array<{ db: Uint8Array; commit: boolean; salt?: [number, number]; badChecksum?: boolean }>): Buffer {
  const hdr = Buffer.alloc(32)
  hdr.writeUInt32BE(0x377f0682, 0)
  hdr.writeUInt32BE(3007000, 4)
  hdr.writeUInt32BE(PAGE, 8)
  hdr.writeUInt32BE(SALT1, 16)
  hdr.writeUInt32BE(SALT2, 20)
  let ck = walChecksum(hdr.subarray(0, 24), [0, 0])
  hdr.writeUInt32BE(ck[0], 24)
  hdr.writeUInt32BE(ck[1], 28)
  const parts: Buffer[] = [hdr]
  for (const { db, commit, salt, badChecksum } of frames) {
    const nPages = db.length / PAGE
    for (let p = 1; p <= nPages; p++) {
      const fh = Buffer.alloc(24)
      const page = Buffer.from(db.subarray((p - 1) * PAGE, p * PAGE))
      fh.writeUInt32BE(p, 0)
      fh.writeUInt32BE(commit && p === nPages ? nPages : 0, 4)
      fh.writeUInt32BE(salt?.[0] ?? SALT1, 8)
      fh.writeUInt32BE(salt?.[1] ?? SALT2, 12)
      ck = walChecksum(page, walChecksum(fh.subarray(0, 8), ck))
      fh.writeUInt32BE(badChecksum && p === 1 ? ck[0] ^ 1 : ck[0], 16)
      fh.writeUInt32BE(ck[1], 20)
      parts.push(fh, page)
    }
  }
  return Buffer.concat(parts)
}

suite('LogReader — OpenCode WAL merge and parts', () => {
  let factory: OpenCodeSqlFactory
  let newDb: () => SqlDb
  let dataDir: string
  let savedEnv: string | undefined

  suiteSetup(async () => {
    const sqlJsDir = path.dirname(require.resolve('sql.js'))
    const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
    const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
    factory = SQL as unknown as OpenCodeSqlFactory
    newDb = () => new SQL.Database()
  })
  setup(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-oc-wal-'))
    savedEnv = process.env['OPENCODE_DATA_DIR']
    process.env['OPENCODE_DATA_DIR'] = dataDir
  })
  teardown(() => {
    if (savedEnv === undefined) delete process.env['OPENCODE_DATA_DIR']
    else process.env['OPENCODE_DATA_DIR'] = savedEnv
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  /** Main DB holds only `old`; returns [mainBytes, bytesAfterAddingNew]. */
  function twoGenerations(): [Uint8Array, Uint8Array] {
    const db = newDb()
    db.run(OC_SCHEMA)
    addSession(db, 'old', 'Checkpointed session')
    const before = db.export()
    addSession(db, 'new', 'Only in the WAL')
    const after = db.export()
    db.close()
    assert.strictEqual(before.length % PAGE, 0)
    return [before, after]
  }

  test('sessions committed to the -wal file are visible before OpenCode checkpoints', () => {
    const [main, walState] = twoGenerations()
    fs.writeFileSync(path.join(dataDir, 'opencode.db'), main)
    fs.writeFileSync(path.join(dataDir, 'opencode.db-wal'), buildWal([{ db: walState, commit: true }]))
    const ids = new LogReader({ sqlFactory: factory }).scanOpenCode().map(r => r.card.conversationId).sort()
    assert.deepStrictEqual(ids, ['new', 'old'])
  })

  test('frames from a stale WAL generation (salt mismatch) are ignored', () => {
    const [main, walState] = twoGenerations()
    fs.writeFileSync(path.join(dataDir, 'opencode.db'), main)
    fs.writeFileSync(path.join(dataDir, 'opencode.db-wal'), buildWal([{ db: walState, commit: true, salt: [1, 2] }]))
    const ids = new LogReader({ sqlFactory: factory }).scanOpenCode().map(r => r.card.conversationId)
    assert.deepStrictEqual(ids, ['old'])
  })

  test('frames after the last commit frame (an in-flight transaction) are not applied', () => {
    const db = newDb()
    db.run(OC_SCHEMA)
    addSession(db, 'old', 'Checkpointed session')
    const main = db.export()
    addSession(db, 'committed', 'Committed in the WAL')
    const committed = db.export()
    addSession(db, 'uncommitted', 'Still being written')
    const inFlight = db.export()
    db.close()
    fs.writeFileSync(path.join(dataDir, 'opencode.db'), main)
    fs.writeFileSync(path.join(dataDir, 'opencode.db-wal'),
      buildWal([{ db: committed, commit: true }, { db: inFlight, commit: false }]))
    const ids = new LogReader({ sqlFactory: factory }).scanOpenCode().map(r => r.card.conversationId).sort()
    assert.deepStrictEqual(ids, ['committed', 'old'])
  })

  test('a WAL with no commit frame, or a bad frame checksum, leaves the main DB as is', () => {
    const [main, walState] = twoGenerations()
    fs.writeFileSync(path.join(dataDir, 'opencode.db'), main)
    const read = () => new LogReader({ sqlFactory: factory }).scanOpenCode().map(r => r.card.conversationId)
    fs.writeFileSync(path.join(dataDir, 'opencode.db-wal'), buildWal([{ db: walState, commit: false }]))
    assert.deepStrictEqual(read(), ['old'])
    fs.writeFileSync(path.join(dataDir, 'opencode.db-wal'), buildWal([{ db: walState, commit: true, badChecksum: true }]))
    assert.deepStrictEqual(read(), ['old'])
  })

  test('a truncated or foreign -wal file is ignored rather than corrupting the read', () => {
    const [main] = twoGenerations()
    fs.writeFileSync(path.join(dataDir, 'opencode.db'), main)
    const bogus = Buffer.alloc(64, 0xab)
    fs.writeFileSync(path.join(dataDir, 'opencode.db-wal'), bogus)
    const ids = new LogReader({ sqlFactory: factory }).scanOpenCode().map(r => r.card.conversationId)
    assert.deepStrictEqual(ids, ['old'])
  })

  test('a newer WAL alone (same DB size) triggers a re-read', () => {
    const [main, walState] = twoGenerations()
    const dbPath = path.join(dataDir, 'opencode.db')
    fs.writeFileSync(dbPath, main)
    fs.utimesSync(dbPath, 1_000, 1_000)
    const reader = new LogReader({ sqlFactory: factory })
    assert.deepStrictEqual(reader.scanOpenCode().map(r => r.card.conversationId), ['old'])
    assert.deepStrictEqual(reader.scanOpenCode(), [], 'unchanged DB → skipped')
    const walPath = dbPath + '-wal'
    fs.writeFileSync(walPath, buildWal([{ db: walState, commit: true }]))
    fs.utimesSync(walPath, 2_000, 2_000)
    // Only turns whose card changed come back: the session already returned is not repeated.
    assert.deepStrictEqual(reader.scanOpenCode().map(r => r.card.conversationId).sort(), ['new'])
  })

  test('part rows feed prompt, tool counts, read/written files and tool error entries', () => {
    const db = newDb()
    db.run(OC_SCHEMA)
    addSession(db, 'sp', '')
    db.run(`INSERT INTO message (id, session_id, time_created, data) VALUES
      ('mu', 'sp', 1704067200000, '{"role":"user"}'),
      ('ma', 'sp', 1704067201000, '{"role":"assistant","time":{"created":1704067201000,"completed":1704067203000},"tokens":{"input":100,"output":10}}')`)
    const part = (id: string, msg: string, ts: number, data: unknown) =>
      db.run('INSERT INTO part (id, session_id, message_id, time_created, data) VALUES (?, ?, ?, ?, ?)', [id, 'sp', msg, ts, JSON.stringify(data)])
    part('p1', 'mu', 1704067200100, { type: 'text', text: 'Refactor the parser' })
    part('p2', 'ma', 1704067201100, { type: 'tool', tool: 'read', callID: 'c1', state: { input: { filePath: '/oc/proj/a.ts' }, output: 'contents', status: 'completed' } })
    part('p3', 'ma', 1704067201200, { type: 'tool', tool: 'Edit', callID: 'c2', state: { input: { filePath: '/oc/proj/b.ts' }, output: 'no match', status: 'error' } })
    part('p4', 'ma', 1704067201300, { type: 'tool', tool: 'bash', callID: 'c3', state: { input: { command: 'ls' }, status: 'completed' } })
    fs.writeFileSync(path.join(dataDir, 'opencode.db'), db.export())
    db.close()

    const [r] = new LogReader({ sqlFactory: factory }).scanOpenCode()
    assert.strictEqual(r.card.userRequest, 'Refactor the parser')
    assert.deepStrictEqual(r.card.toolCounts, { read: 1, Edit: 1, bash: 1 })
    assert.strictEqual(r.card.totalToolCalls, 3)
    assert.deepStrictEqual(r.card.filesRead, ['/oc/proj/a.ts'])
    assert.deepStrictEqual(r.card.filesChanged, ['/oc/proj/b.ts'])
    const tools = r.card.timeline.filter(e => e.type === 'tool')
    const edit = tools.find(e => e.action === 'Edit')!
    assert.strictEqual(edit.label, 'Edit: b.ts')
    assert.strictEqual(edit.isError, true)
    assert.strictEqual(edit.errorMessage, 'no match')
    assert.strictEqual(tools.find(e => e.action === 'bash')!.label, 'bash')
  })
})
