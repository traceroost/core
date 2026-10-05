// Per-session change size — files changed, lines added, lines removed — from the agent's OWN
// edit/write tool calls. These are agent-authored edits as the summarizers saw them in the trace,
// NOT git commit stats: git-side authorship/line attribution is a separate thing (src/attribution/)
// and the two are never mixed. Deliberately import-free (structural input types only).
//
// Definitions (also in Help → Traces → Change size, and src/language.ts's header):
//  - filesChanged: the number of distinct files the agent edited or wrote — the summarizers'
//    filesChanged set, counted. ALL files count here, code or not (README, JSON, lockfiles too) —
//    unlike the session's language (src/language.ts), which ignores non-code files.
//  - linesAdded / linesRemoved: summed over every edit detail the summarizers extracted
//    (TimelineEntry.editDetails). Per edit:
//      * old → new string (Edit / MultiEdit / replace_string_in_file): a line diff — common
//        leading/trailing lines are trimmed, then the middle is diffed with an LCS (exact when the
//        middle is ≤ LCS_CELL_LIMIT cells; above that, every middle line counts as removed/added).
//      * apply_patch hunk (toolName 'apply_patch'): its `-` lines are removed, its `+` lines added,
//        as the patch states them (context lines are already dropped by the summarizer).
//      * a full write with only `content` (Write / create_file): every content line is added. The
//        prior contents of an overwritten file are not in the trace, so nothing counts as removed.
//    A line is a `\n`-separated segment; a trailing newline does not add an empty line.
//    Claude Code records the same edit on its LLM entry and its tool entry — like the one-shot
//    metric (loopDetector.ts's getFileEditCounts), LLM-entry details are used when any exist,
//    else tool-entry details, so nothing is counted twice.
//  - When the session changed files but no edit details were extracted at all (Codex, OpenCode
//    and Cursor, and the Copilot/Codex log formats, don't record edit contents), lines are
//    UNKNOWN (undefined), never a misleading 0. A session that changed nothing is 0 / 0.

export interface EditStatsDetail {
  filePath?: string
  oldString?: string
  newString?: string
  content?: string
  toolName?: string
}

export interface EditStatsInput {
  filesChanged?: readonly string[]
  timeline?: ReadonlyArray<{ type: string; editDetails?: readonly EditStatsDetail[] }>
}

export interface EditStats {
  filesChangedCount: number
  linesAdded?: number
  linesRemoved?: number
}

/** Above this many DP cells (old middle lines × new middle lines) an edit is not LCS-diffed. */
const LCS_CELL_LIMIT = 250_000

export function countLines(s: string | undefined): number {
  if (!s) return 0
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

function splitLines(s: string | undefined): string[] {
  if (!s) return []
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Lines added/removed turning `oldText` into `newText`. */
export function lineDiff(oldText: string | undefined, newText: string | undefined): { added: number; removed: number } {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length === 0 || midB.length === 0 || midA.length * midB.length > LCS_CELL_LIMIT) {
    return { added: midB.length, removed: midA.length }
  }
  // LCS length, two rolling rows.
  let prev = new Array<number>(midB.length + 1).fill(0)
  let cur = new Array<number>(midB.length + 1).fill(0)
  for (let i = 1; i <= midA.length; i++) {
    for (let j = 1; j <= midB.length; j++) {
      cur[j] = midA[i - 1] === midB[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    ;[prev, cur] = [cur, prev]
  }
  const lcs = prev[midB.length]
  return { added: midB.length - lcs, removed: midA.length - lcs }
}

function detailLines(d: EditStatsDetail): { added: number; removed: number } {
  if (d.toolName === 'apply_patch') return { added: countLines(d.newString), removed: countLines(d.oldString) }
  if (d.oldString === undefined && d.newString === undefined) return { added: countLines(d.content), removed: 0 }
  return lineDiff(d.oldString, d.newString)
}

export function computeEditStats(card: EditStatsInput): EditStats {
  const filesChangedCount = new Set(card.filesChanged ?? []).size
  const collect = (type: string) => (card.timeline ?? [])
    .filter(e => e.type === type)
    .flatMap(e => e.editDetails ?? [])
  let details = collect('llm')
  if (details.length === 0) details = collect('tool')
  if (details.length === 0) {
    return filesChangedCount === 0 ? { filesChangedCount, linesAdded: 0, linesRemoved: 0 } : { filesChangedCount }
  }
  let linesAdded = 0
  let linesRemoved = 0
  for (const d of details) {
    const { added, removed } = detailLines(d)
    linesAdded += added
    linesRemoved += removed
  }
  return { filesChangedCount, linesAdded, linesRemoved }
}

/** Change-size counts for a card rebuilt from untrusted JSON (an Import): the record's own
 *  counts when they are non-negative integers; the file count falls back to its filesChanged. */
export function editStatsFromRecord(raw: Record<string, unknown>, filesChanged: readonly string[]): EditStats {
  const n = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
  const out: EditStats = { filesChangedCount: n(raw['filesChangedCount']) ?? new Set(filesChanged).size }
  const added = n(raw['linesAdded'])
  const removed = n(raw['linesRemoved'])
  if (added !== undefined) out.linesAdded = added
  if (removed !== undefined) out.linesRemoved = removed
  return out
}
