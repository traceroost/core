import { useEffect, useRef, type MutableRef } from 'preact/hooks'

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

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary'

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null || el === document.activeElement)
}

/**
 * Dialog behavior for the dashboard's drawers and popovers: while `open`, Escape calls `onClose`,
 * focus moves into the dialog (its first focusable control) and Tab/Shift+Tab wrap inside it;
 * on close, focus returns to whatever had it before opening — unless something else already took
 * it (e.g. "View trace" focusing a row). Returns the ref to put on the dialog's root element.
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

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      if (e.key !== 'Tab' || !root) return
      const items = focusables(root)
      if (items.length === 0) return
      const first = items[0], last = items[items.length - 1]
      const active = document.activeElement
      if (!root.contains(active)) { e.preventDefault(); first.focus(); return }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      // Hand focus back only if it's still in the closing dialog (or was dropped to <body>).
      const active = document.activeElement
      const lost = active === null || active === document.body || (root?.contains(active) ?? false)
      if (lost && opener && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [open])

  return ref
}
