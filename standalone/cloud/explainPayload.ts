/**
 * `traceroost --explain-payload` / `--dry-run` (AL 03).
 *
 * Prints the exact JSON that would be transmitted for a real session — not a synthetic example.
 * Works on a free install with no org linked (the repo key is then derived under a placeholder
 * salt, so the hashes are representative but not the ones a real org would produce). A test
 * asserts this output is byte-identical to what the forwarding queue enqueues (AL 04).
 *
 * The repository key is never printed, including here and in any verbose mode.
 */

import { execFileSync } from 'child_process'
import { loadAllSessions } from '../local/sessionLoader'
import { classifySessionOutcome } from '../../src/gitOutcome'
import { readServiceConfig, ensureInstallId } from '../../src/serviceConfig'
import { loadCredentials } from '../../src/cloud/org/credentials'
import { deriveRepoKey } from '../../src/repoKey'
import { sessionRollupPayload, type SessionRollupInput } from '../../src/cloud/forward/buildSessionRollup'
import { assertValidRollupPayload } from '../../src/cloud/forward/validate'
import { stableStringify } from '../../src/cloud/forward/preview'
import { ForwardQueue } from '../../src/cloud/forward/queue'
import { SENT, NEVER_SENT } from '../../src/cloud/org/privacy'
import { previewManifestChunk } from '../../src/cloud/forward/traceManifest'
import { sourceRankOf, traceKeysInWindow, localHorizonOf, countTracesInWindow } from '../../src/traceIdentity'
import type { SessionSummaryCard } from '../../src/summarizers/summarizerTypes'

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

/** One line naming the per-session fields that are easiest to misread as content. */
export const SESSION_FIELD_NOTE =
  'language / language_secondary are fixed ids from a 14-value list (derived locally from file extensions); ' +
  'files_changed / lines_added / lines_removed are counts only — no paths, no file content, and not git stats.'

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
    dataSource: card.dataSource,
    initiator: card.initiator,
    language: card.language,
    languageSecondary: card.languageSecondary,
    filesChangedCount: card.filesChangedCount,
    linesAdded: card.linesAdded,
    linesRemoved: card.linesRemoved,
    sourceRank: sourceRankOf(card),
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
      console.log(`# --explain-payload --all — ${queued.length} trace(s) currently queued for the next send.`)
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
  console.log('# ' + SESSION_FIELD_NOTE)
  console.log('')

  for (const card of selected) {
    const workspace = card.workspace || card.projectPath || process.cwd()
    const rk = await deriveRepoKey(workspace, orgId)
    if (!rk.ok) {
      console.log(`# ${card.sessionId}: cannot build — ${rk.reason} (reported to the service as "no repository grouping", never as a fake hash)`)
      console.log('')
      continue
    }
    const outcome = await classifySessionOutcome(workspace, card.filesChanged ?? [])
    const payload = sessionRollupPayload(toInput(card), {
      repoKey: rk.ctx,
      branch: currentBranch(rk.ctx.root),
      outcome: outcome?.overall,
    })
    assertValidRollupPayload(payload)
    console.log(stableStringify(payload))
    console.log('')
  }

  // The trace manifest (stable trace identity): what reconciliation sends besides rollups.
  const chunk = previewManifestChunk({
    localHorizonMs: () => localHorizonOf(all),
    listTraceKeys: (fromMs, toMs) => traceKeysInWindow(all, fromMs, toMs),
    countTraces: (fromMs, toMs) => countTracesInWindow(all, fromMs, toMs),
  })
  if (chunk) {
    console.log('# Trace manifest (POST /api/ingest/manifest) — the newest day\'s chunk as it would be sent now.')
    console.log('# One chunk per UTC day of the settled window: the trace keys this machine still holds (the same')
    console.log('# session_id values above), so the cloud can retire traces it holds from this machine that no')
    console.log('# longer exist here. Only window bounds and opaque UUIDs — nothing else.')
    console.log(creds ? '# Sent by the forwarding timer.' : '# Not sent: this machine is not linked.')
    console.log(stableStringify(chunk))
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
