/**
 * Session-outcome correlation with git — did a session's file changes survive, and did they make
 * it all the way to the shared trunk branch?
 *
 * Local git only, on-demand (called per session when its detail view is opened, not eagerly for
 * every loaded session — see .staged-issues/03-git-outcome-correlation.md for why). Classifies
 * each changed file by comparing its content right now against the working tree, the local HEAD,
 * and (when resolvable) the tip of the repo's trunk branch — using git history as the source of
 * truth rather than TraceRoost's own recorded diff snippets (which only capture partial
 * before/after strings, not full file content).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'

const execFileAsync = promisify(execFile)

export type FileOutcome = 'merged' | 'committed' | 'abandoned' | 'ambiguous'

export interface GitOutcome {
  overall: FileOutcome
  files: Record<string, FileOutcome>
  reason: string
}

const GIT_TIMEOUT_MS = 5000
const MAX_FILES = 25 // cap subprocess fan-out for sessions that touched an unusually large number of files

// Bounds how many sessions' git-outcome classifications run at once, across every caller sharing
// this module (DashboardPanel, the standalone server). Each session can itself fan out several
// concurrent git subprocesses per file (classifyFile's own git calls below) — with nothing
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

/**
 * Memoizes `findRepoRoot`/`resolveTrunkRef` across many `classifySessionOutcome` calls that share
 * a workspace or repo root — a developer's sessions cluster in a handful of repos, so without this
 * every one of them re-runs the same `git rev-parse`/`symbolic-ref` round trips from scratch.
 * Scoped to whatever call site constructs one (e.g. one on-demand reconcile pass); nothing here is
 * cached across separate instances, so a mid-history branch change is picked up next time one is
 * created, same as the uncached path. See .staged-issues/reconcile-gap-and-latency.md.
 */
export interface OutcomeRepoCache {
  root(workspace: string): Promise<string | null>
  trunkRef(root: string): Promise<string | null>
}

export function createOutcomeRepoCache(): OutcomeRepoCache {
  const roots = new Map<string, Promise<string | null>>()
  const trunkRefs = new Map<string, Promise<string | null>>()
  return {
    root(workspace: string) {
      let p = roots.get(workspace)
      if (!p) { p = findRepoRoot(workspace); roots.set(workspace, p) }
      return p
    },
    trunkRef(root: string) {
      let p = trunkRefs.get(root)
      if (!p) { p = resolveTrunkRef(root); trunkRefs.set(root, p) }
      return p
    },
  }
}

/** Resolves a ref for the repo's shared/trunk branch — preferring the remote's advertised default
 *  (works whichever it's named), then falling back to a local main/master. Returns null if none of
 *  these resolve (no remote and no local main/master — e.g. a repo that hasn't set one up, or uses
 *  a trunk name this can't guess): callers treat that as "can't tell if it's merged," not as
 *  evidence that it isn't. */
async function resolveTrunkRef(root: string): Promise<string | null> {
  const symbolic = await runGit(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  const ref = symbolic?.trim()
  if (ref) return ref
  for (const candidate of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    const exists = await runGit(root, ['show-ref', '--verify', '--quiet', candidate])
    if (exists !== null) return candidate
  }
  return null
}

/** Resolves the repo root and a cache key for `filesChanged` — combining the latest commit sha
 *  touching any of those specific files with the trunk branch's current tip sha (if resolvable).
 *  Used to key the on-disk outcome cache (GitOutcomeRepository) so a restart doesn't force a
 *  rescan unless something relevant has actually moved: either a new commit to *this session's own
 *  files*, or the trunk branch advancing (which can flip a file from 'committed' to 'merged'
 *  without touching the file again locally — e.g. a human merges the PR later). Deliberately
 *  scoped to those two things rather than the repo's overall HEAD: keying on HEAD meant an
 *  unrelated commit anywhere else in the repo invalidated every other session's cached outcome at
 *  the same time, which read as a full reload rather than an isolated recompute. Returns null if
 *  none of the files are inside the repo (mirrors classifySessionOutcome's own "nothing to
 *  classify" case, so nothing gets cached for it either). */
export async function resolveOutcomeCacheKey(workspace: string, filesChanged: string[]): Promise<{ root: string; cacheKey: string } | null> {
  const root = await findRepoRoot(workspace)
  if (!root) return null
  const relPaths = filesChanged
    .map(absPath => relativeToRoot(root, absPath))
    .filter((p): p is string => p !== null)
    .slice(0, MAX_FILES)
  if (relPaths.length === 0) return null

  const [fileSha, trunkRef] = await Promise.all([
    runGit(root, ['log', '-1', '--format=%H', '--', ...relPaths]),
    resolveTrunkRef(root),
  ])
  const trunkSha = trunkRef ? await runGit(root, ['rev-parse', trunkRef]) : null
  return { root, cacheKey: `${fileSha?.trim() ?? ''}:${trunkSha?.trim() ?? ''}` }
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

// Content of `relPath` right now: working tree if present on disk, else HEAD, else null.
function currentContentOnDisk(root: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(root, relPath), 'utf-8')
  } catch {
    return null
  }
}

async function classifyFile(root: string, relPath: string, trunkRef: string | null): Promise<FileOutcome> {
  const onDisk = currentContentOnDisk(root, relPath)
  const headContent = await runGit(root, ['show', 'HEAD:' + relPath])
  const after = onDisk !== null ? onDisk : headContent
  if (after === null) return 'ambiguous' // deleted, moved, or never committed and gone

  // Whether the change made it into a commit is "is the working tree clean" (or there's no
  // working-tree copy to be dirty, and we already fell back to HEAD) — not "did a commit land
  // after some cutoff timestamp". A time-window check (a previous approach, keyed off the
  // session's end time) misclassifies a file committed mid-session — before the session's last
  // logged event, but well after the edit — as 'abandoned', even though it's sitting cleanly in
  // HEAD with no further changes.
  const committed = onDisk === null || onDisk === headContent
  if (!committed) return 'abandoned'

  if (!trunkRef) return 'committed' // no resolvable trunk branch to compare against

  // Content-based rather than ancestry-based (`git merge-base --is-ancestor`): a squash or rebase
  // merge gives the trunk copy of a commit a different sha than the local one, so ancestry checks
  // would miss those. Comparing file content at the trunk tip catches "this exact content is on
  // the shared branch now" regardless of how it got there.
  const trunkContent = await runGit(root, ['show', trunkRef + ':' + relPath])
  return trunkContent === after ? 'merged' : 'committed'
}

// Worst-first: one abandoned file drags the whole session down even if everything else merged.
const OUTCOME_PRIORITY: FileOutcome[] = ['abandoned', 'ambiguous', 'committed', 'merged']

function trunkDisplayName(trunkRef: string | null): string {
  if (!trunkRef) return 'the trunk branch'
  return trunkRef.replace(/^refs\/(remotes\/origin|heads)\//, '')
}

function summarize(overall: FileOutcome, files: Record<string, FileOutcome>, trunkRef: string | null): string {
  const total = Object.keys(files).length
  const count = Object.values(files).filter(v => v === overall).length
  const trunk = trunkDisplayName(trunkRef)
  switch (overall) {
    case 'abandoned':  return `${count}/${total} file(s) changed but not yet committed to git`
    case 'committed':  return `${count}/${total} file(s) committed, but not yet merged into ${trunk}`
    case 'merged':     return `${total} file(s) committed and merged into ${trunk}`
    default:           return `Could not determine git status for ${count}/${total} file(s)`
  }
}

/**
 * Returns null (rather than an "ambiguous" result) when there's nothing meaningful to classify —
 * no workspace, no changed files, the workspace path doesn't exist, it isn't a git repo at all, or
 * every changed file falls outside the repo root. Callers should treat null as "not applicable,"
 * distinct from a computed-but-inconclusive result.
 */
export async function classifySessionOutcome(workspace: string, filesChanged: string[], cache?: OutcomeRepoCache): Promise<GitOutcome | null> {
  if (!workspace || filesChanged.length === 0) return null
  if (!fs.existsSync(workspace)) return null

  const root = cache ? await cache.root(workspace) : await findRepoRoot(workspace)
  if (!root) return null

  // Files outside the repo (global settings, cross-project memory notes, etc. — a session's
  // filesChanged isn't scoped to the repo it ran in) have no git status to speak of. Drop them
  // before classifying rather than counting them as 'ambiguous': that outranks 'merged'/'committed'
  // in OUTCOME_PRIORITY, so a single unrelated housekeeping edit would otherwise drag an entire
  // cleanly-merged session's verdict down to ambiguous.
  const inRepo = filesChanged
    .map((absPath): [string, string | null] => [absPath, relativeToRoot(root, absPath)])
    .filter((pair): pair is [string, string] => pair[1] !== null)
  if (inRepo.length === 0) return null

  const trunkRef = cache ? await cache.trunkRef(root) : await resolveTrunkRef(root)

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
        [absPath, await classifyFile(root, rel, trunkRef)]
      )
    )
    files = Object.fromEntries(entries)
  } finally {
    releaseSessionClassificationSlot()
  }

  const values = Object.values(files)
  const overall = OUTCOME_PRIORITY.find(p => values.includes(p)) ?? 'ambiguous'

  return { overall, files, reason: summarize(overall, files, trunkRef) }
}
