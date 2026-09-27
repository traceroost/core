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

/** Starts a background check now (fire-and-forget) and re-checks every `REFRESH_INTERVAL_MS` for
 *  as long as the process lives. Call once, near server startup. */
export function startVersionCheckLoop(currentVersion: string, packageName = 'traceroost'): void {
  cache = { ...cache, currentVersion }
  void refresh(currentVersion, packageName)
  setInterval(() => {
    if (Date.now() - lastAttemptAt < REFRESH_INTERVAL_MS) { return }
    void refresh(currentVersion, packageName)
  }, REFRESH_INTERVAL_MS).unref()
}
