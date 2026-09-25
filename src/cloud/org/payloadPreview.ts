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
import { classifySessionOutcome, createOutcomeRepoCache, type OutcomeRepoCache } from '../../gitOutcome'
import { deriveRepoKey, type RepoKeyResult } from '../forward/repoKey'
import { sessionRollupPayload, type SessionRollupInput } from '../forward/buildSessionRollup'
import { assertValidRollupPayload } from '../forward/validate'
import { stableStringify } from '../forward/preview'
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
    dataSource: card.dataSource,
    initiator: card.initiator,
    conversationId: card.conversationId,
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

/**
 * Memoizes the per-workspace git work `buildPayloadForCard` does — `deriveRepoKey`'s three `git`
 * subprocesses, the current-branch lookup, and `classifySessionOutcome`'s repo-root/trunk-ref
 * resolution — across many sessions that share a workspace. A developer's sessions cluster in a
 * handful of repos, so reconciling a real backlog without this recomputes the same root commit,
 * shallow-clone check, and trunk ref once per *session* instead of once per distinct workspace.
 * Scoped to whatever call site creates one (see `panelController.ts`'s reconcile loop) — nothing
 * here is cached across separate reconcile runs, so a mid-history branch change or repo move is
 * still picked up next time. See .staged-issues/reconcile-gap-and-latency.md.
 */
export interface PayloadBuildCache {
  repoKey(workspace: string, orgId: string): Promise<RepoKeyResult>
  branch(root: string): Promise<string>
  outcome: OutcomeRepoCache
}

export function createPayloadBuildCache(): PayloadBuildCache {
  const repoKeys = new Map<string, Promise<RepoKeyResult>>()
  const branches = new Map<string, Promise<string>>()
  return {
    repoKey(workspace: string, orgId: string) {
      const cacheKey = `${orgId} ${workspace}`
      let p = repoKeys.get(cacheKey)
      if (!p) { p = deriveRepoKey(workspace, orgId); repoKeys.set(cacheKey, p) }
      return p
    },
    branch(root: string) {
      let p = branches.get(root)
      if (!p) { p = currentBranch(root); branches.set(root, p) }
      return p
    },
    outcome: createOutcomeRepoCache(),
  }
}

export interface PayloadForCard {
  payload: RollupPayload
  /** Set when the workspace's repository couldn't be keyed (not a git repo, a shallow clone, or
   *  no discoverable root commit). `payload` is still complete and still gets sent — just without
   *  repo grouping, never with a fake hash. */
  ungroupedReason?: 'not-a-repo' | 'shallow-clone' | 'no-root-commit'
}

/**
 * Builds the exact `RollupPayload` for one session. Used by both the panel's payload preview and
 * the forwarding queue — so what the panel shows is byte-identical to what is enqueued.
 *
 * When no team is linked, hashes are derived under a placeholder org salt so the preview is
 * representative; nothing is ever sent.
 */
export async function buildPayloadForCard(card: SessionSummaryCard, cache?: PayloadBuildCache, revision?: number): Promise<PayloadForCard> {
  const creds = loadCredentials()
  const orgId = creds?.orgId ?? 'unlinked-preview'
  const workspace = card.workspace || card.projectPath || process.cwd()

  const rk = cache ? await cache.repoKey(workspace, orgId) : await deriveRepoKey(workspace, orgId)

  const outcome = await classifySessionOutcome(workspace, card.filesChanged ?? [], cache?.outcome)
  const payload = sessionRollupPayload(cardToInput(card), {
    repoKey: rk.ok ? rk.ctx : undefined,
    branch: rk.ok ? await (cache ? cache.branch(rk.ctx.root) : currentBranch(rk.ctx.root)) : undefined,
    outcome: outcome?.overall,
    revision,
  })
  assertValidRollupPayload(payload)
  return rk.ok ? { payload } : { payload, ungroupedReason: rk.reason }
}

/** Just the wire bytes — no prose. The panel already shows the sent/never-sent promise and the
 *  linked/unlinked state as their own UI elements; repeating them as text here only pushed the
 *  actual JSON further down. */
export async function buildPayloadPreviewText(card: SessionSummaryCard): Promise<string> {
  const result = await buildPayloadForCard(card)
  return stableStringify(result.payload)
}

/**
 * Same as `buildPayloadPreviewText`, but for several sessions at once, sharing one
 * `PayloadBuildCache` across all of them — the expensive part of building a payload (three `git`
 * subprocesses in `deriveRepoKey`, another for the current branch, more inside
 * `classifySessionOutcome`) is per-*workspace*, not per-session, and a developer's recent
 * sessions typically cluster in one or two repos. Without a shared cache (the single-session
 * `buildPayloadPreviewText` never gets one — it's only ever called for the panel's own "show the
 * payload" button, always for just the most recent session, so caching across calls was never
 * worth it there) this is what made the panel's payload preview slow: every click re-ran every
 * `git` subprocess from scratch for that one session. Batching several sessions behind one cache
 * turns that around — the first session pays the real cost, every session after it that shares a
 * workspace is nearly free.
 *
 * Runs the batch concurrently (`Promise.all`), which is safe with this cache: each cache method
 * stores the in-flight `Promise` itself the moment it's first requested, before any `await`, so
 * two concurrent calls for the same workspace key both find and await the one promise already in
 * flight rather than racing to start the same `git` subprocess twice.
 */
export async function buildPayloadPreviewTexts(cards: SessionSummaryCard[]): Promise<string[]> {
  const cache = createPayloadBuildCache()
  const results = await Promise.all(cards.map((card) => buildPayloadForCard(card, cache)))
  return results.map((r) => stableStringify(r.payload))
}
