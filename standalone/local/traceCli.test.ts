import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findSessionById, runTraceCli } from './traceCli'
import { toUuid } from '../../src/traceIdentity'
import { loadAllSessions } from './sessionLoader'
import type { SessionSummaryCard } from '../../src/summarizers/summarizerTypes'

function makeCard(overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-1',
    traceId: 'trace-1',
    source: 'claude_code',
    dataSource: 'otel',
    workspace: '/repo',
    userRequest: 'do a thing',
    model: 'claude-3',
    turns: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    cacheHitRate: 0,
    durationMs: 1000,
    startTime: '2024-01-01T00:00:00.000Z',
    filesRead: [],
    filesSearched: [],
    filesChanged: [],
    filesWritten: [],
    toolCounts: {},
    totalToolCalls: 0,
    totalLlmCalls: 0,
    errors: 0,
    outcome: 'tool_calls',
    timeline: [],
    backgroundSpans: [],
    loopSignals: [],
    ...overrides,
  }
}

suite('findSessionById', () => {
  test('matches by sessionId', () => {
    const sessions = [makeCard({ sessionId: 'a' }), makeCard({ sessionId: 'b' })]
    assert.strictEqual(findSessionById(sessions, 'b')?.sessionId, 'b')
  })

  test('matches by traceId when sessionId differs', () => {
    const sessions = [makeCard({ sessionId: 'a', traceId: 'trace-a' })]
    assert.strictEqual(findSessionById(sessions, 'trace-a')?.sessionId, 'a')
  })

  test('returns undefined when nothing matches', () => {
    const sessions = [makeCard({ sessionId: 'a' })]
    assert.strictEqual(findSessionById(sessions, 'nope'), undefined)
  })

  test('matches the wire session_id the cloud hand-off shows for a non-UUID local key', () => {
    const local = 'copilot-otel-span-7f3a'
    const sessions = [makeCard({ sessionId: 'other' }), makeCard({ sessionId: local })]
    assert.strictEqual(findSessionById(sessions, toUuid(local))?.sessionId, local)
    assert.strictEqual(findSessionById(sessions, toUuid(local).toUpperCase())?.sessionId, local)
  })

  test('a UUID local key matches itself case-insensitively but no other trace', () => {
    const key = '0b6c2f9e-3a1d-4c55-8e2f-1a2b3c4d5e6f'
    const sessions = [makeCard({ sessionId: 'x' }), makeCard({ sessionId: key })]
    assert.strictEqual(findSessionById(sessions, key.toUpperCase())?.sessionId, key)
    assert.strictEqual(findSessionById(sessions, toUuid('unrelated')), undefined)
  })

  test('does not partial-match — an id that is only a substring of a real one does not match', () => {
    const sessions = [makeCard({ sessionId: 'abcdef' })]
    assert.strictEqual(findSessionById(sessions, 'abc'), undefined)
  })
})

suite('runTraceCli', () => {
  test('uses already-loaded sessions when given them (find passes its own load through)', async () => {
    const log = console.log
    const lines: string[] = []
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
    try {
      assert.strictEqual(await runTraceCli(['--id', 'preloaded'], [makeCard({ sessionId: 'preloaded', workspace: '/preloaded-repo' })]), 0)
      assert.strictEqual(await runTraceCli(['--id', 'missing'], [makeCard({ sessionId: 'preloaded' })]), 1)
    } finally {
      console.log = log
    }
    assert.ok(lines.some(l => l.includes('/preloaded-repo')))
  })
})

suite('runTraceCli against recorded transcripts', () => {
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, DATA_DIR: process.env.DATA_DIR }
  let root: string

  /** A minimal Claude Code transcript: one prompt + one reply per `startsMs` entry. */
  function transcript(dir: string, id: string, startsMs: number[], cwd = '/repo-a'): void {
    const lines = startsMs.flatMap((t, i) => [
      { type: 'user', uuid: `${id}-u${i}`, sessionId: id, cwd, timestamp: new Date(t).toISOString(), message: { role: 'user', content: `prompt ${i} for ${id}` } },
      { type: 'assistant', uuid: `${id}-a${i}`, sessionId: id, cwd, timestamp: new Date(t + 5000).toISOString(), message: { id: `msg-${id}-${i}`, model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } } },
    ])
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  }

  suiteSetup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-trace-'))
    const projects = path.join(root, 'claude', 'projects')
    const t0 = Date.parse('2026-03-01T00:00:00Z')
    // Two turns a day apart in one transcript: two traces, one per turn.
    transcript(path.join(projects, '-repo-a'), 'tr-split', [t0, t0 + 86_400_000])
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
    process.env.DATA_DIR = path.join(root, 'data')
  })

  suiteTeardown(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('finds a trace by its per-turn key; a transcript file name is not a trace id', async () => {
    const turns = loadAllSessions().filter(s => s.conversationId === 'tr-split')
    assert.strictEqual(turns.length, 2)
    const second = turns.find(s => s.userRequest === 'prompt 1 for tr-split')
    assert.ok(second)
    assert.strictEqual(findSessionById(loadAllSessions(), second.sessionId)?.userRequest, 'prompt 1 for tr-split')
    assert.strictEqual(findSessionById(loadAllSessions(), 'tr-split'), undefined)

    const log = console.log
    console.log = () => {}
    try {
      assert.strictEqual(await runTraceCli(['--id', second.sessionId]), 0)
      assert.strictEqual(await runTraceCli(['--id', 'tr-split']), 1)
    } finally {
      console.log = log
    }
  })
})
