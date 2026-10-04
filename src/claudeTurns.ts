/**
 * Claude Code transcript → turns (staged feature 11). One turn = one trace: a turn opens at the
 * first prompt line carrying a `promptId` not seen before in the file, and every later line
 * belongs to the turn that is open — except a line carrying an already-seen `promptId`, which goes
 * back to that turn (interrupt markers "[Request interrupted by user…]", compaction carry-overs
 * "This session is being continued…", slash-command lines and their `<local-command-stdout>`
 * output all share their turn's promptId). A message typed while the agent works never opens a
 * turn: Claude Code delivers it inside the next tool result, and a tool-result line never opens
 * one. Sidechain (subagent) lines never open one either.
 *
 * A transcript written before Claude Code stamped `promptId` falls back to one turn per real
 * prompt line (not a tool result, not meta, not an interrupt marker or command output), keyed
 * `derived` from the conversation id plus that line's own `uuid` (or its exact timestamp).
 *
 * Shared by the log reader (logReader.ts) and the OTEL→transcript join (claudeTurnJoin.ts), so
 * both always agree on where a turn starts. Pure: parsed lines in, index ranges out.
 */

export interface ClaudeTurnSpan {
  /** The agent's own turn id (`promptId`) when `exact`; otherwise the opening line's uuid or
   *  timestamp (combined with the conversation id into a derived key). */
  turnId: string
  exact: boolean
  /** Index of the line that opened the turn. */
  opening: number
  /** Every line index that belongs to this turn, ascending. Lines before the first turn (file
   *  bookkeeping) belong to the first turn. */
  indices: number[]
  /** The opening line's timestamp in epoch ms, or 0. */
  startMs: number
  /** Text length of the turn's first non-meta prompt line — a join tie-breaker only, kept local. */
  promptLength: number
}

type Entry = Record<string, unknown>

function isEntry(v: unknown): v is Entry {
  return typeof v === 'object' && v !== null
}

function contentOf(e: Entry): unknown {
  return (e['message'] as Entry | undefined)?.['content']
}

/** A user line whose content carries a tool result — the agent's own turn continuing. */
function isToolResultLine(e: Entry): boolean {
  const c = contentOf(e)
  return Array.isArray(c) && c.some(b => isEntry(b) && b['type'] === 'tool_result')
}

export function claudeLineText(e: Entry): string {
  const c = contentOf(e)
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) {
    for (const b of c) {
      if (isEntry(b) && b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].trim()) return b['text'].trim()
    }
  }
  return ''
}

const CONTINUATION_RE = /^(\[Request interrupted by user|<local-command-stdout>|<local-command-stderr>|This session is being continued from a previous conversation)/

function promptIdOf(e: Entry): string {
  return typeof e['promptId'] === 'string' ? e['promptId'] : ''
}

function tsMs(e: Entry): number {
  const ts = e['timestamp']
  const ms = typeof ts === 'string' ? Date.parse(ts) : NaN
  return Number.isFinite(ms) ? ms : 0
}

/** The id of the turn this line opens, or '' when it opens none. */
function openingId(e: Entry, hasPromptIds: boolean): string {
  if (e['type'] !== 'user' || e['isSidechain'] === true || isToolResultLine(e)) return ''
  if (hasPromptIds) return promptIdOf(e)
  if (e['isMeta'] === true || e['isCompactSummary'] === true) return ''
  const text = claudeLineText(e)
  if (!text || CONTINUATION_RE.test(text)) return ''
  const uuid = typeof e['uuid'] === 'string' ? e['uuid'] : ''
  return uuid || (typeof e['timestamp'] === 'string' ? e['timestamp'] : '')
}

export function segmentClaudeTurns(parsed: unknown[]): ClaudeTurnSpan[] {
  const hasPromptIds = parsed.some(e => isEntry(e) && e['type'] === 'user' && !!promptIdOf(e))
  const turns: ClaudeTurnSpan[] = []
  const byId = new Map<string, ClaudeTurnSpan>()
  const leading: number[] = []
  let current: ClaudeTurnSpan | undefined

  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i]
    if (!isEntry(e)) { (current ? current.indices : leading).push(i); continue }
    const id = openingId(e, hasPromptIds)
    if (id && !byId.has(id)) {
      const turn: ClaudeTurnSpan = { turnId: id, exact: hasPromptIds, opening: i, indices: [i], startMs: tsMs(e), promptLength: 0 }
      if (e['isMeta'] !== true) turn.promptLength = claudeLineText(e).length
      if (turns.length === 0) turn.indices.unshift(...leading)
      turns.push(turn)
      byId.set(id, turn)
      current = turn
      continue
    }
    // A line sharing an earlier turn's promptId goes back to that turn.
    const own = hasPromptIds && e['type'] === 'user' ? byId.get(promptIdOf(e)) : undefined
    const target = own ?? current
    if (!target) { leading.push(i); continue }
    target.indices.push(i)
    if (target.promptLength === 0 && e['type'] === 'user' && e['isMeta'] !== true && !isToolResultLine(e) && promptIdOf(e) === target.turnId) {
      target.promptLength = claudeLineText(e).length
    }
  }

  // No prompt line at all (an assistant-only fragment): one derived turn for the lot, opened at
  // the first line with an id or timestamp, so its usage is still counted once. Only when there
  // is an assistant line to count: a transcript read before its first prompt line is written
  // holds only bookkeeping (Claude Code opens a file with queue-operation lines ~100 ms ahead of
  // the prompt), and a turn keyed off those would be re-keyed by the prompt a moment later —
  // the early key already sent to the cloud, but held by no store.
  if (turns.length === 0 && leading.some(i => isEntry(parsed[i]) && (parsed[i] as Entry)['type'] === 'assistant')) {
    const first = leading.find(i => isEntry(parsed[i]) && (typeof (parsed[i] as Entry)['uuid'] === 'string' || tsMs(parsed[i] as Entry) > 0))
    if (first === undefined) return []
    const e = parsed[first] as Entry
    const turnId = typeof e['uuid'] === 'string' ? e['uuid'] : String(e['timestamp'])
    turns.push({ turnId, exact: false, opening: first, indices: leading.slice(), startMs: tsMs(e), promptLength: 0 })
  }
  for (const t of turns) t.indices.sort((a, b) => a - b)
  return turns
}
