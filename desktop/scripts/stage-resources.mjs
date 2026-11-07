/**
 * Stages the collector the desktop app runs, into `desktop/resources/collector`.
 *
 * The layout is not a choice — it is dictated by how `standalone/server.js` resolves things
 * relative to its own `__dirname` (`../media`, `../package.json`, `require.resolve('sql.js')`).
 * Reproducing it exactly is what lets the collector run inside the app with no changes at all.
 *
 *   collector/package.json            → the version the collector reports and logs
 *   collector/standalone/server.js    → the collector itself (the desktop edition — see below)
 *   collector/media/…                 → the dashboard it serves
 *   collector/node_modules/sql.js/…   → `require.resolve('sql.js')` and its WASM
 *
 * About sql.js: the bundle has it inlined by esbuild, but the collector *also* calls
 * `require.resolve('sql.js')` to find the WASM file next to the package on disk
 * (`standalone/db/outcomesDb.ts`). That resolution cannot be bundled away, so the package has to
 * be present as a real directory or the commit-outcomes cache silently falls back to recomputing
 * everything. Hence a copied package rather than a copied `.wasm`.
 *
 * Builds the collector itself before staging it, so there is one command to get this right and
 * no way to stage a stale (or wrong-edition) bundle by forgetting a step.
 *
 * Edition: `TRACEROOST_DESKTOP_EDITION` (scripts/edition.cjs; unset = `core`). The release edition
 * flows into it from release.yml, so a core release ships a core collector and a full release a
 * full one (TraceRoost Cloud's org link + upload, the dashboard's Org panel).
 *   core   `esbuild.js --edition=core`.
 *   full   `esbuild.js --edition=full`.
 * With `--release` (build:release) either edition is also built `--production`, like the
 * npm/VSIX/Docker release builds: the public links a core build carries (the header's "Make a
 * suggestion", the Cloud page — media/src/suggest.ts, media/src/cloudInfo.ts) point at
 * production, not stage, and a full collector is pinned to production TraceRoost Cloud and reads
 * no `.env` (src/cloud/org/config.ts's resolveOrgEnvironment). The production build writes its
 * maps externally (TRACEROOST_EXTERNAL_SOURCEMAPS) for third-party-notices.mjs, and the maps are
 * not staged.
 * Either way the staged tree is checked against that edition with scripts/check-edition.mjs, and
 * the edition is stamped beside it for afterPack.cjs.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { spawnSync } from 'child_process'

const require = createRequire(import.meta.url)
const { desktopEdition, EDITION_STAMP } = require('./edition.cjs')

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.join(here, '..')
const repoRoot = path.join(desktopDir, '..')
const out = path.join(desktopDir, 'resources', 'collector')
const edition = desktopEdition()
const release = process.argv.includes('--release')

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

function requireFile(rel) {
  const from = path.join(repoRoot, rel)
  if (!fs.existsSync(from)) {
    throw new Error(`stage-resources: ${rel} is missing — the ${edition}-edition build above should have produced it.`)
  }
  return from
}

// ── Build the collector, in the desktop edition ──
//
// From the repo root, not from here: esbuild.js resolves its entry points relative to the working
// directory, so running it from desktop/ fails to find src/extension.ts.
const production = release
const build = spawnSync(process.execPath, [
  path.join(repoRoot, 'esbuild.js'), ...(production ? ['--production'] : []), `--edition=${edition}`,
], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: production ? { ...process.env, TRACEROOST_EXTERNAL_SOURCEMAPS: '1' } : process.env,
})
if (build.status !== 0) throw new Error(`stage-resources: the ${edition}-edition build failed — see above.`)

fs.rmSync(out, { recursive: true, force: true })

// ── The collector bundle ──
copyFile(requireFile('standalone/server.js'), path.join(out, 'standalone', 'server.js'))

// ── The dashboard assets the collector serves from ../media ──
// Only the extensions `resolveStaticFile` will serve; the .ts sources in media/src stay behind.
// (A full release build's external .map files stay behind too: they are for the notices, not the app.)
const mediaDir = path.join(repoRoot, 'media')
let mediaCount = 0
for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue
  if (!/\.(js|css|svg|png|woff2?|map)$/.test(entry.name)) continue
  if (production && entry.name.endsWith('.map')) continue
  copyFile(path.join(mediaDir, entry.name), path.join(out, 'media', entry.name))
  mediaCount++
}
if (mediaCount === 0) throw new Error('stage-resources: no dashboard assets found in media/ — build the repo first.')

// ── The manifest the collector reads its own version out of ──
// Trimmed to what `readPackageManifest` reads, so the app does not ship the extension's full
// manifest (contributes, scripts, devDependencies) as a confusing near-duplicate.
const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'))
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify({
    name: rootManifest.name,
    version: rootManifest.version,
    private: true,
    description: 'Staged TraceRoost collector for the desktop app — see desktop/scripts/stage-resources.mjs',
    license: rootManifest.license,
  }, null, 2) + '\n',
)

// ── sql.js, as a resolvable package ──
const sqlJsMain = require.resolve('sql.js', { paths: [repoRoot] })
const sqlJsRoot = path.resolve(path.dirname(sqlJsMain), '..')
const sqlJsOut = path.join(out, 'node_modules', 'sql.js')
copyFile(path.join(sqlJsRoot, 'package.json'), path.join(sqlJsOut, 'package.json'))
for (const name of ['sql-wasm.js', 'sql-wasm.wasm']) {
  copyFile(path.join(sqlJsRoot, 'dist', name), path.join(sqlJsOut, 'dist', name))
}

// Prove the layout works before anyone ships it: resolve sql.js the way the collector will.
const stagedRequire = createRequire(path.join(out, 'standalone', 'server.js'))
const resolved = stagedRequire.resolve('sql.js')
if (!resolved.startsWith(sqlJsOut)) {
  throw new Error(`stage-resources: sql.js resolved to ${resolved}, outside the staged tree — the collector would read the wrong copy.`)
}
if (!fs.existsSync(path.join(path.dirname(resolved), 'sql-wasm.wasm'))) {
  throw new Error('stage-resources: sql-wasm.wasm is not beside the resolved sql.js — the outcomes cache would fall back to recomputing.')
}

// ── Edition verification of what this app actually ships ──
//
// The build already refuses to bundle cloud modules in a core build, but the plan asks for
// after-the-fact verification of the artifact, and the artifact here is this staged tree rather
// than the repo's build output. `--tree`/`--bundles` point the repo's own checker at it, so the
// marker list stays in exactly one place: for `core` no Cloud marker may appear, for `full` the
// collector and the dashboard must carry them (the Org route and panel are really there). Note
// the tree ships no dist/extension.js: the desktop app runs the collector, not the VS Code
// extension.
const SHIPPED_BUNDLES = ['standalone/server.js', 'media/dashboard.js', 'media/sidebar.js']
const check = spawnSync(process.execPath, [
  path.join(repoRoot, 'scripts', 'check-edition.mjs'), edition, '--skip-manifest',
  '--tree', out, '--bundles', SHIPPED_BUNDLES.join(','),
], { stdio: 'inherit' })
if (check.status !== 0) {
  throw new Error(`stage-resources: the staged collector failed the ${edition}-edition check — see above.`)
}
fs.writeFileSync(path.join(desktopDir, 'resources', EDITION_STAMP), `${edition}\n`)

const bytes = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter(e => e.isFile())
  .reduce((sum, e) => sum + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size, 0)

console.log(`staged the ${edition}-edition collector${production ? ' (production)' : ''} into ${path.relative(process.cwd(), out)} — ${mediaCount} dashboard assets, ${(bytes(out) / 1024 / 1024).toFixed(1)} MB`)
