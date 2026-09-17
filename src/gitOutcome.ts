/**
 * Session-outcome correlation with git — did a session's file changes survive?
 *
 * Local git only, on-demand (called per session when its detail view is opened, not eagerly for
 * every loaded session — see .staged-issues/03-git-outcome-correlation.md for why). Classifies
 * each changed file by comparing its content immediately before the session started against its
 * content right now, using git history as the source of truth rather than TraceRoost's own
 * recorded diff snippets (which only capture partial before/after strings, not full file content).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'

const execFileAsync = promisify(execFile)

export type FileOutcome = 'productive' | 'reverted' | 'abandoned' | 'ambiguous'

export interface GitOutcome {
  overall: FileOutcome
  files: Record<string, FileOutcome>
  reason: string
}

const GIT_TIMEOUT_MS = 5000
const MAX_FILES = 25 // cap subprocess fan-out for sessions that touched an unusually large number of files

// Bounds how many sessions' git-outcome classifications run at once, across every caller sharing
// this module (DashboardPanel, the standalone server). Each session can itself fan out up to
// MAX_FILES*2 concurrent git subprocesses (classifyFile's own Promise.all below) — with nothing
// bounding how many sessions run at once on top of that, switching the Outcome filter on over a
// large candidate set could try to classify dozens of sessions simultaneously, spawning hundreds
// of concurrent `git` processes. That doesn't just make the batch slow — it thrashes disk/CPU
// enough to slow down every session's classification together, which is what turns "resolving N
// outcomes" into a spinner that hangs for a long time rather than one that steadily counts down.
// A small, fixed number here keeps total concurrent git subprocess load bounded and predictable
// regardless of how many sessions are queued.
const MAX_CONCURRENT_SESSION_CLASSIFICATIONS = 4
let activeSessionClassifications = 0
const sessionClassificationQueue: Array<() => void> = []

function acquireSessionClassificationSlot(): Promise<void> {
  if (activeSessionClassifications < MAX_CONCURRENT_SESSION_CLASSIFICATIONS) {
    activeSessionClassifications++
    return Promise.resolve()
  }
  return new Promise<void>(resolve => sessionClassificationQueue.push(resolve))
}

// Hands the freed slot directly to the next queued caller rather than decrementing then letting
// them re-increment — same count, no window where a slot looks free to anyone else.
function releaseSessionClassificationSlot(): void {
  const next = sessionClassificationQueue.shift()
  if (next) next()
  else activeSessionClassifications--
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

async function findRepoRoot(workspace: string): Promise<string | null> {
  const out = await runGit(workspace, ['rev-parse', '--show-toplevel'])
  return out?.trim() || null
}

/** Resolves the repo root and current HEAD sha for `workspace` in one git call — used to key the
 *  on-disk outcome cache (GitOutcomeRepository) so a restart doesn't force a rescan unless the
 *  repo has actually moved. */
export async function resolveRepoHead(workspace: string): Promise<{ root: string; headSha: string } | null> {
  const out = await runGit(workspace, ['rev-parse', '--show-toplevel', 'HEAD'])
  if (!out) return null
  const [root, headSha] = out.trim().split('\n')
  if (!root || !headSha) return null
  return { root, headSha }
}

// Resolves symlinks where possible so paths compare consistently — `git rev-parse --show-toplevel`
// always returns a fully-resolved path, but a workspace/file path from elsewhere may not (notably
// macOS, where the default tmpdir and often the home directory sit behind a symlink).
function realpathBestEffort(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p))
    } catch {
      return path.resolve(p)
    }
  }
}

// Relative path (posix separators) of `absPath` under `root`, or null if outside the repo.
function relativeToRoot(root: string, absPath: string): string | null {
  const rel = path.relative(realpathBestEffort(root), realpathBestEffort(absPath))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

// Content of `relPath` at the last commit strictly before `sinceIso`, or null if no such commit.
async function contentBeforeSession(root: string, relPath: string, sinceIso: string): Promise<string | null> {
  const hash = await runGit(root, ['log', '--format=%H', '-1', '--before=' + sinceIso, '--', relPath])
  const commitHash = hash?.trim()
  if (!commitHash) return null
  return runGit(root, ['show', commitHash + ':' + relPath])
}

// Content of `relPath` right now: working tree if present on disk, else HEAD, else null.
function currentContentOnDisk(root: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(root, relPath), 'utf-8')
  } catch {
    return null
  }
}

async function classifyFile(root: string, relPath: string, sessionStartIso: string): Promise<FileOutcome> {
  const onDisk = currentContentOnDisk(root, relPath)
  const headContent = await runGit(root, ['show', 'HEAD:' + relPath])
  const after = onDisk !== null ? onDisk : headContent
  if (after === null) return 'ambiguous' // deleted, moved, or never committed and gone

  const before = await contentBeforeSession(root, relPath, sessionStartIso)
  if (before !== null && before === after) return 'reverted' // net no-op vs. pre-session state

  // Whether the change made it into a commit is "is the working tree clean" (or there's no
  // working-tree copy to be dirty, and we already fell back to HEAD) — not "did a commit land
  // after some cutoff timestamp". A time-window check (the previous approach, keyed off the
  // session's end time) misclassifies a file committed mid-session — before the session's last
  // logged event, but well after the edit — as 'abandoned', even though it's sitting cleanly in
  // HEAD with no further changes.
  const committed = onDisk === null || onDisk === headContent
  return committed ? 'productive' : 'abandoned'
}

const OUTCOME_PRIORITY: FileOutcome[] = ['reverted', 'abandoned', 'ambiguous', 'productive']

function summarize(overall: FileOutcome, files: Record<string, FileOutcome>): string {
  const total = Object.keys(files).length
  const count = Object.values(files).filter(v => v === overall).length
  switch (overall) {
    case 'reverted':   return `${count}/${total} file(s) reverted to their pre-session state, per git history`
    case 'abandoned':  return `${count}/${total} file(s) changed but not yet committed to git`
    case 'productive': return `${total} file(s) committed to git after the session`
    default:           return `Could not determine git status for ${count}/${total} file(s)`
  }
}

/**
 * Returns null (rather than an "ambiguous" result) when there's nothing meaningful to classify —
 * no workspace, no changed files, the workspace path doesn't exist, it isn't a git repo at all, or
 * every changed file falls outside the repo root. Callers should treat null as "not applicable,"
 * distinct from a computed-but-inconclusive result.
 */
export async function classifySessionOutcome(
  workspace: string,
  filesChanged: string[],
  startTime: string,
  endTime: string,
): Promise<GitOutcome | null> {
  if (!workspace || filesChanged.length === 0) return null
  if (!fs.existsSync(workspace)) return null

  const root = await findRepoRoot(workspace)
  if (!root) return null

  const sessionStartIso = startTime || endTime
  if (!sessionStartIso) return null

  // Files outside the repo (global settings, cross-project memory notes, etc. — a session's
  // filesChanged isn't scoped to the repo it ran in) have no git status to speak of. Drop them
  // before classifying rather than counting them as 'ambiguous': that outranks 'productive' in
  // OUTCOME_PRIORITY, so a single unrelated housekeeping edit would otherwise drag an entire
  // cleanly-committed session's verdict down to ambiguous.
  const inRepo = filesChanged
    .map((absPath): [string, string | null] => [absPath, relativeToRoot(root, absPath)])
    .filter((pair): pair is [string, string] => pair[1] !== null)
  if (inRepo.length === 0) return null

  // Each file's classification is independent — run them concurrently rather than
  // one at a time. This is the dominant cost of the whole function (each file spawns
  // up to two more git subprocesses on top of this), so serializing it was the main
  // source of visible delay on sessions with more than a handful of changed files.
  // Gated so this session's own fan-out doesn't stack unbounded on top of every other session
  // being classified at the same time — see acquireSessionClassificationSlot's doc comment.
  await acquireSessionClassificationSlot()
  let files: Record<string, FileOutcome>
  try {
    const entries = await Promise.all(
      inRepo.slice(0, MAX_FILES).map(async ([absPath, rel]): Promise<[string, FileOutcome]> =>
        [absPath, await classifyFile(root, rel, sessionStartIso)]
      )
    )
    files = Object.fromEntries(entries)
  } finally {
    releaseSessionClassificationSlot()
  }

  const values = Object.values(files)
  const overall = OUTCOME_PRIORITY.find(p => values.includes(p)) ?? 'ambiguous'

  return { overall, files, reason: summarize(overall, files) }
}
