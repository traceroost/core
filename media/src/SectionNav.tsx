import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

// Left-hand jump rail for long single-page tabs (Analytics, Advisor) — the same pattern as
// cloud's analytics/advisor nav rail. Cloud uses plain `#id` anchors + :target styling; here
// the scrolling element is `.panel.active` (base.css), not the document, so clicks scroll
// explicitly and the active link follows the scroll position instead. Scroll events don't bubble,
// so a capture-phase window listener picks up whichever ancestor actually scrolls.

export interface NavSection { id: string; label: string }

export function SectionNav({ label, sections, children }: { label: string; sections: NavSection[]; children: ComponentChildren }) {
  const shellRef = useRef<HTMLDivElement>(null)
  // A clicked link stays highlighted while its smooth scroll runs — otherwise a short section near
  // the bottom (which can never reach the top) would light up the last link instead.
  const clickLockUntil = useRef(0)
  const [active, setActive] = useState<string | null>(sections[0]?.id ?? null)
  const key = sections.map(s => s.id).join('|')

  useEffect(() => {
    const onScroll = (e: Event) => {
      const shell = shellRef.current
      const scroller = e.target instanceof HTMLElement ? e.target : document.documentElement
      if (!shell || !scroller.contains(shell)) return
      if (Date.now() < clickLockUntil.current) { clickLockUntil.current = Date.now() + 150; return }
      const top = Math.max(0, scroller.getBoundingClientRect().top) + 48
      let current = sections[0]?.id ?? null
      for (const s of sections) {
        const el = document.getElementById(s.id)
        if (el && el.getBoundingClientRect().top <= top) current = s.id
      }
      // Short trailing sections can never reach the top — treat "scrolled to the end" as the last one.
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) current = sections[sections.length - 1]?.id ?? current
      setActive(current)
    }
    setActive(sections[0]?.id ?? null)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => window.removeEventListener('scroll', onScroll, { capture: true })
  }, [key])

  const jump = (id: string) => {
    setActive(id)
    clickLockUntil.current = Date.now() + 600
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div class="section-nav-shell" ref={shellRef}>
      {sections.length > 1 && (
        <nav class="section-nav-rail" aria-label={label}>
          {sections.map(s => (
            <button
              key={s.id}
              type="button"
              class={s.id === active ? 'active' : undefined}
              aria-current={s.id === active ? 'location' : undefined}
              onClick={() => jump(s.id)}
            >{s.label}</button>
          ))}
        </nav>
      )}
      <div class="section-nav-content">{children}</div>
    </div>
  )
}
