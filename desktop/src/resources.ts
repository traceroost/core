/**
 * Where the bundled collector lives, and which runtime runs it.
 *
 * The app ships the standalone collector as a *staged tree* rather than as loose files, because
 * `standalone/server.js` resolves things relative to its own `__dirname`: `../media` for the
 * dashboard assets, `../package.json` for the version it reports and logs, and
 * `require.resolve('sql.js')` for the SQLite reader and its WASM. Reproducing that layout exactly
 * (see scripts/stage-resources.mjs) means the collector runs packaged with no changes at all —
 * which is the point. A forked copy of ingestion or asset serving for the desktop build would be a
 * second implementation to keep in step, and the plan rules that out.
 *
 *   <root>/package.json
 *   <root>/standalone/server.js
 *   <root>/media/…
 *   <root>/node_modules/sql.js/…
 *
 * The runtime is Electron's own binary re-entered as Node (`ELECTRON_RUN_AS_NODE=1`). Electron
 * 44.7.1 bundles Node 24.21.0, which satisfies this repo's `"node": ">=22"` engine requirement, so
 * no separate Node is packaged and the user needs none installed. That pairing is the thing to
 * re-check on every Electron major: see desktop/README.md.
 */

import * as fs from 'fs'
import * as path from 'path'

/** Minimum Node the collector is supported on — `package.json`'s `engines.node`. Asserted against
 *  the runtime actually about to run it, so an Electron upgrade that regressed below it fails
 *  loudly at startup instead of producing syntax errors from the collector bundle. */
export const MIN_COLLECTOR_NODE_MAJOR = 22

export interface CollectorResources {
  /** The staged tree's root — the directory holding package.json, standalone/, media/. */
  root: string
  /** The script to run. */
  serverScript: string
  /** Version read from the staged package.json. */
  version: string
}

/**
 * Resolves the staged tree.
 *
 * Packaged, it sits in `process.resourcesPath` (outside the asar, since the collector is run as a
 * child process and `require.resolve` cannot reach into an archive). In development it is
 * `desktop/resources/collector`, produced by `pnpm run stage`.
 */
export function resolveCollectorResources(opts: {
  isPackaged: boolean
  resourcesPath: string
  devRoot: string
}): CollectorResources {
  const root = opts.isPackaged
    ? path.join(opts.resourcesPath, 'collector')
    : path.join(opts.devRoot, 'resources', 'collector')
  const serverScript = path.join(root, 'standalone', 'server.js')
  if (!fs.existsSync(serverScript)) {
    throw new Error(
      `The bundled collector is missing: ${serverScript} does not exist.` +
      (opts.isPackaged ? ' This build is incomplete.' : ' Run `pnpm run stage` in desktop/ first.'),
    )
  }
  let version = 'unknown'
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version?: string }
    version = manifest.version ?? 'unknown'
  } catch {
    // Left as 'unknown'. readPackageManifest in the collector degrades the same way rather than
    // refusing to start, and handshake.ts treats an unknown version as needing confirmation —
    // never as compatible.
  }
  return { root, serverScript, version }
}

/** Throws when the runtime about to run the collector is older than it supports. */
export function assertRuntimeSupportsCollector(nodeVersion: string): void {
  const major = Number(nodeVersion.replace(/^v/, '').split('.')[0])
  if (!Number.isFinite(major) || major < MIN_COLLECTOR_NODE_MAJOR) {
    throw new Error(
      `This build runs the collector on Node ${nodeVersion}, but TraceRoost requires Node ` +
      `>=${MIN_COLLECTOR_NODE_MAJOR}. The bundled Electron runtime is too old for it.`,
    )
  }
}
