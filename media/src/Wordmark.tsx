// The "traceroost" wordmark. Rendered as real text (not the brand SVG) so it
// stays hinted and crisp at small sizes — the SVG lockup at media/brand/ is for
// larger placements. "trace" tracks the theme foreground, "roost" is the brand
// teal.

type Props = { size?: number; class?: string }

const TEAL = '#0FBFA6'

export function Wordmark({ size = 15, class: cls }: Props) {
  return (
    <span
      class={cls}
      aria-label="TraceRoost"
      style={{
        fontFamily: "'Avenir Next', 'Century Gothic', 'Segoe UI', ui-rounded, system-ui, sans-serif",
        fontWeight: 600,
        fontSize: `${size}px`,
        letterSpacing: '-0.005em',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        color: 'var(--fg, var(--vscode-foreground))',
        userSelect: 'none',
      }}
    >
      trace<span style={{ color: TEAL }}>roost</span>
    </span>
  )
}
