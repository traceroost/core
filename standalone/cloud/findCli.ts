/**
 * `traceroost find <repo hash | trace/session id> [--reporter <email>]` — the one local hand-off
 * command the cloud dashboard's HashHandoff points every hash/id at (verb="find"). Cloud never
 * knows which kind of value it's handing back — a repo_hash is a one-way hash, a session id is
 * the raw column — so this takes either, tells them apart locally, and delegates to whichever of
 * patternsCli.ts (repo) / traceCli.ts (trace) actually matches. One command to remember instead
 * of two, and nothing to get wrong by picking the "wrong" one.
 *
 * Ends with a `vscode://` deep link (see extension.ts's registerUriHandler, kind="find") rather
 * than trying to find and open a running server itself — that guessed at ports and only ever
 * reached a server on this same machine anyway, which a plain terminal printout already answers
 * for. The link is a bonus for anyone with the VS Code extension: click it and the same hash
 * resolves again there, straight into the interactive Sessions/Advisor view.
 */

import { loadAllSessions } from './sessionLoader'
import { runPatternsCli } from './patternsCli'
import { runTraceCli, findSessionById } from './traceCli'
import type { SessionSummaryCard } from '../../src/summarizers/summarizerTypes'

/** Must match the id `registerUriHandler` in extension.ts is actually registered under — see
 *  that file's own "Deep links" comment for why this can't just be the new `traceroost.traceroost`
 *  marketplace listing. */
const EXTENSION_ID = 'agentlens.agentlens-dashboard'

/** The first arg that isn't a flag — supports a bare `find <hash>`, and `find --repo <hash>` /
 *  `find --id <hash>` for anyone (or any old copied command) still typing the flag out. */
function firstPositional(args: string[]): string {
  return (args.find(a => !a.startsWith('-')) ?? '').trim()
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

/** Pure classification, split out for testing: a hash locally recorded as a session/trace id
 *  is a trace; everything else is treated as a repo hash (patternsCli.ts's own resolution — a
 *  real repo_hash, or a human-typed name/substring — reports "not a repository" if it's neither). */
export function classify(hash: string, sessions: SessionSummaryCard[]): 'trace' | 'repo' {
  return findSessionById(sessions, hash) ? 'trace' : 'repo'
}

/** Exported for testing — the exact link extension.ts's `find` case has to parse. */
export function findDeepLink(hash: string, reporter?: string): string {
  const query = new URLSearchParams({ hash, ...(reporter ? { reporter } : {}) })
  return `vscode://${EXTENSION_ID}/find?${query.toString()}`
}

export async function runFindCli(args: string[]): Promise<number> {
  const hash = firstPositional(args)
  const reporter = valueAfter(args, '--reporter')?.trim() || undefined
  if (!hash) {
    console.log('Usage: traceroost find <repo hash | trace/session id> [--reporter <email>]')
    return 1
  }

  const sessions = loadAllSessions()
  const code =
    classify(hash, sessions) === 'trace'
      ? await runTraceCli(['--id', hash])
      : await runPatternsCli(['--repo', hash])

  if (code !== 0) {
    // patternsCli/traceCli already printed their own "not found" line — this just adds the one
    // thing they can't know: cloud saw this hash come from somewhere, and it wasn't necessarily
    // this machine.
    console.log(
      reporter
        ? `(It may be on ${reporter}'s linked machine instead of this one.)`
        : '(It may be on a different linked machine.)',
    )
    return code
  }

  console.log(`\nOpen in the editor: ${findDeepLink(hash, reporter)}`)
  return code
}
