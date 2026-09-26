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
// choice rather than the full wire payload. "instruction-conflict" still has no local signal that
// maps to it (cloud-only, computed across sessions) so it never appears here. "context-thrash" did
// not either until 2026-09-26's signal-catalog stages 02-03 (file_reread/cache_miss/ttl_expiry/
// low_cache_hit_ratio) — the first local signals to actually fill that wire slot; see
// IconRefreshCcw below. budget_overrun/model_tier_mismatch (added the same pass) are local-only
// and never reach toWireLoopSignal at all, but still need an entry here since this map is
// exhaustive over LoopSignalType.
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
  // Added 2026-09-26 (signal-catalog stages 01-04). tool_call_cycle shares oscillation's bucket —
  // both are "the agent is going back and forth" at different granularities (one file vs. a
  // multi-step sequence). file_reread/cache_miss/ttl_expiry/low_cache_hit_ratio all land in
  // context-thrash, the wire enum value schema.ts defined ahead of any producer — this is the
  // first local signal set to actually fill it, so it needed a real icon (below) for the first
  // time. budget_overrun/model_tier_mismatch are local-only (never sent to cloud, see
  // toWireLoopSignal) but still need an icon bucket here since this map is exhaustive over
  // LoopSignalType; both reuse runaway-cost since they're cost signals, not loop patterns.
  tool_call_cycle: 'oscillation',
  file_reread: 'context-thrash',
  cache_miss: 'context-thrash',
  ttl_expiry: 'context-thrash',
  low_cache_hit_ratio: 'context-thrash',
  budget_overrun: 'runaway-cost',
  model_tier_mismatch: 'runaway-cost',
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

// Added 2026-09-26 for the context-thrash bucket (file_reread/cache_miss/ttl_expiry/
// low_cache_hit_ratio) — distinct from IconRotateCw's single arrow (retry-loop) with a double
// counter-rotating arrow (refresh-ccw), reading as "re-fetching the same thing" rather than
// "retrying an attempt."
function IconRefreshCcw({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
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
  'context-thrash': IconRefreshCcw,
}
