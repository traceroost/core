/**
 * Stages the collector the desktop app runs, into `desktop/resources/collector`.
 *
 * The layout is not a choice — it is dictated by how `standalone/server.js` resolves things
 * relative to its own `__dirname` (`../media`, `../package.json`, `require.resolve('sql.js')`).
 * Reproducing it exactly is what lets the collector run inside the app with no changes at all.
 *
 *   collector/package.json            → the version the collector reports and logs
 *   collector/standalone/server.js    → the collector itself (core edition)
 *   collector/media/…                 → the dashboard it serves
 *   collector/node_modules/sql.js/…   → `require.resolve('sql.js')` and its WASM
 *
 * About sql.js: the bundle has it inlined by esbuild, but the collector *also* calls
 * `require.resolve('sql.js')` to find the WASM file next to the package on disk
 * (`standalone/db/outcomesDb.ts`). That resolution cannot be bundled away, so the package has to
 * be present as a real directory or the commit-outcomes cache silently falls back to recomputing
 * everything. Hence a copied package rather than a copied `.wasm`.
 *
 * Builds the core edition itself before staging it, so there is one command to get this right and
 * no way to stage a stale (or full-edition) bundle by forgetting a step.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { spawnSync } from 'child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.join(here, '..')
const repoRoot = path.join(desktopDir, '..')
const out = path.join(desktopDir, 'resources', 'collector')

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

function requireFile(rel) {
  const from = path.join(repoRoot, rel)
  if (!fs.existsSync(from)) {
    throw new Error(`stage-resources: ${rel} is missing — the core-edition build above should have produced it.`)
  }
  return from
}

// ── Build the core edition ──
//
// From the repo root, not from here: esbuild.js resolves its entry points relative to the working
// directory, so running it from desktop/ fails to find src/extension.ts.
const build = spawnSync(process.execPath, [path.join(repoRoot, 'esbuild.js'), '--edition=core'], {
  cwd: repoRoot,
  stdio: 'inherit',
})
if (build.status !== 0) throw new Error('stage-resources: the core-edition build failed — see above.')

fs.rmSync(out, { recursive: true, force: true })

// ── The collector bundle ──
copyFile(requireFile('standalone/server.js'), path.join(out, 'standalone', 'server.js'))

// ── The dashboard assets the collector serves from ../media ──
// Only the extensions `resolveStaticFile` will serve; the .ts sources in media/src stay behind.
const mediaDir = path.join(repoRoot, 'media')
let mediaCount = 0
for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue
  if (!/\.(js|css|svg|png|woff2?|map)$/.test(entry.name)) continue
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
const require = createRequire(import.meta.url)
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

// ── Core-edition verification of what this app actually ships ──
//
// The build already refuses to bundle cloud modules in a core build, but the plan asks for
// after-the-fact verification of the artifact, and the artifact here is this staged tree rather
// than the repo's build output. `--tree`/`--bundles` point the repo's own checker at it, so the
// marker list stays in exactly one place. Note the tree ships no dist/extension.js: the desktop
// app runs the collector, not the VS Code extension.
const SHIPPED_BUNDLES = ['standalone/server.js', 'media/dashboard.js', 'media/sidebar.js']
const check = spawnSync(process.execPath, [
  path.join(repoRoot, 'scripts', 'check-edition.mjs'), 'core', '--skip-manifest',
  '--tree', out, '--bundles', SHIPPED_BUNDLES.join(','),
], { stdio: 'inherit' })
if (check.status !== 0) {
  throw new Error('stage-resources: the staged collector failed the core-edition check — see above.')
}

const bytes = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter(e => e.isFile())
  .reduce((sum, e) => sum + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size, 0)

console.log(`staged the collector into ${path.relative(process.cwd(), out)} — ${mediaCount} dashboard assets, ${(bytes(out) / 1024 / 1024).toFixed(1)} MB`)
