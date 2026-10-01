/**
 * `traceroost advise <--list|--apply <id>> [--repo <path>]` (AL 08).
 *
 * The local Advisor is free and unchanged. What this adds is the apply loop: regenerate a
 * suggestion with real paths, show the drafted line and append it to the instruction file. The
 * cloud step — recording the apply in the CLI's suggestion ledger and, only when an org is
 * linked, emitting a `SuggestionEvent` — is injected as `afterApply`
 * (standalone/cloud/adviseTelemetry.ts); this file has no cloud dependency of its own.
 * `traceroost cluster` lives in standalone/cloud/clusterCli.ts.
 */

import * as crypto from 'crypto'
import * as path from 'path'
import { generateSuggestions, type SuggestionCard } from '../../src/instructionAdvisor'
import { detectInstructionFiles, appendSuggestion, readAllInstructionContent } from '../../src/instructionFiles'
import { loadSessionsForWorkspace } from './sessionLoader'
import type { SessionSummaryCard } from '../../src/summarizers/summarizerTypes'

/** Runs after a suggestion has been appended — see this file's header. */
export type AfterApplyHook = (workspace: string, card: SuggestionCard, sessions: SessionSummaryCard[]) => Promise<void>

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

async function runApply(workspace: string, idOrHash: string, afterApply?: AfterApplyHook): Promise<number> {
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
  console.log(`✓ Applied. ${target.relativePath} updated.`)

  await afterApply?.(workspace, card, sessions)
  return 0
}

function safeInstructions(workspace: string): string {
  try { return readAllInstructionContent(workspace) } catch { return '' }
}

export async function runAdviseCli(args: string[], afterApply?: AfterApplyHook): Promise<number> {
  const workspace = valueAfter(args, '--repo') ?? process.cwd()
  const abs = path.resolve(workspace)

  if (args.includes('--list')) return runList(abs)
  const applyId = valueAfter(args, '--apply')
  if (applyId && !applyId.startsWith('-')) return runApply(abs, applyId, afterApply)

  console.log('Usage:')
  console.log('  traceroost advise --list                 list instruction suggestions for this repo')
  console.log('  traceroost advise --apply <id> [--repo p] draft + append a suggestion, capture a baseline')
  // Like every other subcommand's usage fallback (cohort, trace, find, service): no valid
  // action — including `--apply` with its id missing — is a usage error, not success.
  return 1
}
