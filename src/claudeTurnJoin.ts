/**
 * Claude Code's OTEL carries no turn id, so a `claude_code.interaction` finds its transcript turn
 * by a join (staged feature 11), never by a key of its own:
 *
 *   - Claude Code's `session.id` names the transcript file (<projects>/<project>/<session.id>.jsonl);
 *   - the interaction's start picks the turn whose opening line is nearest, within ±2 s — OTEL
 *     starts 1–67 ms *before* the transcript line, never after, so a line more than LEAD_SLACK_MS
 *     before the interaction is a neighbouring turn and is never taken;
 *   - `user_prompt_length` (equal, or one longer when IDE context was attached) breaks a tie
 *     between two lines within TIE_MS of each other; still ambiguous → no join.
 *
 * Joined → the card takes the turn's key (traceKey('claude', promptId)) and the transcript's card
 * for that turn becomes the same row. Not joinable yet → held for `holdMs` (a few seconds, the
 * transcript line may not be on disk yet) and then given a derived key
 * `claude:interaction:<session.id>:<start ms>`, marked `derived`, never merged by guesswork. A
 * decision is final — across restarts too, when the host gives the joiner a `store` (a reloaded span
 * window re-decided against a transcript that has grown since could otherwise flip a turn between
 * the two keys); a turn is joined by at most one interaction.
 *
 * Timestamps and prompt lengths are only compared here and discarded; none of them enters a key.
 */

import * as fs from 'fs'
import { segmentClaudeTurns } from './claudeTurns'
import { traceKey, derivedTraceKey, claudeInteractionKey } from './traceIdentity'

export const JOIN_WINDOW_MS = 2_000
/** How far before the interaction start a transcript line may be and still be its own: clock
 *  rounding only — measured, OTEL always leads. */
export const LEAD_SLACK_MS = 250
const TIE_MS = 50
export const DEFAULT_JOIN_HOLD_MS = 5_000
const MAX_MEMO = 20_000

export interface ClaudeJoinInput {
  /** The OTEL interaction's own span id — what the decision is memoized under. */
  interactionId: string
  claudeSessionId: string
  startMs: number
  /** OTEL `user_prompt_length`, when present. */
  promptLength?: number
}

export type ClaudeJoinResult =
  | { status: 'joined'; key: string; derived: boolean }
  | { status: 'pending' }
  | { status: 'derived'; key: string }

interface IndexedTurn { key: string; derived: boolean; startMs: number; promptLength: number }
interface FileIndex { mtimeMs: number; size: number; turns: IndexedTurn[] }

/** Where decisions outlive the process (database/claudeJoinRepository.ts). */
export interface ClaudeJoinStore {
  get(interactionId: string): (ClaudeJoinResult & { status: 'joined' | 'derived' }) | undefined
  /** The interaction a turn key was joined to, if any. */
  ownerOf(turnKey: string): string | undefined
  put(interactionId: string, result: ClaudeJoinResult & { status: 'joined' | 'derived' }): void
}

export interface ClaudeTurnJoinerOptions {
  /** Transcript files that may hold `claudeSessionId` (default: none — inject the log reader's). */
  findTranscripts?: (claudeSessionId: string) => string[]
  holdMs?: number
  now?: () => number
  store?: ClaudeJoinStore
  /** The store opens later (attachStore): until then every undecided interaction stays pending,
   *  so nothing is decided — and keyed — without the decisions an earlier run already made. */
  awaitStore?: boolean
}

export class ClaudeTurnJoiner {
  private readonly findTranscripts: (claudeSessionId: string) => string[]
  readonly holdMs: number
  private readonly now: () => number
  private readonly decided = new Map<string, ClaudeJoinResult & { status: 'joined' | 'derived' }>()
  private readonly firstSeen = new Map<string, number>()
  /** Turn key → the interaction that joined it. */
  private readonly claimed = new Map<string, string>()
  private readonly indexes = new Map<string, FileIndex>()
  private store: ClaudeJoinStore | undefined
  private storeReady: boolean

  constructor(opts: ClaudeTurnJoinerOptions = {}) {
    this.findTranscripts = opts.findTranscripts ?? (() => [])
    this.holdMs = opts.holdMs ?? DEFAULT_JOIN_HOLD_MS
    this.now = opts.now ?? Date.now
    this.store = opts.store
    this.storeReady = !opts.awaitStore || !!opts.store
  }

  /** Gives an `awaitStore` joiner its store — or null when none could be opened, to decide
   *  without one (per process) rather than hold every interaction forever. */
  attachStore(store: ClaudeJoinStore | null): void {
    this.store = store ?? undefined
    this.storeReady = true
  }

  resolve(input: ClaudeJoinInput): ClaudeJoinResult {
    const done = this.decided.get(input.interactionId)
    if (done) return done
    if (!this.storeReady) return { status: 'pending' }
    const stored = this.store?.get(input.interactionId)
    if (stored) {
      if (stored.status === 'joined') this.claimed.set(stored.key, input.interactionId)
      this.remember(input.interactionId, stored, false)
      return stored
    }
    const seen = this.firstSeen.get(input.interactionId) ?? this.now()
    if (!this.firstSeen.has(input.interactionId)) this.firstSeen.set(input.interactionId, seen)

    const pick = this.pick(input)
    if (pick === 'none' && this.now() - seen < this.holdMs) return { status: 'pending' }
    const result: ClaudeJoinResult & { status: 'joined' | 'derived' } = pick !== 'none' && pick !== 'ambiguous'
      ? { status: 'joined', key: pick.key, derived: pick.derived }
      : { status: 'derived', key: claudeInteractionKey(input.claudeSessionId, input.startMs) }
    if (result.status === 'joined') this.claimed.set(result.key, input.interactionId)
    this.remember(input.interactionId, result, true)
    return result
  }

  private remember(interactionId: string, result: ClaudeJoinResult & { status: 'joined' | 'derived' }, fresh: boolean): void {
    this.firstSeen.delete(interactionId)
    this.decided.set(interactionId, result)
    if (fresh) this.store?.put(interactionId, result)
    if (this.decided.size > MAX_MEMO) {
      const oldest = this.decided.keys().next().value as string
      const old = this.decided.get(oldest)
      this.decided.delete(oldest)
      if (old?.status === 'joined' && this.claimed.get(old.key) === oldest) this.claimed.delete(old.key)
    }
  }

  private pick(input: ClaudeJoinInput): IndexedTurn | 'none' | 'ambiguous' {
    if (!input.claudeSessionId || !(input.startMs > 0)) return 'none'
    const candidates: Array<{ turn: IndexedTurn; delta: number }> = []
    for (const file of this.findTranscripts(input.claudeSessionId)) {
      for (const turn of this.index(file)) {
        const delta = turn.startMs - input.startMs
        if (delta < -LEAD_SLACK_MS || delta > JOIN_WINDOW_MS) continue
        const owner = this.claimed.get(turn.key) ?? this.store?.ownerOf(turn.key)
        if (owner && owner !== input.interactionId) continue
        if (!candidates.some(c => c.turn.key === turn.key)) candidates.push({ turn, delta })
      }
    }
    if (candidates.length === 0) return 'none'
    candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))
    const close = candidates.filter(c => Math.abs(c.delta) - Math.abs(candidates[0].delta) <= TIE_MS)
    if (close.length === 1) return close[0].turn
    const len = input.promptLength
    if (len === undefined || len <= 0) return 'ambiguous'
    const matching = close.filter(c => c.turn.promptLength === len || c.turn.promptLength + 1 === len)
    return matching.length === 1 ? matching[0].turn : 'ambiguous'
  }

  /** The file's turns (key, opening time, prompt length), re-read only when the file changed. */
  private index(file: string): IndexedTurn[] {
    let stat: fs.Stats
    try { stat = fs.statSync(file) } catch { this.indexes.delete(file); return [] }
    const cached = this.indexes.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.turns
    let raw: string
    try { raw = fs.readFileSync(file, 'utf-8') } catch { return [] }
    const conversationId = file.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '')
    const parsed = raw.split('\n').map(line => {
      if (!line.trim()) return undefined
      try { return JSON.parse(line) as unknown } catch { return undefined }
    })
    const turns = segmentClaudeTurns(parsed).filter(t => t.startMs > 0).map(t => ({
      key: t.exact ? traceKey('claude', t.turnId) : derivedTraceKey('claude', conversationId, t.turnId),
      derived: !t.exact,
      startMs: t.startMs,
      promptLength: t.promptLength,
    }))
    this.indexes.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, turns })
    if (this.indexes.size > 256) this.indexes.delete(this.indexes.keys().next().value as string)
    return turns
  }
}

// The process-wide joiner the summarizers use (spanSummarizer → otelTraceKeys). Set by the hosts
// (extension.ts, standalone/server.ts, the CLI) at startup with the log reader's transcript
// lookup. Unset — a test, a tool with no transcripts — Claude interactions get derived keys.
let activeJoiner: ClaudeTurnJoiner | null = null

export function setClaudeTurnJoiner(joiner: ClaudeTurnJoiner | null): void {
  activeJoiner = joiner
}

export function getClaudeTurnJoiner(): ClaudeTurnJoiner | null {
  return activeJoiner
}

/** The hold to read from the environment: TRACEROOST_CLAUDE_JOIN_HOLD_MS, else the default. */
export function joinHoldMsFromEnv(): number {
  const v = Number(process.env['TRACEROOST_CLAUDE_JOIN_HOLD_MS'])
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_JOIN_HOLD_MS
}
