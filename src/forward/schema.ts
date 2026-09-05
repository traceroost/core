/**
 * The AgentLens Pro wire format (AL 02) — hand-written, and deliberately NOT derived from
 * `SessionSummaryCard`.
 *
 * `SessionSummaryCard` carries `userRequest`, `timeline[].responseText`, `toolInput`,
 * `editDetails[].oldString/newString` — prompts, completions and diffs. A *redacted subset* of a
 * type that has those fields is a promise the sender keeps; the moment a client is modified,
 * misconfigured or compromised, the field still exists and a server that accepts the parent
 * shape will take it. So the forward payload is its own closed type where **every member is a
 * number, an enum, a hash, or an ISO 8601 timestamp**. There is no string field that accepts
 * free text, so there is nothing for code to travel in.
 *
 * This file is the source of truth for the shape. `schema/rollup.v1.json` is the JSON Schema
 * form of the same contract, committed and published; `alsaas` validates every ingest against
 * that document (SA 05). A test (`src/test/forward/schema.test.ts`) walks the JSON Schema and
 * fails if any string property is left unconstrained — the mechanical guard that keeps the
 * invariant true as the schema grows.
 *
 * Nothing in `src/forward/` may import `SessionSummaryCard`. The builder (AL 03) maps into these
 * types field by field, by name, with no spread and no `Omit<>`.
 */

export const SCHEMA_VERSION = '1' as const

// ── Enums (closed sets — a value outside the set maps to the catch-all, never passes through) ──

/** Wire agent identifier. Hyphenated, unlike the internal `SessionSummaryCard.source`. */
export type WireAgent = 'claude-code' | 'copilot' | 'codex' | 'cursor' | 'other'

export type WireAttribution = 'certain' | 'probable' | 'unknown'

export type WireOutcome = 'merged' | 'abandoned' | 'in-progress' | 'reverted' | 'unknown'

export type WireLoopSignal =
  | 'context-flooding'
  | 'repeated-edit'
  | 'retry-loop'
  | 'tool-failure-cascade'
  | 'no-progress'
  | 'oscillation'
  | 'runaway-cost'
  | 'instruction-conflict'
  | 'context-thrash'

export const WIRE_LOOP_SIGNALS: readonly WireLoopSignal[] = [
  'context-flooding', 'repeated-edit', 'retry-loop', 'tool-failure-cascade',
  'no-progress', 'oscillation', 'runaway-cost', 'instruction-conflict', 'context-thrash',
]

/** `SessionSummaryCard.source` → wire enum. Anything unrecognised is `other`. */
export function toWireAgent(source: string): WireAgent {
  switch (source) {
    case 'claude_code': return 'claude-code'
    case 'copilot':     return 'copilot'
    case 'codex':       return 'codex'
    case 'opencode':    return 'other'
    case 'cursor':      return 'cursor'
    default:            return 'other'
  }
}

/** Internal loop-signal type (`src/types.ts` `LoopSignalType`) → wire enum, or `null` to drop. */
export function toWireLoopSignal(type: string): WireLoopSignal | null {
  const MAP: Record<string, WireLoopSignal> = {
    exact_tool_repeat: 'repeated-edit',
    edit_revert_cycle: 'oscillation',
    error_recurrence: 'retry-loop',
    runaway_steps: 'no-progress',
    token_runaway: 'runaway-cost',
    chronic_tool_failures: 'tool-failure-cascade',
    context_flooding_risk: 'context-flooding',
    malformed_tool_call: 'tool-failure-cascade',
    hallucinated_import: 'retry-loop',
    failed_check_submission: 'no-progress',
  }
  return MAP[type] ?? null
}

/** `'warning' | 'critical'` → the schema's integer severity (1–3). */
export function toWireSeverity(severity: 'warning' | 'critical'): 1 | 2 | 3 {
  return severity === 'critical' ? 3 : 2
}

/** git-outcome / session verdict → wire outcome. */
export function toWireOutcome(v: string): WireOutcome {
  switch (v) {
    case 'productive': return 'merged'
    case 'reverted':   return 'reverted'
    case 'abandoned':  return 'abandoned'
    case 'in_progress':
    case 'in-progress': return 'in-progress'
    default:           return 'unknown'
  }
}

/** Tool name → the schema's `^[a-z_]{1,40}$` key form. Unmappable names collapse to `other`. */
export function toWireToolName(tool: string): string {
  const slug = tool.toLowerCase().replace(/[^a-z_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return slug.length > 0 ? slug : 'other'
}

/** Model id → the schema's `^[A-Za-z0-9._:@/-]{1,80}$` form. Strips anything else (notably
 *  spaces), so a free-text model name cannot become a free-text field on the wire. */
export function toWireModel(model: string): string {
  const cleaned = model.replace(/[^A-Za-z0-9._:@/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return cleaned.length > 0 ? cleaned : 'other'
}

// ── Record types (mirror schema/rollup.v1.json exactly) ──────────────────────

/** A `[a-f0-9]{64}` HMAC-SHA256 hex digest. */
export type Sha256 = string
/** RFC 3339 / ISO 8601 timestamp. */
export type Iso8601 = string

export interface WireModelUse {
  model: string
  calls: number
}

export interface WireLoopSignalEntry {
  signal: WireLoopSignal
  severity: 1 | 2 | 3
}

export interface WireOneShot {
  files_edited?: number
  files_first_pass?: number
}

export interface SessionRollup {
  session_id: string          // uuid
  agent: WireAgent
  models?: WireModelUse[]
  repo_hash: Sha256
  branch_hash?: Sha256
  started_at: Iso8601
  duration_ms: number
  turns?: number
  tokens_in?: number
  tokens_out?: number
  cost_usd?: number
  tool_calls?: Record<string, number>
  errors?: number
  file_hashes?: Sha256[]
  one_shot?: WireOneShot
  loop_signals?: WireLoopSignalEntry[]
  outcome?: WireOutcome
}

export interface CommitRecord {
  commit_hash: Sha256
  repo_hash: Sha256
  authored_at: Iso8601
  lines_added: number
  lines_removed: number
  ai_lines?: number
  attribution?: WireAttribution
}

export interface TurnoverSample {
  commit_hash: Sha256
  window_days: 30 | 90
  ai_lines_authored: number
  ai_lines_surviving: number
}

/**
 * The complete request body a linked machine may POST to `/api/ingest`. `install_id` and
 * `member_id` are NOT here — the service derives them from the bearer token, so a client cannot
 * claim to be someone else.
 */
export interface RollupPayload {
  schema_version: typeof SCHEMA_VERSION
  repo_key_fp: Sha256
  session?: SessionRollup
  commits?: CommitRecord[]
  turnover?: TurnoverSample[]
}

// ── Schema-drift guard (shared by the test and any build step) ───────────────
//
// Walks a JSON Schema and returns a list of violations of the two structural rules that keep
// the privacy invariant true: every object sets `additionalProperties:false`, and every string
// is constrained by `pattern`, `enum`, `const` or `format`. Mirrors alsaas's `schemaViolations`
// so the two repos check the identical property.

type JsonSchemaNode = Record<string, unknown>

export function schemaViolations(node: JsonSchemaNode, nodePath = '#'): string[] {
  const out: string[] = []
  const type = node.type

  if (type === 'object' || node.properties || node.patternProperties) {
    if (node.additionalProperties !== false) {
      out.push(`${nodePath}: object without additionalProperties:false`)
    }
    for (const [k, v] of Object.entries((node.properties ?? {}) as Record<string, JsonSchemaNode>)) {
      out.push(...schemaViolations(v, `${nodePath}/properties/${k}`))
    }
    for (const [k, v] of Object.entries((node.patternProperties ?? {}) as Record<string, JsonSchemaNode>)) {
      out.push(...schemaViolations(v, `${nodePath}/patternProperties/${k}`))
    }
  }

  if (type === 'string') {
    const constrained = 'pattern' in node || 'enum' in node || 'const' in node || 'format' in node
    if (!constrained) out.push(`${nodePath}: unconstrained string`)
  }

  if (type === 'array' && node.items) {
    out.push(...schemaViolations(node.items as JsonSchemaNode, `${nodePath}/items`))
  }

  for (const [k, v] of Object.entries((node.$defs ?? {}) as Record<string, JsonSchemaNode>)) {
    out.push(...schemaViolations(v, `#/$defs/${k}`))
  }

  return out
}
