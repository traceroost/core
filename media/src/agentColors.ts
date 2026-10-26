/**
 * One colour per agent, everywhere: filter pills, row dots, legends, the Analytics charts, the
 * Flow graph, the Efficiency Map and the sidebar. Each agent maps to one of VS Code's own chart
 * colours (--vscode-charts-*), so it follows the active theme — light, dark or high contrast —
 * instead of fixed neon hex values that vanished on a white page (OpenCode's white, Codex's
 * #F0FF42).
 *
 * base.css defines --agent-<key> from these chart variables for DOM styles; the standalone and
 * desktop dashboards, which have no VS Code host, define the chart variables in their own theme
 * shim (standalone/dashboardHtml.ts). Canvas can't use var(), so canvas code resolves a concrete
 * colour at draw time with resolveAgentColor().
 *
 * Imports nothing, so the sidebar bundle (sidebarWebview.ts) can use it too.
 */

type AgentKey = 'claude_code' | 'copilot' | 'codex' | 'opencode' | 'cursor'

interface AgentColorDef {
  /** The --agent-* custom property base.css defines. */
  token: string
  /** The VS Code chart colour it follows. */
  chart: string
  /** Last resort when neither variable is defined (VS Code's dark-theme default for `chart`). */
  fallback: string
}

const AGENT_COLORS: Record<AgentKey, AgentColorDef> = {
  claude_code: { token: '--agent-claude',   chart: '--vscode-charts-orange',     fallback: '#d18616' },
  copilot:     { token: '--agent-copilot',  chart: '--vscode-charts-blue',       fallback: '#3794ff' },
  codex:       { token: '--agent-codex',    chart: '--vscode-charts-purple',     fallback: '#b180d7' },
  opencode:    { token: '--agent-opencode', chart: '--vscode-charts-foreground', fallback: '#cccccc' },
  cursor:      { token: '--agent-cursor',   chart: '--vscode-charts-yellow',     fallback: '#cca700' },
}

/** Traces from an agent TraceRoost doesn't know (shouldn't happen — `source` is a closed set). */
const UNKNOWN: AgentColorDef = { token: '--agent-unknown', chart: '--vscode-descriptionForeground', fallback: '#90a4ae' }

function def(source: string | null | undefined): AgentColorDef {
  return (source && AGENT_COLORS[source as AgentKey]) || UNKNOWN
}

/** A CSS colour for DOM styles (`background:${agentColorVar(s)}`) — tracks theme changes live. */
export function agentColorVar(source: string | null | undefined): string {
  const d = def(source)
  return `var(${d.token}, var(${d.chart}, ${d.fallback}))`
}

/** null outside a browser (the unit tests' Node DOM shim), where every colour is its fallback. */
function computedBody(): CSSStyleDeclaration | null {
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined' || !document.body) return null
  return getComputedStyle(document.body)
}

let probe: CanvasRenderingContext2D | null | undefined
const hexCache = new Map<string, string>()

/** Any CSS colour string as #rrggbb (alpha dropped), so callers can append a two-digit alpha
 *  (`color + '28'`) as the canvas code does. Unparseable input comes back as it was. */
function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase()
  const cached = hexCache.get(color)
  if (cached) return cached
  if (probe === undefined) probe = typeof document !== 'undefined' && document.createElement ? document.createElement('canvas').getContext('2d') : null
  let out = color
  if (probe) {
    probe.fillStyle = '#000000'
    probe.fillStyle = color
    const parsed = String(probe.fillStyle)
    if (/^#[0-9a-f]{6}$/i.test(parsed)) {
      out = parsed.toLowerCase()
    } else {
      const m = parsed.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
      if (m) out = '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')
    }
  }
  hexCache.set(color, out)
  return out
}

/** The agent's colour as a concrete #rrggbb for the current theme — for canvas, and anywhere a
 *  colour gets string-concatenated. Read at call time, so a redraw after a theme change picks up
 *  the new value. */
export function resolveAgentColor(source: string | null | undefined): string {
  const d = def(source)
  const cs = computedBody()
  const value = (cs && (cs.getPropertyValue(d.token).trim() || cs.getPropertyValue(d.chart).trim())) || d.fallback
  return toHex(value)
}

/** A `--vscode-charts-*` (or any) CSS variable's current value as #rrggbb, for canvas charts that
 *  draw non-agent series (input vs output tokens, daily totals). */
export function resolveCssColor(variable: string, fallback: string): string {
  const value = computedBody()?.getPropertyValue(variable).trim()
  return toHex(value || fallback)
}
