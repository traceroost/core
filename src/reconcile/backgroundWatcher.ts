/**
 * Background reconciliation (staged feature 10, Stage 2 — see
 * .staged-features/10-live-outcome-reconciliation.md).
 *
 * Runs from extension-host / standalone-server lifecycle, not dashboard lifecycle: started once
 * at activation/startup and kept alive independent of whether a Traces view is open, so "leave
 * Traces open through multiple commits and a merge" and "closed UI; collector running" both
 * converge without navigating away and back or reopening a tab.
 *
 * Scope, honestly: this watches each retained session's resolved repo root's `.git` directory
 * (HEAD, refs, packed-refs) for commits, checkouts, resets, rebases, merges, and fetches — the
 * bulk of the staged feature's trigger list. It does *not* additionally watch every session's
 * individual working-tree files (a large retained history can span thousands of files across
 * dozens of repos; watching all of them individually was judged not worth the fd/resource cost).
 * An uncommitted edit or a growing/shrinking file set is instead picked up by the bounded 60-second
 * fallback poll below, via resolveOutcomeCacheKey's working-tree content digest — slower than a
 * watch event, but within the staged feature's own 60-second fallback-detection budget, and it's
 * the fallback poll (not a dedicated watch) that covers "changes to the session's file set" and
 * "relevant working-tree changes" for files that were never part of a commit.
 *
 * `fs.watch(..., { recursive: true })` is not reliably available on every platform this extension
 * ships on; the watcher is wrapped so a platform that can't support it just falls back to the
 * poll-only path rather than throwing at startup — matching "missed watcher events recover
 * automatically."
 */

import * as fs from 'fs'
import * as path from 'path'
import { findRepoRoot } from '../gitOutcome'
import type { ReconciliationService, ReconcileInput } from './reconciliationService'

export interface WatchableSession {
  sessionId: string
  workspace: string
  filesChanged: string[]
  /** ISO end time, or undefined for a session still actively growing — reconcile() treats an
   *  absent/unparseable endTime as "not in grace" (see ReconciliationService.doReconcile). */
  endTime?: string
}

export interface BackgroundWatcherDeps {
  service: ReconciliationService
  /** All retained local sessions worth reconciling — unbounded, same "every retained session, not
   *  just the most recent page" contract as DashboardPanel.orgDeps().allLocalSessions. */
  listSessions: () => WatchableSession[]
  log?: (msg: string) => void
}

export interface BackgroundWatcher {
  /** Forces an immediate reconciliation pass across every distinct repo root, bypassing the
   *  debounce — used for startup/resume catch-up and an explicit user-triggered refresh. */
  refreshNow(): void
  dispose(): void
}

const DEBOUNCE_MS = 3_000
const FALLBACK_POLL_MS = 60_000
// Bounds concurrent `git` subprocess fan-out across repos in one reconciliation pass, on top of
// gitOutcome.ts's own per-session classification gate — a large multi-repo history shouldn't spawn
// one classification batch per repo all at once.
const MAX_CONCURRENT_REPO_PASSES = 4

function toReconcileInput(s: WatchableSession): ReconcileInput {
  return { sessionId: s.sessionId, workspace: s.workspace, filesChanged: s.filesChanged, endTime: s.endTime ?? '' }
}

export function startBackgroundReconciliation(deps: BackgroundWatcherDeps): BackgroundWatcher {
  let disposed = false
  const gitWatchers = new Map<string, fs.FSWatcher>() // repo root -> watcher on its .git dir
  const knownRoots = new Set<string>()
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let pendingRoots = new Set<string>() // repo roots due for a debounced pass; empty set = "all"

  async function reconcileRoots(roots: Set<string> | null): Promise<void> {
    if (disposed) return
    const sessions = deps.listSessions()
    const byRoot = new Map<string, WatchableSession[]>()
    for (const s of sessions) {
      const root = await findRepoRoot(s.workspace)
      if (!root) continue
      if (roots && !roots.has(root)) continue
      if (!byRoot.has(root)) byRoot.set(root, [])
      byRoot.get(root)!.push(s)
      ensureWatched(root)
    }

    const entries = [...byRoot.entries()]
    let cursor = 0
    async function worker() {
      while (cursor < entries.length) {
        const [, group] = entries[cursor++]
        try {
          await deps.service.reconcileMany(group.map(toReconcileInput))
        } catch (err) {
          deps.log?.(`[TraceRoost] background reconciliation failed for a repo: ${(err as Error).message}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REPO_PASSES, entries.length) }, worker))
  }

  function scheduleDebounced(root: string): void {
    pendingRoots.add(root)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      const roots = pendingRoots
      pendingRoots = new Set()
      debounceTimer = undefined
      void reconcileRoots(roots)
    }, DEBOUNCE_MS)
    debounceTimer.unref?.()
  }

  function ensureWatched(root: string): void {
    if (knownRoots.has(root)) return
    knownRoots.add(root)
    const gitDir = path.join(root, '.git')
    try {
      // `.git` can itself be a file (a linked worktree or submodule pointer, "gitdir: <path>") —
      // resolve to the real directory before watching so worktrees are covered, per the staged
      // feature's "including linked worktrees and packed refs."
      const target = resolveGitDir(gitDir)
      if (!target) return
      const watcher = fs.watch(target, { recursive: true, persistent: false }, () => scheduleDebounced(root))
      watcher.on('error', () => { /* platform doesn't support this watch mode — fallback poll still covers it */ })
      gitWatchers.set(root, watcher)
    } catch {
      // fs.watch with { recursive: true } isn't supported everywhere — the 60s fallback poll
      // below is what actually guarantees eventual detection regardless.
    }
  }

  function resolveGitDir(gitDir: string): string | null {
    try {
      const stat = fs.statSync(gitDir)
      if (stat.isDirectory()) return gitDir
      const contents = fs.readFileSync(gitDir, 'utf-8').trim()
      const m = /^gitdir:\s*(.+)$/.exec(contents)
      if (!m) return null
      return path.isAbsolute(m[1]) ? m[1] : path.resolve(path.dirname(gitDir), m[1])
    } catch {
      return null
    }
  }

  const fallbackTimer = setInterval(() => { void reconcileRoots(null) }, FALLBACK_POLL_MS)
  fallbackTimer.unref?.()

  // Startup/resume catch-up: reconcile everything once immediately rather than waiting for the
  // first watch event or the first fallback tick.
  void reconcileRoots(null)

  return {
    refreshNow() { void reconcileRoots(null) },
    dispose() {
      disposed = true
      clearInterval(fallbackTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const w of gitWatchers.values()) w.close()
      gitWatchers.clear()
      knownRoots.clear()
    },
  }
}
