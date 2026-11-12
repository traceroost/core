import * as assert from 'assert'
import { churnLines } from './cohortCli'
import type { TurnoverResult } from '../../src/turnover'

function measured(overrides: Partial<TurnoverResult> = {}): TurnoverResult {
  return {
    kind: 'measured',
    cohortLabel: '2026-07',
    windowDays: 30,
    turnoverRate: 134 / 494,
    aiLinesAuthored: 494,
    aiLinesSurviving: 360,
    commitCount: 3,
    mergeRange: { fromIso: '2026-07-19T00:00:00.000Z', toIso: '2026-07-27T00:00:00.000Z' },
    benchmark: { low: 0.12, high: 0.18, healthyUnder: 0.15, verdict: 'elevated' },
    cohortShas: ['a', 'b', 'c'],
    commits: [
      { sha: 'a', authoredAt: '2026-07-19T00:00:00.000Z', linesAdded: 300, aiLines: 300, aiLinesSurviving: 200, attribution: 'certain' },
      { sha: 'b', authoredAt: '2026-07-20T00:00:00.000Z', linesAdded: 110, aiLines: 110, aiLinesSurviving: 100, attribution: 'certain' },
      { sha: 'c', authoredAt: '2026-07-27T00:00:00.000Z', linesAdded: 90, aiLines: 84, aiLinesSurviving: 60, attribution: 'probable' },
    ],
    ...overrides,
  }
}

const COVERAGE = { attributedLines: 620, totalMergedLines: 1000 }

suite('churnLines', () => {
  test('the count beside the percentage is the churned lines, not the surviving ones', () => {
    assert.strictEqual(
      churnLines(measured(), COVERAGE)[0],
      'Churn:             27.1%   (134 of 494 lines in agent-edited files rewritten or removed)',
    )
  })

  test('says how firm the attribution is, and how much of the repo it covers', () => {
    const lines = churnLines(measured(), COVERAGE)
    assert.ok(lines.includes('Attribution:       certain for 2 commits (410 lines), probable for 1 commit (84 lines)'))
    assert.ok(lines.some(l => l.startsWith('Coverage:          62% of the lines you merged in this repo')))
  })

  test('shows the published range as context, with no verdict on the code', () => {
    const text = churnLines(measured(), COVERAGE).join('\n')
    assert.match(text, /Published range: {3}12%–18% at 30 days.*context, not a verdict/)
    assert.doesNotMatch(text, /elevated|healthy|typical|Benchmark/)
  })

  test('does not call the lines AI-written: attribution is per file', () => {
    const text = churnLines(measured(), COVERAGE).join('\n')
    assert.doesNotMatch(text, /AI lines/)
    assert.match(text, /including lines edited by hand/)
  })

  test('a result cached without per-commit detail, or a repo with nothing merged, drops those lines', () => {
    const lines = churnLines(measured({ commits: undefined }), { attributedLines: 0, totalMergedLines: 0 })
    assert.ok(!lines.some(l => l.startsWith('Attribution:') || l.startsWith('Coverage:')))
  })
})
