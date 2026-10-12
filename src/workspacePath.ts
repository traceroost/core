/**
 * Whether a session's recorded workspace is `root` itself or a directory inside it. A bare
 * `startsWith(root)` also matched siblings sharing a prefix (`/repo-old` for `/repo`), pulling
 * another project's sessions into this one's suggestions and telemetry. Compared with a path
 * separator after `root`; either separator counts (a Windows workspace recorded with `/`).
 * Local-only module (MIT).
 */
export function isSameOrInsideWorkspace(candidate: string | undefined | null, root: string): boolean {
  if (!candidate || !root) return false
  const trim = (p: string) => p.replace(/[\\/]+$/, '')
  const c = trim(candidate)
  const r = trim(root)
  if (!r) return false
  if (c === r) return true
  return c.startsWith(r) && (c[r.length] === '/' || c[r.length] === '\\')
}
