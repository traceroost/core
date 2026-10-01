#!/usr/bin/env node
// Verifies a built edition — run after `node esbuild.js [--production] --edition=<edition>`.
//
//   node scripts/check-edition.mjs core [--package <package.json>] [--skip-manifest]
//     Fails if any shipped bundle contains a TraceRoost Cloud (org link + upload) marker — a cloud
//     module path, a Cloud endpoint or hostname, a forwarding-queue/link identifier — or if the
//     package manifest (default: ./package.json; pass the core-prepared one from
//     scripts/prepare-edition.mjs) still contributes an Org command or ships a cloud file.
//     `--skip-manifest` checks the bundles only (a local `pnpm run build:core`, where
//     package.json is still the checked-in full manifest).
//
//   node scripts/check-edition.mjs full
//     The inverse sanity check: the same markers must be present, which proves the core check is
//     actually looking at something (a marker list that silently matched nothing would pass core
//     builds forever).
//
// The build itself already refuses to bundle a cloud module in the core edition (esbuild.js's
// coreEditionPlugin); this is the independent, after-the-fact check on what actually shipped.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const edition = args[0]
if (edition !== 'core' && edition !== 'full') {
  console.error('usage: node scripts/check-edition.mjs <core|full> [--package <package.json>] [--skip-manifest]')
  process.exit(2)
}
const skipManifest = args.includes('--skip-manifest')
const pkgArgIndex = args.indexOf('--package')
const packagePath = path.resolve(root, pkgArgIndex >= 0 ? args[pkgArgIndex + 1] : 'package.json')

/** Everything the VSIX, the npm tarball and the Docker image execute. */
const BUNDLES = [
  'dist/extension.js',
  'standalone/server.js',
  'standalone/cli.js',
  'media/dashboard.js',
  'media/sidebar.js',
]

/** Strings that only TraceRoost Cloud code carries. Each is a plain substring (case-sensitive). */
const MARKERS = [
  'cloud/org',          // module paths (esbuild keeps them as comments in unminified bundles,
  'cloud/forward',      //   and in import-path strings)
  'standalone/cloud',
  'panels/OrgPanel',
  '/api/ingest',        // Cloud service endpoints (src/cloud/org/config.ts)
  '/api/org',           // the standalone server's Org-panel route
  '/api/roster',
  '/api/rates/effective',
  '/api/clusters',
  '/oauth/',
  'traceroost.com',     // Cloud hostnames (ORG_ENDPOINTS)
  'ForwardQueue',       // forwarding-queue class
  'forward-queue.jsonl',
  'team.json',          // the link credential file
  'orgLink',            // link command id / webview message
  'linkInteractive',
  'linkViaDevice',
]

/** Manifest entries that must not appear in a core package.json. */
function manifestProblems(pkg) {
  const problems = []
  const commands = pkg.contributes?.commands ?? []
  for (const c of commands) {
    if (/^traceRoost\.org/i.test(c.command)) problems.push(`contributes.commands lists ${c.command}`)
  }
  for (const [where, entries] of Object.entries(pkg.contributes?.menus ?? {})) {
    for (const m of entries) if (/^traceRoost\.org/i.test(m.command ?? '')) problems.push(`contributes.menus.${where} lists ${m.command}`)
  }
  for (const e of pkg.activationEvents ?? []) {
    if (/traceRoost\.org/i.test(e)) problems.push(`activationEvents lists ${e}`)
  }
  for (const f of pkg.files ?? []) {
    if (/(^|\/)cloud(\/|$)/.test(f)) problems.push(`files ships ${f}`)
  }
  const walkthroughs = JSON.stringify(pkg.contributes?.walkthroughs ?? [])
  if (/traceRoost\.org|TraceRoost Cloud/.test(walkthroughs)) problems.push('contributes.walkthroughs mentions the Org/Cloud feature')
  if (pkg.traceroostEdition !== undefined && pkg.traceroostEdition !== 'core') problems.push(`traceroostEdition is ${pkg.traceroostEdition}`)
  return problems
}

let failed = false
const report = []

for (const rel of BUNDLES) {
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) {
    console.error(`✘ ${rel} does not exist — build first: node esbuild.js --production --edition=${edition}`)
    failed = true
    continue
  }
  const text = fs.readFileSync(file, 'utf8')
  const hits = MARKERS.map(m => [m, text.split(m).length - 1]).filter(([, n]) => n > 0)
  report.push({ rel, bytes: text.length, hits })
  if (edition === 'core' && hits.length > 0) {
    failed = true
    console.error(`✘ ${rel} contains TraceRoost Cloud code:`)
    for (const [m, n] of hits) {
      const i = text.indexOf(m)
      const context = text.slice(Math.max(0, i - 60), i + m.length + 40).replace(/\s+/g, ' ')
      console.error(`    ${JSON.stringify(m)} ×${n}   …${context}…`)
    }
  }
}

if (edition === 'full') {
  // The extension and the dashboard are where the Cloud surface lives; the sidebar never had any.
  for (const rel of ['dist/extension.js', 'standalone/server.js', 'standalone/cli.js', 'media/dashboard.js']) {
    const r = report.find(x => x.rel === rel)
    if (r && r.hits.length === 0) {
      failed = true
      console.error(`✘ ${rel} has no Cloud markers at all in a full build — the marker list in scripts/check-edition.mjs has gone stale`)
    }
  }
}

if (edition === 'core' && !skipManifest) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const problems = manifestProblems(pkg)
  if (problems.length > 0) {
    failed = true
    console.error(`✘ ${path.relative(root, packagePath)} is not a core manifest (run scripts/prepare-edition.mjs core):`)
    for (const p of problems) console.error(`    ${p}`)
  }
}

for (const r of report) {
  console.log(`  ${r.rel.padEnd(22)} ${String(r.bytes).padStart(9)} bytes   Cloud markers: ${r.hits.reduce((n, [, c]) => n + c, 0)}`)
}
if (failed) {
  console.error(`\ncheck-edition: ${edition} edition check FAILED`)
  process.exit(1)
}
console.log(`check-edition: ${edition} edition OK`)
