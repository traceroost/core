#!/usr/bin/env node
// Packages the VSIX for an edition the way release.yml does — prepare-edition.mjs rewrites the
// manifest, vsce-identity.json's marketplace identity is patched in, and `vsce package` runs the
// edition's `vscode:prepublish` (type check + lint + production build + check-edition for core) —
// then puts this checkout's package.json/.vscodeignore back exactly as they were.
//
//   node tests/e2e/package-vsix.mjs --edition core|full
//
// Writes test-results/e2e/traceroost-<edition>.vsix and a <name>.manifest.json beside it (the
// packed manifest's publisher/name/version/commands), which tests/e2e/vscode/run.mjs reads.

import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, run, log, assert } from './lib.mjs'

const argv = process.argv.slice(2)
const edition = argv[argv.indexOf('--edition') + 1]
if (!['core', 'full'].includes(edition)) {
  console.error('usage: node tests/e2e/package-vsix.mjs --edition core|full')
  process.exit(2)
}
// Kept in step with release.yml's `pnpm add -g @vscode/vsce` (unpinned there); pinned to the major it currently resolves to
// here so a vsce release can't silently change what this suite packs.
const VSCE = '@vscode/vsce@4'

const outDir = path.join(REPO_ROOT, 'test-results', 'e2e')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, `traceroost-${edition}.vsix`)
const pkgPath = path.join(REPO_ROOT, 'package.json')
const ignorePath = path.join(REPO_ROOT, '.vscodeignore')
const savedPkg = fs.readFileSync(pkgPath)
const savedIgnore = fs.readFileSync(ignorePath)

try {
  run(process.execPath, ['scripts/prepare-edition.mjs', edition], { cwd: REPO_ROOT, stdio: 'inherit' })
  const id = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vsce-identity.json'), 'utf8'))
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  pkg.name = id.name
  pkg.publisher = id.publisher
  // `files` is the npm tarball's allowlist; the VSIX's contents come from .vscodeignore, and vsce
  // refuses a manifest that has both. release.yml drops it the same way.
  delete pkg.files
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  log(`vsce identity: ${id.publisher}.${id.name}`)
  run('npx', ['--yes', VSCE, 'package', '--no-dependencies', '--out', out], { cwd: REPO_ROOT, stdio: 'inherit' })
  run(process.execPath, ['scripts/check-edition.mjs', edition], { cwd: REPO_ROOT, stdio: 'inherit' })
  assert(fs.existsSync(out), `${out} written`)
  const manifest = {
    publisher: pkg.publisher, name: pkg.name, version: pkg.version, edition,
    commands: (pkg.contributes?.commands ?? []).map(c => c.command),
  }
  fs.writeFileSync(path.join(outDir, `traceroost-${edition}.manifest.json`), JSON.stringify(manifest, null, 2))
  log(`packed ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KiB) as ${pkg.publisher}.${pkg.name}@${pkg.version}`)
} finally {
  fs.writeFileSync(pkgPath, savedPkg)
  fs.writeFileSync(ignorePath, savedIgnore)
  for (const f of ['.package.json.edition-backup', '.vscodeignore.edition-backup']) fs.rmSync(path.join(REPO_ROOT, f), { force: true })
}
