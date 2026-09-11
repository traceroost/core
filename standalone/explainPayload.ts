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
import { summarizeSpans } from '../src/spanSummarizer'
import { LogReader } from '../src/logReader'
import { computeOneShotStats } from '../src/oneShotRate'
import { calcTokenCostUsd } from '../src/pricing'
import { classifySessionOutcome } from '../src/gitOutcome'
import { readServiceConfig, ensureInstallId } from '../src/serviceConfig'
import { loadCredentials } from '../src/team/credentials'
import { deriveRepoKey } from '../src/forward/repoKey'
import { sessionRollupPayload, type SessionRollupInput } from '../src/forward/buildSessionRollup'
import { assertValidRollupPayload } from '../src/forward/validate'
import { stableStringify } from '../src/forward/preview'
import { SENT, NEVER_SENT } from '../src/team/privacy'
import type { Span } from '../src/types'
import type { SessionSummaryCard } from '../src/summarizers/summarizerTypes'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface ExplainOptions {
  last?: boolean
  sessionId?: string
  since?: string
  all?: boolean
  /** `--dry-run`: same output, framed as "would send" for a live session. */
  dryRun?: boolean
}

function loadAllSessions(): SessionSummaryCard[] {
  const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), '.agentlens')
  const sessions: SessionSummaryCard[] = []

  try {
    const raw = fs.readFileSync(path.join(dataDir, 'spans.json'), 'utf-8')
    const spans = JSON.parse(raw) as Span[]
    sessions.push(...summarizeSpans(spans).sessions)
  } catch { /* no OTEL spans persisted */ }

  try {
    const reader = new LogReader()
    for (const file of reader.collectFileMeta()) {
      if (file.agentKey === 'opencode') continue
      try {
        for (const { card } of reader.parseFile(file.filePath, file.agentKey)) {
          card.oneShotStats = computeOneShotStats(card)
          sessions.push(card)
        }
      } catch { /* skip bad file */ }
    }
  } catch { /* no logs */ }

  return sessions
    .filter(s => s.startTime)
    .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
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
