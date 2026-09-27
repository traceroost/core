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
  authorHash,
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
  dataSource: 'otel' | 'log'
  initiator?: 'user' | 'agent' | 'api'
  /** Set only when this session is one segment of a log file split by a long idle gap — see
   *  `SessionSummaryCard.conversationId` (logReader.ts). Absent for an ordinary one-file-one-
   *  session card, same as core's own color-coding (getConversationColor) leaves it uncolored. */
  conversationId?: string
}

export interface BuildContext {
  /** Absent when the workspace's repository can't be keyed (not a git repo, a shallow clone, or
   *  no discoverable root commit) — the rollup is still built, just without repo grouping. */
  repoKey?: RepoKeyContext
  /** Meaningless without `repoKey`; ignored when it's absent. */
  branch?: string
  /** This machine's `git config user.email` for the workspace, if resolvable — the same value
   *  used elsewhere to scope AL 05's local attribution to "commits I authored"
   *  (`attribution/index.ts`'s `localGitEmail()`). Meaningless without `repoKey`; ignored when
   *  either is absent. Hashed into `member_author_hash` so the server can match this member's own
   *  commits by author fingerprint instead of by "whichever install reported it" — see AL 04 /
   *  cloud's docs/decisions/0005-commit-author-fingerprint-matching.md. */
  authorEmail?: string
  /** git-outcome verdict for the session, if known (`productive` / `reverted` / …). */
  outcome?: string
  /** This session's current durable revision number, if known (staged feature 10) -- see
   *  `SessionRollup.revision`'s doc comment. */
  revision?: number
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

/** Plain sha256 — deliberately not the repo_key-derived HMAC repoHash/branchHash/fileHash use.
 *  A conversationId is already an opaque, high-entropy token (a uuid, or an OTEL trace id), not a
 *  guessable path, so there is nothing for an org-scoped salt to protect against here. */
function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
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
  const out: WireModelUse[] = [{ model: primary, calls: nonNegInt(input.totalLlmCalls) }]
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
    started_at: normalizeTimestamp(input.startTime),
    duration_ms: nonNegInt(input.durationMs),
    turns: nonNegInt(input.totalLlmCalls),
    tokens_in: nonNegInt(input.inputTokens),
    tokens_out: nonNegInt(input.outputTokens),
    tokens_cache_read: nonNegInt(input.cacheReadTokens),
    tokens_cache_create: nonNegInt(input.cacheCreateTokens ?? 0),
    // cost_usd is deliberately not sent — cloud computes it itself, server-side, from an org's own
    // editable pricing table (0022_pricing_rates.sql in traceroost/cloud) rather than trusting a
    // number from the client. See src/pricing.ts's setCloudRateOverrides for the other half of
    // this: a linked install can now *read* that same table back to price its own local display.
    errors: nonNegInt(input.errors),
    outcome: ctx.outcome ? toWireOutcome(ctx.outcome) : 'unknown',
    data_source: input.dataSource,
  }
  if (input.initiator) rollup.initiator = input.initiator
  if (input.conversationId) rollup.conversation_hash = sha256Hex(input.conversationId)
  if (ctx.revision && ctx.revision > 0) rollup.revision = Math.round(ctx.revision)

  if (rk) {
    rollup.repo_hash = repoHash(rk)
    if (ctx.branch) rollup.branch_hash = branchHash(rk, ctx.branch)
  }

  const models = perModelCalls(input)
  if (models && models.length > 0) rollup.models = models

  const toolCalls = wireToolCalls(input.toolCounts)
  if (toolCalls) rollup.tool_calls = toolCalls

  const fileHashes = rk ? wireFileHashes(input, rk) : undefined
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
    ...(ctx.repoKey ? { repo_key_fp: repoKeyFingerprint(ctx.repoKey) } : {}),
    ...(ctx.repoKey && ctx.authorEmail ? { member_author_hash: authorHash(ctx.repoKey, ctx.authorEmail) } : {}),
    session: buildSessionRollup(input, ctx),
  }
}

// Mirrors #/$defs/count's `maximum` in schema/rollup.v1.json. A session that legitimately
// exceeds this (or has a bad count from an upstream bug) must still be sent — clamping loses a
// little precision on one field; letting assertValidRollupPayload reject the whole payload loses
// the entire session, forever, with no retry path (see enqueueSession.ts's catch).
const MAX_COUNT = 100_000_000
function nonNegInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_COUNT, Math.round(n)) : 0
}
function normalizeTimestamp(t: string): string {
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString()
}
