import * as assert from 'assert'
import { initialWindowBounds, MIN_SIZE, parseSavedWindowState, PREFERRED_SIZE, SCREEN_MARGIN, type Rect } from './windowBounds'
import { parsePrefs } from './prefs'

// A 14" MacBook Pro at its default scaling, minus the menu bar and Dock.
const LAPTOP: Rect = { x: 0, y: 38, width: 1512, height: 862 }
const DESKTOP_4K: Rect = { x: 0, y: 25, width: 2560, height: 1390 }
// An external monitor to the laptop's right.
const EXTERNAL: Rect = { x: 1512, y: 0, width: 2560, height: 1415 }

function inside(r: Rect, area: Rect): boolean {
  return r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height
}

suite('windowBounds — first launch', () => {
  test('on a laptop the window opens at the preferred size, inside the usable area', () => {
    const { bounds, maximized } = initialWindowBounds(undefined, [LAPTOP], LAPTOP)
    assert.deepStrictEqual({ width: bounds.width, height: bounds.height }, PREFERRED_SIZE)
    assert.ok(inside(bounds, LAPTOP))
    assert.strictEqual(maximized, false)
  })

  test('on a short screen the window fits the usable height with a margin, instead of running past the Dock', () => {
    const short: Rect = { x: 0, y: 25, width: 1366, height: 700 }
    const { bounds } = initialWindowBounds(undefined, [short], short)
    assert.strictEqual(bounds.height, short.height - 2 * SCREEN_MARGIN)
    assert.ok(inside(bounds, short))
  })

  test('on a big screen it opens at the preferred size, centred', () => {
    const { bounds } = initialWindowBounds(undefined, [DESKTOP_4K], DESKTOP_4K)
    assert.deepStrictEqual({ width: bounds.width, height: bounds.height }, PREFERRED_SIZE)
    assert.strictEqual(bounds.x, (DESKTOP_4K.width - PREFERRED_SIZE.width) / 2)
    assert.strictEqual(bounds.y, DESKTOP_4K.y + (DESKTOP_4K.height - PREFERRED_SIZE.height) / 2)
  })

  test('it opens on the display it is given, not at the origin', () => {
    const { bounds } = initialWindowBounds(undefined, [LAPTOP, EXTERNAL], EXTERNAL)
    assert.ok(inside(bounds, EXTERNAL))
  })

  test('a screen smaller than the minimum lowers the minimum rather than overflowing', () => {
    const tiny: Rect = { x: 0, y: 0, width: 640, height: 400 }
    const r = initialWindowBounds(undefined, [tiny], tiny)
    assert.ok(inside(r.bounds, tiny))
    assert.strictEqual(r.minWidth, 640)
    assert.strictEqual(r.minHeight, 400)
  })

  test('the minimum size is kept on a normal screen', () => {
    const r = initialWindowBounds(undefined, [LAPTOP], LAPTOP)
    assert.deepStrictEqual({ w: r.minWidth, h: r.minHeight }, { w: MIN_SIZE.width, h: MIN_SIZE.height })
  })
})

suite('windowBounds — reopening where the user left it', () => {
  test('a remembered window on an attached display opens exactly there', () => {
    const saved = { bounds: { x: 1700, y: 120, width: 1600, height: 1000 }, maximized: false }
    const { bounds } = initialWindowBounds(saved, [LAPTOP, EXTERNAL], LAPTOP)
    assert.deepStrictEqual(bounds, saved.bounds)
  })

  test('a maximised window reopens maximised', () => {
    const saved = { bounds: { x: 100, y: 100, width: 1000, height: 700 }, maximized: true }
    assert.strictEqual(initialWindowBounds(saved, [LAPTOP], LAPTOP).maximized, true)
  })

  test('a window last on a monitor that is gone comes back onto the laptop, at a size that fits', () => {
    const saved = { bounds: { x: 1700, y: 120, width: 1600, height: 1200 }, maximized: false }
    const { bounds } = initialWindowBounds(saved, [LAPTOP], LAPTOP)
    assert.ok(inside(bounds, LAPTOP), JSON.stringify(bounds))
    assert.strictEqual(bounds.width, LAPTOP.width)
    assert.strictEqual(bounds.height, LAPTOP.height)
  })

  test('a window taller than the screen after a resolution change is shrunk to fit', () => {
    const saved = { bounds: { x: 50, y: 60, width: 1200, height: 1100 }, maximized: false }
    const { bounds } = initialWindowBounds(saved, [LAPTOP], LAPTOP)
    assert.ok(inside(bounds, LAPTOP), JSON.stringify(bounds))
    assert.strictEqual(bounds.width, 1200)
  })

  test('a window hanging mostly off the bottom edge is slid back on', () => {
    const saved = { bounds: { x: 200, y: 700, width: 1000, height: 600 }, maximized: false }
    const { bounds } = initialWindowBounds(saved, [LAPTOP], LAPTOP)
    assert.ok(inside(bounds, LAPTOP), JSON.stringify(bounds))
    assert.deepStrictEqual({ w: bounds.width, h: bounds.height }, { w: 1000, h: 600 })
  })

  test('a sliver left on screen does not count as on that display', () => {
    const saved = { bounds: { x: LAPTOP.width - 20, y: 100, width: 900, height: 600 }, maximized: false }
    const { bounds } = initialWindowBounds(saved, [LAPTOP], LAPTOP)
    assert.ok(inside(bounds, LAPTOP))
  })
})

suite('windowBounds — reading the saved state', () => {
  test('a well-formed state round-trips through prefs', () => {
    const window = { bounds: { x: -1200, y: 40, width: 1100, height: 760 }, maximized: true }
    assert.deepStrictEqual(parsePrefs(JSON.stringify({ window })).window, window)
  })

  test('malformed states are dropped, so the window just fits the screen again', () => {
    for (const bad of [null, 'big', {}, { bounds: { x: 1, y: 1, width: 'wide', height: 2 } }, { bounds: { x: 0, y: 0, width: 0, height: 500 } }, { bounds: { x: NaN, y: 0, width: 10, height: 10 } }]) {
      assert.strictEqual(parseSavedWindowState(bad), undefined, JSON.stringify(bad))
    }
    assert.strictEqual(parsePrefs(JSON.stringify({ window: { bounds: null } })).window, undefined)
  })

  test('other prefs survive alongside the window state', () => {
    const prefs = parsePrefs(JSON.stringify({ moveToApplications: 'declined', window: { bounds: { x: 0, y: 0, width: 800, height: 600 } } }))
    assert.strictEqual(prefs.moveToApplications, 'declined')
    assert.strictEqual(prefs.window?.maximized, false)
  })
})
