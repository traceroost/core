import * as path from 'path'

/** `child` resolves to somewhere strictly beneath `parent` (not `parent` itself) — lexically, so a
 *  file that doesn't exist yet still checks correctly. The standalone server's counterpart of
 *  src/dashboardPanel.ts's isPathInside guard on applying an instruction suggestion. */
export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(parent, child))
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}
