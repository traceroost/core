import * as assert from 'assert'
import { mergeSessions, resolveWorkspacesFromLogs, SessionRepository, MAX_SESSIONS_TO_WEBVIEW } from '../../sessionRepository'
import type { DatabaseReader } from '../../database/reader'
import type { DatabaseWriter } from '../../database/writer'
import type { SessionStore } from '../../sessionStore'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

function makeCard(id: string, startTime: string, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: id, traceId: 'trace-' + id, source: 'copilot', dataSource: 'otel', workspace: 'ws',
    userRequest: 'test', model: 'gpt-4o', turns: 1,
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime,
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

suite('mergeSessions', () => {
  test('a stored card with more calls beats a partial live card of the same session', () => {
    const db = [makeCard('s1', '2024-01-01T00:00:00.000Z', { totalLlmCalls: 40, totalToolCalls: 30, model: 'db-model' })]
    const live = [makeCard('s1', '2024-01-01T00:00:00.000Z', { totalLlmCalls: 3, totalToolCalls: 2, model: 'live-model' })]
    const result = mergeSessions(db, live)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].model, 'db-model')
  })

  test('live sessions win on conflict with the same sessionId', () => {
    const db = [makeCard('s1', '2024-01-01T00:00:00.000Z', { model: 'db-model' })]
    const live = [makeCard('s1', '2024-01-01T00:00:00.000Z', { model: 'live-model' })]
    const result = mergeSessions(db, live)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].model, 'live-model')
  })

  test('db-only sessions are preserved when no live conflict', () => {
    const db = [makeCard('db1', '2024-01-01T00:00:00.000Z')]
    const live = [makeCard('live1', '2024-02-01T00:00:00.000Z')]
    const result = mergeSessions(db, live)
    assert.strictEqual(result.length, 2)
    assert.ok(result.some(s => s.sessionId === 'db1'))
    assert.ok(result.some(s => s.sessionId === 'live1'))
  })

  test('result is sorted by startTime DESC', () => {
    const db = [
      makeCard('a', '2024-01-01T00:00:00.000Z'),
      makeCard('c', '2024-03-01T00:00:00.000Z'),
    ]
    const live = [makeCard('b', '2024-02-01T00:00:00.000Z')]
    const result = mergeSessions(db, live)
    assert.strictEqual(result[0].sessionId, 'c')
    assert.strictEqual(result[1].sessionId, 'b')
    assert.strictEqual(result[2].sessionId, 'a')
  })

  test('empty db and live both return empty array', () => {
    assert.deepStrictEqual(mergeSessions([], []), [])
  })

  test('empty live returns db sessions sorted', () => {
    const db = [
      makeCard('x', '2024-01-01T00:00:00.000Z'),
      makeCard('y', '2024-06-01T00:00:00.000Z'),
    ]
    const result = mergeSessions(db, [])
    assert.strictEqual(result[0].sessionId, 'y')
    assert.strictEqual(result[1].sessionId, 'x')
  })
})

suite('resolveWorkspacesFromLogs', () => {
  const T = '2024-06-01T12:00:00.000Z'  // base time (within same minute = same bucket)

  test('borrows workspace from log session of same source in same minute', () => {
    const sessions = [
      makeCard('log1', T, { dataSource: 'log', source: 'claude_code', workspace: '/home/alice/myapp' }),
      makeCard('otel1', T, { dataSource: 'otel', source: 'claude_code', workspace: '' }),
    ]
    resolveWorkspacesFromLogs(sessions)
    assert.strictEqual(sessions[1].workspace, '/home/alice/myapp')
  })

  test('does not borrow across different sources', () => {
    const sessions = [
      makeCard('log1', T, { dataSource: 'log', source: 'copilot', workspace: '/home/alice/myapp' }),
      makeCard('otel1', T, { dataSource: 'otel', source: 'claude_code', workspace: '' }),
    ]
    resolveWorkspacesFromLogs(sessions)
    assert.strictEqual(sessions[1].workspace, '')
  })

  test('marks bucket as ambiguous when two log sessions have different workspaces', () => {
    const sessions = [
      makeCard('log1', T, { dataSource: 'log', source: 'claude_code', workspace: '/home/alice/proj-a' }),
      makeCard('log2', T, { dataSource: 'log', source: 'claude_code', workspace: '/home/alice/proj-b' }),
      makeCard('otel1', T, { dataSource: 'otel', source: 'claude_code', workspace: '' }),
    ]
    resolveWorkspacesFromLogs(sessions)
    assert.strictEqual(sessions[2].workspace, '')
  })

  test('does not overwrite an OTEL session that already has a workspace', () => {
    const sessions = [
      makeCard('log1', T, { dataSource: 'log', source: 'claude_code', workspace: '/home/alice/myapp' }),
      makeCard('otel1', T, { dataSource: 'otel', source: 'claude_code', workspace: '/home/alice/existing' }),
    ]
    resolveWorkspacesFromLogs(sessions)
    assert.strictEqual(sessions[1].workspace, '/home/alice/existing')
  })

  test('borrows from adjacent-minute buckets (±1 minute tolerance)', () => {
    const base = new Date('2024-06-01T12:00:30.000Z').getTime()
    const slightly_before = new Date(base - 90_000).toISOString()  // 90s earlier = prev minute bucket
    const sessions = [
      makeCard('log1', slightly_before, { dataSource: 'log', source: 'claude_code', workspace: '/home/alice/myapp' }),
      makeCard('otel1', T, { dataSource: 'otel', source: 'claude_code', workspace: '' }),
    ]
    resolveWorkspacesFromLogs(sessions)
    assert.strictEqual(sessions[1].workspace, '/home/alice/myapp')
  })

  test('no-op when session list is empty', () => {
    assert.doesNotThrow(() => resolveWorkspacesFromLogs([]))
  })
})

suite('SessionRepository — MAX_SESSIONS_TO_WEBVIEW safety valve', () => {
  function fakeReader(count: number): DatabaseReader {
    const sessions = Array.from({ length: count }, (_, i) =>
      makeCard(`s${i}`, new Date(2024, 0, 1, 0, 0, i).toISOString())
    )
    return { listSessions: () => sessions, sessionsVersion: () => 0 } as unknown as DatabaseReader
  }
  const noopWriter = {} as unknown as DatabaseWriter
  const emptyStore = { getSpans: () => [], version: 0 } as unknown as SessionStore

  test('an unfiltered call below the cap returns everything', () => {
    const repo = new SessionRepository(fakeReader(10), noopWriter, emptyStore)
    assert.strictEqual(repo.listSessions().length, 10)
  })

  test('an unfiltered call above the cap is truncated to MAX_SESSIONS_TO_WEBVIEW', () => {
    const repo = new SessionRepository(fakeReader(MAX_SESSIONS_TO_WEBVIEW + 500), noopWriter, emptyStore)
    assert.strictEqual(repo.listSessions().length, MAX_SESSIONS_TO_WEBVIEW)
  })

  test('truncation keeps the most recent sessions, not an arbitrary slice', () => {
    const repo = new SessionRepository(fakeReader(MAX_SESSIONS_TO_WEBVIEW + 500), noopWriter, emptyStore)
    const result = repo.listSessions()
    // mergeSessions sorts newest-first, so the kept slice should be the last-created (highest index) sessions.
    assert.strictEqual(result[0].sessionId, `s${MAX_SESSIONS_TO_WEBVIEW + 499}`)
  })

  test('an explicit caller-supplied limit smaller than the cap is still honored', () => {
    const repo = new SessionRepository(fakeReader(100), noopWriter, emptyStore)
    assert.strictEqual(repo.listSessions({ limit: 25 }).length, 25)
  })

  test('limit: Infinity bypasses the safety cap entirely — the reconcile path needs every local session', () => {
    const repo = new SessionRepository(fakeReader(MAX_SESSIONS_TO_WEBVIEW + 500), noopWriter, emptyStore)
    assert.strictEqual(repo.listSessions({ limit: Infinity }).length, MAX_SESSIONS_TO_WEBVIEW + 500)
  })

  test('logs when the safety cap (not a caller limit) truncates the list', () => {
    const messages: string[] = []
    const repo = new SessionRepository(fakeReader(MAX_SESSIONS_TO_WEBVIEW + 1), noopWriter, emptyStore, (m) => messages.push(m))
    repo.listSessions()
    assert.ok(messages.some(m => m.includes('safety cap')))
  })

  test('does not log when a caller-supplied limit (not the safety cap) truncates the list', () => {
    const messages: string[] = []
    const repo = new SessionRepository(fakeReader(100), noopWriter, emptyStore, (m) => messages.push(m))
    repo.listSessions({ limit: 25 })
    assert.strictEqual(messages.length, 0)
  })
})

suite('SessionRepository — listSessions memo', () => {
  function fixture() {
    const state = { dbVersion: 0, storeVersion: 0, reads: 0, rows: [makeCard('a', '2024-01-01T00:00:00.000Z'), makeCard('b', '2024-01-02T00:00:00.000Z')] }
    const reader = {
      listSessions: (f?: { limit?: number }) => { state.reads++; return state.rows.slice(0, f?.limit ?? Infinity).map(r => ({ ...r })) },
      sessionsVersion: () => state.dbVersion,
    } as unknown as DatabaseReader
    const store = { getSpans: () => [], get version() { return state.storeVersion } } as unknown as SessionStore
    return { state, repo: new SessionRepository(reader, {} as unknown as DatabaseWriter, store) }
  }

  test('identical calls between data changes read the database once and return equal results', () => {
    const { state, repo } = fixture()
    const first = repo.listSessions()
    const second = repo.listSessions()
    assert.strictEqual(state.reads, 1)
    assert.deepStrictEqual(second, first)
    assert.strictEqual(second[0], first[0])
  })

  test('each call gets its own array, so a caller reordering it cannot affect another caller', () => {
    const { repo } = fixture()
    const first = repo.listSessions()
    first.reverse()
    assert.deepStrictEqual(repo.listSessions().map(s => s.sessionId), ['b', 'a'])
  })

  test('different filters are cached separately', () => {
    const { state, repo } = fixture()
    assert.strictEqual(repo.listSessions({ limit: 1 }).length, 1)
    assert.strictEqual(repo.listSessions().length, 2)
    assert.strictEqual(repo.listSessions({ limit: 1 }).length, 1)
    assert.strictEqual(state.reads, 2)
  })

  test('a sessions-table write invalidates the memo', () => {
    const { state, repo } = fixture()
    repo.listSessions()
    state.rows.push(makeCard('c', '2024-01-03T00:00:00.000Z'))
    state.dbVersion++
    assert.deepStrictEqual(repo.listSessions().map(s => s.sessionId), ['c', 'b', 'a'])
    assert.strictEqual(state.reads, 2)
  })

  test('a live span-window change invalidates the memo', () => {
    const { state, repo } = fixture()
    repo.listSessions()
    state.storeVersion++
    repo.listSessions()
    assert.strictEqual(state.reads, 2)
  })
})
