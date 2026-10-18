/**
 * Writes `desktop/resources/THIRD_PARTY_NOTICES.md`: the license of every third-party package the
 * desktop app ships, with each license's full text.
 *
 * What counts as "ships" is decided from evidence rather than from a dependency list. The collector
 * and dashboard bundles inline their npm dependencies, so a `dependencies` walk would both miss
 * the transitive packages esbuild pulled in (ajv, zod, @hono/node-server, …) and list packages
 * whose code was tree-shaken away. The bundles' **source maps** name every file that actually
 * ended up in them, so the package set is read from those — the maps the core-edition build wrote
 * at the repo root a moment ago (scripts/stage-resources.mjs runs that build, so run this right
 * after it). Then two things the maps cannot see are added: Electron, which is the runtime, and
 * sql.js, which is also copied in as a real package for its WASM.
 *
 * Fails rather than writing an incomplete file when a map is missing or a package has no license
 * identifier. A package whose manifest names a license but ships no license text gets the
 * identifier alone, marked as such.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.join(here, '..')
const repoRoot = path.join(desktopDir, '..')
const out = path.join(desktopDir, 'resources', 'THIRD_PARTY_NOTICES.md')

/** The bundles the staged collector ships, and where their maps are after the build. */
const MAPS = ['standalone/server.js.map', 'media/dashboard.js.map', 'media/sidebar.js.map']

/** `…/node_modules/[.pnpm/<x>/node_modules/]<name>/…` → the package directory and its name. */
const PACKAGE_DIR = /^(.*node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+))\//

/** @type {Map<string, string>} name → directory */
const packages = new Map()

for (const rel of MAPS) {
  const mapPath = path.join(repoRoot, rel)
  if (!fs.existsSync(mapPath)) {
    throw new Error(`third-party-notices: ${rel} is missing — run \`pnpm run stage\` first (the non-production core build writes the maps this reads).`)
  }
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
  for (const source of map.sources) {
    const m = source.match(PACKAGE_DIR)
    if (!m) continue
    packages.set(m[2], path.resolve(path.dirname(mapPath), m[1]))
  }
}

// Not in any map: the runtime, and the package copied in as a directory for its WASM.
packages.set('electron', path.join(desktopDir, 'node_modules', 'electron'))
if (!packages.has('sql.js')) {
  packages.set('sql.js', path.join(desktopDir, 'resources', 'collector', 'node_modules', 'sql.js'))
}

const entries = []
for (const [name, dir] of [...packages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const license = typeof manifest.license === 'string'
    ? manifest.license
    : manifest.license?.type ?? (Array.isArray(manifest.licenses) ? manifest.licenses.map(l => l.type).join(' OR ') : undefined)
  if (!license) throw new Error(`third-party-notices: ${name}@${manifest.version} declares no license in its package.json`)
  const licenseFile = fs.readdirSync(dir).find(f => /^(licen[cs]e|copying)(\.|$)/i.test(f))
  entries.push({
    name,
    version: manifest.version,
    license,
    homepage: homepageUrl(manifest),
    text: licenseFile ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim() : undefined,
  })
}

/** A URL for the package, or undefined. `repository` may be a URL, a `git+…` URL, or npm's
 *  `owner/repo` / `github:owner/repo` shorthand; only a real URL is linked. */
function homepageUrl(manifest) {
  const raw = manifest.homepage ?? (typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url)
  if (!raw) return undefined
  const shorthand = raw.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/)
  if (shorthand) return `https://github.com/${shorthand[1]}`
  const url = raw.replace(/^git\+/, '').replace(/\.git$/, '')
  return /^https?:\/\//.test(url) ? url : undefined
}

const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const lines = [
  '# Third-party notices',
  '',
  `TraceRoost ${rootManifest.version} for macOS is MIT licensed (see LICENSE beside this file). It is built on and`,
  'ships the following third-party software, each under its own license, reproduced below.',
  '',
  'Electron itself bundles Chromium, Node.js and their dependencies; their notices are in',
  '`LICENSES.chromium.html` and `LICENSE.electron.txt`, also beside this file.',
  '',
  '| Package | Version | License |',
  '| --- | --- | --- |',
  ...entries.map(e => `| ${e.homepage ? `[${e.name}](${e.homepage})` : e.name} | ${e.version} | ${e.license} |`),
  '',
  '---',
  '',
]
for (const e of entries) {
  lines.push(`## ${e.name} ${e.version}`, '', `License: ${e.license}`, '')
  if (e.text) lines.push('```', e.text, '```')
  else lines.push('_The package ships no license text file; the identifier above is from its package.json._')
  lines.push('')
}

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, lines.join('\n'))
const missingText = entries.filter(e => !e.text).map(e => e.name)
console.log(`wrote ${path.relative(process.cwd(), out)} — ${entries.length} packages${missingText.length ? ` (no license text shipped by: ${missingText.join(', ')})` : ''}`)
