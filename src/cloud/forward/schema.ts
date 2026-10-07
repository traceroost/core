/**
 * The TraceRoost Cloud wire format (AL 02) — hand-written, and deliberately NOT derived from
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
 * form of the same contract, committed and published; `cloud` validates every ingest against
 * that document (SA 05). A test (`src/test/cloud/forward/schema.test.ts`) walks the JSON Schema and
 * fails if any string property is left unconstrained — the mechanical guard that keeps the
 * invariant true as the schema grows.
 *
 * Nothing in `src/forward/` may import `SessionSummaryCard`. The builder (AL 03) maps into these
 * types field by field, by name, with no spread and no `Omit<>`.
 */

export const SCHEMA_VERSION = '1' as const

// ── Enums (closed sets — a value outside the set maps to the catch-all, never passes through) ──

/** Wire agent identifier. Hyphenated, unlike the internal `SessionSummaryCard.source`. */
export type WireAgent = 'claude-code' | 'copilot' | 'codex' | 'cursor' | 'opencode' | 'other'

export type WireAttribution = 'certain' | 'probable' | 'unknown'

// 'reverted' stays a valid value on the wire (historical rows may carry it, and cloud's schema
// still lists it) even though the local classifier (gitOutcome.ts) no longer produces it — see
// that file's FileOutcome for why. 'committed' is new: locally committed but not (yet, or
// verifiably) merged into the repo's trunk branch — distinct from 'merged', which core only
// reports once a file's content also matches the trunk tip.
export type WireOutcome = 'merged' | 'committed' | 'abandoned' | 'in-progress' | 'reverted' | 'unknown'

/** Whether the session was built from a finished, on-disk transcript file, or from live OTEL
 *  telemetry with no transcript file (yet). Mirrors `SessionSummaryCard.dataSource`. */
export type WireDataSource = 'otel' | 'log'

/** Who or what started the session. Mirrors `SessionSummaryCard.initiator`. */
export type WireInitiator = 'user' | 'agent' | 'api'

/** The session's primary programming language — src/language.ts's LANGUAGE_IDS, verbatim (no
 *  hyphenation; the ids are already wire-safe). A fixed-choice label like `agent`, never free
 *  text: derived from file extensions on the machine, only the id leaves it. */
export type WireLanguage =
  | 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'csharp' | 'cpp'
  | 'ruby' | 'php' | 'swift' | 'kotlin' | 'dart' | 'shell' | 'sql' | 'html' | 'css' | 'other'
  | 'docs' | 'config' | 'data' | 'assets' | 'none' | 'no_files'

export const WIRE_LANGUAGES: readonly WireLanguage[] = [
  'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp', 'cpp',
  'ruby', 'php', 'swift', 'kotlin', 'dart', 'shell', 'sql', 'html', 'css', 'other',
  'docs', 'config', 'data', 'assets', 'none', 'no_files',
]

/** Maps a local language id to the wire enum; anything unrecognised becomes undefined (the field
 *  is then omitted), never passed through. */
export function toWireLanguage(lang: string | null | undefined): WireLanguage | undefined {
  return (WIRE_LANGUAGES as readonly string[]).includes(lang ?? '') ? lang as WireLanguage : undefined
}

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
    case 'opencode':    return 'opencode'
    case 'cursor':      return 'cursor'
    default:            return 'other'
  }
}

/** Internal loop-signal type (`src/types.ts` `LoopSignalType`) → wire enum, or `null` to drop.
 *
 * `budget_overrun` and `model_tier_mismatch` (added 2026-09-26, signal-catalog stage 04) are
 * deliberately absent from this map and fall through to `null` — both are local-only
 * cost-optimization tips, not loop/malfunction patterns — the signal-catalog stage 04 decision was
 * to keep them off the wire rather than force them into an existing bucket (the cloud's taxonomy
 * is loop/malfunction only; see runbooks/SIGNAL_CALIBRATION.md for the catalog). */
export function toWireLoopSignal(type: string): WireLoopSignal | null {
  const MAP: Record<string, WireLoopSignal> = {
    exact_tool_repeat: 'repeated-edit',
    edit_revert_cycle: 'oscillation',
    error_recurrence: 'retry-loop',
    runaway_steps: 'no-progress',
    token_runaway: 'runaway-cost',
    chronic_tool_failures: 'tool-failure-cascade',
    context_flooding_risk: 'context-flooding',
    hallucinated_import: 'retry-loop',
    failed_check_submission: 'no-progress',
    // Signal-catalog stages 01-03 (2026-09-26). tool_call_cycle is the same "going back and
    // forth" pattern as edit_revert_cycle at a different granularity, so it shares oscillation.
    // file_reread/cache_miss/ttl_expiry/low_cache_hit_ratio are the first local producers for
    // context-thrash, defined in this enum ahead of any detector — see WIRE_LOOP_SIGNALS above.
    tool_call_cycle: 'oscillation',
    file_reread: 'context-thrash',
    cache_miss: 'context-thrash',
    ttl_expiry: 'context-thrash',
    low_cache_hit_ratio: 'context-thrash',
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
    case 'merged':     return 'merged'
    case 'committed':  return 'committed'
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
/** A lower-case RFC 4122 UUID — `session.session_id` and the trace-manifest keys. */
export type Uuid = string

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
  /** Absent when the workspace's repository can't be keyed (not a git repo, a shallow clone, or
   *  no discoverable root commit) — the session is still sent, just without repo grouping, rather
   *  than dropped or keyed with a fake hash. See `repoKey.ts`. */
  repo_hash?: Sha256
  branch_hash?: Sha256
  started_at: Iso8601
  duration_ms: number
  turns?: number
  tokens_in?: number
  tokens_out?: number
  tokens_cache_read?: number
  tokens_cache_create?: number
  tool_calls?: Record<string, number>
  errors?: number
  file_hashes?: Sha256[]
  one_shot?: WireOneShot
  loop_signals?: WireLoopSignalEntry[]
  outcome?: WireOutcome
  data_source?: WireDataSource
  initiator?: WireInitiator
  /** sha256 of the local conversationId — the conversation (transcript) this trace, one turn of
   *  it, belongs to; absent when the source names none. Lets the server color-code/group rows
   *  that are really one conversation, the same way this client already does locally. Plain sha256, not the
   *  repo_key-derived HMAC repo_hash/branch_hash/commit_hash use — a conversationId is already an
   *  opaque, high-entropy token (a uuid or an OTEL trace id), not a guessable path, so it needs no
   *  org-scoped salt to stay uncorrelatable. */
  conversation_hash?: Sha256
  /** Primary language (most common code language among the distinct files the session read or
   *  changed; with no code, the kind of file — docs, config, data, assets — or none/no_files) —
   *  see src/language.ts. Absent for a session built before language tracking. */
  language?: WireLanguage
  /** Runner-up in the primary's tier (code or non-code) — never 'none' or 'no_files'. Omitted (the
   *  schema also accepts null) when only one was touched. */
  language_secondary?: Exclude<WireLanguage, 'none' | 'no_files'> | null
  /** Change size from the agent's own edit/write tool calls (src/editStats.ts) — counts only,
   *  never paths or content, and not git stats. files_changed is the distinct file count; the
   *  line counts are omitted when the source records no edit contents. */
  files_changed?: number
  lines_added?: number
  lines_removed?: number
  /** Durable, monotonically increasing local revision number for this session's canonical trace
   *  snapshot (live trace reconciliation) -- see database/traceRevisionRepository.ts. Absent on a send
   *  built without a known revision (no reconciliation service available, or the session's
   *  outcome has never been classified) -- the server treats an absent revision as the lowest
   *  possible one for replace-ordering, never as newer than an already-acknowledged one. */
  revision?: number
  /** How much evidence this snapshot carries (src/traceIdentity.ts): 3 OTEL
   *  with usage, 2 full transcript, 1 partial. A turn's log and OTEL snapshots share one
   *  `session_id`; a lower rank must never replace a higher one, and within a rank the newer
   *  `revision` wins. Opaque small integer — no new information about the session. Always sent;
   *  core also never sends a lower-rank snapshot over a higher one itself
   *  (contentChangeForward.ts) — the field lets the cloud enforce the same rule across installs. */
  source_rank: 1 | 2 | 3
  /** Which TraceRoost host sent this snapshot (`src/cloud/org/hostIdentity.ts`): the editor
   *  extension and the standalone server share one install (one credential) but each keeps its
   *  own trace store, so each has its own id — a random UUID generated once per host store, never
   *  derived from a hostname, path or anything else identifying. A trace manifest retires only
   *  rows whose last sender was its own host. Always sent. */
  host_id: Uuid
}

/** One chunk of the trace manifest (stable trace identity), POSTed to `/api/ingest/manifest`:
 *  every trace key this host holds whose trace started in [window.from, window.to). The keys
 *  are the same opaque UUIDs that already travel as `session.session_id`; the window bounds are
 *  the only timestamps. `$defs/trace_manifest` in schema/rollup.v1.json. */
export interface TraceManifestChunk {
  schema_version: typeof SCHEMA_VERSION
  /** The sending host — the same id its rollups carry as `session.host_id`. The cloud retires
   *  only rows this install last received from this host. */
  host_id: Uuid
  window: { from: Iso8601; to: Iso8601 }
  keys: Uuid[]
  /** Only with an empty `keys`, and only when the local store positively holds no trace for the
   *  window and the window is inside its local horizon — without it, an empty chunk retires
   *  nothing. */
  confirm_empty?: true
}

export interface CommitRecord {
  commit_hash: Sha256
  repo_hash: Sha256
  authored_at: Iso8601
  lines_added: number
  lines_removed: number
  ai_lines?: number
  attribution?: WireAttribution
  /** HMAC(repo_key, "author:" + git author email) — lets the server match this commit to
   *  whichever member's own `member_author_hash` (on the payload this commit rides in, or any
   *  other payload for the same repo) agrees, regardless of which install reported it. Absent for
   *  a caller that hasn't computed it yet; falls back to reporting-install attribution. See
   *  docs/decisions/0005 in `cloud`. */
  author_hash?: Sha256
}

export interface TurnoverSample {
  commit_hash: Sha256
  window_days: 30 | 90
  ai_lines_authored: number
  ai_lines_surviving: number
}

// ── AL 08 additions — instruction telemetry ─────────────────────────────────
// Same rules: booleans, counts, enums, hashes and timestamps only. No new field shape.

export type InstructionFileKind = 'claude_md' | 'agents_md' | 'copilot_instructions' | 'other'

export interface InstructionFileState {
  repo_hash: Sha256
  present: boolean
  kind: InstructionFileKind
  path_hash?: Sha256
  /** Answers "did this change" and nothing more. */
  content_hash?: Sha256
  line_count?: number
  last_modified?: Iso8601
}

export interface FileFootprint {
  repo_hash: Sha256
  file_hash: Sha256
  sessions_read: number
  sessions_total: number
  /** Read within the first three turns. */
  early_reads?: number
  /** The file's own token size, for the rediscovery-cost arithmetic. */
  token_size?: number
  /** The substring check `getHotFileSuggestions` already performs — computed locally, the
   *  service receives the answer, never the inputs. */
  covered_by_instructions?: boolean
}

export type SuggestionCategory = 'context' | 'behavior' | 'prompting'
export type SuggestionPriority = 'high' | 'medium' | 'low'
export type SuggestionAction = 'surfaced' | 'applied' | 'dismissed' | 'reverted'

export interface SuggestionBaseline {
  cost_avg?: number
  turns_avg?: number
  error_rate?: number
  loop_rate?: number
  insufficient?: boolean
}

export interface SuggestionEvent {
  repo_hash: Sha256
  /** Hash of the existing `SuggestionCard.id` — the prose title/evidence/text never leave. */
  suggestion_id: Sha256
  category: SuggestionCategory
  priority: SuggestionPriority
  target_agents?: WireAgent[]
  action: SuggestionAction
  at: Iso8601
  baseline?: SuggestionBaseline
}

export function toWireTargetAgent(agent: string): WireAgent {
  return toWireAgent(agent === 'claude_code' || agent === 'copilot' || agent === 'codex' || agent === 'opencode' ? agent : agent.replace(/-/g, '_'))
}

/**
 * The complete request body a linked machine may POST to `/api/ingest`. `install_id` and
 * `member_id` are NOT here — the service derives them from the bearer token, so a client cannot
 * claim to be someone else.
 */
export interface RollupPayload {
  schema_version: typeof SCHEMA_VERSION
  /** Absent under the same conditions as `SessionRollup.repo_hash` — an unkeyable repo means
   *  there's no fingerprint to send either, not that nothing is sent. */
  repo_key_fp?: Sha256
  /** HMAC(repo_key, "author:" + this machine's git config user.email) for the repo this payload
   *  is about — lets the server match this member's own commits by author fingerprint instead of
   *  by whichever install reported them. See AL 04 / cloud's
   *  docs/decisions/0005-commit-author-fingerprint-matching.md. Absent under the same conditions
   *  as repo_key_fp, plus whenever the local git email couldn't be resolved. */
  member_author_hash?: Sha256
  session?: SessionRollup
  commits?: CommitRecord[]
  turnover?: TurnoverSample[]
  instruction_files?: InstructionFileState[]
  file_footprints?: FileFootprint[]
  suggestion_events?: SuggestionEvent[]
}

// ── Schema-drift guard (shared by the test and any build step) ───────────────
//
// Walks a JSON Schema and returns a list of violations of the two structural rules that keep
// the privacy invariant true: every object sets `additionalProperties:false`, and every string
// is constrained by `pattern`, `enum`, `const` or `format`. Mirrors cloud's `schemaViolations`
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
