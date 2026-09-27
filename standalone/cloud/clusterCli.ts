/**
 * `traceroost cluster --repo <hash> --id <id>` (AL 08) — Pro only: asks the linked org's service
 * which sessions make up a Repeat work cluster, then matches them against this machine's
 * recorded sessions.
 */

import { loadCredentials } from '../../src/cloud/org/credentials'
import { fetchClusterResolution, matchLocalSessions } from '../../src/cloud/org/clusterResolve'
import { loadAllSessions } from '../local/sessionLoader'

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

/**
 * Resolves a Repeat work cluster's hand-off command into real local sessions. Cloud can identify a
 * cluster (same repo, overlapping files, similar tools, crossing people) but never say what it's
 * about — no filename or prompt ever reached it. This machine is the one place that can, for
 * whichever of the cluster's sessions actually happened here.
 */
export async function runClusterCli(args: string[]): Promise<number> {
  const repo = valueAfter(args, '--repo')
  const id = valueAfter(args, '--id')
  if (!repo || !id) {
    console.log(
      `Usage: traceroost cluster --repo <hash> --id <id>\n` +
      `  repo: ${repo ?? '(missing --repo)'}\n  cluster: ${id ?? '(missing --id)'}`,
    )
    return 1
  }

  if (!loadCredentials()) {
    console.log('Not linked to an org — nothing to resolve. Run `traceroost org link` first.')
    return 1
  }

  const resolution = await fetchClusterResolution(repo, id)
  if (!resolution) {
    console.log("Couldn't reach the cloud service to resolve this cluster — check your connection and try again.")
    return 1
  }
  if (resolution.sessionIds.length === 0) {
    console.log('No sessions found for this cluster — it may have aged out or already dissolved.')
    return 1
  }

  const { matched, unmatchedCount } = matchLocalSessions(resolution, loadAllSessions())
  console.log(
    `\n${resolution.sessions} sessions · ${resolution.members} people · ${resolution.files} files` +
    (resolution.topTools.length ? ` · tools: ${resolution.topTools.join(' → ')}` : '') + '\n',
  )

  if (matched.length === 0) {
    console.log(`None of this cluster's ${resolution.sessionIds.length} session(s) are on this machine — try a machine that worked on this repo.`)
    return 1
  }

  console.log(`Found ${matched.length} of ${resolution.sessionIds.length} session(s) on this machine:\n`)
  for (const s of matched) {
    console.log(`  ${s.startTime}  ${s.workspace}`)
    console.log(`    "${s.userRequest.slice(0, 100)}"`)
    if (s.filesChanged.length > 0) {
      const shown = s.filesChanged.slice(0, 5).join(', ')
      console.log(`    files: ${shown}${s.filesChanged.length > 5 ? ', …' : ''}`)
    }
  }
  if (unmatchedCount > 0) {
    console.log(`\n${unmatchedCount} more session(s) in this cluster are on other machines.`)
  }
  return 0
}
