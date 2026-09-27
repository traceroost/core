/**
 * Resolves a `--repo <hash|name>` argument to a local repository root — shared by `patterns`,
 * `find` and `cohort`.
 *
 * A human-typed name/substring is matched against known session workspaces (falling back to the
 * cwd) entirely locally. A 64-hex `repo_hash` is different: it's the one-way hash TraceRoost Cloud
 * shows for a repository, and turning it back into a path means re-deriving the org-salted key
 * from each candidate clone (`src/cloud/org/resolveRepoHash.ts`). That half is cloud code, so it
 * arrives here as an optional `resolveHash` callback — without one (the core edition, or any
 * caller that doesn't pass it), a hash simply resolves to nothing. Never an oracle either way: an
 * unknown hash yields null, and nothing is ever requested from anywhere.
 */

import * as path from 'path'
import { repoRootOf } from '../../src/attribution/commitScan'

/** Turns a cloud `repo_hash` back into a local repo root, or null — see this file's header. */
export type RepoHashResolver = (repoHashHex: string, candidateWorkspaces: string[]) => Promise<string | null>

export const REPO_HASH_RE = /^[a-f0-9]{64}$/

export async function resolveRepoArg(
  repoArg: string,
  sessionWorkspaces: string[],
  resolveHash?: RepoHashResolver,
): Promise<string | null> {
  if (REPO_HASH_RE.test(repoArg)) return resolveHash ? resolveHash(repoArg, sessionWorkspaces) : null
  // A name: match a session workspace whose path contains it, then resolve to the repo root.
  const match = sessionWorkspaces.find(w => w.toLowerCase().includes(repoArg.toLowerCase()))
  if (match) return repoRootOf(match.replace(/^file:\/\//, ''))
  // Or the cwd if it looks right.
  const cwdRoot = await repoRootOf(process.cwd())
  if (cwdRoot && path.basename(cwdRoot).toLowerCase() === repoArg.toLowerCase()) return cwdRoot
  return null
}
