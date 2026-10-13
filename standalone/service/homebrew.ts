import * as fs from 'fs'
import * as path from 'path'

/**
 * Homebrew installs (`brew install traceroost/tap/traceroost`) — the second way, after npm's
 * global install, that a stable `traceroost` lands on disk for the background service to launch.
 *
 * Homebrew keeps each version in its own keg (`<prefix>/Cellar/traceroost/<version>/…`) and
 * points a version-less symlink at the current one (`<prefix>/opt/traceroost`). A service
 * definition must name the `opt` path, never the Cellar path: `brew upgrade` deletes the old keg,
 * and a launchd plist or systemd unit still naming it would fail on the next start. The same goes
 * for Node: Homebrew's `node` lives in a versioned keg too, so the service runs
 * `<prefix>/opt/node/bin/node`, which survives `brew upgrade node`.
 *
 * Everything here is a pure function of paths (and of what exists on disk), so it is tested
 * without Homebrew installed.
 */

export interface HomebrewInstall {
  /** Homebrew's prefix: `/opt/homebrew` (Apple silicon), `/usr/local` (Intel macOS),
   *  `/home/linuxbrew/.linuxbrew` (Linux), or wherever a custom install lives. */
  prefix: string
  /** The formula this copy was installed from (`traceroost`). */
  formula: string
  /** The running cli.js through `<prefix>/opt/<formula>/…` — stable across `brew upgrade`. */
  stableCliPath: string
  /** The installed package's directory through the same `opt` link, for reading its version. */
  stablePackageDir: string
}

function realpathOrSelf(p: string): string {
  try { return fs.realpathSync.native(p) } catch { return path.resolve(p) }
}

/** Splits `<prefix>/Cellar/<formula>/<version>/<rest>` (after resolving symlinks, so the
 *  `<prefix>/bin/traceroost` and `<prefix>/opt/traceroost` links both land here). */
function splitCellarPath(p: string): { prefix: string; formula: string; rest: string } | undefined {
  const parts = p.split(path.sep)
  const i = parts.lastIndexOf('Cellar')
  if (i < 1 || parts.length < i + 4) return undefined
  const prefix = parts.slice(0, i).join(path.sep) || path.sep
  return { prefix, formula: parts[i + 1], rest: parts.slice(i + 3).join(path.sep) }
}

/** The Homebrew install the running `cli.js` belongs to, or undefined for npm, npx, a dev
 *  checkout or anything else. `packageName` is the npm package inside the keg
 *  (`<keg>/libexec/lib/node_modules/<packageName>/…`). */
export function detectHomebrewInstall(cliPath: string, packageName: string): HomebrewInstall | undefined {
  if (!cliPath) return undefined
  const cellar = splitCellarPath(realpathOrSelf(cliPath))
  if (!cellar) return undefined
  const marker = path.join('node_modules', packageName) + path.sep
  const at = cellar.rest.indexOf(marker)
  if (at < 0) return undefined
  const optRoot = path.join(cellar.prefix, 'opt', cellar.formula)
  return {
    prefix: cellar.prefix,
    formula: cellar.formula,
    stableCliPath: path.join(optRoot, cellar.rest),
    stablePackageDir: path.join(optRoot, cellar.rest.slice(0, at + marker.length - 1)),
  }
}

/** Where Homebrew is usually installed, `HOMEBREW_PREFIX` (set by `brew shellenv`) first. */
export function homebrewPrefixes(env: NodeJS.ProcessEnv): string[] {
  const all = [env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew']
  return [...new Set(all.filter((p): p is string => typeof p === 'string' && p.length > 0))]
}

/** A Homebrew-installed copy of `packageName` under any of `prefixes`, found through its `opt`
 *  link — what `npx traceroost@latest service install` hands off to instead of installing a second
 *  copy with npm (which would also collide with Homebrew's `bin/traceroost`). */
export function findHomebrewCopy(packageName: string, prefixes: string[]): HomebrewInstall | undefined {
  for (const prefix of prefixes) {
    const cli = path.join(prefix, 'opt', packageName, 'libexec', 'lib', 'node_modules', packageName, 'standalone', 'cli.js')
    if (!fs.existsSync(cli)) continue
    const install = detectHomebrewInstall(cli, packageName)
    if (install) return install
  }
  return undefined
}

/** The Node binary a Homebrew-installed service should run. When `execPath` is Homebrew's own
 *  versioned `node` (`<prefix>/Cellar/node[@N]/<version>/bin/node`), the matching
 *  `<prefix>/opt/node[@N]/bin/node` if it exists; otherwise `execPath` unchanged (nvm, a system
 *  Node, the official installer — none of which move on upgrade the way a keg does). */
export function stableNodePath(execPath: string): string {
  const cellar = splitCellarPath(realpathOrSelf(execPath))
  if (!cellar || !/^node(@\d+)?$/.test(cellar.formula)) return execPath
  const candidate = path.join(cellar.prefix, 'opt', cellar.formula, cellar.rest)
  return fs.existsSync(candidate) ? candidate : execPath
}

/** `brew` itself — Homebrew always installs it at `<prefix>/bin/brew`, so this works even when
 *  the shell's PATH doesn't include Homebrew (a service manager's environment, for one). */
export function brewExecutable(prefix: string): string {
  return path.join(prefix, 'bin', 'brew')
}

/** The installed package's version, read through the `opt` link — after `brew upgrade` that is
 *  the new keg. */
export function readHomebrewVersion(install: HomebrewInstall): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(install.stablePackageDir, 'package.json'), 'utf-8')).version
  } catch {
    return undefined
  }
}

/** The name to hand `brew upgrade`: tap-qualified (`traceroost/tap/traceroost`) when the keg's
 *  install receipt names its tap, since a bare `traceroost` is ambiguous — and refused — as soon as
 *  a second tap also has a formula by that name; the bare formula name when it doesn't. */
export function brewFormulaRef(install: HomebrewInstall): string {
  try {
    const receipt = JSON.parse(
      fs.readFileSync(path.join(install.prefix, 'opt', install.formula, 'INSTALL_RECEIPT.json'), 'utf-8'),
    ) as { source?: { tap?: unknown } }
    const tap = receipt.source?.tap
    if (typeof tap === 'string' && /^[\w.-]+\/[\w.-]+$/.test(tap) && tap !== 'homebrew/core') {
      return `${tap}/${install.formula}`
    }
  } catch { /* no receipt, or not JSON: the bare name */ }
  return install.formula
}

/** Condenses whatever `child_process` threw when `brew upgrade` failed into one short clause. */
export function describeBrewFailure(err: unknown): string {
  const e = (err ?? {}) as { code?: string; status?: number; message?: string }
  if (e.code === 'ENOENT') return 'brew was not found'
  if (typeof e.status === 'number') return `brew exited with code ${e.status} — see its output above`
  if (e.code) return `brew could not be run (${e.code})`
  return e.message ? e.message.split('\n')[0] : 'unknown error'
}
