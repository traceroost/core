import * as assert from 'assert'
import './domShim'
import {
  fitPageSize, getSessionsPagination, MIN_FIT_ROWS, parseSessionsPageSizeChoice, rowsThatFit, sessionsPage,
  sessionsPageSize, sessionsPageSizeChoice, setFitPageSize, setSessionsPageSize,
} from '../../../media/src/state'

suite('Traces page size — Fit', () => {
  setup(() => {
    setSessionsPageSize('fit')
    fitPageSize.value = 20
    sessionsPage.value = 0
  })

  test('rows that fit: whole rows only, never below the minimum', () => {
    assert.strictEqual(rowsThatFit(738 - 130, 28), 21)
    assert.strictEqual(rowsThatFit(1200, 28), 42)
    assert.strictEqual(rowsThatFit(60, 28), MIN_FIT_ROWS)
    assert.strictEqual(rowsThatFit(-40, 28), MIN_FIT_ROWS)
  })

  test('nothing measured yet (no row, or a hidden tab) leaves the page size alone', () => {
    assert.strictEqual(rowsThatFit(600, 0), undefined)
    assert.strictEqual(rowsThatFit(Number.NaN, 28), undefined)
  })

  test('the page size in effect follows the measurement while the choice is Fit', () => {
    setFitPageSize(26)
    assert.strictEqual(sessionsPageSize.value, 26)
    assert.strictEqual(getSessionsPagination(100).totalPages, 4)
  })

  test('a fixed choice ignores the measurement', () => {
    setSessionsPageSize(50)
    setFitPageSize(26)
    assert.strictEqual(sessionsPageSize.value, 50)
  })

  test('a resize keeps the first visible trace on screen instead of jumping to page 1', () => {
    sessionsPage.value = 3 // rows 60–79 at 20 per page
    setFitPageSize(30)
    assert.strictEqual(sessionsPage.value, 2) // rows 60–89
    setFitPageSize(10)
    assert.strictEqual(sessionsPage.value, 6) // rows 60–69
  })

  test('the choice is stored, and Fit is understood when read back', () => {
    const store = new Map<string, string>()
    const g = globalThis as { localStorage?: unknown }
    const had = g.localStorage
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }
    try {
      setSessionsPageSize(100)
      assert.strictEqual(store.get('traceroost-sessions-page-size'), '100')
      setSessionsPageSize('fit')
      assert.strictEqual(store.get('traceroost-sessions-page-size'), 'fit')
      assert.strictEqual(sessionsPageSizeChoice.value, 'fit')
    } finally {
      g.localStorage = had
    }
  })

  test('stored values: Fit, the fixed sizes, and anything else falls back to the default', () => {
    assert.strictEqual(parseSessionsPageSizeChoice('fit'), 'fit')
    assert.strictEqual(parseSessionsPageSizeChoice('20'), 20)
    assert.strictEqual(parseSessionsPageSizeChoice('500'), 500)
    for (const bad of [null, undefined, '', '37', 'auto', 'NaN']) assert.strictEqual(parseSessionsPageSizeChoice(bad), undefined, String(bad))
  })
})
