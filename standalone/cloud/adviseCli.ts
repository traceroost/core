/**
 * `agentlens advise <--list|--apply <id>> [--repo <path>]` and `agentlens cluster --repo <hash|name> --id <id>` (AL 08).
 *
 * The local Advisor is free and unchanged. What this adds is the apply loop: regenerate a
 * suggestion with real paths, show the drafted line, append it to the instruction file, capture
 * a baseline, and — only when a team is linked — emit a `SuggestionEvent`.
 */

import * as crypto from 'crypto'
import * as path from 'path'
import { generateSuggestions, type SuggestionCard } from '../../src/instructionAdvisor'
import { detectInstructionFiles, appendSuggestion, readAllInstructionContent } from '../../src/instructionFiles'
import { recordApplied } from '../../src/cloud/team/suggestionLedgerStore'
import { readLedger } from '../../src/cloud/team/suggestionLedgerStore'
import { maybeEnqueueInstructionTelemetry } from '../../src/cloud/team/instructionTelemetry'
import { drainForwardQueueSoon } from '../../src/cloud/forward/scheduler'
import { loadSessionsForWorkspace } from './sessionLoader'

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
  console.log('\nApply one with:  agentlens advise --apply <id>')
  return 0
}

async function runApply(workspace: string, idOrHash: string): Promise<number> {
  const sessions = loadSessionsForWorkspace(workspace)
  const existing = safeInstructions(workspace)
  const suggestions = generateSuggestions(sessions, existing)
  const card = matchSuggestion(suggestions, idOrHash)
  if (!card) {
    console.log(`No suggestion matches "${idOrHash}" in this repo. Run \`agentlens advise --list\`.`)
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
    console.log('  A suggestion event (id hashed, no prose) was queued for your team.')
  }
  return 0
}

function runCluster(args: string[]): number {
  const repo = valueAfter(args, '--repo')
  const id = valueAfter(args, '--id')
  console.log(
    'Cluster naming happens locally, where the prompts are. This command opens the local view:\n' +
    `  repo: ${repo ?? '(missing --repo)'}\n  cluster: ${id ?? '(missing --id)'}\n` +
    'In the editor, run the AgentLens: Open Dashboard command and use the Advisor tab.',
  )
  return repo && id ? 0 : 1
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
  console.log('  agentlens advise --list                 list instruction suggestions for this repo')
  console.log('  agentlens advise --apply <id> [--repo p] draft + append a suggestion, capture a baseline')
  return 0
}
