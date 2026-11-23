import type { ComponentChildren } from 'preact'
import { useRef } from 'preact/hooks'

// Left-hand menu for the Analytics and Advisor tabs: each item is a view, and only the chosen view
// renders. The same structure as cloud's Analytics and Advisor pages, where each view is a `?view=`
// URL. Items never come and go with the data: a view with nothing to show says why instead, so the
// menu reads the same every time. Each item carries a one-line hint so the label alone doesn't
// have to say where something lives.

export interface ViewNavItem<T extends string> {
  id: T
  label: string
  hint: string
  /** A small count after the label (Recommendations' pending items); omitted when 0. */
  badge?: number
}

export function ViewNav<T extends string>({ label, title, items, active, onSelect, children }: {
  /** The menu's accessible name, e.g. "Analytics views". */
  label: string
  /** The small heading over the items, e.g. "Analytics". */
  title: string
  items: ViewNavItem<T>[]
  active: T
  onSelect: (id: T) => void
  children: ComponentChildren
}) {
  const shellRef = useRef<HTMLDivElement>(null)
  const select = (id: T) => {
    onSelect(id)
    // The tab's panel is the scroller (base.css), not the document: start the new view at its top.
    const scroller = shellRef.current?.closest('.panel')
    if (scroller) scroller.scrollTop = 0
  }
  return (
    <div class="view-nav-shell" ref={shellRef}>
      <nav class="view-nav-rail" aria-label={label}>
        <div class="view-nav-title" aria-hidden="true">{title}</div>
        {items.map(it => {
          const on = it.id === active
          return (
            <button
              key={it.id}
              type="button"
              data-view={it.id}
              class={on ? 'active' : undefined}
              aria-current={on ? 'page' : undefined}
              onClick={() => select(it.id)}
            >
              <span class="view-nav-label">
                {it.label}
                {it.badge ? <span class="view-nav-badge" aria-label={`${it.badge} pending`}>{it.badge}</span> : null}
              </span>
              <span class="view-nav-hint">{it.hint}</span>
            </button>
          )
        })}
      </nav>
      <div class="view-nav-content">{children}</div>
    </div>
  )
}

/** A view's title and the one question it answers, at the top of every view. */
export function ViewHeader({ title, question }: { title: string; question: string }) {
  return (
    <div class="view-header">
      <h2>{title}</h2>
      <p>{question}</p>
    </div>
  )
}

/** A section's heading inside a view. `id` keeps deep links and tests stable. */
export function ViewSection({ id, title, tip, helpAnchor, onHelp, children }: {
  id: string
  title: string
  tip?: string
  helpAnchor?: string
  onHelp?: (anchor: string) => void
  children: ComponentChildren
}) {
  return (
    <section class="view-section" id={id}>
      <div class="view-section-head">
        <h3
          class={tip ? 'has-metric-tip' : undefined}
          data-tip={tip}
          tabIndex={tip ? 0 : undefined}
        >{title}</h3>
        {helpAnchor && onHelp && (
          <button type="button" class="view-section-help" onClick={() => onHelp(helpAnchor)} title="Learn more" aria-label={`Learn more about ${title}`}>?</button>
        )}
      </div>
      {children}
    </section>
  )
}

/** A view's empty state: what's missing and why, in place of a section that has no data. */
export function ViewEmpty({ children }: { children: ComponentChildren }) {
  return <div class="view-empty">{children}</div>
}
