import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader } from '../logReader'
import { OUTCOMES_SCHEMA_SQL } from '../database/schema'
import { parseClaudeCachedUsage, readClaudeCachedUsage, claudeConfigPath } from '../planUsage/claudeCache'
import { claudeLimitHit } from '../planUsage/limitReadings'
import { LimitRepository, type StoredReading } from '../planUsage/limitRepository'
import {
  attributeIntervals, sessionConsumption, windowRollups, currentMeters, projectPace, codexPace, limitSeries,
  pointsPerDollar, type SessionSpan,
} from '../planUsage/consumption'
import { PlanUsageService } from '../planUsage/planUsageService'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

interface SqlDb {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
}
let createDb: () => SqlDb

const HOUR = 3_600_000
const T0 = Date.parse('2026-09-20T00:00:00.000Z')

/** The real shape, from a Claude Code ~/.claude.json on 2026-09-30 (unrelated keys trimmed). */
function claudeConfig(overrides: { five?: number; week?: number; fetchedAtMs?: number; cacheAccount?: string; signedIn?: string } = {}) {
  return {
    numStartups: 812,
    projects: { '/Users/someone/secret-project': { history: ['do not read me'] } },
    oauthAccount: { accountUuid: overrides.signedIn ?? 'acct-1', emailAddress: 'someone@example.com', organizationName: 'Org' },
    cachedUsageUtilization: {
      fetchedAtMs: overrides.fetchedAtMs ?? 1790645703065,
      accountUuid: overrides.cacheAccount ?? 'acct-1',
      utilization: {
        five_hour: { utilization: overrides.five ?? 0, resets_at: '2026-09-29T05:39:59.985529+00:00', limit_dollars: null },
        seven_day: { utilization: overrides.week ?? 31, resets_at: '2026-10-01T05:59:59.985557+00:00' },
        seven_day_opus: null,
        seven_day_sonnet: null,
        tangelo: { utilization: 99 },
        extra_usage: { is_enabled: false },
        limits: [{ kind: 'session', percent: 0 }, { kind: 'weekly_all', percent: 31 }],
      },
    },
  }
}

function reading(provider: 'claude' | 'codex', windowKind: 'five_hour' | 'weekly', usedPct: number, observedAt: number, extra: Partial<StoredReading> = {}): StoredReading {
  return { provider, windowKind, usedPct, observedAt, source: provider === 'codex' ? 'codex_rollout' : 'claude_cache', accountHash: '', ...extra }
}

function span(sessionId: string, provider: 'claude' | 'codex', startMs: number, endMs: number, costUsd = 1): SessionSpan {
  return { sessionId, provider, startMs, endMs, costUsd, tokens: 1000 }
}

function card(sessionId: string, source: 'claude_code' | 'codex', startMs: number, durationMs: number): SessionSummaryCard {
  return {
    sessionId, traceId: sessionId, source, dataSource: 'log', workspace: '', userRequest: '', model: source === 'codex' ? 'gpt-5.6-luna' : 'claude-sonnet-5',
    turns: 1, inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0,
    durationMs, startTime: new Date(startMs).toISOString(), filesRead: [], filesSearched: [], filesChanged: [], toolCounts: {},
    totalToolCalls: 0, totalLlmCalls: 1, errors: 0, outcome: 'unknown', timeline: [], backgroundSpans: [], loopSignals: [], filesWritten: [],
  } as unknown as SessionSummaryCard
}

suiteSetup(async () => {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  createDb = () => {
    const db = new SQL.Database()
    db.run(OUTCOMES_SCHEMA_SQL)
    return db
  }
})

suite('Claude cached usage (~/.claude.json)', () => {
  test('reads the 5-hour and weekly windows from the real shape', () => {
    const u = parseClaudeCachedUsage(JSON.stringify(claudeConfig({ five: 12, week: 31 })))
    assert.ok(u)
    assert.strictEqual(u.fetchedAt, 1790645703065)
    assert.deepStrictEqual(u.readings.map(r => [r.windowKind, r.usedPct, r.resetsAt]), [
      ['five_hour', 12, Date.parse('2026-09-29T05:39:59.985529+00:00')],
      ['weekly', 31, Date.parse('2026-10-01T05:59:59.985557+00:00')],
    ])
    for (const r of u.readings) {
      assert.strictEqual(r.observedAt, 1790645703065)
      assert.strictEqual(r.provider, 'claude')
      assert.strictEqual(r.sessionId, undefined)
    }
  })

  test('never returns anything but percentages, times and a hashed account', () => {
    const u = parseClaudeCachedUsage(JSON.stringify(claudeConfig()))
    const out = JSON.stringify(u)
    for (const secret of ['someone@example.com', 'acct-1', 'secret-project', 'do not read me', 'Org']) {
      assert.ok(!out.includes(secret), `output must not contain ${secret}`)
    }
    assert.match(u!.accountHash, /^[0-9a-f]{16}$/)
  })

  test('falls back to limits[] when the named window keys are gone', () => {
    const cfg = claudeConfig()
    const util = cfg.cachedUsageUtilization.utilization as Record<string, unknown>
    delete util['five_hour']; delete util['seven_day']
    const u = parseClaudeCachedUsage(JSON.stringify(cfg))
    assert.deepStrictEqual(u?.readings.map(r => [r.windowKind, r.usedPct]), [['five_hour', 0], ['weekly', 31]])
  })

  test('every failure mode is "no reading", not an error', () => {
    const bad = [
      'not json',
      '[]',
      JSON.stringify({}),
      JSON.stringify({ ...claudeConfig(), cachedUsageUtilization: undefined }),
      JSON.stringify({ ...claudeConfig(), oauthAccount: undefined }),
      JSON.stringify(claudeConfig({ cacheAccount: 'someone-else' })),
      JSON.stringify(claudeConfig({ fetchedAtMs: 'soon' as unknown as number })),
      JSON.stringify({ ...claudeConfig(), cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: 'acct-1', utilization: 'x' } }),
      JSON.stringify({ ...claudeConfig(), cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: 'acct-1', utilization: {} } }),
    ]
    for (const text of bad) assert.strictEqual(parseClaudeCachedUsage(text), null, text.slice(0, 60))
  })

  test('honors CLAUDE_CONFIG_DIR, and reading skips an unchanged file', () => {
    assert.strictEqual(claudeConfigPath({ CLAUDE_CONFIG_DIR: '/x/cfg' }, '/home/u'), path.join('/x/cfg', '.claude.json'))
    assert.strictEqual(claudeConfigPath({ CLAUDE_CONFIG_DIR: '  ' }, '/home/u'), path.join('/home/u', '.claude.json'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-claude-cfg-'))
    try {
      const file = path.join(dir, '.claude.json')
      assert.strictEqual(readClaudeCachedUsage(file), null)
      fs.writeFileSync(file, JSON.stringify(claudeConfig()))
      const first = readClaudeCachedUsage(file)
      assert.ok(first?.usage)
      const again = readClaudeCachedUsage(file, first.mtimeMs)
      assert.strictEqual(again?.usage, null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** The real record Claude Code 2.1.270 wrote on a 5-hour limit refusal (paths trimmed). */
function claudeLimitRow(ts: string, rateLimitType = 'five_hour', resetsAt = 1789516200) {
  return {
    parentUuid: 'p', isSidechain: false, type: 'assistant', uuid: 'u-' + ts, timestamp: ts,
    message: {
      id: 'm-' + ts, model: '<synthetic>', role: 'assistant', type: 'message', stop_reason: 'stop_sequence',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: 'text', text: "You've hit your session limit · resets 4:50pm (America/Los_Angeles)" }],
    },
    requestId: 'req_x',
    quotaLimits: {
      status: 'rejected', resetsAt, unifiedRateLimitFallbackAvailable: false, rateLimitType,
      overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', upgradePaths: ['upgrade_plan'], isUsingOverage: false,
    },
    error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429, sessionId: 'sess-1', version: '2.1.270',
  }
}

suite('Claude limit hits', () => {
  test('parses the structured refusal record', () => {
    const hit = claudeLimitHit(claudeLimitRow('2026-09-15T23:15:34.875Z'), 's1')
    assert.deepStrictEqual(hit, { provider: 'claude', sessionId: 's1', windowKind: 'five_hour', hitAt: Date.parse('2026-09-15T23:15:34.875Z'), resetsAt: 1789516200000 })
    assert.strictEqual(claudeLimitHit(claudeLimitRow('2026-09-15T23:15:34.875Z', 'seven_day'), 's1')?.windowKind, 'weekly')
  })

  test('ignores text-only notices, unknown windows, and non-rejections', () => {
    const textOnly = { ...claudeLimitRow('2026-09-15T23:15:34.875Z') } as Record<string, unknown>
    delete textOnly['quotaLimits']
    assert.strictEqual(claudeLimitHit(textOnly, 's1'), null)
    assert.strictEqual(claudeLimitHit(claudeLimitRow('2026-09-15T23:15:34.875Z', 'mystery'), 's1'), null)
    const warning = claudeLimitRow('2026-09-15T23:15:34.875Z') as Record<string, unknown>
    warning['quotaLimits'] = { ...(warning['quotaLimits'] as object), status: 'allowed_warning' }
    delete warning['error']
    assert.strictEqual(claudeLimitHit(warning, 's1'), null)
  })

  test('the session parser records the hit and does not count the refusal as a turn or model', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-claude-hit-'))
    try {
      const file = path.join(dir, 'sess-1.jsonl')
      const rows = [
        { type: 'user', timestamp: '2026-09-15T23:10:00.000Z', sessionId: 'sess-1', cwd: '/tmp/p', message: { role: 'user', content: 'fix it' } },
        { type: 'assistant', timestamp: '2026-09-15T23:11:00.000Z', sessionId: 'sess-1', requestId: 'r1',
          message: { id: 'a1', model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } } },
        claudeLimitRow('2026-09-15T23:15:34.875Z'),
        claudeLimitRow('2026-09-15T23:16:00.000Z'),
      ]
      fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
      const [result] = new LogReader().parseFile(file, 'claude')
      assert.ok(result)
      assert.strictEqual(result.card.turns, 1)
      assert.strictEqual(result.card.model, 'claude-sonnet-5')
      assert.ok(!(result.card.models ?? []).includes('<synthetic>'))
      // Two refusals against the same reset are one hit.
      assert.deepStrictEqual(result.limitHits?.map(h => [h.windowKind, h.resetsAt]), [['five_hour', 1789516200000]])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

suite('LimitRepository', () => {
  test('round-trips readings, hits and rollups, idempotently', () => {
    const repo = new LimitRepository(createDb())
    const r = reading('codex', 'five_hour', 23, T0, { resetsAt: T0 + HOUR, sessionId: 's1', planType: 'plus' })
    repo.insertReadings([r])
    repo.insertReadings([r])
    repo.insertReadings([reading('claude', 'weekly', 31, T0 + 1)], 'acct')
    assert.strictEqual(repo.readingsSince(0).length, 2)
    assert.deepStrictEqual(repo.readingsSince(0)[0], { ...r, accountHash: '' })
    assert.strictEqual(repo.readingsSince(0)[1].accountHash, 'acct')
    repo.insertHits([{ provider: 'claude', sessionId: 's2', windowKind: 'five_hour', hitAt: T0, resetsAt: T0 + HOUR }])
    assert.strictEqual(repo.hitsSince(0).length, 1)
    assert.strictEqual(repo.firstReadingAt('claude'), T0 + 1)
    assert.strictEqual(repo.firstReadingAt('codex'), T0)
    repo.upsertRollups([{ provider: 'codex', accountHash: '', windowKind: 'weekly', windowEnd: T0, peakPct: 50, hit: false, coverage: 'full' }])
    repo.upsertRollups([{ provider: 'codex', accountHash: '', windowKind: 'weekly', windowEnd: T0, peakPct: 60, hit: true, coverage: 'full' }])
    assert.deepStrictEqual(repo.rollups('weekly', 0).map(x => [x.peakPct, x.hit]), [[60, true]])
  })

  test('retention drops old readings and hits but keeps rollups for a year', () => {
    const repo = new LimitRepository(createDb())
    const now = T0 + 100 * 24 * HOUR
    repo.insertReadings([reading('codex', 'weekly', 10, T0)])
    repo.insertHits([{ provider: 'codex', sessionId: 's', windowKind: 'weekly', hitAt: T0 }])
    repo.upsertRollups([{ provider: 'codex', accountHash: '', windowKind: 'weekly', windowEnd: T0, peakPct: 10, hit: false, coverage: 'full' }])
    repo.deleteOlderThan(30, now)
    assert.strictEqual(repo.readingsSince(0).length, 0)
    assert.strictEqual(repo.hitsSince(0).length, 0)
    assert.strictEqual(repo.rollups('weekly', 0).length, 1)
  })
})

suite('Plan-limit consumption', () => {
  test('a single Codex session gets exactly the rise it caused, including its first turn', () => {
    const readings = [
      reading('codex', 'five_hour', 10, T0, { sessionId: 'earlier' }),
      reading('codex', 'five_hour', 14, T0 + 2 * 60_000 + HOUR, { sessionId: 's1' }),
      reading('codex', 'five_hour', 20, T0 + 30 * 60_000 + HOUR, { sessionId: 's1' }),
    ]
    const usage = sessionConsumption(attributeIntervals(readings, [span('s1', 'codex', T0 + HOUR, T0 + HOUR + 30 * 60_000)]))
    assert.deepStrictEqual(usage.get('s1'), { fiveHourPct: 10, approximate: false })
  })

  test('overlapping sessions share a rise by cost and are marked approximate', () => {
    const readings = [reading('codex', 'weekly', 30, T0), reading('codex', 'weekly', 36, T0 + HOUR)]
    const usage = sessionConsumption(attributeIntervals(readings, [
      span('a', 'codex', T0, T0 + HOUR, 2),
      span('b', 'codex', T0, T0 + HOUR, 1),
      span('other-agent', 'claude', T0, T0 + HOUR, 5),
    ]))
    assert.ok(Math.abs(usage.get('a')!.weeklyPct! - 4) < 1e-9)
    assert.ok(Math.abs(usage.get('b')!.weeklyPct! - 2) < 1e-9)
    assert.strictEqual(usage.get('a')!.approximate, true)
    assert.strictEqual(usage.has('other-agent'), false)
  })

  test('a reset mid-session counts usage since the reset, not a negative delta', () => {
    const readings = [
      reading('codex', 'five_hour', 90, T0, { resetsAt: T0 + HOUR }),
      reading('codex', 'five_hour', 5, T0 + 2 * HOUR, { resetsAt: T0 + 6 * HOUR }),
    ]
    const usage = sessionConsumption(attributeIntervals(readings, [span('s', 'codex', T0, T0 + 2 * HOUR)]))
    assert.strictEqual(usage.get('s')!.fiveHourPct, 5)
  })

  test('sparse Claude readings attribute approximately; a session no reading brackets gets nothing', () => {
    const readings = [reading('claude', 'weekly', 20, T0), reading('claude', 'weekly', 26, T0 + 10 * HOUR)]
    const usage = sessionConsumption(attributeIntervals(readings, [
      span('in', 'claude', T0 + HOUR, T0 + 2 * HOUR),
      span('after', 'claude', T0 + 11 * HOUR, T0 + 12 * HOUR),
    ]))
    assert.deepStrictEqual(usage.get('in'), { weeklyPct: 6, approximate: true })
    assert.strictEqual(usage.has('after'), false)
  })

  test('no readings, no values', () => {
    assert.strictEqual(sessionConsumption(attributeIntervals([], [span('s', 'codex', T0, T0 + HOUR)])).size, 0)
    assert.deepStrictEqual(currentMeters([], T0), [])
    assert.deepStrictEqual(limitSeries([], [], 'weekly', 0), [])
  })

  test('rollups: one per completed window, with peak, hit and coverage', () => {
    const week = 7 * 24 * HOUR
    const readings = [
      reading('codex', 'weekly', 10, T0, { resetsAt: T0 + week }),
      reading('codex', 'weekly', 70, T0 + 3 * 24 * HOUR, { resetsAt: T0 + week }),
      reading('codex', 'weekly', 4, T0 + week + HOUR, { resetsAt: T0 + 2 * week }),
      reading('claude', 'weekly', 40, T0 + HOUR, { resetsAt: T0 + week }),
    ]
    const hits = [{ provider: 'codex' as const, sessionId: 's', windowKind: 'weekly' as const, hitAt: T0 + 3 * 24 * HOUR }]
    const rollups = windowRollups(readings, hits, T0 + week + 2 * HOUR)
    const codex = rollups.filter(r => r.provider === 'codex')
    assert.deepStrictEqual(codex.map(r => [r.windowEnd, r.peakPct, r.hit, r.coverage]), [[T0 + week, 70, true, 'full']])
    const claude = rollups.filter(r => r.provider === 'claude')
    assert.deepStrictEqual(claude.map(r => [r.peakPct, r.coverage]), [[40, 'partial']])
  })

  test('meters show the latest reading, and zero only when the window has since reset', () => {
    const meters = currentMeters([
      reading('codex', 'five_hour', 23, T0, { resetsAt: T0 + HOUR, planType: 'plus' }),
      reading('codex', 'weekly', 38, T0, { resetsAt: T0 + 100 * HOUR }),
      reading('codex', 'five_hour', 30, T0 + 1000, { resetsAt: T0 + HOUR, planType: 'plus' }),
    ], T0 + 2 * HOUR)
    assert.strictEqual(meters.length, 1)
    assert.strictEqual(meters[0].planType, 'plus')
    const five = meters[0].windows.find(w => w.windowKind === 'five_hour')!
    assert.deepStrictEqual([five.usedPct, five.resetSinceReading], [0, true])
    const week = meters[0].windows.find(w => w.windowKind === 'weekly')!
    assert.deepStrictEqual([week.usedPct, week.resetSinceReading], [38, false])
  })

  test('pace projects to the limit before the reset, or to a percentage at the reset', () => {
    assert.deepStrictEqual(projectPace(50, 1, T0 + 2 * HOUR, T0), { minutesToLimit: 50 })
    assert.deepStrictEqual(projectPace(50, 0.5, T0 + HOUR, T0), { pctAtReset: 80 })
    assert.strictEqual(projectPace(50, 0, T0 + HOUR, T0), undefined)
    assert.strictEqual(projectPace(50, 1, undefined, T0), undefined)
    const readings = [
      reading('codex', 'five_hour', 20, T0 - 8 * 60_000, { sessionId: 's' }),
      reading('codex', 'five_hour', 24, T0 - 60_000, { sessionId: 's' }),
    ]
    assert.ok(Math.abs(codexPace(readings, 's', T0)! - 4 / 7) < 1e-9)
    assert.strictEqual(codexPace(readings.slice(0, 1), 's', T0), undefined)
  })

  test('pts-per-dollar needs at least three priced rises', () => {
    const readings = [0, 1, 2, 3].map(i => reading('codex', 'weekly', 10 + i * 2, T0 + i * HOUR))
    const two = attributeIntervals(readings.slice(0, 3), [span('s', 'codex', T0, T0 + 4 * HOUR, 4)])
    assert.strictEqual(pointsPerDollar(two, 'codex', 'weekly'), undefined)
    const three = attributeIntervals(readings, [span('s', 'codex', T0, T0 + 3 * HOUR, 3)])
    assert.ok(Math.abs(pointsPerDollar(three, 'codex', 'weekly')! - 2) < 1e-9)
  })
})

suite('PlanUsageService', () => {
  test('a machine with no limit data produces an empty snapshot and no live card', () => {
    const svc = new PlanUsageService(createDb(), { claudeConfigPath: '/nonexistent/.claude.json', now: () => T0 })
    assert.strictEqual(svc.pollClaudeCache(), false)
    const snap = svc.snapshot([card('s', 'codex', T0 - HOUR, HOUR)])
    assert.deepStrictEqual(snap.meters, [])
    assert.deepStrictEqual(snap.sessions, {})
    assert.deepStrictEqual(snap.series, { weekly: [], fiveHour: [] })
    assert.deepStrictEqual(snap.weeklyRollups, [])
    assert.deepStrictEqual(snap.historyStartsAt, {})
    assert.deepStrictEqual(snap.planStatus, [])
    assert.strictEqual(svc.liveCard(card('s', 'codex', T0 - HOUR, HOUR), null), undefined)
  })

  test('ingests Codex results into meters, per-session usage, hits and a live card', () => {
    const now = T0 + 2 * HOUR
    const svc = new PlanUsageService(createDb(), { claudeConfigPath: '/nonexistent/.claude.json', now: () => now })
    const resetsAt = now + 3 * HOUR
    svc.ingest([{
      card: card('s1', 'codex', T0, HOUR),
      workspace: '',
      limitReadings: [
        { provider: 'codex', windowKind: 'five_hour', usedPct: 10, observedAt: now - 9 * 60_000, resetsAt, source: 'codex_rollout', sessionId: 's1', planType: 'plus' },
        { provider: 'codex', windowKind: 'five_hour', usedPct: 70, observedAt: now - 60_000, resetsAt, source: 'codex_rollout', sessionId: 's1', planType: 'plus' },
      ],
      limitHits: [{ provider: 'codex', sessionId: 's1', windowKind: 'weekly', hitAt: now - 30_000, resetsAt: now + 24 * HOUR }],
    }])
    const cards = [card('s1', 'codex', now - 10 * 60_000, 10 * 60_000), card('c1', 'claude_code', now - HOUR, HOUR)]
    const snap = svc.snapshot(cards)
    assert.deepStrictEqual(snap.meters.map(m => [m.provider, m.planType]), [['codex', 'plus']])
    assert.strictEqual(snap.sessions['s1'].fiveHourPct, 60)
    assert.strictEqual(snap.sessions['s1'].hits?.length, 1)
    assert.strictEqual(snap.sessions['c1'], undefined)
    assert.deepStrictEqual(snap.series.fiveHour.map(s => s.provider), ['codex'])
    assert.strictEqual(snap.historyStartsAt.claude, undefined)

    const live = svc.liveCard(cards[0], null)
    assert.ok(live)
    assert.strictEqual(live.severity, 'blocked')
    assert.strictEqual(live.blocked?.windowKind, 'weekly')
    assert.strictEqual(live.thisTrace?.fiveHourPct, 60)
    assert.ok(live.pace?.minutesToLimit !== undefined)
    assert.strictEqual(svc.liveCard(cards[1], { costPerHour: 5 }), undefined)
  })

  test('a windowless plan status reaches the snapshot, and a newer one is never replaced by an older', () => {
    const now = T0 + 2 * HOUR
    const svc = new PlanUsageService(createDb(), { claudeConfigPath: '/nonexistent/.claude.json', now: () => now })
    const status = (observedAt: number, planType: string) => ({
      provider: 'codex' as const, planType, observedAt, noWindows: true, hasCredits: true, unlimitedCredits: false, limitReached: false, sessionId: 's1',
    })
    assert.strictEqual(svc.ingest([{ card: card('s1', 'codex', T0, HOUR), workspace: '', planStatus: status(now - HOUR, 'business') }]), true)
    svc.ingest([{ card: card('s0', 'codex', T0 - 5 * HOUR, HOUR), workspace: '', planStatus: status(now - 4 * HOUR, 'plus') }])
    const snap = svc.snapshot([])
    assert.deepStrictEqual(snap.meters, [])
    assert.deepStrictEqual(snap.planStatus, [status(now - HOUR, 'business')])
  })

  test('stores a Claude cache reading once per fetch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-claude-svc-'))
    try {
      const file = path.join(dir, '.claude.json')
      fs.writeFileSync(file, JSON.stringify(claudeConfig({ fetchedAtMs: T0, week: 31 })))
      const svc = new PlanUsageService(createDb(), { claudeConfigPath: file, now: () => T0 + HOUR })
      assert.strictEqual(svc.pollClaudeCache(), true)
      assert.strictEqual(svc.pollClaudeCache(), false)
      const snap = svc.snapshot([])
      assert.deepStrictEqual(snap.meters.map(m => [m.provider, m.approximate]), [['claude', true]])
      assert.strictEqual(snap.historyStartsAt.claude, T0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
