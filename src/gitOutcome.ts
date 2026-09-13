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

// Is there a commit touching `relPath` at or after `sinceIso`?
async function hasCommitSince(root: string, relPath: string, sinceIso: string): Promise<boolean> {
  const out = await runGit(root, ['log', '--format=%H', '--since=' + sinceIso, '--', relPath])
  return Boolean(out?.trim())
}

async function classifyFile(root: string, relPath: string, sessionStartIso: string, sessionEndIso: string): Promise<FileOutcome> {
  const onDisk = currentContentOnDisk(root, relPath)
  const after = onDisk !== null ? onDisk : await runGit(root, ['show', 'HEAD:' + relPath])
  if (after === null) return 'ambiguous' // deleted, moved, or never committed and gone

  // These two don't depend on each other's result — run concurrently rather than
  // paying for two sequential git subprocess round-trips per file. hasCommitSince
  // ends up unused in the 'reverted' case, but that wastes a little CPU, not latency.
  const [before, committedSince] = await Promise.all([
    contentBeforeSession(root, relPath, sessionStartIso),
    hasCommitSince(root, relPath, sessionEndIso),
  ])
  if (before !== null && before === after) return 'reverted' // net no-op vs. pre-session state

  return committedSince ? 'productive' : 'abandoned'
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
 * no workspace, no changed files, the workspace path doesn't exist, or it isn't a git repo at all.
 * Callers should treat null as "not applicable," distinct from a computed-but-inconclusive result.
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
  const sessionEndIso = endTime || startTime
  if (!sessionStartIso) return null

  // Each file's classification is independent — run them concurrently rather than
  // one at a time. This is the dominant cost of the whole function (each file spawns
  // up to two more git subprocesses on top of this), so serializing it was the main
  // source of visible delay on sessions with more than a handful of changed files.
  const entries = await Promise.all(
    filesChanged.slice(0, MAX_FILES).map(async (absPath): Promise<[string, FileOutcome]> => {
      const rel = relativeToRoot(root, absPath)
      if (!rel) return [absPath, 'ambiguous']
      return [absPath, await classifyFile(root, rel, sessionStartIso, sessionEndIso)]
    })
  )
  const files: Record<string, FileOutcome> = Object.fromEntries(entries)

  const values = Object.values(files)
  const overall = OUTCOME_PRIORITY.find(p => values.includes(p)) ?? 'ambiguous'

  return { overall, files, reason: summarize(overall, files) }
}
