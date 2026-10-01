import * as assert from 'assert'
import { getCostSavingActions } from '../../../media/src/costSavingActions'
import type { LoopSignal, SessionSummaryCard } from '../../../media/src/types'
import { makeCard } from './fixtures'

function signal(type: LoopSignal['type'], overrides: Partial<LoopSignal> = {}): LoopSignal {
  return { type, severity: 'warning', evidence: 'e', count: 1, examples: [], patternName: `Pattern ${type}`, action: `Fix ${type}`, ...overrides }
}
function cards(n: number, f: (i: number) => Partial<SessionSummaryCard>): SessionSummaryCard[] {
  return Array.from({ length: n }, (_, i) => makeCard({ sessionId: `s${i}`, ...f(i) }))
}
const cached = (rate: number): Partial<SessionSummaryCard> => ({ totalLlmCalls: 2, cacheReadTokens: 100, cacheHitRate: rate })

suite('costSavingActions', () => {
  test('no sessions, no actions', () => {
    assert.deepStrictEqual(getCostSavingActions([], ''), [])
  })

  test('a low cache hit rate leads, averaged only over sessions that report caching', () => {
    const sessions = [
      ...cards(3, () => cached(0.2)),
      // Sources that never report caching are "no data", not 0%.
      makeCard({ sessionId: 'nocache', totalLlmCalls: 4, cacheHitRate: 0 }),
      makeCard({ sessionId: 'nocalls', totalLlmCalls: 0, cacheCreateTokens: 5, cacheHitRate: 0 }),
    ]
    const [first] = getCostSavingActions(sessions, '')
    assert.strictEqual(first.id, 'cache_rate')
    assert.strictEqual(first.title, 'Prompt cache hit rate is 20%')
    assert.strictEqual(first.affectedSessions, 3)
    assert.strictEqual(first.priority, 'high')
    assert.match(first.evidence, /across 3 sessions in view/)
  })

  test('cache rate is medium priority between 30% and 60%, and absent at 60% or with too few sessions', () => {
    assert.strictEqual(getCostSavingActions(cards(3, () => cached(0.45)), '')[0].priority, 'medium')
    assert.deepStrictEqual(getCostSavingActions(cards(3, () => cached(0.6)), ''), [])
    assert.deepStrictEqual(getCostSavingActions(cards(2, () => cached(0)), ''), [])
  })

  test('loop signals are counted once per session, escalate to critical, and are prioritized by share', () => {
    const sessions = cards(25, i => ({
      loopSignals: [
        ...(i < 5 ? [signal('error_recurrence', { severity: i === 4 ? 'critical' : 'warning' }), signal('error_recurrence')] : []),
        ...(i < 2 ? [signal('runaway_steps')] : []),
        ...(i < 1 ? [signal('token_runaway', { wasteUsd: 0 })] : []),
      ],
    }))
    const actions = getCostSavingActions(sessions, '')
    assert.deepStrictEqual(actions.map(a => [a.id, a.priority, a.affectedSessions]), [
      ['loop_signal:error_recurrence', 'high', 5],
      ['loop_signal:runaway_steps', 'medium', 2],
      ['loop_signal:token_runaway', 'low', 1],
    ])
    assert.strictEqual(actions[0].loopSignalSeverity, 'critical')
    assert.strictEqual(actions[1].loopSignalSeverity, 'warning')
    assert.strictEqual(actions[0].title, 'Pattern error_recurrence')
    assert.strictEqual(actions[0].action, 'Fix error_recurrence')
    assert.match(actions[0].evidence, /Detected in 5 of 25 sessions \(20%\)/)
    assert.strictEqual(actions[2].estimatedUsd, undefined, 'zero waste is not priced')
  })

  test('a single session reads in the singular', () => {
    const [a] = getCostSavingActions([makeCard({ loopSignals: [signal('file_reread', { wasteUsd: 0.5 })] })], '')
    assert.match(a.evidence, /Detected in 1 of 1 session \(100%\)/)
    assert.strictEqual(a.estimatedUsd, 0.5)
  })

  test('hot files: frequently touched, undocumented, non-trivial files point at the Instructions tab', () => {
    const sessions = cards(5, i => ({
      filesRead: [
        'src/engine.ts', 'src/index.ts', 'a.c',
        ...(i < 1 ? ['C:\\repo\\docs\\GUIDE.md'] : []),
        ...(i < 4 ? ['src/documented.ts'] : []),
      ],
      filesChanged: i < 3 ? ['lib/util.ts'] : undefined,
    }))
    const hot = getCostSavingActions(sessions, 'Always read documented.ts first').find(a => a.kind === 'hot_file')!
    assert.strictEqual(hot.title, '2 files read often but missing from your instruction file')
    assert.strictEqual(hot.affectedSessions, 5)
    assert.strictEqual(hot.priority, 'high')

    const medium = getCostSavingActions(cards(5, i => ({ filesRead: i < 2 ? ['src/engine.ts'] : [] })), '').find(a => a.kind === 'hot_file')!
    assert.strictEqual(medium.title, '1 file read often but missing from your instruction file')
    assert.strictEqual(medium.priority, 'medium')

    assert.strictEqual(getCostSavingActions(cards(4, () => ({ filesRead: ['src/engine.ts'] })), '').find(a => a.kind === 'hot_file'), undefined, 'needs five sessions')
    assert.strictEqual(getCostSavingActions(cards(5, i => ({ filesRead: i < 1 ? ['src/engine.ts'] : [] })), '').find(a => a.kind === 'hot_file'), undefined, 'needs a 40% share')
  })

  test('actions are ordered by priority, then by sessions affected', () => {
    const sessions = cards(10, i => ({
      filesRead: ['src/engine.ts'],
      loopSignals: i < 1 ? [signal('runaway_steps')] : i < 3 ? [signal('error_recurrence')] : [],
    }))
    assert.deepStrictEqual(getCostSavingActions(sessions, '').map(a => a.id), ['hot_file_pointer', 'loop_signal:error_recurrence', 'loop_signal:runaway_steps'])
  })
})
