import * as fs from 'fs'
import * as path from 'path'

/** Canonical absolute form of `p`: symlinks resolved when the path exists, otherwise just
 *  `path.resolve`d (a missing path can't be a symlink we'd be fooled by). */
function canonicalPath(p: string): string {
  try { return fs.realpathSync.native(p) } catch { return path.resolve(p) }
}

/** True when `file` is `dir` itself or lies anywhere beneath it, after resolving symlinks on both
 *  sides. Launched through npm's global bin link on macOS/Linux, `process.argv[1]` is the symlink
 *  (`<prefix>/bin/traceroost`), not the package's `standalone/cli.js` — and `npm root -g` itself
 *  may sit under a symlinked prefix (e.g. macOS's `/var` → `/private/var`, Homebrew links) — so a
 *  plain string-prefix comparison never matched and `service install` skipped its upgrade step. */
export function isPathInsideDir(file: string, dir: string): boolean {
  if (!file || !dir) { return false }
  const realFile = canonicalPath(file)
  const realDir = canonicalPath(dir)
  const rel = path.relative(realDir, realFile)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}
