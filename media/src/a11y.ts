import { useEffect, useRef, type MutableRef } from 'preact/hooks'
import { focusables, pushDialog, topDialog } from './dialogStack'

/** True when the OS asks for less motion — JS-driven smooth scrolling ignores the CSS
 *  `scroll-behavior` override in base.css, so callers pick their behavior with this. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

/** 'smooth', or 'auto' (an instant jump) when reduced motion is requested. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}

/**
 * Dialog behavior for the dashboard's drawers and popovers: while `open`, Escape calls `onClose`,
 * focus moves into the dialog (its first focusable control) and Tab/Shift+Tab wrap inside it;
 * on close, focus returns to whatever had it before opening — unless something else already took
 * it (e.g. "View trace" focusing a row). With several open (dialogStack.ts), only the topmost
 * handles Tab and Escape. Returns the ref to put on the dialog's root element.
 */
export function useDialog<T extends HTMLElement>(open: boolean, onClose: () => void): MutableRef<T | null> {
  const ref = useRef<T | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    const root = ref.current
    if (root && !root.contains(document.activeElement)) focusables(root)[0]?.focus({ preventScroll: true })

    const remove = pushDialog({ root: () => root, close: () => onCloseRef.current() })
    return () => {
      remove()
      // Hand focus back only if it's still in the closing dialog (or was dropped to <body>): to
      // the opener, or — if that's gone — into the dialog now on top, so Tab stays trapped there.
      const active = document.activeElement
      const lost = active === null || active === document.body || (root?.contains(active) ?? false)
      if (!lost) return
      if (opener && opener.isConnected && opener !== document.body) { opener.focus({ preventScroll: true }); return }
      const below = topDialog()?.root()
      if (below) focusables(below)[0]?.focus({ preventScroll: true })
    }
  }, [open])

  return ref
}
