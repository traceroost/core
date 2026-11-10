/**
 * May TraceRoost touch this project folder — run git in it, stat it, read files from it?
 *
 * The one policy point behind the macOS cloud-storage rule (owner decision 2026-11-10): in the
 * desktop app and the standalone server / background service, TraceRoost does not touch anything
 * under `~/Library/CloudStorage/<Provider>` (OneDrive, Dropbox, Google Drive, Box — including
 * `~/Documents` / `~/Desktop` when OneDrive backs them up), because the first access makes macOS
 * ask "“TraceRoost.app” wants to access files managed by “OneDrive - Org”". Traces from such
 * projects still appear (they come from the agents' own logs) but without git outcome,
 * attribution/survival, repo identity from git or instruction-file checks — each reads as "not
 * available", exactly like a folder that isn't a git repo. `readCloudStorageProjects: true` in
 * `~/.traceroost/config.json` (or Settings → Projects in cloud storage) turns access back on.
 *
 * The VS Code extension is unaffected: VS Code already has access to the folders the user opens
 * in it. The host says which it is once, at startup — `configureProjectAccess({ host: 'standalone' })`
 * in standalone/server.ts (which the desktop app and the background service both run), `{ host:
 * 'extension' }` in src/extension.ts. Until then the guard is off, so unit tests and the one-shot
 * CLI subcommands a user types in their own terminal (`traceroost advise --repo …`) keep today's
 * behavior.
 *
 * Callers: actionLog.ts's `recordAction` (the shared wrapper nearly every git spawn goes through)
 * refuses a guarded cwd, so a new git call site is covered automatically; the few git runners
 * that don't use it, and every entry point that reads files or stats a project path
 * (gitOutcome.ts, repoKey.ts, attribution/, turnover/, instructionFiles.ts, summarizers/helpers.ts,
 * sessionRiskSignals.ts, repoRemote.ts, cloudBridge.core.ts, reconcile/backgroundWatcher.ts,
 * standalone/instructionActions.ts) ask `mayTouchProject` before any fs or git work.
 */

import * as os from 'os'
import { defaultCloudStoragePredicate, type CloudStoragePredicate } from './cloudStoragePaths'

export type ProjectAccessHost = 'extension' | 'standalone'

interface ProjectAccessState {
  host: ProjectAccessHost | null
  readCloudStorageProjects: boolean
  predicate: () => CloudStoragePredicate
  log: (msg: string) => void
  home: string
}

// Silent until a host passes its log (standalone/server.ts: console.log — the server log).
const defaultLog = (_msg: string) => {}

let state: ProjectAccessState = {
  host: null,
  readCloudStorageProjects: false,
  predicate: defaultCloudStoragePredicate,
  log: defaultLog,
  home: os.homedir(),
}

/** Provider roots already announced in the log — once per process per provider, not per session. */
const announced = new Set<string>()
/** Display names of providers whose projects were skipped, for Settings. */
const skippedProviders = new Map<string, string>()

export interface ProjectAccessOptions {
  host: ProjectAccessHost
  /** config.json's `readCloudStorageProjects` (standalone only). */
  readCloudStorageProjects?: boolean
  /** Where the once-per-provider notice goes (the server passes console.log — the server log). */
  log?: (msg: string) => void
  /** Tests: a predicate with a fake platform/home/fs. */
  predicate?: CloudStoragePredicate
  /** Tests: the home directory the notice abbreviates to `~`. */
  home?: string
}

/** Set once at startup by the host (see the module comment). Calling again replaces the settings. */
export function configureProjectAccess(opts: ProjectAccessOptions): void {
  const predicate = opts.predicate
  state = {
    host: opts.host,
    readCloudStorageProjects: opts.readCloudStorageProjects === true,
    predicate: predicate ? () => predicate : defaultCloudStoragePredicate,
    log: opts.log ?? defaultLog,
    home: opts.home ?? os.homedir(),
  }
  announced.clear()
  skippedProviders.clear()
}

/** Settings → Projects in cloud storage flips this at runtime (and persists it to config.json). */
export function setReadCloudStorageProjects(value: boolean): void {
  state.readCloudStorageProjects = value
  if (!value) announced.clear()
}

/** Back to the state before any host configured it (guard off). Tests only. */
export function resetProjectAccessForTests(): void {
  state = { host: null, readCloudStorageProjects: false, predicate: defaultCloudStoragePredicate, log: defaultLog, home: os.homedir() }
  announced.clear()
  skippedProviders.clear()
}

/** True when cloud-storage project folders are being skipped in this process. */
export function cloudStorageGuardActive(): boolean {
  return state.host === 'standalone' && !state.readCloudStorageProjects
}

function tildify(p: string): string {
  const home = state.home.replace(/\/+$/, '')
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
}

/**
 * Whether TraceRoost may run git in, stat, or read files under `p`. Empty / non-absolute paths
 * are not project folders and always pass (callers already treat '' as "no workspace").
 */
export function mayTouchProject(p: string | null | undefined): boolean {
  if (!p || !cloudStorageGuardActive()) return true
  const match = state.predicate().match(p)
  if (!match) return true
  skippedProviders.set(match.providerRoot, match.providerName)
  if (!announced.has(match.providerRoot)) {
    announced.add(match.providerRoot)
    // The provider root only — never the project path itself.
    state.log(
      `[TraceRoost] Skipping project folders in ${match.providerName} (${tildify(match.providerRoot)}): macOS would ask for access. ` +
      'Set readCloudStorageProjects: true in ~/.traceroost/config.json (or turn on Settings → Projects in cloud storage) to include them.',
    )
  }
  return false
}

/** Thrown by `assertMayTouchProject` — callers that already treat a failed git/fs call as "not
 *  available" need nothing more. */
export class ProjectAccessSkipped extends Error {
  constructor() {
    super('TraceRoost does not read projects in macOS cloud storage (readCloudStorageProjects is off).')
    this.name = 'ProjectAccessSkipped'
  }
}

export function assertMayTouchProject(p: string | null | undefined): void {
  if (!mayTouchProject(p)) throw new ProjectAccessSkipped()
}

export interface ProjectAccessStatus {
  /** Only macOS has cloud-storage File Provider prompts; elsewhere the setting does nothing. */
  applicable: boolean
  readCloudStorageProjects: boolean
  /** Providers whose project folders were skipped since startup (display names). */
  skippedProviders: string[]
}

export function projectAccessStatus(platform: NodeJS.Platform = process.platform): ProjectAccessStatus {
  return {
    applicable: platform === 'darwin',
    readCloudStorageProjects: state.readCloudStorageProjects,
    skippedProviders: [...new Set(skippedProviders.values())].sort(),
  }
}
