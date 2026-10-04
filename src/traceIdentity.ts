/**
 * Stable trace identity (staged feature 11): one agent turn = one trace = one key, everywhere —
 * the local `sessionId`, the wire `session_id`, the delivery ledger, deep links and every
 * per-session cache all use the same canonical key, so a trace whose evidence settles (a log card
 * first, its OTEL card later; a transcript re-scanned) is updated in place instead of re-keyed.
 *
 *   traceKey = toUuid(`${agent}:turn:${turnId}`)
 *
 * `turnId` is the agent's own turn id (Claude transcript `promptId`, Codex `turn_id`, Copilot Chat
 * `requestId`), scoped by agent only — never by file or conversation — so a resumed or forked copy
 * of a transcript upserts onto the original row. Sources without a turn id get a *derived* key
 * from the conversation id plus the opening record's own id (or its exact timestamp), and are
 * marked `derived`. Prompt text, prompt length and file paths never enter a key.
 *
 * Local-only module (the core edition bundles it): src/cloud/forward imports `toUuid` from here,
 * never the other way round.
 */

import * as crypto from 'crypto'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Session ids from some agents are not UUIDs. The wire schema requires `format: uuid`, so a
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

/** Whether `id` names this trace: its local key, its wire `session_id` (the cloud dashboard's
 *  hand-off shows that form — a non-UUID local key reaches the cloud folded through `toUuid`),
 *  or its OTEL trace id. */
export function matchesTraceId(trace: { sessionId: string; traceId?: string | null }, id: string): boolean {
  const want = id.trim()
  if (!want) return false
  return (
    trace.sessionId === want ||
    trace.traceId === want ||
    (UUID_RE.test(want) && toUuid(trace.sessionId) === want.toLowerCase())
  )
}

/** The agent part of a key. Short and fixed — `SessionSummaryCard.source` values map onto it. */
export type KeyAgent = 'claude' | 'codex' | 'copilot' | 'opencode' | 'cursor'

export function keyAgentOf(source: string): KeyAgent {
  switch (source) {
    case 'claude_code': return 'claude'
    case 'codex': return 'codex'
    case 'opencode': return 'opencode'
    case 'cursor': return 'cursor'
    default: return 'copilot'
  }
}

/** The canonical key of an agent-issued turn id. Exact. */
export function traceKey(agent: KeyAgent, turnId: string): string {
  return toUuid(`${agent}:turn:${turnId}`)
}

/** A key for a source with no turn id of its own: the conversation id plus the opening record's
 *  own id, or its exact timestamp when the format has no record ids. Marked `derived` on the card
 *  — it is stable for an unchanged file, but not verified against any other source, so it is never
 *  merged with one. */
export function derivedTraceKey(agent: KeyAgent, conversationId: string, opening: string): string {
  return toUuid(`${agent}:derived:${conversationId}:${opening}`)
}

/** The key of a Claude OTEL interaction that could not be joined to its transcript turn (see
 *  claudeTurnJoin.ts): Claude Code's `session.id` plus the interaction's start in epoch ms. */
export function claudeInteractionKey(claudeSessionId: string, startMs: number): string {
  return toUuid(`claude:interaction:${claudeSessionId}:${Math.round(startMs)}`)
}

// ── Source precedence ─────────────────────────────────────────────────────────

/**
 * How much evidence a card for a key carries. A lower rank never replaces a higher one; within a
 * rank the newer card (revision) wins. Travels next to `revision` on the wire as `source_rank`.
 *   3 — OTEL with usage (per-call tokens/timing)
 *   2 — full transcript (the turn's usage is on disk)
 *   1 — partial: a transcript turn with no usage recorded (still running, interrupted before a
 *       reply, or a format that stores none), or OTEL with no usage yet
 */
export const SOURCE_RANK_OTEL = 3
export const SOURCE_RANK_FULL_TRANSCRIPT = 2
export const SOURCE_RANK_PARTIAL = 1

export interface RankedCard {
  dataSource: 'otel' | 'log'
  sourceRank?: number
  totalLlmCalls: number
  inputTokens: number
  outputTokens: number
}

/** The card's rank: its own `sourceRank` when the builder set one, else inferred. */
export function sourceRankOf(card: RankedCard): number {
  if (card.sourceRank && card.sourceRank > 0) return card.sourceRank
  const hasUsage = card.inputTokens > 0 || card.outputTokens > 0
  if (card.dataSource === 'otel') return hasUsage && card.totalLlmCalls > 0 ? SOURCE_RANK_OTEL : SOURCE_RANK_PARTIAL
  return hasUsage ? SOURCE_RANK_FULL_TRANSCRIPT : SOURCE_RANK_PARTIAL
}

/** Whether `incoming` may replace `existing` for the same key: never a lower rank; an equal or
 *  higher one does (the incoming card is the newer revision of what it has evidence for). */
export function mayReplace(existing: RankedCard, incoming: RankedCard): boolean {
  return sourceRankOf(incoming) >= sourceRankOf(existing)
}

// ── Trace-key manifest hooks (feature 11 step 5 builds on these) ─────────────

export interface KeyedCard {
  sessionId: string
  startTime: string
  keyPending?: boolean
}

/** Whether `card` carries its canonical key yet. A Claude OTEL card whose transcript join is on
 *  hold (`keyPending`, a provisional id) or a synthesized in-progress root (`synth-…`, its root
 *  span hasn't arrived) has none: neither is ever stored, put in a manifest or sent to the cloud —
 *  a row sent under one would be a cloud row no local store ever holds. */
export function hasSettledKey(card: Pick<KeyedCard, 'sessionId' | 'keyPending'>): boolean {
  return !card.keyPending && !card.sessionId.startsWith('synth-')
}

function startMsOf(card: KeyedCard): number {
  const ms = Date.parse(card.startTime)
  return Number.isFinite(ms) ? ms : 0
}

/** The wire keys of the traces in `cards` that started in [fromMs, toMs] — cards whose key
 *  isn't settled yet (a Claude join on hold, a synthesized in-progress root) left out.
 *  For a host that holds its traces in memory (the standalone server); the extension's database
 *  answers the same with DatabaseReader.listTraceKeys. */
export function traceKeysInWindow(cards: Iterable<KeyedCard>, fromMs: number, toMs: number): string[] {
  const keys = new Set<string>()
  for (const c of cards) {
    if (!hasSettledKey(c)) continue
    const ms = startMsOf(c)
    if (ms >= fromMs && ms <= toMs) keys.add(toUuid(c.sessionId))
  }
  return [...keys]
}

/** How many traces in `cards` started in [fromMs, toMs] — not-yet-keyed and synthesized ones
 *  included — so 0 means positively none there (the trace manifest's `confirm_empty`). */
export function countTracesInWindow(cards: Iterable<KeyedCard>, fromMs: number, toMs: number): number {
  let n = 0
  for (const c of cards) {
    const ms = startMsOf(c)
    if (ms >= fromMs && ms <= toMs) n++
  }
  return n
}

/** Start of the oldest trace in `cards` (epoch ms), or null — the manifest window's lower bound
 *  (localHorizon): the oldest turn this install still has evidence for from any source. */
export function localHorizonOf(cards: Iterable<KeyedCard>): number | null {
  let min: number | null = null
  for (const c of cards) {
    if (!hasSettledKey(c)) continue
    const ms = startMsOf(c)
    if (ms > 0 && (min === null || ms < min)) min = ms
  }
  return min
}
