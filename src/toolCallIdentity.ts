/**
 * What makes two tool calls "the same call".
 *
 * The repeat detectors (loopDetector.ts's exact_tool_repeat and tool_call_cycle, and the live
 * Loop Breaker alert in automationEngine.ts) used to key a call on its timeline `label` alone.
 * That label encodes the arguments on some sources (OpenCode: `Read: foo.ts`) but is the bare
 * tool name on others — every Claude Code OTel tool span is labelled `Bash`, `Read`, `Edit` —
 * so 74 different shell commands counted as one call repeated 74 times. A call's identity is
 * its tool *and its arguments*; this module is the one place that says so.
 *
 * Identity, in order of what the entry captured:
 *   1. `toolInput` present → label + the normalized arguments (JSON with keys sorted and
 *      annotation-only keys dropped, so a reworded `description` on the same command is still the
 *      same call; a non-JSON input is compared whitespace-collapsed).
 *   2. no `toolInput`, but the label itself carries arguments (`read_file README`,
 *      `Read: foo.ts`) → the label.
 *   3. no `toolInput`, a bare tool-name label, but the result was captured → the label; the
 *      detectors already break a streak when the result changes, so identical results on an
 *      unknown command are the only evidence left and are still worth something.
 *   4. nothing but a bare tool name → `null`: unknown call. A detector must not count it as a
 *      repeat of anything; "Bash ran 74 times" is not "the same Bash command ran 74 times".
 */
import type { TimelineEntry } from './summarizers/summarizerTypes'

/** Argument keys that annotate a call rather than define it. */
const ANNOTATION_KEYS = new Set(['description'])

/** The argument that best says what a call did, in preference order, for display. */
const DISPLAY_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'path', 'target_file', 'notebook_path', 'pattern', 'query', 'url', 'prompt']

function stableJson(value: unknown, dropAnnotations: boolean): string {
  if (Array.isArray(value)) return '[' + value.map(v => stableJson(v, false)).join(',') + ']'
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return '{' + Object.keys(obj).sort()
      .filter(k => !(dropAnnotations && ANNOTATION_KEYS.has(k)))
      .map(k => JSON.stringify(k) + ':' + stableJson(obj[k], false)).join(',') + '}'
  }
  return JSON.stringify(value)
}

/** The call's arguments in a comparable form: sorted-key JSON without annotation keys, or the raw
 *  input whitespace-collapsed when it isn't JSON. '' when nothing was captured. */
export function normalizeToolInput(input: string | undefined): string {
  const raw = (input ?? '').trim()
  if (!raw) return ''
  try {
    return stableJson(JSON.parse(raw), true)
  } catch {
    return raw.replace(/\s+/g, ' ')
  }
}

/** True when a label says more than which tool ran (`read_file README`, `Read: foo.ts`). */
function labelCarriesArguments(label: string): boolean {
  return /[\s:]/.test(label)
}

/** Identity key for the repeat detectors — see the module comment for the four cases. Two entries
 *  share a key only when they can be said to have made the same call. `null` means the entry
 *  captured too little to say what call it was. */
export function toolCallKey(entry: TimelineEntry): string | null {
  const label = (entry.label || '').trim()
  if (!label) return null
  const input = normalizeToolInput(entry.toolInput)
  if (input) return `${label}\u0000${input}`
  if (labelCarriesArguments(label) || entry.fullResult !== undefined) return label
  return null
}

/** The most telling captured argument of a call, whitespace-collapsed, or '' when none. */
export function toolCallArgument(entry: TimelineEntry): string {
  const raw = (entry.toolInput ?? '').trim()
  if (!raw) return ''
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return raw.replace(/\s+/g, ' ') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
  const obj = parsed as Record<string, unknown>
  for (const key of DISPLAY_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ')
  }
  const firstString = Object.keys(obj).sort().map(k => obj[k]).find(v => typeof v === 'string' && v.trim())
  return typeof firstString === 'string' ? firstString.trim().replace(/\s+/g, ' ') : ''
}

/** A call as a person reads it in a signal's `examples`: the label, plus the argument that
 *  identifies the call when the label alone doesn't carry it (`Bash: git status`). */
export function describeToolCall(entry: TimelineEntry): string {
  const label = (entry.label || '').trim() || 'tool'
  const arg = toolCallArgument(entry)
  if (!arg || labelCarriesArguments(label)) return label
  return `${label}: ${arg}`
}
