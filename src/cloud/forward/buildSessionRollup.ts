/**
 * Builds a `SessionRollup` (AL 03).
 *
 * This function names every output field explicitly. There is no spread of the input, no
 * `Omit<>`, no `JSON.parse(JSON.stringify(...))`. Spreading the session object and deleting keys
 * is the exact failure mode this whole design exists to prevent — a field added to the source
 * type later would silently start being sent.
 *
 * `src/forward/` must not import `SessionSummaryCard` (that type carries prompts, completions and
 * diffs). The input is the narrow structural interface below; a real `SessionSummaryCard`
 * satisfies it, but the coupling is one-way and the compiler enforces that only these fields are
 * reachable from here.
 *
 * All hashing happens here, in the builder — never at the transport layer. A record never exists
 * in memory in unhashed form beyond this call.
 */

import * as crypto from 'crypto'
import {
  SCHEMA_VERSION,
  toWireAgent,
  toWireLoopSignal,
  toWireModel,
  toWireOutcome,
  toWireSeverity,
  toWireToolName,
  type RollupPayload,
  type SessionRollup,
  type WireLoopSignalEntry,
  type WireModelUse,
} from './schema'
import {
  repoHash,
  branchHash,
  fileHash,
  repoKeyFingerprint,
  type RepoKeyContext,
} from './repoKey'

/** The only fields of a session the builder is allowed to see. Every one is a scalar, an enum,
 *  a number, or an array of paths/enums — nothing that can hold free text. */
export interface SessionRollupInput {
  sessionId: string
  source: string
  models?: string[]
  model: string
  startTime: string
  durationMs: number
  totalLlmCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  errors: number
  toolCounts: Record<string, number>
  filesChanged: string[]
  filesWritten?: string[]
  loopSignals?: Array<{ type: string; severity: 'warning' | 'critical' }>
  oneShotStats?: { filesConsidered: number; oneShotFiles: number; totalEdits: number }
  /** Per-LLM-entry model tags, if the timeline is loaded — used only for per-model call counts. */
  llmModels?: string[]
}

export interface BuildContext {
  repoKey: RepoKeyContext
  branch: string
  /** USD cost — computed by the caller with `calcTokenCostUsd` (kept out of `src/forward/` so
   *  this island imports no pricing tables). */
  costUsd: number
  /** git-outcome verdict for the session, if known (`productive` / `reverted` / …). */
  outcome?: string
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Session ids from some agents are not UUIDs. The schema requires `format: uuid`, so a
 *  non-UUID id is folded to a deterministic v8-style UUID of its sha256 — stable across runs and
 *  machines, and carrying no information the raw id did not (it is already an opaque token). */
export function toUuid(raw: string): string {
  if (UUID_RE.test(raw)) return raw.toLowerCase()
  const b = crypto.createHash('sha256').update(raw).digest()
  b[6] = (b[6] & 0x0f) | 0x80 // version 8 (name-based, custom)
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function perModelCalls(input: SessionRollupInput): WireModelUse[] | undefined {
  // Prefer real per-entry counts when the timeline is loaded.
  if (input.llmModels && input.llmModels.length > 0) {
    const counts = new Map<string, number>()
    for (const m of input.llmModels) {
      const key = toWireModel(m || input.model || 'other')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
      .map(([model, calls]) => ({ model, calls }))
  }
  // Otherwise: attribute every call to the primary model, and list any secondaries at 0.
  const primary = toWireModel(input.model || input.models?.[0] || 'other')
  const out: WireModelUse[] = [{ model: primary, calls: Math.max(0, input.totalLlmCalls) }]
  for (const m of (input.models ?? []).slice(1, 16)) {
    const w = toWireModel(m)
    if (w !== primary && !out.some(e => e.model === w)) out.push({ model: w, calls: 0 })
  }
  return out
}

function wireToolCalls(toolCounts: Record<string, number>): Record<string, number> | undefined {
  const merged = new Map<string, number>()
  for (const [tool, count] of Object.entries(toolCounts ?? {})) {
    if (!Number.isFinite(count) || count <= 0) continue
    const key = toWireToolName(tool)
    merged.set(key, (merged.get(key) ?? 0) + Math.round(count))
  }
  if (merged.size === 0) return undefined
  // Schema caps tool_calls at 32 properties — keep the busiest.
  const top = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 32)
  return Object.fromEntries(top)
}

function wireLoopSignals(signals: SessionRollupInput['loopSignals']): WireLoopSignalEntry[] | undefined {
  if (!signals || signals.length === 0) return undefined
  const out: WireLoopSignalEntry[] = []
  for (const s of signals.slice(0, 32)) {
    const signal = toWireLoopSignal(s.type)
    if (!signal) continue
    out.push({ signal, severity: toWireSeverity(s.severity) })
  }
  return out.length > 0 ? out : undefined
}

function wireFileHashes(input: SessionRollupInput, ctx: RepoKeyContext): string[] | undefined {
  const seen = new Set<string>()
  for (const p of [...(input.filesChanged ?? []), ...(input.filesWritten ?? [])]) {
    const h = fileHash(ctx, p)
    if (h) seen.add(h)
    if (seen.size >= 2000) break
  }
  return seen.size > 0 ? [...seen] : undefined
}

/** Builds the `SessionRollup` record for one session. */
export function buildSessionRollup(input: SessionRollupInput, ctx: BuildContext): SessionRollup {
  const rk = ctx.repoKey
  const rollup: SessionRollup = {
    session_id: toUuid(input.sessionId),
    agent: toWireAgent(input.source),
    repo_hash: repoHash(rk),
    branch_hash: branchHash(rk, ctx.branch),
    started_at: normalizeTimestamp(input.startTime),
    duration_ms: nonNegInt(input.durationMs),
    turns: nonNegInt(input.totalLlmCalls),
    tokens_in: nonNegInt(input.inputTokens),
    tokens_out: nonNegInt(input.outputTokens),
    cost_usd: Math.max(0, round4(ctx.costUsd)),
    errors: nonNegInt(input.errors),
    outcome: ctx.outcome ? toWireOutcome(ctx.outcome) : 'unknown',
  }

  const models = perModelCalls(input)
  if (models && models.length > 0) rollup.models = models

  const toolCalls = wireToolCalls(input.toolCounts)
  if (toolCalls) rollup.tool_calls = toolCalls

  const fileHashes = wireFileHashes(input, rk)
  if (fileHashes) rollup.file_hashes = fileHashes

  if (input.oneShotStats && input.oneShotStats.filesConsidered > 0) {
    rollup.one_shot = {
      files_edited: nonNegInt(input.oneShotStats.filesConsidered),
      files_first_pass: nonNegInt(input.oneShotStats.oneShotFiles),
    }
  }

  const loopSignals = wireLoopSignals(input.loopSignals)
  if (loopSignals) rollup.loop_signals = loopSignals

  return rollup
}

/** Wraps one session rollup as a complete `RollupPayload`. */
export function sessionRollupPayload(input: SessionRollupInput, ctx: BuildContext): RollupPayload {
  return {
    schema_version: SCHEMA_VERSION,
    repo_key_fp: repoKeyFingerprint(ctx.repoKey),
    session: buildSessionRollup(input, ctx),
  }
}

function nonNegInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}
function round4(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0
}
function normalizeTimestamp(t: string): string {
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString()
}
