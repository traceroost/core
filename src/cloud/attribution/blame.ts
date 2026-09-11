/**
 * Per-commit line attribution (AL 05).
 *
 * For a set of agent-touched files, counts how many lines a given commit *introduced* (i.e.
 * `git blame` at that commit attributes to that commit). Fan-out is capped the way
 * `gitOutcome.ts` caps it — a repository with a 10,000-line generated file must not hang the
 * report.
 *
 * Blame output is line content; it stays in memory and is never written to the local database
 * or a log.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 10_000
const MAX_FILES = 40
const MAX_BLAME_BYTES = 16 * 1024 * 1024

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BLAME_BYTES })
    return stdout
  } catch {
    return null
  }
}

/**
 * Counts lines in `files` (repo-relative POSIX paths) that `git blame <sha>` attributes to
 * `sha` itself — the lines this commit introduced that are still part of the file as of that
 * commit. Renamed files are out of scope for v1 (their lines fall to `unknown`).
 */
export async function countLinesIntroducedByCommit(
  repoRoot: string,
  sha: string,
  files: string[],
): Promise<number> {
  let total = 0
  for (const file of files.slice(0, MAX_FILES)) {
    const out = await git(repoRoot, ['blame', '--line-porcelain', sha, '--', file])
    if (!out) continue
    for (const line of out.split('\n')) {
      // A porcelain record's first line is "<40-hex> <orig-line> <final-line> [group-size]".
      const m = line.match(/^([0-9a-f]{40}) \d+ \d+/)
      if (m && m[1] === sha) total++
    }
  }
  return total
}
