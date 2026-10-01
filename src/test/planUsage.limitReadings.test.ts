import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader } from '../logReader'
import { CodexLimitCollector } from '../planUsage/limitReadings'

/** The real shape, from a Codex CLI rollout on 2026-09-18. */
function rateLimits(primaryPct: number, secondaryPct: number, extra: Record<string, unknown> = {}) {
  return {
    limit_id: 'codex',
    limit_name: null,
    primary: { used_percent: primaryPct, window_minutes: 300, resets_at: 1790052354 },
    secondary: { used_percent: secondaryPct, window_minutes: 10080, resets_at: 1790178910 },
    credits: { has_credits: false, unlimited: false, balance: '0' },
    individual_limit: null,
    spend_control_reached: null,
    plan_type: 'plus',
    rate_limit_reached_type: null,
    ...extra,
  }
}

function tokenCountPayload(rl: unknown, withInfo = true): Record<string, unknown> {
  return {
    type: 'token_count',
    info: withInfo
      ? { total_token_usage: { input_tokens: 10, output_tokens: 5 }, last_token_usage: { input_tokens: 1, output_tokens: 1 } }
      : null,
    ...(rl === undefined ? {} : { rate_limits: rl }),
  }
}

suite('CodexLimitCollector', () => {
  test('reads both windows, classified by window length, with resets_at in ms', () => {
    const c = new CodexLimitCollector('s1')
    c.add(tokenCountPayload(rateLimits(23, 38)), '2026-09-18T17:50:00.000Z')
    const readings = c.readingsOut()
    assert.deepStrictEqual(readings.map(r => [r.windowKind, r.usedPct, r.resetsAt]), [
      ['five_hour', 23, 1790052354000],
      ['weekly', 38, 1790178910000],
    ])
    for (const r of readings) {
      assert.strictEqual(r.provider, 'codex')
      assert.strictEqual(r.source, 'codex_rollout')
      assert.strictEqual(r.sessionId, 's1')
      assert.strictEqual(r.planType, 'plus')
      assert.strictEqual(r.observedAt, Date.parse('2026-09-18T17:50:00.000Z'))
    }
  })

  test('primary-only rollouts yield only the 5-hour window', () => {
    const c = new CodexLimitCollector('s1')
    c.add(tokenCountPayload({ primary: { used_percent: 3, window_minutes: 300, resets_at: 1787000000 } }), '2026-08-21T09:00:01Z')
    assert.deepStrictEqual(c.readingsOut().map(r => r.windowKind), ['five_hour'])
  })

  test('a token_count with info: null still counts as a reading', () => {
    const c = new CodexLimitCollector('s1')
    c.add(tokenCountPayload(rateLimits(3, 4), false), '2026-08-21T09:00:01Z')
    assert.strictEqual(c.readingsOut().length, 2)
  })

  test('missing, null, or malformed rate_limits produce nothing', () => {
    const c = new CodexLimitCollector('s1')
    c.add(tokenCountPayload(undefined), '2026-08-21T09:00:01Z')
    c.add(tokenCountPayload(null), '2026-08-21T09:00:02Z')
    c.add(tokenCountPayload('nope'), '2026-08-21T09:00:03Z')
    c.add(tokenCountPayload({ primary: { used_percent: 'x', window_minutes: 300 } }), '2026-08-21T09:00:04Z')
    c.add(tokenCountPayload({ primary: { used_percent: 5, window_minutes: 42 } }), '2026-08-21T09:00:05Z')
    c.add(tokenCountPayload(rateLimits(1, 1)), undefined)
    assert.deepStrictEqual(c.readingsOut(), [])
    assert.deepStrictEqual(c.hitsOut(), [])
  })

  test('repeated identical readings collapse to the first change plus the latest observation', () => {
    const c = new CodexLimitCollector('s1')
    c.add(tokenCountPayload(rateLimits(10, 30)), '2026-09-18T10:00:00Z')
    c.add(tokenCountPayload(rateLimits(10, 30)), '2026-09-18T10:01:00Z')
    c.add(tokenCountPayload(rateLimits(12, 30)), '2026-09-18T10:02:00Z')
    c.add(tokenCountPayload(rateLimits(12, 30)), '2026-09-18T10:03:00Z')
    const fiveHour = c.readingsOut().filter(r => r.windowKind === 'five_hour')
    assert.deepStrictEqual(fiveHour.map(r => [r.usedPct, new Date(r.observedAt).toISOString()]), [
      [10, '2026-09-18T10:00:00.000Z'],
      [12, '2026-09-18T10:02:00.000Z'],
      [12, '2026-09-18T10:03:00.000Z'],
    ])
    const weekly = c.readingsOut().filter(r => r.windowKind === 'weekly')
    assert.deepStrictEqual(weekly.map(r => new Date(r.observedAt).toISOString()), [
      '2026-09-18T10:00:00.000Z',
      '2026-09-18T10:03:00.000Z',
    ])
  })

  test('a window reset (used_percent dropping) is kept as a change', () => {
    const c = new CodexLimitCollector('s1')
    c.add(tokenCountPayload(rateLimits(95, 40)), '2026-09-18T10:00:00Z')
    c.add(tokenCountPayload(rateLimits(2, 41)), '2026-09-18T15:05:00Z')
    assert.deepStrictEqual(c.readingsOut().filter(r => r.windowKind === 'five_hour').map(r => r.usedPct), [95, 2])
  })

  test('a limit hit is recorded once per run of reached events, against the named window', () => {
    const c = new CodexLimitCollector('s1')
    c.add(tokenCountPayload(rateLimits(99, 40)), '2026-09-18T10:00:00Z')
    c.add(tokenCountPayload(rateLimits(100, 40, { rate_limit_reached_type: 'primary' })), '2026-09-18T10:01:00Z')
    c.add(tokenCountPayload(rateLimits(100, 40, { rate_limit_reached_type: 'primary' })), '2026-09-18T10:02:00Z')
    c.add(tokenCountPayload(rateLimits(3, 41)), '2026-09-18T15:05:00Z')
    c.add(tokenCountPayload(rateLimits(60, 100, { rate_limit_reached_type: 'secondary' })), '2026-09-19T10:00:00Z')
    assert.deepStrictEqual(c.hitsOut().map(h => [h.windowKind, new Date(h.hitAt).toISOString(), h.resetsAt]), [
      ['five_hour', '2026-09-18T10:01:00.000Z', 1790052354000],
      ['weekly', '2026-09-19T10:00:00.000Z', 1790178910000],
    ])
  })

  test('an unrecognized reached value falls back to the full window', () => {
    const c = new CodexLimitCollector('s1')
    c.add(tokenCountPayload(rateLimits(40, 100, { rate_limit_reached_type: 'something_new' })), '2026-09-18T10:00:00Z')
    assert.deepStrictEqual(c.hitsOut().map(h => h.windowKind), ['weekly'])
  })

  // The real shape from a ChatGPT Business account (Codex 0.155.0-alpha, 2026-10-01): no windows,
  // metered in credits.
  const business = (extra: Record<string, unknown> = {}) => ({
    limit_id: 'codex', limit_name: null, primary: null, secondary: null,
    credits: { has_credits: true, unlimited: false, balance: null },
    individual_limit: null, spend_control_reached: null, plan_type: 'business', rate_limit_reached_type: null,
    ...extra,
  })

  test('a plan with no windows yields no readings, but a status saying so', () => {
    const c = new CodexLimitCollector('s1')
    c.add(tokenCountPayload(business()), '2026-10-01T13:30:00Z')
    c.add(tokenCountPayload(business()), '2026-10-01T13:35:00Z')
    assert.deepStrictEqual(c.readingsOut(), [])
    assert.deepStrictEqual(c.hitsOut(), [])
    assert.deepStrictEqual(c.statusOut(), {
      provider: 'codex', planType: 'business', observedAt: Date.parse('2026-10-01T13:35:00Z'), sessionId: 's1',
      noWindows: true, hasCredits: true, unlimitedCredits: false, limitReached: false,
    })
  })

  test('a spend cap, or a limit with no window, marks the status as reached', () => {
    const capped = new CodexLimitCollector('s1')
    capped.add(tokenCountPayload(business({ spend_control_reached: true })), '2026-10-01T13:30:00Z')
    assert.strictEqual(capped.statusOut()?.limitReached, true)
    const reached = new CodexLimitCollector('s1')
    reached.add(tokenCountPayload(business({ rate_limit_reached_type: 'credits' })), '2026-10-01T13:30:00Z')
    assert.strictEqual(reached.statusOut()?.limitReached, true)
    assert.deepStrictEqual(reached.hitsOut(), [])
  })

  test('a credit balance is kept only when it is a plain number', () => {
    const c = new CodexLimitCollector('s1')
    c.add(tokenCountPayload(business({ credits: { has_credits: true, unlimited: false, balance: '12.50' } })), '2026-10-01T13:30:00Z')
    assert.strictEqual(c.statusOut()?.creditBalance, '12.50')
    c.add(tokenCountPayload(business({ credits: { has_credits: true, unlimited: false, balance: 'see admin' } })), '2026-10-01T13:31:00Z')
    assert.strictEqual(c.statusOut()?.creditBalance, undefined)
  })

  test('a plan with windows still reports a status, with noWindows false', () => {
    const c = new CodexLimitCollector('s1')
    c.add(tokenCountPayload(rateLimits(10, 20)), '2026-09-18T10:00:00Z')
    assert.strictEqual(c.statusOut()?.noWindows, false)
    assert.strictEqual(c.statusOut()?.creditBalance, '0')
  })
})

suite('LogReader — Codex plan-limit readings', () => {
  let tmpDir: string
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-codex-limits-')) })
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  function write(name: string, lines: Record<string, unknown>[]): string {
    const filePath = path.join(tmpDir, name)
    fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    return filePath
  }

  const start = (ts: string) => [
    { timestamp: ts, type: 'session_meta', payload: { session_id: 'sess', cwd: '/tmp/proj' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'thread_settings_applied' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
  ]

  test('attaches readings and hits to the session result, not the card', () => {
    const filePath = write('rollout-a.jsonl', [
      ...start('2026-09-18T10:00:00.000Z'),
      { timestamp: '2026-09-18T10:00:05.000Z', type: 'event_msg', payload: tokenCountPayload(rateLimits(20, 30)) },
      { timestamp: '2026-09-18T10:00:09.000Z', type: 'event_msg', payload: tokenCountPayload(rateLimits(100, 31, { rate_limit_reached_type: 'primary' })) },
    ])
    const [result] = new LogReader().parseFile(filePath, 'codex')
    assert.ok(result)
    assert.deepStrictEqual(result.limitReadings?.map(r => [r.windowKind, r.usedPct]), [
      ['five_hour', 20], ['weekly', 30], ['five_hour', 100], ['weekly', 31],
    ])
    assert.strictEqual(result.limitReadings?.[0].sessionId, result.card.sessionId)
    assert.deepStrictEqual(result.limitHits?.map(h => h.windowKind), ['five_hour'])
    assert.strictEqual((result.card as unknown as Record<string, unknown>)['limitReadings'], undefined)
  })

  test('a session with no rate_limits carries no limit fields at all', () => {
    const filePath = write('rollout-b.jsonl', [
      ...start('2026-09-18T10:00:00.000Z'),
      { timestamp: '2026-09-18T10:00:05.000Z', type: 'event_msg', payload: tokenCountPayload(undefined) },
    ])
    const [result] = new LogReader().parseFile(filePath, 'codex')
    assert.ok(result)
    assert.strictEqual('limitReadings' in result, false)
    assert.strictEqual('limitHits' in result, false)
  })
})
