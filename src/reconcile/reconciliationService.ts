/**
 * Host-independent trace-outcome reconciliation (staged feature 10, Stage 1 -- see
 * .staged-features/10-live-outcome-reconciliation.md).
 *
 * Both DashboardPanel (the editor webview) and standalone/server.ts used to keep their own
 * `Map<sessionId, Promise<GitOutcome | null>>` as a *permanent* success cache -- once a session's
 * classification resolved, that promise (and therefore its answer) lived for the rest of the
 * panel/server's lifetime, even after the durable GitOutcomeRepository row it came from was
 * invalidated by a later commit or edit. Reopening a browser tab did not restart the standalone
 * server, so that promise cache -- and its stale answer -- outlived the tab. This service is the
 * single place both hosts now go through instead: it deduplicates only *in-flight* work (so two
 * near-simultaneous requests for the same not-yet-resolved session share one classification pass
 * rather than paying for it twice), and evicts its in-flight entry in `finally` regardless of
 * outcome -- there is no long-lived success cache at this layer. The durable, invalidation-aware
 * cache is GitOutcomeRepository (unchanged); this service is what decides when that cache is
 * still trustworthy and what to do when it isn't.
 *
 * Revision allocation (TraceRevisionRepository) rides along on every check: a revision only
 * advances when the classified outcome's value actually changes, so callers -- in particular the
 * forwarding queue -- can tell "reclassified, same answer" apart from "reclassified, different
 * answer" without diffing the outcome object themselves.
 *
 * Cross-process note: this service assumes it is the sole writer of the database instance it is
 * given. When the editor and the standalone server are both pointed at the same workspace, each
 * owns a *separate* on-disk database (traceroost.db vs outcomes-cache.db under a different data
 * directory) today, so they do not race on the same file -- but neither do they see each other's
 * revisions or notify each other's subscribers. Serializing revision allocation and invalidation
 * across genuinely shared storage is called out in the staged feature's Stage 2 ("provide
 * cross-process ownership for overlapping standalone/editor hosts") and is intentionally not
 * attempted here; see the staged-features doc for the follow-up this leaves open.
 */

import {
  classifySessionOutcome,
  resolveOutcomeCacheKey,
  createOutcomeRepoCache,
  type GitOutcome,
  type OutcomeRepoCache,
} from '../gitOutcome'
import { GitOutcomeRepository } from '../database/gitOutcomeRepository'
import { TraceRevisionRepository } from '../database/traceRevisionRepository'

interface WriteableDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  run(sql: string, params?: unknown[]): void
}

export interface ReconcileInput {
  sessionId: string
  workspace: string
  filesChanged: string[]
  /** ISO timestamp of the session's last known activity -- used for the active-session grace
   *  window, same cutoff DashboardPanel.update() uses for the burn-rate "still live" check. */
  endTime: string
}

export interface ReconcileResult {
  sessionId: string
  outcome: GitOutcome | null
  /** Null only when there is nothing to classify (no workspace/files/repo) and no prior row --
   *  the "not applicable" case, distinct from a computed-but-inconclusive ('ambiguous') result. */
  revision: number | null
  /** True when this call produced a different outcome value than the last stored one (or there
   *  was no prior stored value). False for "reclassified, same answer" and for a skipped
   *  in-grace check. */
  changed: boolean
  /** True when this call was skipped because the session is still inside its active-session
   *  grace window -- `outcome` reflects the last durable result (or null), not a fresh check. */
  deferred: boolean
}

// Mirrors DashboardPanel.GIT_OUTCOME_ACTIVE_GRACE_MS.
const ACTIVE_GRACE_MS = 2 * 60_000
// Bounds retries when the repository generation check (below) finds the world moved out from
// under a classification pass -- a live repo under constant activity could otherwise retry
// forever instead of settling.
const MAX_GENERATION_RETRIES = 2

export type ReconcileListener = (result: ReconcileResult) => void

export class ReconciliationService {
  private readonly outcomes: GitOutcomeRepository
  private readonly revisions: TraceRevisionRepository
  private readonly inFlight = new Map<string, Promise<ReconcileResult>>()
  private readonly listeners = new Set<ReconcileListener>()
  // One pending "revisit at grace expiry" timer per session -- see reconcile()'s deferred branch.
  // Cleared and replaced on every deferred call so a session with repeated activity only ever has
  // its *latest* grace deadline pending, not one timer per request.
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(db: WriteableDb) {
    this.outcomes = new GitOutcomeRepository(db)
    this.revisions = new TraceRevisionRepository(db)
  }

  /** Notified after every completed (non-deferred, non-error) reconcile that produced a result --
   *  including "checked, unchanged" ones, so a freshness indicator can update its checked-at time
   *  even when the verdict didn't move. Returns an unsubscribe function. */
  subscribe(fn: ReconcileListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(result: ReconcileResult): void {
    for (const fn of this.listeners) {
      try { fn(result) } catch { /* one bad listener must not break the others */ }
    }
  }

  /** Reconciles one session: checks the durable cache, reclassifies if it's stale, allocates a
   *  revision on a real outcome change, and (unless deferred) notifies subscribers. In-flight
   *  calls for the same session share one promise; nothing about a resolved call is cached at
   *  this layer once it settles. */
  async reconcile(input: ReconcileInput, opts: { cache?: OutcomeRepoCache; force?: boolean } = {}): Promise<ReconcileResult> {
    const existingInFlight = this.inFlight.get(input.sessionId)
    if (existingInFlight && !opts.force) return existingInFlight

    const pending = this.doReconcile(input, opts.cache)
      .finally(() => {
        if (this.inFlight.get(input.sessionId) === pending) this.inFlight.delete(input.sessionId)
      })
    this.inFlight.set(input.sessionId, pending)
    return pending
  }

  /** Convenience for the background watcher (Stage 2): reconciles many sessions sharing one
   *  short-lived root/trunk-ref cache, since a burst of retained sessions after a commit almost
   *  always shares a handful of repos. The cache is deliberately not retained by the service
   *  itself -- see gitOutcome.ts's OutcomeRepoCache doc comment on why it's scoped per burst. */
  async reconcileMany(inputs: ReconcileInput[]): Promise<ReconcileResult[]> {
    const cache = createOutcomeRepoCache()
    return Promise.all(inputs.map(input => this.reconcile(input, { cache })))
  }

  private async doReconcile(input: ReconcileInput, cache: OutcomeRepoCache | undefined): Promise<ReconcileResult> {
    const { sessionId, workspace, filesChanged, endTime } = input

    if (endTime && Date.now() - Date.parse(endTime) < ACTIVE_GRACE_MS) {
      this.scheduleGraceRevisit(input)
      const stored = this.revisions.get(sessionId)
      return {
        sessionId,
        outcome: stored ? this.outcomes.get(sessionId, stored.fingerprint) ?? null : null,
        revision: stored?.revision ?? null,
        changed: false,
        deferred: true,
      }
    }
    this.clearGraceTimer(sessionId)

    const result = await this.classifyWithGenerationCheck(sessionId, workspace, filesChanged, cache)
    this.notify(result)
    return result
  }

  private async classifyWithGenerationCheck(
    sessionId: string,
    workspace: string,
    filesChanged: string[],
    cache: OutcomeRepoCache | undefined,
    attempt = 0,
  ): Promise<ReconcileResult> {
    const keyBefore = await resolveOutcomeCacheKey(workspace, filesChanged)
    if (!keyBefore) {
      // Nothing to classify (no repo, no in-repo files). Still record the check so a session that
      // *used* to resolve (e.g. its repo directory temporarily vanished) doesn't keep a stale
      // revision forever -- but never overwrite a real prior fingerprint with "unresolvable"; a
      // transient git failure should read as stale/unavailable, not as a fresh 'not applicable'.
      const prior = this.revisions.get(sessionId)
      if (prior) return { sessionId, outcome: null, revision: prior.revision, changed: false, deferred: false }
      return { sessionId, outcome: null, revision: null, changed: false, deferred: false }
    }

    const cached = this.outcomes.get(sessionId, keyBefore.cacheKey)
    const outcome = cached !== undefined ? cached : await classifySessionOutcome(workspace, filesChanged, cache)

    // Generation check: if the fingerprint moved while we were computing (a commit, edit, or
    // merge landed mid-classification), the result we just computed already describes a
    // superseded world. Discard it and reclassify once more against the now-current state rather
    // than publish/cache a result that was correct only for an instant that's already passed.
    if (cached === undefined) {
      const keyAfter = await resolveOutcomeCacheKey(workspace, filesChanged)
      if (keyAfter && keyAfter.cacheKey !== keyBefore.cacheKey && attempt < MAX_GENERATION_RETRIES) {
        return this.classifyWithGenerationCheck(sessionId, workspace, filesChanged, cache, attempt + 1)
      }
      if (outcome) this.outcomes.put(sessionId, keyBefore.root, keyBefore.cacheKey, outcome)
    }

    const { revision, changed } = this.revisions.recordCheck(sessionId, keyBefore.cacheKey, outcome?.overall ?? null)
    return { sessionId, outcome, revision, changed, deferred: false }
  }

  private scheduleGraceRevisit(input: ReconcileInput): void {
    this.clearGraceTimer(input.sessionId)
    const remaining = ACTIVE_GRACE_MS - (Date.now() - Date.parse(input.endTime))
    if (!(remaining > 0)) return
    const timer = setTimeout(() => {
      this.graceTimers.delete(input.sessionId)
      void this.reconcile(input, { force: true })
    }, remaining + 1000) // small buffer past the exact boundary so the revisit itself doesn't re-defer
    timer.unref?.()
    this.graceTimers.set(input.sessionId, timer)
  }

  private clearGraceTimer(sessionId: string): void {
    const timer = this.graceTimers.get(sessionId)
    if (timer) { clearTimeout(timer); this.graceTimers.delete(sessionId) }
  }

  dispose(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer)
    this.graceTimers.clear()
    this.listeners.clear()
  }
}
