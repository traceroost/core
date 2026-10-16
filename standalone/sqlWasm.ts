/**
 * Where the standalone server finds sql.js's `sql-wasm.wasm`.
 *
 * sql.js's JavaScript is bundled into standalone/server.js at build time, but its .wasm is loaded
 * from disk at runtime, and the two must come from the same sql.js release: the wasm's import table
 * changes between versions, and a mismatch fails at startup with a `LinkError` ("function import
 * requires a callable"), silently losing the OpenCode database reads and the git-outcome cache.
 * That is exactly what happened when the wasm came from a consumer's own `node_modules/sql.js`:
 * npm resolved the `^1.14.2` dependency to 1.15.0 while the bundle still held 1.14.2's glue.
 *
 * So the wasm is read from this package's own dist/ first — esbuild copies it there from the
 * sql.js the bundle was built from (`copySqlWasm` in esbuild.js), the npm tarball ships it
 * (`dist/*.wasm` in package.json `files`) and the Docker image copies it next to server.js —
 * and sql.js is no longer a runtime dependency of the npm package at all. `node_modules/sql.js`
 * is only the fallback for the unbundled case (the test build under out/, where `require('sql.js')`
 * is the real package and its own wasm is the matching one).
 */

import * as fs from 'fs'
import * as path from 'path'

/** The directory holding `sql-wasm.wasm`, or undefined when neither location has it. */
export function sqlWasmDir(bundleDir: string = __dirname): string | undefined {
  const dist = path.join(bundleDir, '..', 'dist')
  if (fs.existsSync(path.join(dist, 'sql-wasm.wasm'))) return dist
  try {
    return path.dirname(require.resolve('sql.js'))
  } catch {
    return undefined
  }
}
