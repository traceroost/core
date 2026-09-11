/**
 * Local hash → path resolution for the hand-off (AL 09).
 *
 * The hosted service holds a `repo_hash` and never learns a name. When a lead clicks "show me an
 * example" the service hands over that hash, and this resolves it — but only for repositories
 * that are actually on this machine. It is **not an oracle**: an unknown hash yields "not a
 * repository on this machine", never a probe of any kind, and no network call ever results from
 * a deep link.
 */

import { deriveRepoKey, repoHash as computeRepoHash } from '../forward/repoKey'
import { loadCredentials } from './credentials'

/** Candidate local roots, derived from a caller-supplied list of workspace paths (session
 *  workspaces, open folders). Returns the matching absolute repo root, or null. */
export async function resolveRepoHash(repoHashHex: string, candidateWorkspaces: string[]): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(repoHashHex)) return null
  const orgId = loadCredentials()?.orgId ?? 'unlinked-preview'
  const seen = new Set<string>()
  for (const raw of candidateWorkspaces) {
    const p = raw.replace(/^file:\/\//, '')
    if (seen.has(p)) continue
    seen.add(p)
    const rk = await deriveRepoKey(p, orgId)
    if (rk.ok && computeRepoHash(rk.ctx) === repoHashHex) return rk.ctx.root
  }
  return null
}
