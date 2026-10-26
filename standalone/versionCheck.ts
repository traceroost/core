/** Checks whether a newer version of this package has been published to npm, so the standalone
 *  dashboard (npx / global install / Docker / background service) can surface an "update
 *  available" notice — VS Code never imports this, since it updates through the Marketplace, not
 *  npm. Keeps a small in-memory cache so opening many browser tabs against a long-running server
 *  doesn't hit the registry once per tab, and a failed check never erases a previously-successful
 *  "update available" result. */

export interface VersionCheckResult {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  checkedAt: string | null
  error: string | null
}

const REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000 // 8h — a long-lived service doesn't need it tighter

let cache: VersionCheckResult = {
  currentVersion: '',
  latestVersion: null,
  updateAvailable: false,
  checkedAt: null,
  error: null,
}
let lastAttemptAt = 0

/** Numeric dot-separated version comparison (no semver dependency exists in this repo). Strips
 *  any `-`/`+` prerelease/build suffix first. Treats a malformed segment as 0, and any unparsable
 *  input as "not newer" — fails safe toward no banner rather than a false positive. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => v.split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0)
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    if (ai !== bi) { return ai > bi }
  }
  return false
}

/** Fetches `https://registry.npmjs.org/<packageName>/latest` and returns just the version
 *  string, or null on any failure (offline, timeout, non-200, malformed body). */
export async function fetchLatestPublishedVersion(packageName: string, timeoutMs = 3000): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) { return null }
    const body = await res.json() as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

async function refresh(currentVersion: string, packageName: string): Promise<void> {
  lastAttemptAt = Date.now()
  const latestVersion = await fetchLatestPublishedVersion(packageName)
  if (latestVersion) {
    cache = {
      currentVersion,
      latestVersion,
      updateAvailable: isNewerVersion(latestVersion, currentVersion),
      checkedAt: new Date().toISOString(),
      error: null,
    }
  } else {
    // Keep any previously-successful latestVersion/checkedAt — a transient offline blip
    // shouldn't erase a real "update available" state already shown to the user.
    cache = { ...cache, currentVersion, error: 'Could not reach the npm registry' }
  }
}

/** Returns the cached result immediately. Safe to call on every request — it never itself
 *  triggers a network call. */
export function getCachedVersionCheck(currentVersion: string): VersionCheckResult {
  return { ...cache, currentVersion }
}

/** `TRACEROOST_NO_UPDATE_CHECK=1` (or `true`) turns the npm check off entirely — the only request
 *  the standalone server makes to the internet on its own. */
export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.TRACEROOST_NO_UPDATE_CHECK?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

/** Starts a background check now and re-checks every `REFRESH_INTERVAL_MS` for as long as the
 *  process lives. Call once, near server startup. Does nothing beyond recording the current version
 *  when `updateCheckDisabled()` — no fetch, no timer. Resolves with the first check's result once
 *  it's in (null when disabled), for a caller that wants to act on it; nothing needs to await it. */
export function startVersionCheckLoop(currentVersion: string, packageName = 'traceroost'): Promise<VersionCheckResult | null> {
  cache = { ...cache, currentVersion }
  if (updateCheckDisabled()) { return Promise.resolve(null) }
  const first = refresh(currentVersion, packageName).then(() => getCachedVersionCheck(currentVersion))
  setInterval(() => {
    if (Date.now() - lastAttemptAt < REFRESH_INTERVAL_MS) { return }
    void refresh(currentVersion, packageName)
  }, REFRESH_INTERVAL_MS).unref()
  return first
}

/** What to print when launched through npx, which can serve a stale cached copy. With the first
 *  version check's answer (the check the server makes anyway — no extra request), only when this
 *  copy really is older than npm's latest; with no answer (check disabled, or npm unreachable),
 *  the general reminder, since a stale copy can't be ruled out. */
export function npxCachedCopyNotice(result: VersionCheckResult | null): string | null {
  if (result && result.latestVersion !== null) {
    return result.updateAvailable
      ? `[TraceRoost] Launched via npx, which served a cached copy: this is v${result.currentVersion}, but v${result.latestVersion} is out. Re-run as \`npx traceroost@latest\` (or clear npx's cache with \`rm -rf ~/.npm/_npx\`).`
      : null
  }
  return '[TraceRoost] Launched via npx — if this isn\'t the version you expect, npx served a cached copy. Re-run as `npx traceroost@latest` (or clear it with `rm -rf ~/.npm/_npx`).'
}

/** Where the desktop app's new builds are published (README's Desktop app section links here too). */
export const DESKTOP_RELEASES_URL = 'https://github.com/traceroost/core/releases/latest'

export interface UpdateAdvice {
  isService: boolean
  isDocker: boolean
  /** The collector the desktop app spawned (desktop/src/collector.ts sets TRACEROOST_DESKTOP=1). */
  isDesktop: boolean
  recommendedCommand: string
  /** Set when the update is a download rather than a command (the desktop app). */
  recommendedUrl?: string
}

/** Five ways to be running, five different ways to update: an OS-native background service
 *  (src/serviceConfig.ts's generators set TRACEROOST_SERVICE=1) updates in place (through npm or
 *  brew, whichever installed it); the Docker image (its Dockerfile sets TRACEROOST_DOCKER=1) needs a
 *  new image and a re-created container; the desktop app's own collector is updated by downloading
 *  the new app from GitHub Releases (there is no Node or npm to run a command with); a Homebrew
 *  install run by hand is pointed at the service, which upgrades through brew; anything else (npx,
 *  a global install) is pointed at the background service through npx. */
export function updateAdvice(env: NodeJS.ProcessEnv, isHomebrewInstall: () => boolean): UpdateAdvice {
  const isService = env.TRACEROOST_SERVICE === '1'
  const isDocker = !isService && env.TRACEROOST_DOCKER === '1'
  const isDesktop = !isService && !isDocker && env.TRACEROOST_DESKTOP === '1'
  if (isService) return { isService, isDocker, isDesktop, recommendedCommand: 'traceroost service update' }
  if (isDocker) return { isService, isDocker, isDesktop, recommendedCommand: 'docker pull traceroost/traceroost' }
  if (isDesktop) return { isService, isDocker, isDesktop, recommendedCommand: '', recommendedUrl: DESKTOP_RELEASES_URL }
  return {
    isService, isDocker, isDesktop,
    recommendedCommand: isHomebrewInstall() ? 'traceroost service install' : 'npx traceroost@latest service install',
  }
}
