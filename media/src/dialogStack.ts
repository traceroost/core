/**
 * The open dialogs (src/a11y.ts useDialog), topmost last. Two can be open at once — the Settings
 * drawer, then the TraceRoost Cloud drawer opened from a "Link to Cloud" note inside it — and
 * only the topmost may act on a key: it alone traps Tab, and one Escape closes it alone. One
 * shared keydown listener serves the whole stack, installed while any dialog is open.
 *
 * Kept free of Preact so the unit tests (src/test/media/dialogStack.test.ts) can drive it.
 */

export interface DialogEntry {
  /** The dialog's root element (null before it mounts). */
  root: () => HTMLElement | null
  /** Closes the dialog (its Escape action). */
  close: () => void
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary'

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null || el === document.activeElement)
}

const stack: DialogEntry[] = []

export function topDialog(): DialogEntry | undefined {
  return stack[stack.length - 1]
}

/** Number of open dialogs — for tests. */
export function openDialogCount(): number {
  return stack.length
}

/** Escape closes the topmost dialog only, and goes no further (so a window-level Escape handler
 *  doesn't act on it too); Tab and Shift+Tab wrap inside the topmost dialog. */
export function onDialogKey(e: KeyboardEvent): void {
  const top = topDialog()
  if (!top) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    top.close()
    return
  }
  const root = top.root()
  if (e.key !== 'Tab' || !root) return
  const items = focusables(root)
  if (items.length === 0) return
  const first = items[0], last = items[items.length - 1]
  const active = document.activeElement
  if (!root.contains(active)) { e.preventDefault(); first.focus(); return }
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
}

/** Puts `entry` on top of the stack; the returned function takes it off again (wherever it is
 *  by then — dialogs can close out of order). Listens on `document`, so a control inside the
 *  dialog that handles its own Escape sees it first, and `stopPropagation` keeps it from
 *  reaching `window`. */
export function pushDialog(entry: DialogEntry): () => void {
  if (stack.length === 0) document.addEventListener('keydown', onDialogKey)
  stack.push(entry)
  return () => {
    const i = stack.indexOf(entry)
    if (i === -1) return
    stack.splice(i, 1)
    if (stack.length === 0) document.removeEventListener('keydown', onDialogKey)
  }
}
