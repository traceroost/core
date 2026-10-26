import * as assert from 'assert'
import { onDialogKey, openDialogCount, pushDialog, topDialog } from '../../../media/src/dialogStack'

/** Just enough of `document` and elements for the stack: focus, contains, querySelectorAll. */
interface FakeEl { focus(): void; offsetParent: object | null; name: string }
interface FakeDoc {
  activeElement: FakeEl | null
  body: FakeEl
  listeners: Array<(e: KeyboardEvent) => void>
  addEventListener(type: string, fn: (e: KeyboardEvent) => void): void
  removeEventListener(type: string, fn: (e: KeyboardEvent) => void): void
}

let doc: FakeDoc
function el(name: string): FakeEl {
  const e: FakeEl = { name, offsetParent: {}, focus() { doc.activeElement = e } }
  return e
}
function dialog(...items: FakeEl[]): HTMLElement {
  return {
    querySelectorAll: () => items,
    contains: (x: unknown) => items.includes(x as FakeEl),
  } as unknown as HTMLElement
}
function key(k: string, shiftKey = false) {
  const e = { key: k, shiftKey, prevented: false, stopped: false, preventDefault() { e.prevented = true }, stopPropagation() { e.stopped = true } }
  return e
}
function press(k: string, shiftKey = false) {
  const e = key(k, shiftKey)
  for (const fn of [...doc.listeners]) fn(e as unknown as KeyboardEvent)
  return e
}

suite('dialogStack', () => {
  let savedDocument: unknown
  setup(() => {
    savedDocument = (globalThis as { document?: unknown }).document
    doc = {
      activeElement: null,
      body: el('body'),
      listeners: [],
      addEventListener(_t, fn) { this.listeners.push(fn) },
      removeEventListener(_t, fn) { this.listeners = this.listeners.filter(f => f !== fn) },
    }
    ;(globalThis as { document?: unknown }).document = doc
  })
  teardown(() => {
    (globalThis as { document?: unknown }).document = savedDocument
  })

  test('one shared listener, installed only while a dialog is open', () => {
    const removeA = pushDialog({ root: () => null, close: () => {} })
    const removeB = pushDialog({ root: () => null, close: () => {} })
    assert.strictEqual(doc.listeners.length, 1)
    removeA()
    assert.strictEqual(doc.listeners.length, 1)
    removeB()
    assert.strictEqual(doc.listeners.length, 0)
    assert.strictEqual(openDialogCount(), 0)
  })

  test('Escape closes only the topmost dialog and stops there', () => {
    const closed: string[] = []
    const removeSettings = pushDialog({ root: () => null, close: () => closed.push('settings') })
    const removeOrg = pushDialog({ root: () => null, close: () => closed.push('org') })
    const e = press('Escape')
    assert.deepStrictEqual(closed, ['org'])
    assert.strictEqual(e.stopped, true)
    removeOrg()
    press('Escape')
    assert.deepStrictEqual(closed, ['org', 'settings'])
    removeSettings()
  })

  test('only the topmost dialog traps Tab', () => {
    const s1 = el('s1'), s2 = el('s2'), o1 = el('o1'), o2 = el('o2')
    const removeSettings = pushDialog({ root: () => dialog(s1, s2), close: () => {} })
    const removeOrg = pushDialog({ root: () => dialog(o1, o2), close: () => {} })
    // Focus outside the top dialog (e.g. still on the Settings link that opened it): Tab pulls it in.
    s2.focus()
    assert.strictEqual(press('Tab').prevented, true)
    assert.strictEqual(doc.activeElement, o1)
    // Wraps at both ends, within the top dialog only.
    o2.focus()
    press('Tab')
    assert.strictEqual(doc.activeElement, o1)
    press('Tab', true)
    assert.strictEqual(doc.activeElement, o2)
    // Back to Settings once the top one closes.
    removeOrg()
    s2.focus()
    press('Tab')
    assert.strictEqual(doc.activeElement, s1)
    removeSettings()
  })

  test('a dialog closing out of order leaves the topmost on top', () => {
    const a = { root: () => null, close: () => {} }
    const b = { root: () => null, close: () => {} }
    const removeA = pushDialog(a)
    const removeB = pushDialog(b)
    removeA()
    assert.strictEqual(topDialog(), b)
    removeA() // removing twice is harmless
    assert.strictEqual(openDialogCount(), 1)
    removeB()
    assert.strictEqual(topDialog(), undefined)
  })

  test('keys do nothing with no dialog open', () => {
    const e = key('Escape')
    onDialogKey(e as unknown as KeyboardEvent)
    assert.strictEqual(e.stopped, false)
  })
})
