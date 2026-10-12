import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { SIGNAL_FORMULAS } from '../loopDetector'

// The signal catalog's size is stated in prose in a few shipped docs. Help.tsx derives it from
// SIGNAL_FORMULAS; these can't, so this test fails when one of them drifts from the code.

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']

const root = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

/** `export const SIGNAL_FORMULAS … }` — the part both copies must share byte for byte. */
function formulaBlock(source: string): string {
  const start = source.indexOf('export const SIGNAL_FORMULAS')
  assert.ok(start >= 0, 'SIGNAL_FORMULAS not found')
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end + 3)
}

/** Every catalog-size claim in `text` — "<count> named signals", "<count> stuck-agent and waste
 *  signals", "detects/surfaces … and <count> signals" — as numbers. (Not every "<n> signals": "Two
 *  signals still don't fire here" is about a subset.) */
function statedCounts(text: string): number[] {
  const n = `(${NUMBER_WORDS.join('|')}|\\d+)`
  const res = [
    new RegExp(`\\b${n}\\s+named\\s+signals\\b`, 'gi'),
    new RegExp(`\\b${n}\\s+stuck-agent and waste\\s+signals\\b`, 'gi'),
    new RegExp(`\\b(?:detects|and)\\s+${n}\\s+signals\\b`, 'gi'),
  ]
  return res.flatMap(re => [...text.matchAll(re)].map(m => {
    const w = m[1].toLowerCase()
    return /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS.indexOf(w)
  }))
}

suite('signal count — docs match SIGNAL_FORMULAS', () => {
  const count = Object.keys(SIGNAL_FORMULAS).length

  test('src/loopDetector.ts and media/src/signalFormulas.ts carry a byte-identical SIGNAL_FORMULAS', () => {
    assert.strictEqual(formulaBlock(read('media/src/signalFormulas.ts')), formulaBlock(read('src/loopDetector.ts')))
  })

  for (const file of ['README.md', 'package.json', 'walkthrough/loops.md']) {
    test(`${file} states the real signal count (${count})`, () => {
      const counts = statedCounts(read(file))
      assert.ok(counts.length > 0, `${file} no longer states a signal count — drop it from this test`)
      assert.deepStrictEqual(counts.filter(c => c !== count), [], `${file} states a count other than ${count}`)
    })
  }

  test('Help.tsx derives the count instead of stating one', () => {
    assert.deepStrictEqual(statedCounts(read('media/src/tabs/Help.tsx')), [])
  })
})
