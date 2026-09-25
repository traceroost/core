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
import * as crypto from 'crypto'

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

// Live "what git command is this running right now" ticker, surfaced by the dashboard as a status
// line under the "resolving N outcomes" spinner — without it, a slow or stuck classification (a
// huge repo, a network-mounted working tree) just looks like a spinner that never moves. Module-
// scoped rather than per-call-site since every classifySessionOutcome call, from any caller
// (DashboardPanel, the standalone server, the background watcher), shares this one process's git
// subprocess fan-out.
const runningCommands = new Map<number, string>()
let nextCommandId = 1
const runningCommandListeners = new Set<(commands: string[]) => void>()
let notifyScheduled: ReturnType<typeof setTimeout> | null = null

// Coalesces a burst of fast git calls (many finish in single-digit milliseconds) into one snapshot
// per tick, rather than a listener call — and a postMessage/SSE broadcast on top of that — per
// subprocess. Leading-edge: the first call in a window notifies immediately, since most commands
// here finish well inside the throttle window — a pure trailing-edge debounce would schedule its
// only snapshot out at the full window, and by the time it fires, the map that started this call
// would already be empty again, so the status line would sit blank through almost every burst. A
// trailing call is still scheduled to pick up whatever state the map is in once the window closes
// (a command still running past it, or a different one that started and finished mid-window).
//
// 500ms rather than something closer to real-time: this is a "what's TraceRoost doing right now"
// readout for a human, not a progress bar that needs to track every subprocess. At 100ms (the
// original value) a busy repo cycles the label faster than it can be read — each snapshot is
// gone before its text even registers. 500ms is slow enough to actually read a line like "repo:
// Finding the last commit that touched these files — git log …" while still feeling live.
const RUNNING_COMMANDS_NOTIFY_THROTTLE_MS = 500
let trailingNotifyNeeded = false

function emitRunningCommandsSnapshot(): void {
  const snapshot = [...new Set(runningCommands.values())]
  for (const listener of runningCommandListeners) listener(snapshot)
}

function scheduleRunningCommandsNotify(): void {
  if (notifyScheduled) {
    trailingNotifyNeeded = true
    return
  }
  emitRunningCommandsSnapshot()
  notifyScheduled = setTimeout(() => {
    notifyScheduled = null
    if (trailingNotifyNeeded) {
      trailingNotifyNeeded = false
      emitRunningCommandsSnapshot()
    }
  }, RUNNING_COMMANDS_NOTIFY_THROTTLE_MS)
}

/** Subscribes to the live list of `git` command lines currently in flight (e.g. `git show
 *  HEAD:src/foo.ts`), deduplicated and throttled — see RUNNING_COMMANDS_NOTIFY_THROTTLE_MS. Callers
 *  post this straight through to the webview (DashboardPanel, standalone/server.ts) under a
 *  `runningGitCommands` message so it can render next to the outcome-resolving spinner. */
export function onRunningGitCommandsChanged(listener: (commands: string[]) => void): () => void {
  runningCommandListeners.add(listener)
  return () => { runningCommandListeners.delete(listener) }
}

/** Short, human-readable gloss for a git subcommand, shown ahead of the raw command line in the
 *  status bar so "what is TraceRoost doing to my repo right now" reads as plain English rather
 *  than requiring the viewer to parse git flags. Falls back to no gloss (just the raw command) for
 *  anything not covered here — every call site in this file is listed, so an unrecognized args[0]
 *  means a new call site was added without updating this list. */
function describeGitCommand(args: string[]): string | null {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'rev-parse':
      return rest.includes('--show-toplevel') ? 'Finding the repo root' : 'Resolving a commit for the trunk branch'
    case 'symbolic-ref':
      return 'Detecting the default branch'
    case 'show-ref':
      return 'Checking whether a candidate trunk branch exists'
    case 'log':
      return 'Finding the last commit that touched these files'
    case 'show':
      return 'Reading a file’s content as of a specific commit'
    default:
      return null
  }
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  const id = nextCommandId++
  const raw = `git ${args.join(' ')}`
  const gloss = describeGitCommand(args)
  runningCommands.set(id, `${cwd}: ${gloss ? `${gloss} — ${raw}` : raw}`)
  scheduleRunningCommandsNotify()
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  } finally {
    runningCommands.delete(id)
    scheduleRunningCommandsNotify()
  }
}

/** Exported for the background watcher (reconciliationService's Stage-2 caller), which needs to
 *  resolve a session's repo root once to decide which `.git` directory to watch — independent of
 *  classifySessionOutcome's per-file work. */
export async function findRepoRoot(workspace: string): Promise<string | null> {
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

// Cheap stand-in for "has this file's on-disk content changed" — a content hash rather than
// mtime, since mtime survives things that don't actually change bytes (a touch, a checkout that
// restores identical content) and can also be unreliable across some filesystems/clock skews. See
// staged feature 10: "do not rely on mtime alone for correctness."
function workingTreeContentDigest(root: string, relPaths: string[]): string {
  const hash = crypto.createHash('sha256')
  for (const relPath of relPaths) {
    const content = currentContentOnDisk(root, relPath)
    hash.update(relPath)
    hash.update('\0')
    hash.update(content === null ? '\0missing' : content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Resolves the repo root and a cache key for `filesChanged` — combining the latest commit sha
 *  touching any of those specific files, the trunk branch's current tip sha (if resolvable), and a
 *  content digest of those files' current working-tree state. Used to key the on-disk outcome
 *  cache (GitOutcomeRepository) so a restart doesn't force a rescan unless something relevant has
 *  actually moved: a new commit to *this session's own files*, the trunk branch advancing (which
 *  can flip a file from 'committed' to 'merged' without touching the file again locally — e.g. a
 *  human merges the PR later), or an uncommitted edit to those files' working-tree content.
 *  Deliberately scoped to those things rather than the repo's overall HEAD: keying on HEAD meant an
 *  unrelated commit anywhere else in the repo invalidated every other session's cached outcome at
 *  the same time, which read as a full reload rather than an isolated recompute.
 *
 *  The working-tree digest is what makes an edit-without-a-commit (an 'abandoned' file becoming a
 *  different 'abandoned' file, or a file staged back toward its committed content) invalidate the
 *  cache — the commit/trunk shas alone are silent about that, since no commit occurred. The file
 *  list itself is included too (via the digest's per-file structure and the relPaths this key is
 *  computed from), so a session whose changed-file set has grown or shrunk since it was last
 *  cached also invalidates rather than reusing a result computed for a different file set. Returns
 *  null if none of the files are inside the repo (mirrors classifySessionOutcome's own "nothing to
 *  classify" case, so nothing gets cached for it either). */
export async function resolveOutcomeCacheKey(workspace: string, filesChanged: string[]): Promise<{ root: string; cacheKey: string } | null> {
  const root = await findRepoRoot(workspace)
  if (!root) return null
  const relPaths = filesChanged
    .map(absPath => relativeToRoot(root, absPath))
    .filter((p): p is string => p !== null)
    .sort()
    .slice(0, MAX_FILES)
  if (relPaths.length === 0) return null

  const [fileSha, trunkRef] = await Promise.all([
    runGit(root, ['log', '-1', '--format=%H', '--', ...relPaths]),
    resolveTrunkRef(root),
  ])
  const trunkSha = trunkRef ? await runGit(root, ['rev-parse', trunkRef]) : null
  const workingDigest = workingTreeContentDigest(root, relPaths)
  return { root, cacheKey: `${fileSha?.trim() ?? ''}:${trunkSha?.trim() ?? ''}:${workingDigest}` }
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
