/**
 * electron-builder `afterPack` hook: verifies the packed .app before it is signed or wrapped in a
 * DMG. Everything here fails the build, because each is a mistake that produces a perfectly
 * normal-looking artifact that then does nothing (or the wrong thing) when launched:
 *
 *  - the staged collector is where src/resources.ts will look for it, with the dashboard assets,
 *    the manifest and sql.js's WASM at the depths standalone/server.js expects;
 *  - the tray icons and the license files made it in as extraResources;
 *  - the collector's version is the version on the box — the staged package.json, the repo's
 *    package.json and the app's Info.plist all agree;
 *  - the collector the app ships passes the repo's **core-edition** check (no TraceRoost Cloud
 *    markers), run against the bundle actually inside the .app rather than the build tree, and so
 *    does the main-process bundle that was packed into the asar;
 *  - the packaged Electron, re-entered as Node, is a Node the collector supports (only checked
 *    when the build's architecture matches the machine, since a foreign-arch binary may not run).
 *
 * The check-edition marker list is the repo's own (scripts/check-edition.mjs, `--tree`/`--bundles`)
 * — one list, not a copy.
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { Arch } = require('app-builder-lib')

const desktopDir = path.join(__dirname, '..')
const repoRoot = path.join(desktopDir, '..')

/** @param {import('app-builder-lib').AfterPackContext} context */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const archName = Arch[context.arch]
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  const resources = path.join(appPath, 'Contents', 'Resources')
  const collector = path.join(resources, 'collector')
  const problems = []

  // ── Layout ──
  for (const rel of [
    'collector/package.json',
    'collector/standalone/server.js',
    'collector/media/dashboard.js',
    'collector/media/sidebar.js',
    'collector/media/dashboard.css',
    'collector/node_modules/sql.js/package.json',
    'collector/node_modules/sql.js/dist/sql-wasm.js',
    'collector/node_modules/sql.js/dist/sql-wasm.wasm',
    'tray/trayTemplate.png',
    'tray/trayTemplate@2x.png',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
    'app.asar',
  ]) {
    if (!fs.existsSync(path.join(resources, rel))) problems.push(`missing from Contents/Resources: ${rel}`)
  }

  // ── Versions ──
  const expected = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
  const appVersion = context.packager.appInfo.version
  if (appVersion !== expected) problems.push(`the app is versioned ${appVersion} but the repo's package.json says ${expected}`)
  try {
    const staged = JSON.parse(fs.readFileSync(path.join(collector, 'package.json'), 'utf8')).version
    if (staged !== expected) problems.push(`the staged collector is ${staged} but the repo's package.json says ${expected} — re-run \`pnpm run stage\``)
  } catch (err) {
    problems.push(`cannot read the staged collector's package.json: ${err.message}`)
  }

  // ── Core edition, on what actually shipped ──
  const checkEdition = (tree, bundles) => {
    const r = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'check-edition.mjs'), 'core', '--skip-manifest',
      '--tree', tree, '--bundles', bundles.join(','),
    ], { encoding: 'utf8' })
    if (r.status !== 0) problems.push(`core-edition check failed for ${path.relative(repoRoot, tree)}:\n${r.stderr || r.stdout}`)
  }
  if (fs.existsSync(path.join(collector, 'standalone', 'server.js'))) {
    checkEdition(collector, ['standalone/server.js', 'media/dashboard.js', 'media/sidebar.js'])
  }
  // The main-process bundle is inside app.asar by now; the file the builder packed is out/main.js.
  checkEdition(desktopDir, ['out/main.js'])

  // ── The runtime inside the box ──
  if (archName === process.arch || archName === 'universal') {
    const binary = path.join(appPath, 'Contents', 'MacOS', context.packager.appInfo.productFilename)
    const r = spawnSync(binary, ['-p', 'process.versions.node'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    const nodeVersion = (r.stdout || '').trim()
    const major = Number(nodeVersion.split('.')[0])
    const required = Number(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).engines.node.replace(/[^\d.]/g, '').split('.')[0])
    if (r.status !== 0 || !Number.isFinite(major)) {
      problems.push(`could not run the packaged Electron as Node (exit ${r.status}): ${(r.stderr || '').trim()}`)
    } else if (major < required) {
      problems.push(`the packaged Electron runs the collector on Node ${nodeVersion}, below the required >=${required}`)
    } else {
      console.log(`  • afterPack: ${archName} app runs the collector on Node ${nodeVersion}`)
    }
  } else {
    console.log(`  • afterPack: ${archName} build on a ${process.arch} host — skipped running the packaged runtime`)
  }

  if (problems.length > 0) {
    throw new Error(`afterPack: ${appName} (${archName}) failed verification:\n  - ${problems.join('\n  - ')}`)
  }
  const size = dirBytes(appPath)
  console.log(`  • afterPack: ${appName} (${archName}) verified — ${(size / 1024 / 1024).toFixed(0)} MB on disk, core edition, version ${appVersion}`)
}

function dirBytes(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += dirBytes(p)
    else total += fs.statSync(p).size
  }
  return total
}
