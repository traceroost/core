/**
 * "Still present" (AL 06): a line survives if `git blame` at the measurement commit attributes it
 * to one of the cohort's commits. A moved or copied line survives, and so does a line whose only
 * change was whitespace (blame runs with `-w -M -C`); an edited line does not — an edited line is
 * rework, which is the intended reading.
 *
 * Two entry points:
 *   - `survivalAt` — survival at a specific commit (a cohort's window end), blaming only the files
 *     the cohort touched. This is what turnover is measured with.
 *   - `buildSurvivalIndex` — one blame per file currently in `HEAD`, bucketed by originating
 *     commit, with a per-file cache. Survival-to-date at HEAD.
 * Blame content stays in memory; only counts are persisted.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 15_000
const MAX_FILES = 4000
const MAX_BUFFER = 128 * 1024 * 1024

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout, maxBuffer: MAX_BUFFER })
    return stdout
  } catch {
    return null
  }
}

export interface SurvivalIndex {
  /** originating commit SHA → number of its lines still present in HEAD. */
  bySha: Map<string, number>
  /** HEAD SHA the index was computed at — persisted so a recompute is skipped when HEAD hasn't moved. */
  headSha: string
  filesBlamed: number
}

/** Per-file blame cache — a file is only re-blamed when its blob sha (content) has changed since
 *  the last call, instead of every file in the tree on every recompute. See
 *  `database/fileBlameRepository.ts` for the SQLite-backed implementation. */
export interface FileBlameCache {
  get(filePath: string): { blobSha: string; origins: Record<string, number> } | undefined
  put(filePath: string, blobSha: string, origins: Record<string, number>): void
  /** Drops rows for files no longer present at HEAD (renamed/deleted). */
  pruneExcept(filePaths: string[]): void
}

/** `-w` ignores whitespace-only changes, `-M` follows lines moved within a file, `-C` follows lines
 *  moved/copied from other files changed in the same commit — a reindent or a moved function is
 *  not churn. */
const BLAME_FLAGS = ['--line-porcelain', '-w', '-M', '-C']

function parseOrigins(blameOutput: string): Record<string, number> {
  const origins: Record<string, number> = {}
  for (const line of blameOutput.split('\n')) {
    const m = line.match(/^([0-9a-f]{40}) \d+ \d+/)
    if (m) origins[m[1]] = (origins[m[1]] ?? 0) + 1
  }
  return origins
}

/** `git ls-tree -r HEAD -z` output is `<mode> <type> <blob-sha>\t<path>\0...` — one call gives
 *  every file's current blob sha for free, which is exactly the cache key a per-file blame cache
 *  needs, with no extra git process over the plain file listing this replaced. */
function parseLsTree(output: string): Array<{ path: string; blobSha: string }> {
  const out: Array<{ path: string; blobSha: string }> = []
  for (const entry of output.split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    if (tab === -1) continue
    const meta = entry.slice(0, tab).split(' ')
    const blobSha = meta[2]
    const path = entry.slice(tab + 1)
    if (blobSha && path) out.push({ path, blobSha })
  }
  return out
}

export async function buildSurvivalIndex(
  repoRoot: string,
  cache?: FileBlameCache,
  onProgress?: (blamed: number, total: number) => void,
): Promise<SurvivalIndex | null> {
  const headSha = (await git(repoRoot, ['rev-parse', 'HEAD']))?.trim()
  if (!headSha) return null

  const listing = await git(repoRoot, ['ls-tree', '-r', '-z', 'HEAD'])
  if (listing === null) return null
  const entries = parseLsTree(listing).slice(0, MAX_FILES)

  const bySha = new Map<string, number>()
  let filesBlamed = 0
  const currentPaths: string[] = []

  for (let i = 0; i < entries.length; i++) {
    const { path: file, blobSha } = entries[i]
    currentPaths.push(file)

    const cached = cache?.get(file)
    let origins: Record<string, number>
    if (cached && cached.blobSha === blobSha) {
      origins = cached.origins
    } else {
      const out = await git(repoRoot, ['blame', ...BLAME_FLAGS, 'HEAD', '--', file], 10_000)
      if (out === null) { onProgress?.(i + 1, entries.length); continue }
      filesBlamed++
      origins = parseOrigins(out)
      cache?.put(file, blobSha, origins)
    }
    for (const [sha, count] of Object.entries(origins)) {
      bySha.set(sha, (bySha.get(sha) ?? 0) + count)
    }
    onProgress?.(i + 1, entries.length)
  }

  cache?.pruneExcept(currentPaths)
  return { bySha, headSha, filesBlamed }
}

/** Estimated AI-authored lines from `commit` still present in HEAD. We know how many of the
 *  commit's lines survive, and what fraction were AI-authored, but not which specific lines —
 *  so this is proportional, which is more honest than a floor. */
export function survivingAiLines(
  index: SurvivalIndex,
  commit: { sha: string; aiLines: number; linesAdded: number },
): number {
  const surviving = index.bySha.get(commit.sha) ?? 0
  if (surviving === 0 || commit.aiLines === 0) return 0
  const aiFraction = commit.linesAdded > 0 ? commit.aiLines / commit.linesAdded : 1
  return Math.min(commit.aiLines, Math.round(surviving * aiFraction))
}

/** Blame one file at one commit — memoized by `<commit>:<path>` for the life of `memo`, since a
 *  blame at a fixed commit never changes. */
async function blameAt(repoRoot: string, at: string, file: string, memo?: Map<string, Record<string, number> | null>): Promise<Record<string, number> | null> {
  const key = `${at}:${file}`
  if (memo?.has(key)) return memo.get(key) ?? null
  const out = await git(repoRoot, ['blame', ...BLAME_FLAGS, at, '--', file], 10_000)
  const origins = out === null ? null : parseOrigins(out)
  memo?.set(key, origins)
  return origins
}

/** Lines each of `shas` still has at commit `at`, found by blaming `files` (repo-relative paths as
 *  they exist at `at`) there. Files absent at `at` contribute nothing — their lines are gone. */
export async function survivalAt(
  repoRoot: string,
  at: string,
  files: Iterable<string>,
  shas: Set<string>,
  memo?: Map<string, Record<string, number> | null>,
): Promise<Map<string, number>> {
  const bySha = new Map<string, number>()
  for (const file of new Set(files)) {
    const origins = await blameAt(repoRoot, at, file, memo)
    if (!origins) continue
    for (const [sha, count] of Object.entries(origins)) {
      if (shas.has(sha)) bySha.set(sha, (bySha.get(sha) ?? 0) + count)
    }
  }
  return bySha
}
