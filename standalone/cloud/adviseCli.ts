/**
 * `traceroost advise <--list|--apply <id>> [--repo <path>]` and `traceroost cluster --repo <hash|name> --id <id>` (AL 08).
 *
 * The local Advisor is free and unchanged. What this adds is the apply loop: regenerate a
 * suggestion with real paths, show the drafted line, append it to the instruction file, capture
 * a baseline, and — only when an org is linked — emit a `SuggestionEvent`.
 */

import * as crypto from 'crypto'
import * as path from 'path'
import { generateSuggestions, type SuggestionCard } from '../../src/instructionAdvisor'
import { detectInstructionFiles, appendSuggestion, readAllInstructionContent } from '../../src/instructionFiles'
import { recordApplied } from '../../src/cloud/org/suggestionLedgerStore'
import { readLedger } from '../../src/cloud/org/suggestionLedgerStore'
import { maybeEnqueueInstructionTelemetry } from '../../src/cloud/org/instructionTelemetry'
import { drainForwardQueueSoon } from '../../src/cloud/forward/scheduler'
import { loadCredentials } from '../../src/cloud/org/credentials'
import { fetchClusterResolution, matchLocalSessions } from '../../src/cloud/org/clusterResolve'
import { loadSessionsForWorkspace, loadAllSessions } from './sessionLoader'

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function matchSuggestion(suggestions: SuggestionCard[], idOrHash: string): SuggestionCard | undefined {
  return suggestions.find(s => s.id === idOrHash || sha256(s.id) === idOrHash)
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

async function runList(workspace: string): Promise<number> {
  const sessions = loadSessionsForWorkspace(workspace)
  const existing = safeInstructions(workspace)
  const suggestions = generateSuggestions(sessions, existing)
  if (suggestions.length === 0) {
    console.log('No suggestions right now — need at least a handful of recorded sessions in this repo.')
    return 0
  }
  for (const s of suggestions) {
    console.log(`\n[${s.priority}] ${s.title}   (${s.category})`)
    console.log(`  id:     ${s.id}`)
    console.log(`  ref:    ${sha256(s.id).slice(0, 16)}   (the hash the team view hands back)`)
    console.log(`  why:    ${s.evidence}`)
    console.log(`  target: ${s.targetAgents.join(', ')}`)
  }
  console.log('\nApply one with:  traceroost advise --apply <id>')
  return 0
}

async function runApply(workspace: string, idOrHash: string): Promise<number> {
  const sessions = loadSessionsForWorkspace(workspace)
  const existing = safeInstructions(workspace)
  const suggestions = generateSuggestions(sessions, existing)
  const card = matchSuggestion(suggestions, idOrHash)
  if (!card) {
    console.log(`No suggestion matches "${idOrHash}" in this repo. Run \`traceroost advise --list\`.`)
    return 1
  }

  // Pick the target instruction file for the first target agent that has one (or CLAUDE.md).
  const files = detectInstructionFiles(workspace)
  const target = files.find(f => card.targetAgents.includes(f.agent)) ?? files[0]

  console.log(`\nWill append to ${target.relativePath}:\n`)
  console.log('  ' + card.suggestedText.split('\n').join('\n  ') + '\n')

  appendSuggestion(target.filePath, card.suggestedText, card.id)
  recordApplied(workspace, card.id, { id: card.id, category: card.category, priority: card.priority, targetAgents: card.targetAgents })
  console.log(`✓ Applied. ${target.relativePath} updated.`)

  const enqueued = await maybeEnqueueInstructionTelemetry(workspace, sessions, readLedger(workspace))
  if (enqueued) {
    drainForwardQueueSoon()
    console.log('  A suggestion event (id hashed, no prose) was queued for your org.')
  }
  return 0
}

/**
 * Resolves a Repeat work cluster's hand-off command into real local sessions. Cloud can identify a
 * cluster (same repo, overlapping files, similar tools, crossing people) but never say what it's
 * about — no filename or prompt ever reached it. This machine is the one place that can, for
 * whichever of the cluster's sessions actually happened here.
 */
async function runCluster(args: string[]): Promise<number> {
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

function safeInstructions(workspace: string): string {
  try { return readAllInstructionContent(workspace) } catch { return '' }
}

export async function runAdviseCli(args: string[]): Promise<number> {
  const workspace = valueAfter(args, '--repo') ?? process.cwd()
  const abs = path.resolve(workspace)

  if (args[0] === 'cluster') return runCluster(args.slice(1))
  if (args.includes('--list')) return runList(abs)
  const applyId = valueAfter(args, '--apply')
  if (applyId) return runApply(abs, applyId)

  console.log('Usage:')
  console.log('  traceroost advise --list                 list instruction suggestions for this repo')
  console.log('  traceroost advise --apply <id> [--repo p] draft + append a suggestion, capture a baseline')
  return 0
}
