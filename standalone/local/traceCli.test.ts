import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findSessionById, runTraceCli } from './traceCli'
import { loadAllSessions, loadSessionsMatchingId } from './sessionLoader'
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

suite('loadSessionsMatchingId', () => {
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
    for (let i = 0; i < 5; i++) transcript(path.join(projects, '-repo-a'), `tr-sess-${i}`, [t0 + i * 60_000])
    // Split into two sessions (`tr-split`, `tr-split#1`) by a day-long gap.
    transcript(path.join(projects, '-repo-a'), 'tr-split', [t0, t0 + 86_400_000])
    // The same file name under a second project, newer — the full load picks this one first.
    transcript(path.join(projects, '-repo-b'), 'tr-sess-2', [t0 + 3_600_000], '/repo-b')
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

  test('finds the same session a full load would, parsing only the files that can hold it', () => {
    const all = loadAllSessions()
    for (const id of ['tr-sess-0', 'tr-sess-2', 'tr-split', 'tr-split#1', 'tr-split#2', 'nope']) {
      const narrowed = loadSessionsMatchingId(id)
      assert.deepStrictEqual(findSessionById(narrowed, id), findSessionById(all, id), id)
      const base = id.replace(/#\d+$/, '')
      assert.ok(narrowed.filter(s => s.sessionId.startsWith('tr-')).every(s => s.sessionId.replace(/#\d+$/, '') === base), id)
    }
    assert.strictEqual(findSessionById(loadSessionsMatchingId('tr-sess-2'), 'tr-sess-2')?.workspace, '/repo-b')
    assert.strictEqual(findSessionById(loadSessionsMatchingId('tr-split#1'), 'tr-split#1')?.sessionId, 'tr-split#1')
    assert.strictEqual(loadSessionsMatchingId('tr-sess-2').filter(s => s.sessionId === 'tr-sess-2').length, 2)
  })
})
