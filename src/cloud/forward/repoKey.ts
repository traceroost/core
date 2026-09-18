/**
 * The derived repository key (AL 02) — the mechanism that lets every member of a team produce
 * matching hashes without any secret being stored, distributed, or transmitted.
 *
 * ```
 * root        = git rev-list --max-parents=0 HEAD   (smallest, if several)
 * repo_key    = HKDF(ikm = root, salt = org_id, info = "traceroost/v1")
 *
 * repo_hash   = HMAC(repo_key, "repo")
 * branch_hash = HMAC(repo_key, "branch:" + branch)
 * file_hash   = HMAC(repo_key, <repo-relative posix path>)
 * commit_hash = HMAC(repo_key, <commit sha>)
 * repo_key_fp = HMAC(repo_key, "fingerprint")
 * author_hash = HMAC(repo_key, "author:" + <git author email, lowercased>)
 * ```
 *
 * `author_hash` (AL 04's commit-attribution fix, docs/decisions/0005 in `cloud`) is the same
 * primitive applied to a git author email instead of a path or SHA — because `repo_key` is
 * derivable by anyone with the repo cloned (not just the reporting machine), any client can
 * compute `author_hash` for a commit's author email *or* for its own linked member's email, and
 * the server can match the two without ever learning either email.
 *
 * The root commit SHA is content-addressed and byte-identical in every clone, and never leaves
 * the machine — a 30- or 90-day cohort never reaches back to a repository's first day. Mixing in
 * `org_id` (known to the service, useless without the root SHA) means two orgs on the same
 * repository produce different hashes, so nothing correlates across customers.
 *
 * Invariants this module enforces:
 * - `repo_key` is derived on demand and held only for the duration of a build. It is never
 *   written to disk, logged, or returned from any exported function.
 * - Paths are hashed repo-relative and POSIX-separated, so two checkouts at different locations
 *   agree.
 * - A shallow clone has no root commit; `deriveRepoKey` returns `null` and callers report
 *   without repository grouping rather than emitting hashes that silently match nothing.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 5000
// NEVER change this once a real team has linked a real repository — it's baked into every
// repo_key/repo_hash/repo_key_fp already derived, and changing it makes every existing repo
// look like a brand-new one to the service, silently discontinuing its cohort history.
const HKDF_INFO = 'traceroost/v1'

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

export interface RepoKeyContext {
  /** Repository root (absolute, git-resolved). */
  root: string
  /** The derived key. Opaque `Buffer`; never serialise it. */
  key: Buffer
}

export type RepoKeyResult =
  | { ok: true; ctx: RepoKeyContext }
  | { ok: false; reason: 'not-a-repo' | 'shallow-clone' | 'no-root-commit' }

/**
 * Derives the repository key for `workspace` under `orgId`. Returns a discriminated result: the
 * three failure modes (not a repo / shallow clone / genuinely rootless) are all reported, never
 * papered over with a hash that matches nothing.
 */
export async function deriveRepoKey(workspace: string, orgId: string): Promise<RepoKeyResult> {
  const topLevel = (await git(workspace, ['rev-parse', '--show-toplevel']))?.trim()
  if (!topLevel) return { ok: false, reason: 'not-a-repo' }

  // A shallow clone (`--depth`, most CI) cannot see its own first commit.
  const isShallow = (await git(topLevel, ['rev-parse', '--is-shallow-repository']))?.trim()
  if (isShallow === 'true') return { ok: false, reason: 'shallow-clone' }

  const root = smallestRootCommit(await git(topLevel, ['rev-list', '--max-parents=0', 'HEAD']))
  if (!root) return { ok: false, reason: 'no-root-commit' }

  const key = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(root, 'utf8'), Buffer.from(orgId, 'utf8'), Buffer.from(HKDF_INFO, 'utf8'), 32),
  )
  return { ok: true, ctx: { root: realpathBestEffort(topLevel), key } }
}

// `git rev-parse --show-toplevel` returns a fully-resolved path, but a workspace/file path from
// elsewhere may sit behind a symlink (notably macOS, where the tmpdir and often $HOME do). Match
// gitOutcome.ts and resolve both sides before comparing.
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

/** `git rev-list --max-parents=0` can return several roots (merged histories). Pick the
 *  lexicographically smallest so every clone agrees on one. */
function smallestRootCommit(raw: string | null): string | null {
  const roots = (raw ?? '').split('\n').map(l => l.trim()).filter(l => /^[0-9a-f]{40}$/.test(l))
  if (roots.length === 0) return null
  return roots.sort()[0]
}

function hmac(key: Buffer, message: string): string {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex')
}

export function repoHash(ctx: RepoKeyContext): string {
  return hmac(ctx.key, 'repo')
}

export function branchHash(ctx: RepoKeyContext, branch: string): string {
  return hmac(ctx.key, `branch:${branch}`)
}

export function commitHash(ctx: RepoKeyContext, sha: string): string {
  return hmac(ctx.key, sha.trim().toLowerCase())
}

/** Hashes a git author email — used both for a commit's `author_hash` (in buildCommitRecords.ts)
 *  and for a linked member's own `member_author_hash` (in buildSessionRollup.ts, from `git config
 *  user.email`). Same function either way: the server matches the two without ever learning
 *  either email. Lowercased/trimmed so case or whitespace differences between two clients'
 *  git configs don't produce two different hashes for the same person. */
export function authorHash(ctx: RepoKeyContext, email: string): string {
  return hmac(ctx.key, `author:${email.trim().toLowerCase()}`)
}

/** Fingerprint carried on every record so the service can flag a member whose history was
 *  rewritten (different root SHA → every hash differs) as a warning rather than showing two
 *  ghost copies of the same file. */
export function repoKeyFingerprint(ctx: RepoKeyContext): string {
  return hmac(ctx.key, 'fingerprint')
}

/**
 * Hashes a file path. `p` may be absolute or relative, with either separator and a leading
 * `./`; it is normalised to a repo-relative POSIX path first, so two developers with different
 * checkout locations produce the same hash. Returns `null` for a path outside the repo.
 */
export function fileHash(ctx: RepoKeyContext, p: string): string | null {
  const rel = toRepoRelativePosix(ctx.root, p)
  return rel === null ? null : hmac(ctx.key, rel)
}

export function toRepoRelativePosix(root: string, p: string): string | null {
  const resolvedRoot = realpathBestEffort(root)
  const abs = realpathBestEffort(path.isAbsolute(p) ? p : path.resolve(resolvedRoot, p))
  let rel = path.relative(resolvedRoot, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  rel = rel.split(path.sep).join('/')
  // Collapse a redundant leading "./" and any "//".
  rel = rel.replace(/^\.\//, '').replace(/\/{2,}/g, '/')
  return rel
}
