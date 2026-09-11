/**
 * Bridges a local `SessionSummaryCard` to a built `RollupPayload` and its `--explain-payload`
 * text (AL 03 / AL 04).
 *
 * This lives in `src/team/`, not `src/forward/` — `src/forward/` is a closed island that must
 * not import `SessionSummaryCard`. Here is where the card is read, field by field, into the
 * narrow `SessionRollupInput`.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { calcTokenCostUsd } from '../../pricing'
import { classifySessionOutcome } from '../../gitOutcome'
import { deriveRepoKey } from '../forward/repoKey'
import { sessionRollupPayload, type SessionRollupInput } from '../forward/buildSessionRollup'
import { assertValidRollupPayload } from '../forward/validate'
import { renderPayloadPreview } from '../forward/preview'
import type { RollupPayload } from '../forward/schema'
import { loadCredentials } from './credentials'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

const execFileAsync = promisify(execFile)

function cardToInput(card: SessionSummaryCard): SessionRollupInput {
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

async function currentBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 5000 })
    return stdout.trim() || 'HEAD'
  } catch {
    return 'HEAD'
  }
}

export type PayloadForCard =
  | { ok: true; payload: RollupPayload }
  | { ok: false; reason: 'not-a-repo' | 'shallow-clone' | 'no-root-commit' }

/**
 * Builds the exact `RollupPayload` for one session, or reports why it can't. Used by both the
 * panel's payload preview and the forwarding queue — so what the panel shows is byte-identical
 * to what is enqueued.
 *
 * When no team is linked, hashes are derived under a placeholder org salt so the preview is
 * representative; nothing is ever sent.
 */
export async function buildPayloadForCard(card: SessionSummaryCard): Promise<PayloadForCard> {
  const creds = loadCredentials()
  const orgId = creds?.orgId ?? 'unlinked-preview'
  const workspace = card.workspace || card.projectPath || process.cwd()

  const rk = await deriveRepoKey(workspace, orgId)
  if (!rk.ok) return { ok: false, reason: rk.reason }

  const cost = calcTokenCostUsd(
    Math.max(0, card.inputTokens - card.cacheReadTokens - (card.cacheCreateTokens ?? 0)),
    card.cacheReadTokens,
    card.cacheCreateTokens ?? 0,
    card.outputTokens,
    card.model,
  )
  const outcome = await classifySessionOutcome(workspace, card.filesChanged ?? [], card.startTime, card.startTime)
  const payload = sessionRollupPayload(cardToInput(card), {
    repoKey: rk.ctx,
    branch: await currentBranch(rk.ctx.root),
    costUsd: cost,
    outcome: outcome?.overall,
  })
  assertValidRollupPayload(payload)
  return { ok: true, payload }
}

export async function buildPayloadPreviewText(card: SessionSummaryCard): Promise<string> {
  const result = await buildPayloadForCard(card)
  if (!result.ok) {
    return `This session's repository can't be keyed (${result.reason}). It would be reported without repository grouping — never with a fake hash.`
  }
  return renderPayloadPreview(result.payload, { linked: loadCredentials() !== null })
}
