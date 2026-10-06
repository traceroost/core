/**
 * Session-outcome correlation with git — did a session's file changes survive, and did they make
 * it all the way to the shared trunk branch?
 *
 * Local git only, on-demand (called per session when its detail view is opened, not eagerly for
 * every loaded session: each classification is several git subprocesses, and a history of thousands
 * of sessions would make activation and every refresh a git storm). Classifies
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
import { recordAction, onRunningActionsChanged } from './actionLog'

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

/** Subscribes to the live list of command lines currently in flight (e.g. `git show
 *  HEAD:src/foo.ts`) — now backed by actionLog.ts's generalized tracker (action-log.md), which
 *  every shell-out call site routes through, not just this file's own `runGit`. Callers post this
 *  straight through to the webview (DashboardPanel, standalone/server.ts) under a
 *  `runningGitCommands` message so it can render next to the outcome-resolving spinner. Kept as a
 *  re-export under its original name so existing call sites don't need to change their import. */
export const onRunningGitCommandsChanged = onRunningActionsChanged

/** Short, human-readable gloss for a git subcommand, shown ahead of the raw command line in the
 *  status bar so "what is TraceRoost doing to my repo right now" reads as plain English rather
 *  than requiring the viewer to parse git flags. Falls back to no gloss (just the raw command) for
 *  anything not covered here — every call site in this file is listed, so an unrecognized args[0]
 *  means a new call site was added without updating this list. */
function describeGitCommand(args: string[]): string | null {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'rev-parse':
      if (rest.includes('--show-toplevel')) return 'Finding the repo root'
      return rest.includes('HEAD') ? 'Resolving the current commit and the trunk branch tip' : 'Resolving a commit for the trunk branch'
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

const GIT_MAX_BUFFER = 10 * 1024 * 1024

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  return (await runGitDetailed(cwd, args)).stdout
}

/** runGit, also saying whether a failure was only the output exceeding GIT_MAX_BUFFER (a file too
 *  large to read back through `git show`) rather than git itself failing. */
async function runGitDetailed(cwd: string, args: string[]): Promise<{ stdout: string | null; tooLarge: boolean }> {
  const raw = `git ${args.join(' ')}`
  const gloss = describeGitCommand(args)
  try {
    const stdout = await recordAction(cwd, gloss, raw, async () => {
      const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })
      return stdout
    })
    return { stdout, tooLarge: false }
  } catch (err) {
    return { stdout: null, tooLarge: (err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }
  }
}

/** Exported for the background watcher (reconciliationService's Stage-2 caller), which needs to
 *  resolve a session's repo root once to decide which `.git` directory to watch — independent of
 *  classifySessionOutcome's per-file work. */
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
 * created, same as the uncached path. (Introduced when a reconcile over a long history was found
 * to re-resolve the same repo's trunk ref once per session — see CLOUD_ARCHITECTURE.md's "Check
 * for unsent traces".)
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
// Live reconciliation's contract: "do not rely on mtime alone for correctness."
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

/** HEAD and trunk-tip shas of one repo root, as read at one moment. */
export interface RepoTips {
  head: string | null
  trunk: string | null
}

/**
 * Pass-scoped memo of each repo root's HEAD and trunk-tip shas — read once per root per
 * reconcile pass rather than once per session (a `git rev-parse <trunk>` per session was half of
 * a warm startup pass's git spawns). Create one per pass and drop it afterwards: nothing here
 * notices HEAD or the trunk moving, which is what `refresh()` (the generation check, the end-of-
 * pass recheck) and the next pass's fresh snapshot are for.
 */
export interface RepoTipsSnapshot {
  tips(root: string, trunkRef: string | null): Promise<RepoTips>
  /** Re-reads `root`'s tips now and makes that the memoized value for the rest of the pass. */
  refresh(root: string, trunkRef: string | null): Promise<RepoTips>
  /** Every root read so far: whether a refresh() already saw its tips move this pass, and whether
   *  `current` (a live read taken after the pass) differs from any value handed out during it. */
  movedRoots(current: (root: string) => Promise<RepoTips>): Promise<Set<string>>
}

function sameTips(a: RepoTips, b: RepoTips): boolean {
  return a.head === b.head && a.trunk === b.trunk
}

export function createRepoTipsSnapshot(): RepoTipsSnapshot {
  const memo = new Map<string, Promise<RepoTips>>()
  const moved = new Set<string>()
  const refreshChecks: Array<Promise<void>> = []
  return {
    tips(root, trunkRef) {
      let p = memo.get(root)
      if (!p) { p = readRepoTips(root, trunkRef); memo.set(root, p) }
      return p
    },
    refresh(root, trunkRef) {
      const before = memo.get(root)
      const p = readRepoTips(root, trunkRef)
      memo.set(root, p)
      if (before) refreshChecks.push(Promise.all([before, p]).then(([a, b]) => { if (!sameTips(a, b)) moved.add(root) }))
      return p
    },
    async movedRoots(current) {
      await Promise.all(refreshChecks)
      const result = new Set<string>()
      for (const [root, p] of memo) {
        if (moved.has(root) || !sameTips(await p, await current(root))) result.add(root)
      }
      return result
    },
  }
}

/** Live read of HEAD's sha and `trunkRef`'s sha — one `git rev-parse` for both in the usual case.
 *  `trunk` is exactly what resolveOutcomeCacheKey's uncached path reads (`git rev-parse <trunkRef>`,
 *  trimmed). `head` is null when HEAD doesn't resolve (an unborn branch). */
export async function readRepoTips(root: string, trunkRef: string | null): Promise<RepoTips> {
  const both = await runGit(root, trunkRef ? ['rev-parse', 'HEAD', trunkRef] : ['rev-parse', 'HEAD'])
  if (both !== null) {
    const [head, trunk] = both.split('\n').map(line => line.trim())
    return { head: head || null, trunk: trunkRef ? trunk || null : null }
  }
  // One of the two failed (an unborn HEAD, or the trunk ref vanished) — read each on its own.
  const [head, trunk] = await Promise.all([
    runGit(root, ['rev-parse', 'HEAD']),
    trunkRef ? runGit(root, ['rev-parse', trunkRef]) : Promise.resolve(null),
  ])
  return { head: head?.trim() || null, trunk: trunk?.trim() || null }
}

/** What a session's cache key was built from — persisted per session (OutcomeKeyRepository) so the
 *  next pass can skip `git log` when none of the inputs to `fileSha` moved. */
export interface OutcomeCacheKeyParts {
  root: string
  cacheKey: string
  /** HEAD sha `fileSha` was computed at; null when it wasn't pinned to a known HEAD (no snapshot,
   *  or HEAD didn't resolve) — such a key is never reused. */
  headSha: string | null
  trunkSha: string
  relPathsHash: string
  fileSha: string
}

export interface OutcomeCacheKeyOptions {
  /** Read HEAD/trunk tips from this pass-scoped snapshot instead of once per call. */
  snapshot: RepoTipsSnapshot
  /** Re-read this root's tips first (and update the snapshot) — the generation check's read. */
  fresh?: boolean
  /** A previously computed key for this session: its `fileSha` is reused, with no `git log`, when
   *  it was computed in the same repo root at the same HEAD for the same file list. */
  prior?: Pick<OutcomeCacheKeyParts, 'root' | 'headSha' | 'relPathsHash' | 'fileSha'>
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
 *  classify" case, so nothing gets cached for it either).
 *
 *  With `opts` (a reconcile pass), HEAD and the trunk tip come from the pass's snapshot, and the
 *  file sha is `git log -1 <HEAD sha> -- <files>` — a pure function of that HEAD commit and the
 *  file list, so `opts.prior`'s value is reused as-is when both match. The working-tree digest is
 *  never reused: it's recomputed from disk on every call (no subprocess), so an uncommitted edit
 *  is noticed exactly as without a snapshot. */
export async function resolveOutcomeCacheKey(workspace: string, filesChanged: string[], cache?: OutcomeRepoCache, opts?: OutcomeCacheKeyOptions): Promise<OutcomeCacheKeyParts | null> {
  // `cache` memoizes only which repo and which trunk branch (as classifySessionOutcome's does) —
  // the file and trunk-tip shas below are always read fresh (or, with `opts`, once per pass), so
  // the key still moves on a commit.
  const root = cache ? await cache.root(workspace) : await findRepoRoot(workspace)
  if (!root) return null
  const relPaths = filesChanged
    .map(absPath => relativeToRoot(root, absPath))
    .filter((p): p is string => p !== null)
    .sort()
    .slice(0, MAX_FILES)
  if (relPaths.length === 0) return null
  const relPathsHash = crypto.createHash('sha256').update(relPaths.join('\0')).digest('hex')

  let headSha: string | null = null
  let fileSha: string
  let trunkSha: string
  if (opts) {
    const trunkRef = cache ? await cache.trunkRef(root) : await resolveTrunkRef(root)
    const tips = await (opts.fresh ? opts.snapshot.refresh(root, trunkRef) : opts.snapshot.tips(root, trunkRef))
    headSha = tips.head
    trunkSha = tips.trunk ?? ''
    const prior = opts.prior
    if (headSha && prior && prior.headSha === headSha && prior.root === root && prior.relPathsHash === relPathsHash) {
      fileSha = prior.fileSha
    } else {
      const out = await runGit(root, headSha ? ['log', '-1', '--format=%H', headSha, '--', ...relPaths] : ['log', '-1', '--format=%H', '--', ...relPaths])
      fileSha = out?.trim() ?? ''
    }
  } else {
    const [fileOut, trunkRef] = await Promise.all([
      runGit(root, ['log', '-1', '--format=%H', '--', ...relPaths]),
      cache ? cache.trunkRef(root) : resolveTrunkRef(root),
    ])
    const trunkOut = trunkRef ? await runGit(root, ['rev-parse', trunkRef]) : null
    fileSha = fileOut?.trim() ?? ''
    trunkSha = trunkOut?.trim() ?? ''
  }
  const workingDigest = workingTreeContentDigest(root, relPaths)
  return { root, cacheKey: `${fileSha}:${trunkSha}:${workingDigest}`, headSha, trunkSha, relPathsHash, fileSha }
}

// Resolves symlinks where possible so paths compare consistently — `git rev-parse --show-toplevel`
// always returns a fully-resolved path, but a workspace/file path from elsewhere may not (notably
// macOS, where the default tmpdir and often the home directory sit behind a symlink).
// Uses the native realpath: on Windows it also expands 8.3 short names (`C:\Users\RUNNER~1\…`,
// what os.tmpdir() often returns) to the long form git reports, which the JS implementation
// leaves as-is. A path that doesn't exist (a deleted file) resolves its nearest existing ancestor.
function realpathBestEffort(p: string): string {
  const abs = path.resolve(p)
  const rest: string[] = []
  for (let dir = abs; ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest)
    } catch {
      if (path.dirname(dir) === dir) return abs
      rest.unshift(path.basename(dir))
    }
  }
}

// git-for-windows' `rev-parse --show-toplevel` (findRepoRoot) reports its drive letter lowercase
// (an MSYS convention), while a path built from Node's own os/path APIs keeps whatever case the
// OS gave it (typically uppercase) -- path.relative is a pure string operation and treats `c:`
// and `C:` as different drives, so every file looks "outside the repo" until this is normalized.
// Only the drive-letter prefix is touched; the rest of the path keeps its real casing, since git
// tree lookups (`git show HEAD:<relPath>`) are case-sensitive even on a case-insensitive filesystem.
function normalizeDriveLetter(p: string): string {
  return /^[a-zA-Z]:[\\/]/.test(p) ? p[0].toLowerCase() + p.slice(1) : p
}

// Relative path (posix separators) of `absPath` under `root`, or null if outside the repo.
function relativeToRoot(root: string, absPath: string): string | null {
  const rel = path.relative(
    normalizeDriveLetter(realpathBestEffort(root)),
    normalizeDriveLetter(realpathBestEffort(absPath)),
  )
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

// Git blobs are usually stored with LF endings while a Windows checkout (core.autocrlf) has CRLF
// on disk — compare line-ending-insensitively, or every committed file there reads as modified.
function normalizeEol(content: string | null): string | null {
  return content === null ? null : content.replace(/\r\n/g, '\n')
}

async function classifyFile(root: string, relPath: string, trunkRef: string | null): Promise<FileOutcome> {
  const onDisk = normalizeEol(currentContentOnDisk(root, relPath))
  const head = await runGitDetailed(root, ['show', 'HEAD:' + relPath])
  // Too large to read back from git: we can't tell whether it's committed, which is not evidence
  // that it was abandoned.
  if (head.tooLarge) return 'ambiguous'
  const headContent = normalizeEol(head.stdout)
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
  const trunkContent = normalizeEol(await runGit(root, ['show', trunkRef + ':' + relPath]))
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

interface FileRepoGroup {
  root: string
  trunkRef: string | null
  files: Array<{ absPath: string; relPath: string }>
}

/** Groups `filesChanged` by the repo each one actually lives in.
 *
 *  With a `workspace` (the common case — a session that ran with one cwd), every file is
 *  resolved against that single root, exactly as before this function existed: one `findRepoRoot`
 *  call, one trunk lookup, files outside it dropped. Returns at most one group.
 *
 *  Without one — a session whose `filesChanged` spans more than one repo has no single cwd to
 *  report, so `workspace` comes back `''` (see spanSummarizer.ts) — each file's own containing
 *  repo is discovered independently (`findRepoRoot` from that file's own directory) and grouped by
 *  it, so a multi-repo session still gets classified instead of being dropped outright just
 *  because there's no one shared root to hang it on. A file with no discoverable repo at all
 *  (moved, deleted along with its directory, or genuinely outside git) is silently excluded, the
 *  same as "outside the repo" already is in the single-workspace case. */
async function resolveFileRepoGroups(
  workspace: string, filesChanged: string[], cache?: OutcomeRepoCache,
): Promise<FileRepoGroup[]> {
  if (workspace) {
    if (!fs.existsSync(workspace)) return []
    const root = cache ? await cache.root(workspace) : await findRepoRoot(workspace)
    if (!root) return []
    const files = filesChanged
      .map((absPath): [string, string | null] => [absPath, relativeToRoot(root, absPath)])
      .filter((pair): pair is [string, string] => pair[1] !== null)
      .map(([absPath, relPath]) => ({ absPath, relPath }))
    if (files.length === 0) return []
    const trunkRef = cache ? await cache.trunkRef(root) : await resolveTrunkRef(root)
    return [{ root, trunkRef, files }]
  }

  const withRoots = await Promise.all(
    filesChanged.map(async absPath => ({
      absPath,
      root: cache ? await cache.root(path.dirname(absPath)) : await findRepoRoot(path.dirname(absPath)),
    })),
  )
  const byRoot = new Map<string, string[]>()
  for (const { absPath, root } of withRoots) {
    if (!root) continue
    const list = byRoot.get(root)
    if (list) list.push(absPath)
    else byRoot.set(root, [absPath])
  }

  const groups: FileRepoGroup[] = []
  for (const [root, absPaths] of byRoot) {
    const files = absPaths
      .map((absPath): [string, string | null] => [absPath, relativeToRoot(root, absPath)])
      .filter((pair): pair is [string, string] => pair[1] !== null)
      .map(([absPath, relPath]) => ({ absPath, relPath }))
    if (files.length === 0) continue
    const trunkRef = cache ? await cache.trunkRef(root) : await resolveTrunkRef(root)
    groups.push({ root, trunkRef, files })
  }
  return groups
}

/**
 * Returns null (rather than an "ambiguous" result) when there's nothing meaningful to classify —
 * no changed files, no discoverable repo for any of them, or every changed file falls outside the
 * repo(s) it's in. Callers should treat null as "not applicable," distinct from a
 * computed-but-inconclusive result.
 */
export async function classifySessionOutcome(workspace: string, filesChanged: string[], cache?: OutcomeRepoCache): Promise<GitOutcome | null> {
  if (filesChanged.length === 0) return null

  const groups = await resolveFileRepoGroups(workspace, filesChanged, cache)
  if (groups.length === 0) return null

  const allFiles = groups.flatMap(g => g.files.map(f => ({ ...f, root: g.root, trunkRef: g.trunkRef })))

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
      allFiles.slice(0, MAX_FILES).map(async ({ absPath, relPath, root, trunkRef }): Promise<[string, FileOutcome]> =>
        [absPath, await classifyFile(root, relPath, trunkRef)]
      )
    )
    files = Object.fromEntries(entries)
  } finally {
    releaseSessionClassificationSlot()
  }

  const values = Object.values(files)
  const overall = OUTCOME_PRIORITY.find(p => values.includes(p)) ?? 'ambiguous'
  // A multi-repo result has no single trunk to name in the summary — summarize() falls back to
  // the generic "the trunk branch" phrasing (trunkDisplayName(null)) rather than picking one of
  // several arbitrarily.
  const trunkRef = groups.length === 1 ? groups[0].trunkRef : null

  return { overall, files, reason: summarize(overall, files, trunkRef) }
}
