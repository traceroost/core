/**
 * Local-only GitHub URL lookup for a workspace's repo — shown in the Sessions table's repo-column
 * hover tooltip so a session can be traced back to its GitHub repo at a glance. Never sent to
 * traceroost-cloud or anywhere else (see repoKey.ts's privacy invariants — this file has none of
 * those constraints precisely because its output never leaves the machine).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 5000

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS })
    return stdout
  } catch {
    return null
  }
}

// git@github.com:owner/repo.git, ssh://git@github.com/owner/repo.git, git://github.com/owner/repo.git,
// https://github.com/owner/repo(.git)? — anything else (GitLab, Bitbucket, a bare local path, no
// remote at all) has no GitHub URL to show, so this returns null rather than a wrong guess.
function normalizeGithubUrl(url: string): string | null {
  const patterns = [
    /^git@github\.com:(.+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?$/,
    /^git:\/\/github\.com\/(.+?)(?:\.git)?$/,
    /^https?:\/\/github\.com\/(.+?)(?:\.git)?$/,
  ]
  for (const re of patterns) {
    const m = url.match(re)
    if (m) return `https://github.com/${m[1]}`
  }
  return null
}

/** Resolves `workspace`'s `origin` remote to a GitHub URL, or null if it has no remote, isn't a
 *  git repo, or its remote isn't on github.com. `workspace` may be any subdirectory of the repo —
 *  git resolves `config` against the repo root regardless of cwd. */
export async function resolveGithubUrl(workspace: string): Promise<string | null> {
  const out = await git(workspace, ['config', '--get', 'remote.origin.url'])
  const url = out?.trim()
  if (!url) return null
  return normalizeGithubUrl(url)
}
