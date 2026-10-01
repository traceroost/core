import * as assert from 'assert'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer, type McpServerOptions } from '../mcpServer'
import { calcSessionCostUsd } from '../pricing'
import { setPlanUsageService, getPlanUsageService } from '../planUsage/planUsageService'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

// Behaviour of the MCP tool handlers themselves (mcpServer.test.ts covers only the HTTP layer).
// These are the tools agents are told to call before every task, so their output shapes, caps
// and filters are what a coding agent actually sees.

const DAY = 86_400_000

function card(o: Partial<SessionSummaryCard> & { sessionId: string }): SessionSummaryCard {
  return {
    traceId: o.sessionId, source: 'claude_code', dataSource: 'log', workspace: '/repo/a', userRequest: 'do a thing',
    model: 'claude-sonnet-4-6', turns: 1, inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0,
    cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 90_000, startTime: new Date(Date.now() - DAY).toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [], toolCounts: {}, totalToolCalls: 0,
    totalLlmCalls: 1, errors: 0, outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    ...o,
  }
}

async function connect(opts: McpServerOptions): Promise<Client> {
  const server = createMcpServer(opts)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientT)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean }
  assert.ok(!res.isError, `${name} returned an error: ${res.content[0]?.text}`)
  return JSON.parse(res.content[0].text)
}

suite('mcpServer tools', () => {
  let client: Client
  let sessions: SessionSummaryCard[]
  let savedPlan: ReturnType<typeof getPlanUsageService>

  setup(async () => {
    savedPlan = getPlanUsageService()
    setPlanUsageService(undefined)
    sessions = []
    client = await connect({ getSessions: () => sessions })
  })
  teardown(async () => {
    setPlanUsageService(savedPlan)
    await client.close()
  })

  test('lists all seven tools, with workspace required where suggestions/triggers are repo-scoped', async () => {
    const { tools } = await client.listTools()
    assert.deepStrictEqual(tools.map(t => t.name).sort(), [
      'check_automation_triggers', 'get_efficiency_report', 'get_instruction_suggestions', 'get_plan_limits',
      'get_recent_sessions', 'get_session_detail', 'get_workspace_patterns',
    ])
    for (const name of ['get_instruction_suggestions', 'check_automation_triggers']) {
      assert.deepStrictEqual(tools.find(t => t.name === name)!.inputSchema.required, ['workspace'])
    }
  })

  test('an unknown tool is reported as an error result, not a thrown exception', async () => {
    const res = await client.callTool({ name: 'drop_tables', arguments: {} }) as { isError?: boolean; content: Array<{ text: string }> }
    assert.strictEqual(res.isError, true)
    assert.match(res.content[0].text, /Unknown tool: drop_tables/)
  })

  suite('get_recent_sessions', () => {
    test('defaults to 10, caps the limit at 50, and keeps the caller\'s (newest-first) order', async () => {
      sessions = Array.from({ length: 60 }, (_, i) => card({ sessionId: `s${i}` }))
      assert.strictEqual((await call(client, 'get_recent_sessions') as unknown[]).length, 10)
      const big = await call(client, 'get_recent_sessions', { limit: 500 }) as Array<{ sessionId: string }>
      assert.strictEqual(big.length, 50)
      assert.strictEqual(big[0].sessionId, 's0')
    })

    test('shapes each row: cost from the pricing table, truncated prompt, top-4 tools, minutes', async () => {
      const long = 'x'.repeat(130)
      const s = card({
        sessionId: 'shape', userRequest: long, startTime: '2026-09-30T14:05:59.000Z', durationMs: 150_000,
        toolCounts: { Read: 9, Edit: 4, Bash: 7, Grep: 1, Glob: 2 },
        loopSignals: [{ type: 'exact_tool_repeat' } as SessionSummaryCard['loopSignals'][number]],
        filesChanged: ['a', 'b', 'c', 'd', 'e', 'f'],
      })
      sessions = [s, card({ sessionId: 'no-prompt', userRequest: '' })]
      const [row, row2] = await call(client, 'get_recent_sessions') as Array<Record<string, unknown>>
      assert.strictEqual(row.date, '2026-09-30 14:05')
      assert.strictEqual(row.prompt, 'x'.repeat(120) + '…')
      assert.strictEqual(row.cost_usd, +calcSessionCostUsd(s).toFixed(4))
      assert.ok((row.cost_usd as number) > 0)
      assert.strictEqual(row.durationMin, 2.5)
      assert.deepStrictEqual(row.topTools, ['Read×9', 'Bash×7', 'Edit×4', 'Glob×2'])
      assert.deepStrictEqual(row.loopSignals, ['exact_tool_repeat'])
      assert.deepStrictEqual(row.filesChanged, ['a', 'b', 'c', 'd', 'e'])
      assert.ok(!('limitUsed' in row), 'no plan-usage service → no limitUsed field')
      assert.strictEqual(row2.prompt, null)
    })

    test('filters by agent', async () => {
      sessions = [card({ sessionId: 'c', source: 'codex' }), card({ sessionId: 'k', source: 'claude_code' })]
      const rows = await call(client, 'get_recent_sessions', { agent: 'codex' }) as Array<{ sessionId: string }>
      assert.deepStrictEqual(rows.map(r => r.sessionId), ['c'])
    })

    test('filters by the session\'s recorded workspace, including subfolders, not by id or prompt text', async () => {
      sessions = [
        card({ sessionId: 'root', workspace: '/home/u/core' }),
        card({ sessionId: 'sub', workspace: '/home/u/core/packages/x' }),
        card({ sessionId: 'sibling', workspace: '/home/u/core-other' }),
        card({ sessionId: 'mentions', workspace: '/home/u/else', userRequest: 'look at /home/u/core please' }),
        card({ sessionId: 'unknown', workspace: undefined }),
      ]
      const ids = async (workspace: string) =>
        (await call(client, 'get_recent_sessions', { workspace }) as Array<{ sessionId: string }>).map(r => r.sessionId)
      assert.deepStrictEqual(await ids('/home/u/core'), ['root', 'sub'])
      assert.deepStrictEqual(await ids('/home/u/core/'), ['root', 'sub'], 'trailing separator ignored')
      assert.deepStrictEqual(await ids('/home/u/core/packages/x'), ['sub'])
      assert.deepStrictEqual(await ids('   '), ['root', 'sub', 'sibling', 'mentions', 'unknown'], 'blank → no filter')
    })

    test('Windows workspace paths match regardless of separator, trailing separator and case', async () => {
      sessions = [
        card({ sessionId: 'win', workspace: 'C:\\Work\\Repo\\src' }),
        card({ sessionId: 'other', workspace: 'C:\\Work\\Repo2' }),
      ]
      const rows = await call(client, 'get_recent_sessions', { workspace: 'c:/work/repo/' }) as Array<{ sessionId: string }>
      assert.deepStrictEqual(rows.map(r => r.sessionId), ['win'])
    })

    test('attaches per-session plan-limit usage when the plan service knows it', async () => {
      setPlanUsageService({
        snapshot: () => ({ meters: [], hits: [], sessions: { lim: { fiveHourPct: 12.345, approximate: true, hits: [{}] } } }),
      } as unknown as Parameters<typeof setPlanUsageService>[0])
      sessions = [card({ sessionId: 'lim' }), card({ sessionId: 'none' })]
      const [a, b] = await call(client, 'get_recent_sessions') as Array<Record<string, unknown>>
      assert.deepStrictEqual(a.limitUsed, { fiveHourPct: 12.3, approximate: true, limitHits: 1 })
      assert.ok(!('limitUsed' in b))
    })
  })

  suite('get_workspace_patterns', () => {
    test('says so when nothing matches', async () => {
      assert.deepStrictEqual(await call(client, 'get_workspace_patterns'), { message: 'No sessions found matching the filters.' })
    })

    test('aggregates hot files, tools, loop signals and per agent/model averages; honours days', async () => {
      sessions = [
        card({ sessionId: '1', filesRead: ['a.ts', 'b.ts'], filesChanged: ['c.ts'], toolCounts: { Read: 2, Edit: 1 }, errors: 1, cacheHitRate: 0.5,
          loopSignals: [{ type: 'file_reread' } as SessionSummaryCard['loopSignals'][number]] }),
        card({ sessionId: '2', filesRead: ['a.ts'], toolCounts: { Read: 3 }, source: 'codex', model: 'gpt-5', totalLlmCalls: 3 }),
        card({ sessionId: 'old', startTime: new Date(Date.now() - 40 * DAY).toISOString(), filesRead: ['old.ts'] }),
      ]
      const r = await call(client, 'get_workspace_patterns', { days: 7 }) as Record<string, unknown>
      assert.strictEqual(r.sessionCount, 2)
      assert.deepStrictEqual(r.hotFiles, [
        { file: 'a.ts', sessions: 2, pct: 100 }, { file: 'b.ts', sessions: 1, pct: 50 }, { file: 'c.ts', sessions: 1, pct: 50 },
      ])
      assert.deepStrictEqual(r.topTools, [{ tool: 'Read', total: 5 }, { tool: 'Edit', total: 1 }])
      assert.deepStrictEqual(r.loopSignals, [{ type: 'file_reread', count: 1 }])
      assert.strictEqual(r.errorRate, '50%')
      assert.strictEqual(r.avgCacheHitRate, '25%')
      assert.strictEqual(r.avgTurns, 2)
      assert.deepStrictEqual((r.agentBreakdown as Array<{ agentModel: string }>).map(a => a.agentModel).sort(),
        ['claude_code/claude-sonnet-4-6', 'codex/gpt-5'])
      const all = await call(client, 'get_workspace_patterns') as Record<string, unknown>
      assert.strictEqual(all.sessionCount, 3, 'no days → every session')
    })
    test('counts a file once per session even when it was both read and changed', async () => {
      sessions = [
        card({ sessionId: '1', filesRead: ['a.ts', 'a.ts'], filesChanged: ['a.ts'] }),
        card({ sessionId: '2', filesRead: ['a.ts'] }),
      ]
      const r = await call(client, 'get_workspace_patterns') as { hotFiles: unknown[] }
      assert.deepStrictEqual(r.hotFiles, [{ file: 'a.ts', sessions: 2, pct: 100 }])
    })

    test('honours the workspace filter', async () => {
      sessions = [
        card({ sessionId: 'in', workspace: '/repo/a/pkg', filesRead: ['in.ts'] }),
        card({ sessionId: 'out', workspace: '/repo/b', filesRead: ['out.ts'] }),
      ]
      const r = await call(client, 'get_workspace_patterns', { workspace: '/repo/a' }) as { sessionCount: number; hotFiles: Array<{ file: string }> }
      assert.strictEqual(r.sessionCount, 1)
      assert.deepStrictEqual(r.hotFiles.map(f => f.file), ['in.ts'])
      assert.deepStrictEqual(await call(client, 'get_workspace_patterns', { workspace: '/nowhere' }),
        { message: 'No sessions found matching the filters.' })
    })
  })

  suite('get_efficiency_report', () => {
    test('defaults to 30 days and reports when that window is empty', async () => {
      sessions = [card({ sessionId: 'old', startTime: new Date(Date.now() - 45 * DAY).toISOString() })]
      assert.deepStrictEqual(await call(client, 'get_efficiency_report'), { message: 'No sessions in the last 30 days.' })
    })

    test('flags a rising cost trend and ranks only agent/models with ≥2 sessions, cheapest first', async () => {
      const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString()
      sessions = [
        card({ sessionId: 'early1', startTime: at(25), outputTokens: 100 }),
        card({ sessionId: 'early2', startTime: at(20), outputTokens: 100 }),
        card({ sessionId: 'late1', startTime: at(2), outputTokens: 200_000, errors: 2 }),
        card({ sessionId: 'cx1', startTime: at(3), source: 'codex', model: '' , inputTokens: 0, outputTokens: 0 }),
        card({ sessionId: 'cx2', startTime: at(4), source: 'codex', model: '', inputTokens: 0, outputTokens: 0 }),
        card({ sessionId: 'solo', startTime: at(5), source: 'opencode' }),
      ]
      const r = await call(client, 'get_efficiency_report') as Record<string, unknown>
      assert.strictEqual(r.period, 'last 30 days')
      assert.strictEqual(r.sessionCount, 6)
      assert.strictEqual(r.costTrend, 'increasing ↑')
      assert.strictEqual(r.errorRate, '17%')
      const ranking = r.agentRanking as Array<{ agentModel: string; sessions: number }>
      assert.deepStrictEqual(ranking.map(a => a.agentModel), ['codex/unknown', 'claude_code/claude-sonnet-4-6'])
    })

    test('honours the workspace filter', async () => {
      sessions = [card({ sessionId: 'in', workspace: '/repo/a' }), card({ sessionId: 'out', workspace: '/repo/b' })]
      assert.strictEqual((await call(client, 'get_efficiency_report', { workspace: '/repo/a' }) as { sessionCount: number }).sessionCount, 1)
      assert.strictEqual((await call(client, 'get_efficiency_report') as { sessionCount: number }).sessionCount, 2)
    })

    test('a flat cost history is "stable"; no first-half sessions is "no data"', async () => {
      const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString()
      sessions = [card({ sessionId: 'a', startTime: at(20) }), card({ sessionId: 'b', startTime: at(2) })]
      assert.strictEqual((await call(client, 'get_efficiency_report') as { costTrend: string }).costTrend, 'stable →')
      sessions = [card({ sessionId: 'b', startTime: at(2) })]
      assert.strictEqual((await call(client, 'get_efficiency_report') as { costTrend: string }).costTrend, 'no data')
    })
  })

  suite('get_session_detail', () => {
    test('unknown ids are an error payload', async () => {
      assert.deepStrictEqual(await call(client, 'get_session_detail', { sessionId: 'missing' }), { error: 'Session missing not found.' })
    })

    test('caps the timeline at 80 entries and maps it to a compact shape', async () => {
      const timeline = Array.from({ length: 100 }, (_, i) => ({ type: 'tool' as const, spanId: `t${i}`, label: `Read ${i}`, durationMs: i, isError: i === 1, timestamp: '' }))
      sessions = [card({ sessionId: 'd', startTime: '2026-09-30T14:05:59.123Z', timeline })]
      const r = await call(client, 'get_session_detail', { sessionId: 'd' }) as { date: string; timeline: unknown[] }
      assert.strictEqual(r.date, '2026-09-30 14:05:59')
      assert.strictEqual(r.timeline.length, 80)
      assert.deepStrictEqual(r.timeline.slice(0, 2), [
        { type: 'tool', label: 'Read 0', ms: 0, error: false },
        { type: 'tool', label: 'Read 1', ms: 1, error: true },
      ])
    })

    test('prefers the host\'s timeline loader over the card\'s own timeline', async () => {
      const loaded: string[] = []
      const c2 = await connect({
        getSessions: () => [card({ sessionId: 'x', timeline: [{ type: 'llm', spanId: 's', label: 'from card', durationMs: 1, isError: false, timestamp: '' }] })],
        getTimeline: (id) => { loaded.push(id); return [{ type: 'llm', label: 'from db', durationMs: 2 }] },
      })
      try {
        const r = await call(c2, 'get_session_detail', { sessionId: 'x' }) as { timeline: Array<{ label: string }> }
        assert.deepStrictEqual(loaded, ['x'])
        assert.strictEqual(r.timeline[0].label, 'from db')
      } finally { await c2.close() }
    })
  })

  suite('workspace-scoped tools', () => {
    test('get_instruction_suggestions requires a workspace and ≥5 sessions in it', async () => {
      assert.deepStrictEqual(await call(client, 'get_instruction_suggestions', { workspace: '  ' }),
        { error: 'workspace is required — instruction suggestions are repo-scoped.' })
      sessions = [card({ sessionId: '1' }), card({ sessionId: '2', workspace: '/elsewhere' })]
      const r = await call(client, 'get_instruction_suggestions', { workspace: '/repo/a' }) as { message: string; suggestions: unknown[] }
      assert.match(r.message, /1 sessions, need 5/)
      assert.deepStrictEqual(r.suggestions, [])
    })

    test('check_automation_triggers requires a workspace and reports none for an idle one', async () => {
      assert.deepStrictEqual(await call(client, 'check_automation_triggers', {}),
        { error: 'workspace is required — automation triggers are project-scoped.' })
      sessions = [card({ sessionId: '1', startTime: new Date(Date.now() - 30 * DAY).toISOString() })]
      assert.deepStrictEqual(await call(client, 'check_automation_triggers', { workspace: '/repo/a' }),
        { message: 'No triggered automations for workspace "/repo/a".', triggers: [] })
    })
  })

  suite('get_plan_limits', () => {
    test('is unavailable without plan data', async () => {
      const r = await call(client, 'get_plan_limits') as { available: boolean }
      assert.strictEqual(r.available, false)
    })

    test('maps meters and the last 10 hits; a window reset since the reading reads 0%', async () => {
      const t = Date.parse('2026-09-30T12:00:00.000Z')
      const hits = Array.from({ length: 12 }, (_, i) => ({ provider: 'codex', windowKind: 'weekly', hitAt: t + i, sessionId: `h${i}` }))
      setPlanUsageService({
        snapshot: () => ({
          meters: [{ provider: 'claude', planType: 'max', observedAt: t, windows: [
            { windowKind: 'five_hour', usedPct: 42.6, resetsAt: t + 3_600_000 },
            { windowKind: 'weekly', usedPct: 90, resetSinceReading: true },
          ] }],
          hits, sessions: {},
        }),
      } as unknown as Parameters<typeof setPlanUsageService>[0])
      const r = await call(client, 'get_plan_limits') as {
        available: boolean; meters: Array<{ agent: string; plan: string; windows: Array<Record<string, unknown>> }>
        recentLimitHits: Array<{ agent: string; window: string; sessionId: string }>
      }
      assert.strictEqual(r.available, true)
      assert.strictEqual(r.meters[0].agent, 'claude_code')
      assert.strictEqual(r.meters[0].plan, 'max')
      assert.deepStrictEqual(r.meters[0].windows, [
        { window: '5h', usedPct: 43, resetsAt: '2026-09-30T13:00:00.000Z' },
        { window: 'weekly', usedPct: 0, note: 'window has reset since the last reading' },
      ])
      assert.strictEqual(r.recentLimitHits.length, 10)
      assert.strictEqual(r.recentLimitHits[0].sessionId, 'h2')
      assert.strictEqual(r.recentLimitHits[0].window, 'weekly')
    })
  })
})
