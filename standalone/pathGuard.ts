import * as path from 'path'

/** `child` resolves to somewhere strictly beneath `parent` (not `parent` itself) — lexically, so a
 *  file that doesn't exist yet still checks correctly. The standalone server's counterpart of
 *  src/dashboardPanel.ts's isPathInside guard on applying an instruction suggestion. */
export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(parent, child))
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

/** The file under `root` a request path names, or null when it resolves outside `root` (or to
 *  `root` itself). The standalone dashboard serves media/ this way: a plain
 *  `filePath.startsWith(root)` check let `/../media-other/x.js` through, because the sibling
 *  folder's path begins with the same characters as `root`'s. */
export function resolveStaticFile(root: string, urlPath: string): string | null {
  const filePath = path.join(root, urlPath)
  return isStrictlyInside(root, filePath) ? filePath : null
}
