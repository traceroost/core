/**
 * Bundles the desktop main process to `out/main.js`.
 *
 * esbuild rather than `tsc` for the same reason the rest of the repo uses it: the shell imports
 * from `src/` and `standalone/`, and bundling means one file with no `rootDir` gymnastics and no
 * runtime dependency on a compiled tree laid out just so. `tsc --noEmit` still type-checks it
 * (`pnpm run check-types`), so nothing is traded away.
 *
 * `electron` is external — it is resolved from the Electron runtime at run time, never bundled.
 * The edition define matches esbuild.js at the repo root's core edition, so any Cloud branch folds
 * away here exactly as it does in the core npm build. It stays `core` even when the app is built as
 * the full edition (TRACEROOST_DESKTOP_EDITION=full, scripts/edition.cjs): the shell itself never
 * carries Cloud code — org linking lives in the collector it spawns, which stage-resources.mjs
 * builds in the desktop edition — and afterPack.cjs checks this bundle against the core markers.
 */

import * as esbuild from 'esbuild'
import * as path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const production = process.argv.includes('--production')

await esbuild.build({
  entryPoints: [path.join(here, 'src', 'main.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  outfile: path.join(here, 'out', 'main.js'),
  external: ['electron'],
  sourcemap: !production,
  sourcesContent: false,
  minify: false,
  define: {
    'process.env.TRACEROOST_RELEASE_BUILD': production ? '"1"' : '""',
    'process.env.TRACEROOST_EDITION': '"core"',
  },
  logLevel: 'info',
})
