/**
 * Is a project folder inside a macOS cloud-storage provider (OneDrive, Dropbox, Google Drive, Box…)?
 *
 * On macOS those providers are File Provider domains under `~/Library/CloudStorage/<Provider>`, and
 * the first time a process touches anything in one — a stat, a readdir, a `git` run with it as the
 * cwd — macOS asks the user "“TraceRoost.app” wants to access files managed by “OneDrive - Org”".
 * OneDrive's "Desktop & Documents" backup turns `~/Desktop` and `~/Documents` into symlinks into
 * `~/Library/CloudStorage/OneDrive-*`, so a project under `~/Documents` counts too.
 *
 * The check must not cause the very prompt it exists to avoid: it never stats, lists, opens or
 * resolves (realpath) anything inside `~/Library/CloudStorage`. It only `lstat`s / `readlink`s path
 * components that lie outside it (e.g. `~/Documents` itself) and resolves a link's target as a
 * string (`path.resolve(dirname(link), readlink(link))`). `~/Library/Mobile Documents` (iCloud
 * Drive) is Apple's own and never prompts, so it is not cloud storage here.
 *
 * Pure apart from those lstat/readlink calls, which go through an injectable `fs` so tests can
 * prove nothing under CloudStorage is touched. The policy that decides whether to *act* on this
 * answer (desktop app / standalone server vs the VS Code extension) is src/projectAccess.ts.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** The only fs calls the predicate makes — never on a path inside CloudStorage. */
export interface CloudStorageFs {
  lstatSync(p: string): { isSymbolicLink(): boolean }
  readlinkSync(p: string): string
}

export interface CloudStorageEnv {
  platform: NodeJS.Platform
  home: string
  fs: CloudStorageFs
}

export interface CloudStorageMatch {
  /** `<home>/Library/CloudStorage/<Provider>` — the provider's root, never a project path. */
  providerRoot: string
  /** The provider folder's name as Finder shows it (`OneDrive - Org`, `Dropbox`, `Google Drive`). */
  providerName: string
}

export interface CloudStoragePredicate {
  isCloudStoragePath(p: string): boolean
  /** The provider `p` lives in, or null when it isn't in cloud storage. */
  match(p: string): CloudStorageMatch | null
}

// A path is resolved through at most this many symlinks before giving up (as "not cloud storage").
const MAX_LINK_HOPS = 16
// Component lstat results are cached per process; bounded so a pathological stream of distinct
// paths can't grow it without limit (it is simply cleared and refilled).
const MAX_CACHED_COMPONENTS = 10_000

/** `OneDrive-Org` → `OneDrive - Org`, `GoogleDrive-me@x.com` → `Google Drive - me@x.com`. */
export function providerDisplayName(folder: string): string {
  const m = /^(OneDrive|GoogleDrive|Box|Dropbox)-(.+)$/.exec(folder)
  const brand = (b: string) => (b === 'GoogleDrive' ? 'Google Drive' : b)
  if (m) return `${brand(m[1])} - ${m[2]}`
  return brand(folder)
}

export function createCloudStoragePredicate(env: CloudStorageEnv): CloudStoragePredicate {
  const p = path.posix
  const home = p.resolve(env.home)
  const cloudRoot = p.join(home, 'Library', 'CloudStorage')
  // macOS volumes are case-insensitive by default: `~/library/cloudstorage/…` is the same folder.
  const lower = (s: string) => s.toLowerCase()
  const cloudRootLower = lower(cloudRoot)
  const homeLower = lower(home)

  /** Resolved target of a symlink at `component`, or null if it isn't one (or can't be read).
   *  Only ever called for components outside CloudStorage. */
  const linkTargets = new Map<string, string | null>()
  function linkTarget(component: string): string | null {
    const hit = linkTargets.get(component)
    if (hit !== undefined) return hit
    let target: string | null = null
    try {
      if (env.fs.lstatSync(component).isSymbolicLink()) {
        target = p.resolve(p.dirname(component), env.fs.readlinkSync(component))
      }
    } catch { /* missing or unreadable: not a link we can follow */ }
    if (linkTargets.size >= MAX_CACHED_COMPONENTS) linkTargets.clear()
    linkTargets.set(component, target)
    return target
  }

  function underCloudRoot(abs: string): boolean {
    const l = lower(abs)
    return l === cloudRootLower || l.startsWith(cloudRootLower + '/')
  }

  function underHome(abs: string): boolean {
    return lower(abs).startsWith(homeLower + '/')
  }

  function matchFor(abs: string): CloudStorageMatch {
    const rest = abs.slice(cloudRoot.length + 1).split('/').filter(Boolean)
    const folder = rest[0] ?? ''
    return {
      providerRoot: folder ? p.join(cloudRoot, folder) : cloudRoot,
      providerName: folder ? providerDisplayName(folder) : 'cloud storage',
    }
  }

  function match(input: string): CloudStorageMatch | null {
    if (env.platform !== 'darwin') return null
    if (!input || !p.isAbsolute(input)) return null
    let abs = p.resolve(input)
    for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
      if (underCloudRoot(abs)) return matchFor(abs)
      // Only components inside the home directory can lead into ~/Library/CloudStorage via the
      // Desktop & Documents backup; anything else (e.g. /Volumes, /opt) is left alone.
      if (!underHome(abs)) return null
      const parts = abs.slice(home.length + 1).split('/').filter(Boolean)
      let redirected = false
      let component = home
      for (let i = 0; i < parts.length; i++) {
        component = p.join(component, parts[i])
        // Never lstat a component inside CloudStorage (a later loop iteration catches it as a
        // string match before getting here, but stay defensive).
        if (underCloudRoot(component)) return matchFor(p.join(component, ...parts.slice(i + 1)))
        const target = linkTarget(component)
        if (target !== null) {
          abs = p.join(target, ...parts.slice(i + 1))
          redirected = true
          break
        }
      }
      if (!redirected) return null
    }
    return null
  }

  return {
    match,
    isCloudStoragePath: (input: string) => match(input) !== null,
  }
}

let defaultPredicate: CloudStoragePredicate | undefined

/** The process-wide predicate: the real platform, home directory and fs. */
export function defaultCloudStoragePredicate(): CloudStoragePredicate {
  if (!defaultPredicate) {
    defaultPredicate = createCloudStoragePredicate({ platform: process.platform, home: os.homedir(), fs })
  }
  return defaultPredicate
}

/** True when `p` is inside a macOS cloud-storage provider (always false off macOS). */
export function isCloudStoragePath(p: string): boolean {
  return defaultCloudStoragePredicate().isCloudStoragePath(p)
}
