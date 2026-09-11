/**
 * Bridges a local `SessionSummaryCard` to the `--explain-payload` text (AL 03), for the Team
 * panel's "Show the exact payload" button.
 *
 * This lives in `src/team/`, not `src/forward/` — `src/forward/` is a closed island that must
 * not import `SessionSummaryCard`. Here is where the card is read, field by field, into the
 * narrow `SessionRollupInput`.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { calcTokenCostUsd } from '../pricing'
import { classifySessionOutcome } from '../gitOutcome'
import { deriveRepoKey } from '../forward/repoKey'
import { sessionRollupPayload, type SessionRollupInput } from '../forward/buildSessionRollup'
import { assertValidRollupPayload } from '../forward/validate'
import { renderPayloadPreview } from '../forward/preview'
import { loadCredentials } from './credentials'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

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

export async function buildPayloadPreviewText(card: SessionSummaryCard): Promise<string> {
  const creds = loadCredentials()
  const orgId = creds?.orgId ?? 'unlinked-preview'
  const workspace = card.workspace || card.projectPath || process.cwd()

  const rk = await deriveRepoKey(workspace, orgId)
  if (!rk.ok) {
    return `This session's repository can't be keyed (${rk.reason}). It would be reported without repository grouping — never with a fake hash.`
  }

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
  return renderPayloadPreview(payload, { linked: creds !== null })
}
