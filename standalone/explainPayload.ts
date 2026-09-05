/**
 * `agentlens --explain-payload` / `--dry-run` (AL 03).
 *
 * Prints the exact JSON that would be transmitted for a real session — not a synthetic example.
 * Works on a free install with no team linked (the repo key is then derived under a placeholder
 * salt, so the hashes are representative but not the ones a real team would produce). A test
 * asserts this output is byte-identical to what the forwarding queue enqueues (AL 04).
 *
 * The repository key is never printed, including here and in any verbose mode.
 */

import { execFileSync } from 'child_process'
import { loadAllSessions } from './sessionLoader'
import { calcTokenCostUsd } from '../src/pricing'
import { classifySessionOutcome } from '../src/gitOutcome'
import { readServiceConfig, ensureInstallId } from '../src/serviceConfig'
import { loadCredentials } from '../src/team/credentials'
import { deriveRepoKey } from '../src/forward/repoKey'
import { sessionRollupPayload, type SessionRollupInput } from '../src/forward/buildSessionRollup'
import { assertValidRollupPayload } from '../src/forward/validate'
import { stableStringify } from '../src/forward/preview'
import { ForwardQueue } from '../src/forward/queue'
import { SENT, NEVER_SENT } from '../src/team/privacy'
import type { SessionSummaryCard } from '../src/summarizers/summarizerTypes'

export interface ExplainOptions {
  last?: boolean
  sessionId?: string
  since?: string
  all?: boolean
  /** `--dry-run`: same output, framed as "would send" for a live session. */
  dryRun?: boolean
}

function selectSessions(all: SessionSummaryCard[], opts: ExplainOptions): SessionSummaryCard[] {
  if (opts.sessionId) return all.filter(s => s.sessionId === opts.sessionId)
  if (opts.since) {
    const cut = Date.parse(opts.since)
    return Number.isNaN(cut) ? [] : all.filter(s => Date.parse(s.startTime) >= cut)
  }
  if (opts.all) return all
  return all.slice(0, 1) // --last (the default)
}

function currentBranch(workspace: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspace, encoding: 'utf-8', timeout: 5000 }).trim() || 'HEAD'
  } catch {
    return 'HEAD'
  }
}

function toInput(card: SessionSummaryCard): SessionRollupInput {
  return {
    sessionId: card.sessionId,
    source: card.source,
    models: card.models,
    model: card.model,
    startTime: card.startTime,
    durationMs: card.durationMs,
    totalLlmCalls: card.totalLlmCalls,
    inputTokens: card.inputTokens,
    outputTokens: card.outputTokens,
    cacheReadTokens: card.cacheReadTokens,
    cacheCreateTokens: card.cacheCreateTokens,
    errors: card.errors,
    toolCounts: card.toolCounts,
    filesChanged: card.filesChanged,
    filesWritten: card.filesWritten,
    loopSignals: (card.loopSignals ?? []).map(s => ({ type: s.type, severity: s.severity })),
    oneShotStats: card.oneShotStats,
    llmModels: (card.timeline ?? []).filter(t => t.type === 'llm' && t.model).map(t => t.model as string),
  }
}

export async function runExplainPayload(opts: ExplainOptions): Promise<number> {
  const creds = loadCredentials()
  const orgId = creds?.orgId ?? 'unlinked-preview'
  ensureInstallId(readServiceConfig())

  // `--all` dumps the forwarding queue when it has anything in it — the exact bytes pending
  // right now — falling back to a preview built from all local sessions when it is empty.
  if (opts.all) {
    const queued = new ForwardQueue().list()
    if (queued.length > 0) {
      console.log(`# --explain-payload --all — ${queued.length} rollup(s) currently queued for the next send.`)
      console.log('# Sent:       ' + SENT.join('; '))
      console.log('# Never sent: ' + NEVER_SENT.join('; '))
      console.log('')
      for (const item of queued) {
        console.log(`# queued ${new Date(item.enqueuedAt).toISOString()} · key ${item.key} · attempts ${item.attempts}`)
        console.log(stableStringify(item.payload))
        console.log('')
      }
      return 0
    }
    console.log('# The forwarding queue is empty. Showing a preview built from local sessions instead.\n')
  }

  const all = loadAllSessions()
  if (all.length === 0) {
    console.log('No sessions recorded yet. Run an agent session, then try again.')
    return 0
  }
  const selected = selectSessions(all, opts)
  if (selected.length === 0) {
    console.log('No session matched. Try --last, --all, --session <id>, or --since <date>.')
    return 1
  }

  console.log(opts.dryRun
    ? '# --dry-run — this is what a forward would send for this session. Nothing is queued.'
    : '# --explain-payload — the exact bytes a forward sends. Run a packet capture and compare.')
  if (!creds) console.log('# This machine is NOT linked. Nothing is being sent. Hashes below use a placeholder org salt.')
  console.log('#')
  console.log('# Sent:       ' + SENT.join('; '))
  console.log('# Never sent: ' + NEVER_SENT.join('; '))
  console.log('')

  for (const card of selected) {
    const workspace = card.workspace || card.projectPath || process.cwd()
    const rk = await deriveRepoKey(workspace, orgId)
    if (!rk.ok) {
      console.log(`# ${card.sessionId}: cannot build — ${rk.reason} (reported to the service as "no repository grouping", never as a fake hash)`)
      console.log('')
      continue
    }
    const cost = calcTokenCostUsd(
      Math.max(0, card.inputTokens - card.cacheReadTokens - (card.cacheCreateTokens ?? 0)),
      card.cacheReadTokens,
      card.cacheCreateTokens ?? 0,
      card.outputTokens,
      card.model,
    )
    const outcome = await classifySessionOutcome(workspace, card.filesChanged ?? [], card.startTime, card.startTime)
    const payload = sessionRollupPayload(toInput(card), {
      repoKey: rk.ctx,
      branch: currentBranch(rk.ctx.root),
      costUsd: cost,
      outcome: outcome?.overall,
    })
    assertValidRollupPayload(payload)
    console.log(stableStringify(payload))
    console.log('')
  }
  return 0
}

/** Parses the `--explain-payload` / `--dry-run` flags off argv. */
export function parseExplainFlags(args: string[]): ExplainOptions | null {
  if (!args.includes('--explain-payload') && !args.includes('--dry-run')) return null
  const valueAfter = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  return {
    dryRun: args.includes('--dry-run'),
    last: args.includes('--last'),
    all: args.includes('--all'),
    sessionId: valueAfter('--session'),
    since: valueAfter('--since'),
  }
}
