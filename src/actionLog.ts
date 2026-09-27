/**
 * Persistent, cross-module record of every shell command TraceRoost's host process runs on the
 * user's machine — generalizes gitOutcome.ts's original `runningCommands` tracker (git-only,
 * transient — a command vanished the instant it finished) into something that (a) covers every
 * `execFile`/`exec` call site that shells out on the user's behalf, git or not, and (b) keeps a
 * bounded history past completion, so "what did TraceRoost just do to my repo" has an answer more
 * than a second after it happened. See .staged-issues/action-log.md for the plan this implements.
 *
 * Two views over the same entries:
 *   - "running" — entries with `finishedAt === null`, formatted as a single line each (the
 *     existing footer ticker's shape) via `onRunningActionsChanged`. Behavior-identical to the
 *     tracker this replaces, just fed by more call sites now.
 *   - "history" — every entry (running or finished), oldest evicted first past MAX_HISTORY, via
 *     `onActionLogChanged`. This is the new persistent log the Log panel reads.
 *
 * A ring buffer, not a database table: this is a transparency/debugging aid for the current
 * session, not a compliance audit trail — nothing here is persisted across a restart.
 */

const MAX_HISTORY = 200

export interface ActionLogEntry {
  id: number
  cwd: string
  /** Plain-English gloss shown ahead of the raw command, or null to fall back to the raw command
   *  alone — mirrors describeGitCommand's `null` fallback for an unrecognized subcommand. */
  gloss: string | null
  raw: string
  startedAt: number
  finishedAt: number | null
  failed: boolean
}

const history: ActionLogEntry[] = []
const running = new Map<number, ActionLogEntry>()
let nextId = 1

const runningChangeListeners = new Set<(lines: string[]) => void>()
const logChangeListeners = new Set<(history: ActionLogEntry[]) => void>()

// Same coalescing behavior as the tracker this replaces — see the original comment history in
// gitOutcome.ts (git blame this file) for why 500ms and why leading-edge.
const NOTIFY_THROTTLE_MS = 500
let notifyScheduled: ReturnType<typeof setTimeout> | null = null
let trailingNotifyNeeded = false

function formatRunningLine(e: ActionLogEntry): string {
  return `${e.cwd}: ${e.gloss ? `${e.gloss} — ${e.raw}` : e.raw}`
}

function emitSnapshot(): void {
  const lines = [...new Set([...running.values()].map(formatRunningLine))]
  for (const listener of runningChangeListeners) listener(lines)
  for (const listener of logChangeListeners) listener([...history])
}

function scheduleNotify(): void {
  if (notifyScheduled) {
    trailingNotifyNeeded = true
    return
  }
  emitSnapshot()
  notifyScheduled = setTimeout(() => {
    notifyScheduled = null
    if (trailingNotifyNeeded) {
      trailingNotifyNeeded = false
      emitSnapshot()
    }
  }, NOTIFY_THROTTLE_MS)
}

/** Subscribes to the live "what's running right now" line list — same shape and throttling as
 *  gitOutcome.ts's original `onRunningGitCommandsChanged`, now fed by every routed call site. */
export function onRunningActionsChanged(listener: (lines: string[]) => void): () => void {
  runningChangeListeners.add(listener)
  return () => { runningChangeListeners.delete(listener) }
}

/** Subscribes to the persistent history (full snapshot on every change, newest last) — feeds the
 *  Log panel. */
export function onActionLogChanged(listener: (history: ActionLogEntry[]) => void): () => void {
  logChangeListeners.add(listener)
  return () => { logChangeListeners.delete(listener) }
}

/** Current history snapshot, newest last — for a panel that just opened and needs the backlog
 *  before the next change event. */
export function getActionLogHistory(): ActionLogEntry[] {
  return [...history]
}

/** Wraps one shell-out with start/end recording. Call sites pass their own plain-English `gloss`
 *  (or null) and the raw command line they're about to run, plus the async work itself — this
 *  keeps the try/finally bookkeeping in one place rather than duplicated at every call site. */
export async function recordAction<T>(cwd: string, gloss: string | null, raw: string, fn: () => Promise<T>): Promise<T> {
  const id = nextId++
  const entry: ActionLogEntry = { id, cwd, gloss, raw, startedAt: Date.now(), finishedAt: null, failed: false }
  running.set(id, entry)
  history.push(entry)
  if (history.length > MAX_HISTORY) history.shift()
  scheduleNotify()
  try {
    return await fn()
  } catch (err) {
    entry.failed = true
    throw err
  } finally {
    entry.finishedAt = Date.now()
    running.delete(id)
    scheduleNotify()
  }
}
