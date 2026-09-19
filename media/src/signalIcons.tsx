import type { JSX } from 'preact/jsx-runtime'
import type { LoopSignalType } from './types'

// Shared between Sessions.tsx's Signals column/expanded-row Insights and Insights.tsx's
// standalone Recommendations tab, so every place a loop signal shows up (however it got there)
// draws the exact same glyph for the exact same pattern. Split out of Sessions.tsx rather than
// exported from it because Insights.tsx already gets imported back into Sessions.tsx
// (generateInsights/InsightCard) — importing this the other way round would be circular.

// schema/rollup.v1.json's loop_signal enum (traceroost/cloud) — same 9 canonical names cloud's own
// Signals column (traces-table.tsx) groups by, though the two don't share exact pictograms (see
// SIGNAL_ICON below). This webview bundle can't import src/cloud/forward/schema.ts (a separate
// bundle) — the map below mirrors that file's toWireLoopSignal MAP, just collapsed onto icon
// choice rather than the full wire payload. "instruction-conflict" has no local signal that maps
// to it (cloud-only, computed across sessions) so it never appears here.
export const LOOP_SIGNAL_ICON_TYPE: Record<LoopSignalType, string> = {
  exact_tool_repeat: 'repeated-edit',
  edit_revert_cycle: 'oscillation',
  error_recurrence: 'retry-loop',
  runaway_steps: 'no-progress',
  token_runaway: 'runaway-cost',
  chronic_tool_failures: 'tool-failure-cascade',
  context_flooding_risk: 'context-flooding',
  hallucinated_import: 'retry-loop',
  failed_check_submission: 'no-progress',
}

// No SIGNAL_LABEL map here on purpose — a label derived from LOOP_SIGNAL_ICON_TYPE's collapsed
// bucket names used to cause misleading tooltips (e.g. every exact_tool_repeat read "Repeated
// edit" even when no edit was involved, and hallucinated_import/error_recurrence shared "Retry
// loop"). Callers should read the accurate per-signal `patternName` off the LoopSignal itself
// instead (see Sessions.tsx's SignalsCell and Insights.tsx's InsightCard).

export const SIGNAL_SEVERITY_COLOR: Record<'warning' | 'critical', string> = {
  warning: '#f6a623',
  critical: 'var(--error)',
}

// Same stroke-icon convention as Settings.tsx's IconMonitor/IconMoon/IconSun (24x24 viewBox,
// stroke-width 2) rather than a second icon convention or emoji — recolored per signal severity
// instead of currentColor, since that's the whole point here. Path data adapted from Lucide
// (lucide.dev, ISC license): waves / repeat-2 / rotate-cw / bomb / brick-wall / arrow-right-left /
// trending-up, one per signal so each reads literally (a wall for stuck, a climbing line for
// runaway cost — a bare $ just says "money", not "spiraling") without needing the hover tooltip
// just to identify the shape.
function IconWaves({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M2 12q2.5 2 5 0t5 0 5 0 5 0" />
      <path d="M2 19q2.5 2 5 0t5 0 5 0 5 0" />
      <path d="M2 5q2.5 2 5 0t5 0 5 0 5 0" />
    </svg>
  )
}

function IconRepeat({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="m2 9 3-3 3 3" />
      <path d="M13 18H7a2 2 0 0 1-2-2V6" />
      <path d="m22 15-3 3-3-3" />
      <path d="M11 6h6a2 2 0 0 1 2 2v10" />
    </svg>
  )
}

function IconRotateCw({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

function IconBomb({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <circle cx="11" cy="13" r="9" />
      <path d="M14.35 4.65 16.3 2.7a2.41 2.41 0 0 1 3.4 0l1.6 1.6a2.4 2.4 0 0 1 0 3.4l-1.95 1.95" />
      <path d="m22 2-1.5 1.5" />
    </svg>
  )
}

function IconBrickWall({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M12 9v6" />
      <path d="M16 15v6" />
      <path d="M16 3v6" />
      <path d="M3 15h18" />
      <path d="M3 9h18" />
      <path d="M8 15v6" />
      <path d="M8 3v6" />
    </svg>
  )
}

function IconArrowRightLeft({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="m16 3 4 4-4 4" />
      <path d="M20 7H4" />
      <path d="m8 21-4-4 4-4" />
      <path d="M4 17h16" />
    </svg>
  )
}

function IconTrendingUp({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M16 7h6v6" />
      <path d="m22 7-8.5 8.5-5-5L2 17" />
    </svg>
  )
}

export const SIGNAL_ICON: Record<string, (props: { color: string }) => JSX.Element> = {
  'context-flooding': IconWaves,
  'repeated-edit': IconRepeat,
  'retry-loop': IconRotateCw,
  'tool-failure-cascade': IconBomb,
  'no-progress': IconBrickWall,
  oscillation: IconArrowRightLeft,
  'runaway-cost': IconTrendingUp,
}
