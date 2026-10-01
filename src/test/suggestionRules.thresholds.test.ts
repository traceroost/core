import * as assert from 'assert'
import {
  generateSuggestions,
  getFrontLoadedDiscoverySuggestions,
  getHighTurnSuggestions,
  getHotFileSuggestions,
  getLoopSuggestions,
  getScopeSuggestions,
  getToolDisciplineSuggestions,
  type SuggestionSession,
} from '../suggestionRules'

// Thresholds and suppression of each rule. The rules are import-free and pure, so sessions here
// carry only the fields the rules read.

function s(id: string, overrides: Partial<SuggestionSession> = {}): SuggestionSession {
  return { sessionId: id, totalLlmCalls: 5, ...overrides }
}
function many(n: number, f: (i: number) => Partial<SuggestionSession> = () => ({})): SuggestionSession[] {
  return Array.from({ length: n }, (_, i) => s(`s${i}`, f(i)))
}
const noCost = () => 0

suite('suggestionRules — thresholds and suppression', () => {
  suite('hot files', () => {
    test('needs three sessions and 20% share; priority is high from 40%', () => {
      assert.deepStrictEqual(getHotFileSuggestions(many(2, () => ({ filesRead: ['src/core/engine.ts'] })), ''), [])
      const sessions = many(10, i => ({
        filesRead: i < 4 ? ['src/core/engine.ts', 'src/core/engine.ts'] : [],
        filesChanged: i < 2 ? ['lib/util.ts'] : i < 3 ? ['README.md'] : [],
      }))
      const cards = getHotFileSuggestions(sessions, '')
      assert.deepStrictEqual(cards.map(c => [c.id, c.priority, c.evidenceSessions.length]), [
        ['hot_file:src_core_engine_ts', 'high', 4],
        ['hot_file:lib_util_ts', 'medium', 2],
      ])
      assert.match(cards[0].suggestedText, /before editing core —/)
      assert.match(cards[0].evidence, /Touched in 4 of 10 traces \(40%\)/)
    })

    test('a top-level file names "this area"; short or already-mentioned basenames are skipped', () => {
      const sessions = many(3, () => ({ filesRead: ['Makefile', 'a.c', 'C:\\repo\\docs\\GUIDE.md'] }))
      const cards = getHotFileSuggestions(sessions, 'see guide.md for docs')
      assert.deepStrictEqual(cards.map(c => c.title), ['Add Makefile to instruction file'])
      assert.match(cards[0].suggestedText, /before editing this area/)
    })

    test('at most six cards, most-touched first', () => {
      const files = Array.from({ length: 8 }, (_, i) => `src/file${i}.ts`)
      const sessions = many(5, i => ({ filesRead: files.slice(0, 8 - i) }))
      const cards = getHotFileSuggestions(sessions, '')
      assert.strictEqual(cards.length, 6)
      assert.ok(cards[0].evidenceSessions.length >= cards[5].evidenceSessions.length)
    })
  })

  suite('front-loaded discovery', () => {
    test('needs eight sessions; only never-modified files read in half of them', () => {
      assert.deepStrictEqual(getFrontLoadedDiscoverySuggestions(many(7, () => ({ filesRead: ['docs/ARCH.md'] })), ''), [])
      const sessions = many(8, i => ({
        filesRead: ['docs/ARCH.md', 'docs/ARCH.md', 'src/edited.ts', ...(i < 3 ? ['src/rare.ts'] : []), 'x.y'],
        filesChanged: i === 0 ? ['src/edited.ts'] : undefined,
      }))
      const cards = getFrontLoadedDiscoverySuggestions(sessions, '')
      assert.deepStrictEqual(cards.map(c => c.id), ['discovery:docs_arch_md'])
      assert.strictEqual(cards[0].evidenceSessions.length, 8)
      assert.deepStrictEqual(getFrontLoadedDiscoverySuggestions(sessions, 'Read ARCH.md first'), [])
    })

    test('at most three, sorted by frequency', () => {
      const sessions = many(8, i => ({ filesRead: ['aaaa.md', 'bbbb.md', 'cccc.md', 'dddd.md'].slice(0, i < 6 ? 4 : 3) }))
      const cards = getFrontLoadedDiscoverySuggestions(sessions, '')
      assert.strictEqual(cards.length, 3)
      assert.ok(!cards.some(c => c.id === 'discovery:dddd_md'), 'the least-read file is the one dropped')
    })
  })

  suite('loop signals', () => {
    test('needs five sessions and a 20% share of a known signal type', () => {
      assert.deepStrictEqual(getLoopSuggestions(many(4, () => ({ loopSignals: [{ type: 'runaway_steps' }] })), ''), [])
      const sessions = many(10, i => ({
        loopSignals: [
          ...(i < 4 ? [{ type: 'error_recurrence' }] : []),
          ...(i < 2 ? [{ type: 'token_runaway' }] : []),
          ...(i < 1 ? [{ type: 'edit_revert_cycle' }] : []),
          ...(i < 5 ? [{ type: 'some_new_signal' }] : []),
        ],
      }))
      const cards = getLoopSuggestions(sessions, '')
      assert.deepStrictEqual(cards.map(c => [c.id, c.priority]), [['loop:error_recurrence', 'high'], ['loop:token_runaway', 'medium']])
      assert.match(cards[0].inquiryText, /in 4 of 10 traces you retried the same failing operation/)
      assert.strictEqual(cards[1].title, 'Prevent token runaway loops')
    })

    test('suppressed once the instruction file already carries the advice', () => {
      const sessions = many(5, () => ({ loopSignals: [{ type: 'exact_tool_repeat' }, { type: 'runaway_steps' }] }))
      const cards = getLoopSuggestions(sessions, 'After reading a file, do not re-read it unless you changed it.')
      assert.deepStrictEqual(cards.map(c => c.id), ['loop:runaway_steps'])
    })
  })

  suite('scope prompting', () => {
    const vague = (i: number) => ({ userRequest: i < 2 ? 'please refactor this' : 'rename foo in bar.ts' })

    test('prefers cost when the matching sessions have it', () => {
      const cost = (x: SuggestionSession) => (x.userRequest?.includes('refactor') ? 5 : 1)
      const [card] = getScopeSuggestions(many(6, vague), '', cost)
      assert.strictEqual(card.id, 'prompting:scope')
      assert.match(card.evidence, /run \d+\.\d× avg cost \(2 of 6 traces\)/)
      assert.deepStrictEqual(card.evidenceSessions, ['s0', 's1'])
    })

    test('falls back to turns when there is no cost data', () => {
      const sessions = many(6, i => ({ ...vague(i), totalLlmCalls: i < 2 ? 30 : 5 }))
      const [card] = getScopeSuggestions(sessions, '', noCost)
      assert.match(card.evidence, /avg turns/)
    })

    test('no card when guidance exists, too few sessions or matches, no metric, or no outsized cost', () => {
      assert.deepStrictEqual(getScopeSuggestions(many(6, vague), 'Prompting guidance: be specific', noCost), [])
      assert.deepStrictEqual(getScopeSuggestions(many(4, vague), '', noCost), [])
      assert.deepStrictEqual(getScopeSuggestions(many(6, i => ({ userRequest: i < 1 ? 'fix the bug' : 'x' })), '', noCost), [])
      assert.deepStrictEqual(getScopeSuggestions(many(6, i => ({ ...vague(i), totalLlmCalls: 0 })), '', noCost), [])
      assert.deepStrictEqual(getScopeSuggestions(many(6, vague), '', () => 1), [], 'vague prompts cost the same as the rest')
      assert.deepStrictEqual(getScopeSuggestions(many(6, i => ({ userRequest: i < 2 ? undefined : 'x' })), '', noCost), [])
    })
  })

  suite('high turns', () => {
    test('fires when enough sessions run 1.5× an average of at least eight turns', () => {
      const sessions = many(6, i => ({ totalLlmCalls: i === 0 ? 40 : 8 }))
      const [card] = getHighTurnSuggestions(sessions, '')
      assert.strictEqual(card.id, 'behavior:high_turns')
      assert.deepStrictEqual(card.evidenceSessions, ['s0'])
    })

    test('no card for existing guidance, few or turnless sessions, a low average, or rare outliers', () => {
      const high = many(6, i => ({ totalLlmCalls: i === 0 ? 40 : 8 }))
      assert.deepStrictEqual(getHighTurnSuggestions(high, 'State what you want done'), [])
      assert.deepStrictEqual(getHighTurnSuggestions(high.slice(0, 4), ''), [])
      assert.deepStrictEqual(getHighTurnSuggestions(many(6, i => ({ totalLlmCalls: i < 2 ? 40 : 0 })), ''), [])
      assert.deepStrictEqual(getHighTurnSuggestions(many(6, () => ({ totalLlmCalls: 3 })), ''), [])
      assert.deepStrictEqual(getHighTurnSuggestions(many(10, i => ({ totalLlmCalls: i === 0 ? 30 : 10 })), ''), [])
    })
  })

  suite('tool discipline', () => {
    test('fires when three sessions use the terminal more than 3× the read tool, across agent aliases', () => {
      const counts: Array<Record<string, number>> = [
        { Bash: 7, Read: 2 }, { run_in_terminal: 4, read_file: 1 }, { execute_command: 10, view_file: 1, Grep: 50 }, { Bash: 9 }, { Bash: 9 },
      ]
      const sessions = many(5, i => ({ toolCounts: counts[i] }))
      const [card] = getToolDisciplineSuggestions(sessions, '')
      assert.strictEqual(card.id, 'behavior:tool_discipline')
      assert.deepStrictEqual(card.evidenceSessions, ['s0', 's1', 's2'], 'terminal-only sessions (no reads) do not count')
      assert.deepStrictEqual(getToolDisciplineSuggestions(sessions, 'Use the Read tool, never cat, head, or tail'), [])
      assert.deepStrictEqual(getToolDisciplineSuggestions(sessions.slice(0, 4), ''), [])
      assert.deepStrictEqual(getToolDisciplineSuggestions(sessions.map((x, i) => (i === 0 ? { ...x, toolCounts: { Bash: 6, Read: 2 } } : x)), ''), [],
        'exactly 3× is not "more than 3×", leaving only two heavy sessions')
    })
  })

  test('generateSuggestions needs three sessions and concatenates every rule', () => {
    assert.deepStrictEqual(generateSuggestions(many(2), '', noCost), [])
    const sessions = many(10, i => ({
      filesRead: ['src/core/engine.ts'],
      loopSignals: i < 3 ? [{ type: 'runaway_steps' }] : [],
      toolCounts: { Bash: 10, Read: 1 },
      totalLlmCalls: i < 3 ? 60 : 9,
    }))
    const ids = generateSuggestions(sessions, '', noCost).map(c => c.id)
    for (const id of ['hot_file:src_core_engine_ts', 'discovery:src_core_engine_ts', 'loop:runaway_steps', 'behavior:high_turns', 'behavior:tool_discipline']) {
      assert.ok(ids.includes(id), `${id} in ${ids.join(', ')}`)
    }
  })
})
